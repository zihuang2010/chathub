import { invoke, isTauri } from "@tauri-apps/api/core";

/**
 * 用系统默认应用打开 URL（浏览器 / 媒体播放器等）。
 *
 * - Tauri：走 opener 插件 `open_url`（capabilities 已授予 `opener:default` → allow-open-url，
 *   覆盖 http/https）。WebView 里原生 `<a download>` / `<audio>` 不可靠时由系统应用接管。
 * - 非 Tauri（浏览器开发态）或 opener 调用失败：回退到 `window.open`。
 *
 * 典型用途：文件下载（系统浏览器拉起下载）、WebView 内无法解码的音频（如企微 amr）外部播放。
 */
export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    try {
      await invoke("plugin:opener|open_url", { url });
      return;
    } catch {
      // opener 不可用 / 被拒：回退浏览器打开，保证动作不至于静默失败。
    }
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
