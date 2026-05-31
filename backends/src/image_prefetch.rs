//! 图片元数据「静默」预热(去重)。
//! 读消息命令构好 records 后调用 `enrich_and_prefetch`:
//!   - 把已落库的 meta 注入到附件字段(宽高 + 有效的本地缩略图路径);
//!   - 对缺尺寸的图并发用 OSS `image/info` 秒取原始宽高、对缺缩略图的图后台下整图落盘,
//!     全部**静默**写入 hub_image_meta —— **不发 ChangeNotice**。
//!
//! 为何不发通知:每发一次 ChangeNotice,前端就整窗 replaceAuthoritative 重渲染一次,
//! 虚拟列表随之重测量,正是「打开会话图片抖动」的引擎。改为静默预热后:
//!   - 当前已打开的会话:图片由前端自身渲染(cachedimg:// 按需下载 + <img> onLoad 实测宽高,
//!     单元素轻收敛、无整窗重读);
//!   - 暖好的尺寸/缩略图在「下次读该会话」(重开 / 新消息 reconcile 自带的那次重读)时被注入,
//!     首帧即真实比例盒 + asset 本地源,零额外重读、零中途换源闪。

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use chathub_net::HistoryMessage;
use chathub_state::{ImageMeta, ImageMetaStore};
use tauri::async_runtime;

/// 聊天附件图片 CDN 基地址（与前端 messageHistory.ts ATTACHMENT_BASE_URL 同构）。
const ATTACHMENT_BASE_URL: &str = "https://filet.jdd51.com";

/// 缩略图固定宽度（px）。高分屏 2x 时气泡显示宽约 256，按 512 预取确保清晰。
const THUMB_W: u32 = 512;

/// 后台预热并发上限（小并发，避免对 OSS 突发过多请求）。
const CONCURRENCY: usize = 6;

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

    /// 注入命中的 meta 进 records；对缺失的图片后台**静默**预热(不发通知)。
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
            .filter(|a| is_image(&a.file_type))
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
        for r in records.iter_mut() {
            for a in r.attachments.iter_mut() {
                if !is_image(&a.file_type) {
                    continue;
                }
                if let Some(u) = image_url(&a.media_id) {
                    if let Some(m) = metas.get(&u) {
                        a.width = Some(m.width);
                        a.height = Some(m.height);
                        if !m.local_path.is_empty() && std::path::Path::new(&m.local_path).exists()
                        {
                            a.local_path = Some(m.local_path.clone());
                        } else {
                            stale_local.insert(u);
                        }
                    }
                }
            }
        }

        // 3. 划分后台工作集：
        //    - missing：完全无 meta 的 url（既缺宽高也缺缩略图）→ A 段尺寸优先 + B 段缩略图。
        //    - stale_b：有宽高、但缩略图文件失效的 url → 只需 B 段重取缩略图。
        let missing: Vec<String> = urls
            .into_iter()
            .filter(|u| !metas.contains_key(u))
            .collect();
        let stale_b: Vec<String> = stale_local.into_iter().collect();
        if missing.is_empty() && stale_b.is_empty() {
            return;
        }

        let this = self.clone();

        async_runtime::spawn(async move {
            use tokio::sync::Semaphore;
            use tokio::task::JoinSet;

            // ── A 段：尺寸优先（并发 image/info 秒取宽高，静默 upsert）──────────
            // 只对 missing 跑（stale_b 已有宽高）。成功者 upsert 宽高（local_path 暂空，B 段补）；
            // image/info 失败的 url 退入 B 段：由 cache.prefetch 下整图，同时拿宽高 + 缩略图。
            let mut a_ok: Vec<String> = Vec::new(); // A 段成功（待 B 段补缩略图）
            let mut b_fallback: Vec<String> = Vec::new(); // A 段失败（B 段下整图回退）
            if !missing.is_empty() {
                let sem = Arc::new(Semaphore::new(CONCURRENCY));
                let mut set: JoinSet<InfoJoinResult> = JoinSet::new();
                for u in missing {
                    // 去重：已在进行中则跳过（A/B 共用 inflight 标记）。
                    {
                        let mut g = this.inflight.lock().unwrap();
                        if g.contains(&u) {
                            continue;
                        }
                        g.insert(u.clone());
                    }
                    let this2 = this.clone();
                    let sem2 = sem.clone();
                    set.spawn(async move {
                        let _permit = sem2.acquire_owned().await;
                        let res = this2.cache.fetch_image_info(&u).await;
                        (u, res)
                    });
                }
                while let Some(joined) = set.join_next().await {
                    let Ok((u, res)) = joined else { continue };
                    match res {
                        Ok((w, h)) => {
                            let meta = ImageMeta {
                                url: u.clone(),
                                width: w as i64,
                                height: h as i64,
                                local_path: String::new(), // B 段补
                                updated_at_ms: now_ms(),
                            };
                            if let Err(e) = this.meta.upsert(meta).await {
                                tracing::warn!(
                                    target: "chathub::image_prefetch",
                                    error = %e,
                                    "image meta (dims-only) upsert failed"
                                );
                            }
                            a_ok.push(u);
                        }
                        Err(e) => {
                            tracing::debug!(
                                target: "chathub::image_prefetch",
                                error = %e,
                                "image/info failed, fall back to full download in B"
                            );
                            b_fallback.push(u);
                        }
                    }
                    // A 段 url 不在此处清 inflight：B 段还要继续用它去重，统一在 B 段末尾清。
                }
            }

            // ── B 段：缩略图（有界并发下整图，静默补缩略图 + 真实 local_path）──────
            // 工作集 = A 段成功待补缩略图 + A 段 image/info 失败回退 + meta 有但 local_path 失效。
            // stale_b 尚未进 inflight，这里补登记去重。
            let mut b_urls: Vec<String> = Vec::new();
            b_urls.extend(a_ok);
            b_urls.extend(b_fallback);
            for u in stale_b {
                let mut g = this.inflight.lock().unwrap();
                if g.contains(&u) {
                    continue;
                }
                g.insert(u.clone());
                drop(g);
                b_urls.push(u);
            }

            if !b_urls.is_empty() {
                let sem = Arc::new(Semaphore::new(CONCURRENCY));
                let mut set: JoinSet<ThumbJoinResult> = JoinSet::new();
                for u in b_urls {
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
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
