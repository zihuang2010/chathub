//! 媒体附件 HTTP 客户端 + Tauri 命令。
//!
//! 与图片缩略图缓存(image_cache.rs)分工不同:这里负责「原始字节」级别的媒体获取——
//!   - `download_attachment`:把远程文件原样下载并写入用户指定的本地路径(配合 dialog 选路径)。
//!   - `fetch_media_bytes`:把远程小文件(如 amr 语音)原样取回内存,经 IPC 交给前端解码 / 播放。
//!
//! 安全(防 SSRF):复用 image_cache::validate_url,仅放行 `https` + OSS 域(白名单同图片)。

use std::time::Duration;

/// 下载到本地的附件字节上限(视频量级)。超限直接拒绝,避免整包读进后端内存把内存读爆;
/// 与 image_cache 的 MAX_DOWNLOAD_BYTES 同口径(先 content-length 廉价预拒,再 body 长度兜底)。
const MAX_DOWNLOAD_BYTES: u64 = 120 * 1024 * 1024;
/// 取回内存交前端解码的媒体字节上限(语音 amr/silk)。比下载更紧:Vec<u8> 经 IPC 序列化为
/// number[] 会膨胀约 6~10x,语音本就只有 KB 级,小上限既挡异常超大 body 又不影响正常语音。
const MAX_FETCH_BYTES: u64 = 10 * 1024 * 1024;

/// 媒体 HTTP 客户端。仅持有一个复用的 reqwest::Client(连接池 / 超时复用)。
pub struct MediaHttp {
    http: reqwest::Client,
}

impl MediaHttp {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .user_agent("chathub-media/1")
            .build()
            .unwrap_or_default();
        Self { http }
    }

    /// 取远程媒体原始字节。先做 SSRF/https 校验,再 GET;非 2xx 返回 `http {status}`。
    /// `max`:字节上限,超限返回 `too large`——先用 content-length 廉价预拒,再用实际 body 长度兜底
    /// (content-length 可能缺失或被伪造,故两道都查),避免被诱导返回超大 body 把内存读爆。
    async fn get_bytes(&self, url: &str, max: u64) -> Result<Vec<u8>, String> {
        crate::image_cache::validate_url(url)?;
        let resp = self
            .http
            .get(url)
            .send()
            .await
            .map_err(|e| format!("fetch: {e}"))?;
        let status = resp.status();
        if !status.is_success() {
            return Err(format!("http {status}"));
        }
        if let Some(len) = resp.content_length() {
            if len > max {
                return Err("too large".into());
            }
        }
        let bytes = resp.bytes().await.map_err(|e| format!("body: {e}"))?;
        if bytes.len() as u64 > max {
            return Err("too large".into());
        }
        Ok(bytes.to_vec())
    }
}

impl Default for MediaHttp {
    fn default() -> Self {
        Self::new()
    }
}

/// 下载远程附件到本地 `dest_path`(前端通过 dialog 选好路径后传入)。
/// 注:Tauri v2 把 snake_case 参数 `dest_path` 暴露为前端 camelCase `destPath`。
#[tauri::command]
pub async fn download_attachment(
    media: tauri::State<'_, MediaHttp>,
    url: String,
    dest_path: String,
) -> Result<(), String> {
    let bytes = media.get_bytes(&url, MAX_DOWNLOAD_BYTES).await?;
    // 写盘是阻塞 IO,放 blocking 线程,别堵 async runtime。
    let dest = dest_path;
    tauri::async_runtime::spawn_blocking(move || std::fs::write(&dest, &bytes))
        .await
        .map_err(|e| format!("join: {e}"))?
        .map_err(|e| format!("write: {e}"))?;
    Ok(())
}

/// 取远程媒体字节并返回给前端(amr 等小文件)。Vec<u8> 经 IPC 序列化为 number[],可接受。
#[tauri::command]
pub async fn fetch_media_bytes(
    media: tauri::State<'_, MediaHttp>,
    url: String,
) -> Result<Vec<u8>, String> {
    media.get_bytes(&url, MAX_FETCH_BYTES).await
}

/// 读取本地文件原始字节,以 ArrayBuffer 经 IPC 返回前端。
/// 用途:macOS 上 webview 的 `<input accept>` 无法过滤原生文件框(WebKit/wry 上游限制,见 wry#1191),
/// 改用 Tauri 原生 `dialog.open({filters})` 按扩展名过滤选路径,再用本命令把所选文件读回字节、在前端
/// 组装成 File 交给既有上传管线。路径来自用户在原生文件框中的显式选择。
/// 用 `tauri::ipc::Response`(原始字节)返回,避免 Vec<u8> 经 JSON 序列化成 number[] 的体积/转换开销。
#[tauri::command]
pub async fn read_local_file(path: String) -> Result<tauri::ipc::Response, String> {
    // 防御性约束:仅读「常规文件」(拒绝目录与 /dev/random 这类设备文件——后者会被无限读),
    // 并对体积设上限(本命令把整文件读进内存经 IPC 返回,避免被诱导读超大/特殊文件把内存读爆)。
    // 残留风险:路径仍由前端(原生 dialog 选择结果)传入;若 webview 被注入脚本,理论上仍可读任意
    // 「常规文件」。根治需把「选路径 + 读字节」并入后端单命令(路径不经前端往返)+ 收紧 CSP,属后续架构改动。
    const MAX_LOCAL_FILE_BYTES: u64 = 500 * 1024 * 1024;
    let bytes = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let meta = std::fs::metadata(&path).map_err(|e| format!("stat: {e}"))?;
        if !meta.is_file() {
            return Err("not a regular file".into());
        }
        if meta.len() > MAX_LOCAL_FILE_BYTES {
            return Err(format!("file too large: {} bytes", meta.len()));
        }
        std::fs::read(&path).map_err(|e| format!("read: {e}"))
    })
    .await
    .map_err(|e| format!("join: {e}"))??;
    Ok(tauri::ipc::Response::new(bytes))
}
