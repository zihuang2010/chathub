import { isTauri } from "@tauri-apps/api/core";
import { WebviewWindow, getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";

/**
 * 在“独立的 Tauri 系统窗口”里打开视频预览（多窗口）。
 *
 * - 非 Tauri（浏览器开发态）：直接返回 false，由调用方回退到系统外部打开。
 * - Tauri：复用固定 label 的预览窗口；已存在则 emit 事件并聚焦，否则新建窗口。
 *
 * 返回 true 表示已在独立窗口打开/聚焦；返回 false 表示未处理（调用方走系统外部打开兜底）。
 */
export async function openVideoPreviewWindow(payload: {
  src: string;
  name?: string;
}): Promise<boolean> {
  if (!isTauri()) return false;

  try {
    const LABEL = "video-preview";

    // 用 URLSearchParams 拼 URL，值自动编码；缺省的 name 传空串。
    const params = new URLSearchParams();
    params.set("view", "video-preview");
    params.set("src", payload.src);
    params.set("name", payload.name ?? "");
    const url = `index.html?${params.toString()}`;

    // 先查已存在的预览窗口：命中则 emit 事件 + 聚焦复用。
    const windows = await getAllWebviewWindows();
    const existing = windows.find((w) => w.label === LABEL);
    if (existing) {
      await existing.emit("video-preview:show", payload);
      await existing.setFocus();
      return true;
    }

    // 否则新建独立预览窗口。
    new WebviewWindow(LABEL, {
      url,
      title: payload.name && payload.name.trim() ? payload.name : "视频预览",
      width: 960,
      height: 600,
      minWidth: 480,
      minHeight: 320,
      resizable: true,
      decorations: true,
    });
    return true;
  } catch {
    // 任何异常都回退返回 false，让调用方走系统外部打开兜底。
    return false;
  }
}
