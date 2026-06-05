//! 图片元数据「静默」预热(去重)。
//! 读消息命令构好 records 后调用 `enrich_and_prefetch`:
//!   - 把已落库的 meta 注入到附件字段(宽高 + 有效的本地缩略图路径);
//!   - 对缺尺寸的图并发用 OSS `image/info` 秒取原始宽高、对缺缩略图的图后台下整图落盘,
//!     全部**静默**写入 hub_image_meta —— **不发 ChangeNotice**。
//!
//! 为何不发通知:每发一次 ChangeNotice,前端就整窗 replaceAuthoritative 重渲染一次,
//! 虚拟列表随之重测量,正是「打开会话图片抖动」的引擎。改为静默预热后:
//!   - 当前已打开的会话:返回前尽量注入真实宽高；没赶上的图保持稳定占位,
//!     不在 <img> onLoad 后二次改行高;
//!   - 暖好的尺寸/缩略图在「下次读该会话」(重开 / 新消息 reconcile 自带的那次重读)时被注入,
//!     首帧即真实比例盒 + asset 本地源,零额外重读、零中途换源闪。

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chathub_net::{HistoryAttachment, HistoryMessage};
use chathub_state::{ImageMeta, ImageMetaStore};
use tauri::async_runtime;

/// 聊天附件图片 CDN 基地址（与前端 messageHistory.ts ATTACHMENT_BASE_URL 同源）。
/// 编译期由 build.rs 从 CHATHUB_ATTACHMENT_BASE_URL env 注入,缺省回落 filet.jdd51.com。
const ATTACHMENT_BASE_URL: &str = env!("CHATHUB_ATTACHMENT_BASE_URL_RESOLVED");

/// 缩略图固定宽度（px）。高分屏 2x 时气泡显示宽约 256，按 512 预取确保清晰。
const THUMB_W: u32 = 512;

/// 后台预热并发上限（小并发，避免对 OSS 突发过多请求）。
const CONCURRENCY: usize = 6;
/// 返回消息首屏前同步等待 image/info 的最大时间。超时则保持稳定占位，缩略图后台补。
const SYNC_DIMS_TIMEOUT: Duration = Duration::from_millis(1200);

/// A 段（image/info 秒取宽高）任务返回：`(url, Ok((宽, 高)) | Err)`。
type InfoJoinResult = (String, Result<(u32, u32), String>);
/// B 段（下整图补缩略图）任务返回：`(url, Ok((宽, 高, 本地路径)) | Err)`。
type ThumbJoinResult = (String, Result<(u32, u32, String), String>);

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

/// 判断附件是否为图片：权威 `attachment_type==1` 优先,扩展名 `file_type` 兜底。
/// 实时推送的图片只带 attachmentType、不带 fileSuffix,故不能只看扩展名,否则预取被整体跳过。
fn is_image_attachment(a: &HistoryAttachment) -> bool {
    a.attachment_type == 1 || is_image(&a.file_type)
}

fn inject_dims_into_records(records: &mut [HistoryMessage], dims: &HashMap<String, (u32, u32)>) {
    if dims.is_empty() {
        return;
    }
    for r in records.iter_mut() {
        for a in r.attachments.iter_mut() {
            if !is_image_attachment(a) || (a.width.is_some() && a.height.is_some()) {
                continue;
            }
            let Some(u) = image_url(&a.media_id) else {
                continue;
            };
            if let Some((w, h)) = dims.get(&u) {
                a.width = Some(i64::from(*w));
                a.height = Some(i64::from(*h));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn message(media_id: &str) -> HistoryMessage {
        HistoryMessage {
            local_message_id: "m1".into(),
            message_direction: 1,
            message_type: 2,
            content_text: "".into(),
            send_status: 3,
            message_time: "2026-05-30 10:00:00".into(),
            sort_key: "1770000000000:2:00000000000000009001:m1".into(),
            attachments: vec![HistoryAttachment {
                media_id: media_id.into(),
                file_name: "image.png".into(),
                file_size: 1,
                attachment_type: 1,
                file_type: "png".into(),
                width: None,
                height: None,
                local_path: None,
                transfer_status: 2,
                duration_seconds: None,
            }],
            gmt_modified_time: "".into(),
            revoked: false,
            fail_reason: "".into(),
            request_message_id: "".into(),
        }
    }

    #[test]
    fn inject_dims_into_records_sets_return_payload_before_prefetch_completes() {
        let mut records = vec![message("t/dev/a.png")];
        let mut dims = HashMap::new();
        dims.insert(
            "https://filet.jdd51.com/t/dev/a.png".to_string(),
            (640_u32, 360_u32),
        );

        inject_dims_into_records(&mut records, &dims);

        let attachment = &records[0].attachments[0];
        assert_eq!(attachment.width, Some(640));
        assert_eq!(attachment.height, Some(360));
        assert_eq!(attachment.local_path, None);
    }

    #[test]
    fn is_image_attachment_prefers_attachment_type_then_falls_back_to_ext() {
        let mut a = HistoryAttachment {
            media_id: "t/x".into(),
            file_name: "".into(),
            file_size: 0,
            attachment_type: 1,
            file_type: "".into(),
            width: None,
            height: None,
            local_path: None,
            transfer_status: 2,
            duration_seconds: None,
        };
        // 推送图片:attachmentType=1、无扩展名 → 仍判为图片(此前会漏判 → 跳过预取)。
        assert!(is_image_attachment(&a));
        // 文件:attachmentType=2、无图片扩展名 → 非图片。
        a.attachment_type = 2;
        assert!(!is_image_attachment(&a));
        // 旧缓存:无 attachmentType(0),靠扩展名兜底仍判图片。
        a.attachment_type = 0;
        a.file_type = "png".into();
        assert!(is_image_attachment(&a));
    }
}

/// 图片预热服务。持有 ImageCache + ImageMetaStore + 去重集合。
/// 只读写本地 meta / 磁盘缓存，不广播 ChangeNotice（见模块头注释）。
#[derive(Clone)]
pub struct ImagePrefetcher {
    cache: Arc<crate::image_cache::ImageCache>,
    meta: ImageMetaStore,
    /// 正在进行中的预取 URL 去重集合，防止同一 URL 被并发重复下载。
    inflight: Arc<Mutex<HashSet<String>>>,
}

impl ImagePrefetcher {
    pub fn new(cache: Arc<crate::image_cache::ImageCache>, meta: ImageMetaStore) -> Self {
        Self {
            cache,
            meta,
            inflight: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    /// 注入命中的 meta 进 records；缺尺寸时在短预算内同步取 image/info 并注入,
    /// 缩略图落盘仍后台**静默**预热(不发通知)。
    /// best-effort：预热失败只记日志，不影响文本气泡正常返回。
    ///
    /// `_conversation_id` / `_employee_id` 保留在签名里仅为兼容调用点;静默预热不再需要
    /// 它们来构造 ChangeNotice。
    pub async fn enrich_and_prefetch(
        &self,
        records: &mut [HistoryMessage],
        _conversation_id: &str,
        _employee_id: &str,
    ) {
        // 1. 收集图片附件 URL（去重后批量查 meta）
        let urls: Vec<String> = records
            .iter()
            .flat_map(|r| r.attachments.iter())
            .filter(|a| is_image_attachment(a))
            .filter_map(|a| image_url(&a.media_id))
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();

        if urls.is_empty() {
            return;
        }

        // 2. 批量查 meta，注入到命中的附件字段。
        //    - 宽高命中即注入（前端据此定真实比例盒）。
        //    - local_path 仅当「非空 + 文件实际存在」才注入；若 meta 有但文件失效
        //      （被 evict / 手动删），不注入 local_path（前端回退 cachedimg 远端读，不闪 asset 404），
        //      并把该 url 计入「需重取缩略图」集合，B 段重新落盘 + 刷新 meta.local_path。
        let metas = self.meta.get_many(urls.clone()).await.unwrap_or_default();
        let mut stale_local: HashSet<String> = HashSet::new();
        // 已带真实宽高的图 url(服务端 imageWidth/imageHeight 反序列化已捕获,或 meta 刚注入)。
        // 这些图首帧即可定比例盒,A 段同步取尺寸对它们是多余的,不进同步集合(省阻塞)。
        let mut urls_with_dims: HashSet<String> = HashSet::new();
        for r in records.iter_mut() {
            for a in r.attachments.iter_mut() {
                if !is_image_attachment(a) {
                    continue;
                }
                let Some(u) = image_url(&a.media_id) else {
                    continue;
                };
                if let Some(m) = metas.get(&u) {
                    a.width = Some(m.width);
                    a.height = Some(m.height);
                    if !m.local_path.is_empty() && std::path::Path::new(&m.local_path).exists() {
                        a.local_path = Some(m.local_path.clone());
                    } else {
                        stale_local.insert(u.clone());
                    }
                }
                if a.width.is_some() && a.height.is_some() {
                    urls_with_dims.insert(u);
                }
            }
        }

        // 3. 首屏返回前优先补宽高：只对**仍缺宽高**的图同步取 image/info(已有服务端 imageWidth/
        //    imageHeight 或 meta 命中的图跳过,省掉一次最多 SYNC_DIMS_TIMEOUT 的 OSS 阻塞)。
        //    image/info 只回小 JSON,短预算内成功即写 meta + 注入 records；失败/超时不阻塞,
        //    前端保持稳定中性比例盒,后台 B 段再下整图补。
        //    注:`missing`(缺 meta)仍是 B 段缩略图工作集 —— 带服务端宽高但无本地缩略图的图
        //    仍需 B 段下整图补 local_path,故 B 段集合不收窄。
        let missing: Vec<String> = urls
            .into_iter()
            .filter(|u| !metas.contains_key(u))
            .collect();
        let dims_missing: Vec<String> = missing
            .iter()
            .filter(|u| !urls_with_dims.contains(*u))
            .cloned()
            .collect();
        if !dims_missing.is_empty() {
            let dims = self.fetch_dims_with_timeout(dims_missing).await;
            inject_dims_into_records(records, &dims);
        }

        // 4. 划分后台工作集：
        //    - missing：无本地缩略图 → B 段缩略图；若同步尺寸失败,B 段下整图时仍会拿到宽高。
        //    - stale_b：有宽高、但缩略图文件失效的 url → 只需 B 段重取缩略图。
        let stale_b: Vec<String> = stale_local.into_iter().collect();
        if missing.is_empty() && stale_b.is_empty() {
            return;
        }

        let this = self.clone();

        async_runtime::spawn(async move {
            use tokio::sync::Semaphore;
            use tokio::task::JoinSet;

            // ── B 段：缩略图（有界并发下整图，静默补缩略图 + 真实 local_path）──────
            // 工作集 = 缺 meta 的 url + meta 有但 local_path 失效的 url。
            let mut b_urls: Vec<String> = Vec::new();
            b_urls.extend(missing);
            b_urls.extend(stale_b);
            let mut unique_b_urls = Vec::new();
            for u in b_urls {
                let mut g = this.inflight.lock().unwrap();
                if g.contains(&u) {
                    continue;
                }
                g.insert(u.clone());
                drop(g);
                unique_b_urls.push(u);
            }

            if !unique_b_urls.is_empty() {
                let sem = Arc::new(Semaphore::new(CONCURRENCY));
                let mut set: JoinSet<ThumbJoinResult> = JoinSet::new();
                for u in unique_b_urls {
                    let this2 = this.clone();
                    let sem2 = sem.clone();
                    set.spawn(async move {
                        let _permit = sem2.acquire_owned().await;
                        let res = this2.cache.prefetch(&u, THUMB_W).await;
                        (u, res)
                    });
                }
                while let Some(joined) = set.join_next().await {
                    let Ok((u, res)) = joined else { continue };
                    match res {
                        Ok((w, h, path)) => {
                            let meta = ImageMeta {
                                url: u.clone(),
                                width: w as i64,
                                height: h as i64,
                                local_path: path,
                                updated_at_ms: now_ms(),
                            };
                            if let Err(e) = this.meta.upsert(meta).await {
                                tracing::warn!(
                                    target: "chathub::image_prefetch",
                                    error = %e,
                                    "image meta (full) upsert failed"
                                );
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
                    this.inflight.lock().unwrap().remove(&u);
                }
            }
        });
    }

    async fn fetch_dims_with_timeout(&self, urls: Vec<String>) -> HashMap<String, (u32, u32)> {
        tokio::time::timeout(SYNC_DIMS_TIMEOUT, self.fetch_dims(urls))
            .await
            .unwrap_or_default()
    }

    async fn fetch_dims(&self, urls: Vec<String>) -> HashMap<String, (u32, u32)> {
        use tokio::sync::Semaphore;
        use tokio::task::JoinSet;

        let urls: Vec<String> = urls.into_iter().filter(|u| !u.is_empty()).collect();
        let mut out: HashMap<String, (u32, u32)> = HashMap::new();
        if urls.is_empty() {
            return out;
        }
        let sem = Arc::new(Semaphore::new(CONCURRENCY));
        let mut set: JoinSet<InfoJoinResult> = JoinSet::new();
        for u in urls {
            let this2 = self.clone();
            let sem2 = sem.clone();
            set.spawn(async move {
                let _permit = sem2.acquire_owned().await;
                let res = this2.cache.fetch_image_info(&u).await;
                (u, res)
            });
        }
        while let Some(joined) = set.join_next().await {
            let Ok((u, Ok((w, h)))) = joined else {
                continue;
            };
            if let Err(e) = self
                .meta
                .upsert(ImageMeta {
                    url: u.clone(),
                    width: w as i64,
                    height: h as i64,
                    local_path: String::new(),
                    updated_at_ms: now_ms(),
                })
                .await
            {
                tracing::warn!(
                    target: "chathub::image_prefetch",
                    error = %e,
                    "image meta (sync dims) upsert failed"
                );
            }
            out.insert(u, (w, h));
        }
        out
    }
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
