//! 远程图片(头像 / 消息图)磁盘缩略图缓存。
//!
//! 分层职责(与前端约定一致):Rust 负责下载 + 图片处理(缩略图)+ 磁盘缓存;webview
//! 只拿缩略图,避免把原图全尺寸位图解码进内存(内存大头正是解码位图,而非传输字节)。
//!
//! 通过自定义 URI scheme `cachedimg://` 暴露:
//!   前端 `<img src="cachedimg://localhost/?w=96&u=<encodeURIComponent(https url)>">`
//!   (Windows 上为 `http://cachedimg.localhost/...`,由前端 helper 按平台拼)
//! handler 命中读盘、未命中下载 → 缩放 → 落盘。LRU 上限 500MB / 30 天。
//!
//! 安全(防 SSRF):仅放行 `https` + OSS 域(`*.aliyuncs.com`)。其余一律拒绝,
//! 避免 webview 被诱导请求内网 / 任意地址。

use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use image::ImageFormat;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

/// 磁盘缓存总预算(字节)。超出按文件写入时间(近似 FIFO/LRU)淘汰最旧。
const MAX_CACHE_BYTES: u64 = 500 * 1024 * 1024; // 500MB
/// 缓存项最大存活时长;超过即视为过期清理。
const MAX_AGE_SECS: u64 = 30 * 24 * 60 * 60; // 30 天
/// 单张原图下载上限,防超大图把内存/磁盘打爆。
const MAX_DOWNLOAD_BYTES: u64 = 25 * 1024 * 1024;
/// SSRF 白名单:仅允许这些域(及其子域)。当前媒体/头像统一走 OSS。
const ALLOWED_HOST_SUFFIXES: &[&str] = &["aliyuncs.com"];

pub struct ImageCache {
    dir: PathBuf,
    http: reqwest::Client,
}

pub struct CachedImage {
    pub bytes: Vec<u8>,
    pub mime: &'static str,
}

impl ImageCache {
    pub fn new(dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&dir);
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .user_agent("chathub-imgcache/1")
            .build()
            .unwrap_or_default();
        Self { dir, http }
    }

    fn key_path(&self, url: &str, width: u32) -> PathBuf {
        let mut h = Sha256::new();
        h.update(width.to_le_bytes());
        h.update(b"|");
        h.update(url.as_bytes());
        let digest = h.finalize();
        let mut hex = String::with_capacity(digest.len() * 2);
        for b in digest {
            hex.push_str(&format!("{b:02x}"));
        }
        self.dir.join(format!("{hex}.img"))
    }

    /// 取缩略图字节:命中读盘,未命中下载 → 缩放到 `width` → 落盘。
    pub async fn get(&self, url: &str, width: u32) -> Result<CachedImage, String> {
        validate_url(url)?;
        let width = width.clamp(16, 1024);
        let path = self.key_path(url, width);

        // 命中:缩略图很小(几 KB~几十 KB),同步读可接受。
        if let Ok(bytes) = std::fs::read(&path) {
            let mime = sniff_mime(&bytes);
            return Ok(CachedImage { bytes, mime });
        }

        // 未命中:下载原图(限大小)。
        let raw = self.download(url).await?;

        // 解码 / 缩放 / 编码是 CPU 密集,放 blocking 线程,别堵 async runtime。
        let out = tauri::async_runtime::spawn_blocking(move || encode_thumbnail(&raw, width))
            .await
            .map_err(|e| format!("join: {e}"))??;

        write_atomic(&path, &out.bytes);
        // 写入后做一次预算/过期淘汰(后台 blocking,不阻塞本次响应)。
        let dir = self.dir.clone();
        tauri::async_runtime::spawn_blocking(move || evict(&dir));

        Ok(out)
    }

    async fn download(&self, url: &str) -> Result<Vec<u8>, String> {
        let resp = self
            .http
            .get(url)
            .send()
            .await
            .map_err(|e| format!("fetch: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("status {}", resp.status()));
        }
        if let Some(len) = resp.content_length() {
            if len > MAX_DOWNLOAD_BYTES {
                return Err("too large".into());
            }
        }
        let body = resp.bytes().await.map_err(|e| format!("body: {e}"))?;
        if body.len() as u64 > MAX_DOWNLOAD_BYTES {
            return Err("too large".into());
        }
        Ok(body.to_vec())
    }
}

/// Tauri 自定义协议 handler。解析 `?w=&u=`,调缓存,返回缩略图字节;失败一律 404,
/// 让前端 `<img onError>` 走 fallback(首字母色块 / 失败卡片)。
pub async fn serve(
    app: &AppHandle,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let Some((url, width)) = parse_request(request.uri()) else {
        return not_found();
    };
    // setup 阶段 manage 了 Arc<ImageCache>;请求一定晚于 setup,但仍兜底 try_state。
    let Some(cache) = app.try_state::<Arc<ImageCache>>() else {
        return not_found();
    };
    match cache.get(&url, width).await {
        Ok(img) => tauri::http::Response::builder()
            .status(200)
            .header(tauri::http::header::CONTENT_TYPE, img.mime)
            .header(tauri::http::header::CACHE_CONTROL, "max-age=31536000")
            .body(img.bytes)
            .unwrap_or_else(|_| not_found()),
        Err(_) => not_found(),
    }
}

fn not_found() -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(404)
        .body(Vec::new())
        .unwrap_or_default()
}

/// 从 `cachedimg://localhost/?w=96&u=<enc>`(或 win 的 `http://cachedimg.localhost/...`)
/// 解析出 (远程 url, 宽度)。
fn parse_request(uri: &tauri::http::Uri) -> Option<(String, u32)> {
    let query = uri.query()?;
    let mut url: Option<String> = None;
    let mut width: u32 = 96;
    for pair in query.split('&') {
        let Some((k, v)) = pair.split_once('=') else {
            continue;
        };
        match k {
            "u" => url = Some(percent_decode(v)),
            "w" => width = v.parse().unwrap_or(96),
            _ => {}
        }
    }
    Some((url?, width))
}

fn encode_thumbnail(raw: &[u8], width: u32) -> Result<CachedImage, String> {
    let img = image::load_from_memory(raw).map_err(|e| format!("decode: {e}"))?;
    // 仅约束宽度,高度按比例(thumbnail 保持纵横比、缩小到 box 内)。
    let thumb = img.thumbnail(width, 100_000);
    let mut buf = Cursor::new(Vec::new());
    if thumb.color().has_alpha() {
        // 有透明通道(常见于头像)→ PNG 保 alpha。
        thumb
            .write_to(&mut buf, ImageFormat::Png)
            .map_err(|e| format!("encode png: {e}"))?;
        Ok(CachedImage {
            bytes: buf.into_inner(),
            mime: "image/png",
        })
    } else {
        // 无 alpha(照片类)→ JPEG q=82,体积更小。
        let rgb = thumb.to_rgb8();
        let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 82);
        enc.encode_image(&rgb)
            .map_err(|e| format!("encode jpeg: {e}"))?;
        Ok(CachedImage {
            bytes: buf.into_inner(),
            mime: "image/jpeg",
        })
    }
}

fn sniff_mime(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        "image/png"
    } else {
        "image/jpeg"
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) {
    let tmp = path.with_extension("tmp");
    if std::fs::write(&tmp, bytes).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}

/// 过期(>30 天)直接删;再按总量预算从最旧开始删到 500MB 以内。
/// 用文件 mtime(写入时间)近似 LRU —— 不引 `filetime` 依赖、不在命中时改 mtime,
/// 故偏 FIFO;热图被按年龄淘汰后下次访问会重新下载缩略图,对缓存语义可接受。
fn evict(dir: &Path) {
    let now = SystemTime::now();
    let mut files: Vec<(PathBuf, u64, SystemTime)> = Vec::new();
    let mut total: u64 = 0;
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in rd.flatten() {
        let Ok(md) = entry.metadata() else {
            continue;
        };
        if !md.is_file() {
            continue;
        }
        let mtime = md.modified().unwrap_or(now);
        let aged_out = now
            .duration_since(mtime)
            .map(|d| d.as_secs() > MAX_AGE_SECS)
            .unwrap_or(false);
        if aged_out {
            let _ = std::fs::remove_file(entry.path());
            continue;
        }
        total += md.len();
        files.push((entry.path(), md.len(), mtime));
    }
    if total <= MAX_CACHE_BYTES {
        return;
    }
    files.sort_by_key(|(_, _, mtime)| *mtime); // 最旧在前
    for (path, size, _) in files {
        if total <= MAX_CACHE_BYTES {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(size);
        }
    }
}

fn validate_url(url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "bad url".to_string())?;
    if parsed.scheme() != "https" {
        return Err("only https allowed".into());
    }
    let host = parsed.host_str().ok_or_else(|| "no host".to_string())?;
    let allowed = ALLOWED_HOST_SUFFIXES
        .iter()
        .any(|s| host == *s || host.ends_with(&format!(".{s}")));
    if !allowed {
        return Err(format!("host not allowed: {host}"));
    }
    Ok(())
}

/// 最小 percent-decode(只处理 %XX;encodeURIComponent 不产生 '+',无需处理空格)。
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 3 <= bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}
