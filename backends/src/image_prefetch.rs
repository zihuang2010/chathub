//! 图片元数据注入 + 后台预取（去重）。
//! 读消息命令构好 records 后调用 `enrich_and_prefetch`，把已落库的 meta 注入到附件字段；
//! 对尚未预取的图片 URL 后台 spawn 下载→写 meta→发 ChangeNotice 让打开着的会话重读。

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use chathub_net::{ChangeNotice, ChangeScope, ChangeTopic, HistoryMessage};
use chathub_state::{ImageMeta, ImageMetaStore};
use tauri::async_runtime;
use tokio::sync::broadcast;

/// 聊天附件图片 CDN 基地址（与前端 messageHistory.ts ATTACHMENT_BASE_URL 同构）。
const ATTACHMENT_BASE_URL: &str = "https://filet.jdd51.com";

/// 缩略图固定宽度（px）。高分屏 2x 时气泡显示宽约 256，按 512 预取确保清晰。
const THUMB_W: u32 = 512;

/// 将附件 media_id（OSS objectName）转为完整 https URL。
/// - 若已是 https URL，原样返回。
/// - 空串返回 None。
pub fn image_url(media_id: &str) -> Option<String> {
    if media_id.is_empty() {
        return None;
    }
    if media_id.starts_with("https://") || media_id.starts_with("http://") {
        return Some(media_id.to_string());
    }
    Some(format!(
        "{}/{}",
        ATTACHMENT_BASE_URL,
        media_id.trim_start_matches('/')
    ))
}

/// 判断附件是否为图片类型（按 file_type 后缀）。
fn is_image(file_type: &str) -> bool {
    matches!(
        file_type.to_lowercase().as_str(),
        "jpg" | "jpeg" | "png" | "gif" | "webp"
    )
}

/// 图片预取服务。持有 ImageCache + ImageMetaStore + ChangeNotice 广播发送端 + 去重集合。
#[derive(Clone)]
pub struct ImagePrefetcher {
    cache: Arc<crate::image_cache::ImageCache>,
    meta: ImageMetaStore,
    change_tx: broadcast::Sender<ChangeNotice>,
    /// 正在进行中的预取 URL 去重集合，防止同一 URL 被并发重复下载。
    inflight: Arc<Mutex<HashSet<String>>>,
}

impl ImagePrefetcher {
    pub fn new(
        cache: Arc<crate::image_cache::ImageCache>,
        meta: ImageMetaStore,
        change_tx: broadcast::Sender<ChangeNotice>,
    ) -> Self {
        Self {
            cache,
            meta,
            change_tx,
            inflight: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    /// 注入命中的 meta 进 records；对缺失的图片 URL 后台预取，完成后发通知让会话重读。
    /// best-effort：预取失败只记日志，不影响文本气泡正常返回。
    pub async fn enrich_and_prefetch(
        &self,
        records: &mut [HistoryMessage],
        conversation_id: &str,
        employee_id: &str,
    ) {
        // 1. 收集图片附件 URL（去重后批量查 meta）
        let urls: Vec<String> = records
            .iter()
            .flat_map(|r| r.attachments.iter())
            .filter(|a| is_image(&a.file_type))
            .filter_map(|a| image_url(&a.media_id))
            .collect::<std::collections::HashSet<_>>()
            .into_iter()
            .collect();

        if urls.is_empty() {
            return;
        }

        // 2. 批量查 meta，注入到命中的附件字段
        let metas = self.meta.get_many(urls.clone()).await.unwrap_or_default();
        for r in records.iter_mut() {
            for a in r.attachments.iter_mut() {
                if !is_image(&a.file_type) {
                    continue;
                }
                if let Some(u) = image_url(&a.media_id) {
                    if let Some(m) = metas.get(&u) {
                        a.width = Some(m.width);
                        a.height = Some(m.height);
                        a.local_path = Some(m.local_path.clone());
                    }
                }
            }
        }

        // 3. 对缺失 meta 的 URL 后台预取（去重）
        let missing: Vec<String> = urls
            .into_iter()
            .filter(|u| !metas.contains_key(u))
            .collect();
        if missing.is_empty() {
            return;
        }

        let this = self.clone();
        let conv = conversation_id.to_string();
        let emp = employee_id.to_string();

        async_runtime::spawn(async move {
            let mut did_any = false;
            for u in missing {
                // 去重：已在进行中则跳过
                {
                    let mut g = this.inflight.lock().unwrap();
                    if g.contains(&u) {
                        continue;
                    }
                    g.insert(u.clone());
                }

                let res = this.cache.prefetch(&u, THUMB_W).await;
                this.inflight.lock().unwrap().remove(&u);

                match res {
                    Ok((w, h, path)) => {
                        let meta = ImageMeta {
                            url: u,
                            width: w as i64,
                            height: h as i64,
                            local_path: path,
                            updated_at_ms: now_ms(),
                        };
                        if let Err(e) = this.meta.upsert(meta).await {
                            tracing::warn!(
                                target: "chathub::image_prefetch",
                                error = %e,
                                "image meta upsert failed"
                            );
                        } else {
                            did_any = true;
                        }
                    }
                    Err(e) => {
                        tracing::debug!(
                            target: "chathub::image_prefetch",
                            error = %e,
                            "image prefetch failed (best-effort, ignoring)"
                        );
                    }
                }
            }

            // 预取到至少一张后，发 ChangeNotice 让前端重读会话消息
            if did_any {
                let _ = this.change_tx.send(ChangeNotice::server_upsert(
                    ChangeTopic::ConversationMessages,
                    ChangeScope {
                        employee_id: emp,
                        conversation_id: Some(conv),
                        ..Default::default()
                    },
                ));
            }
        });
    }
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
