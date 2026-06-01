import { isTauri } from "@tauri-apps/api/core";
import { WebviewWindow, getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";

/**
 * 在“独立的 Tauri 系统窗口”里打开图片预览（多窗口）。
 *
 * - 非 Tauri（浏览器开发态）：直接返回 false，由调用方回退到应用内浮层。
 * - Tauri：复用固定 label 的预览窗口；已存在则 emit 事件并聚焦，否则新建窗口。
 *
 * 返回 true 表示已在独立窗口打开/聚焦；返回 false 表示未处理（调用方走应用内浮层兜底）。
 */
export async function openImagePreviewWindow(payload: {
  src: string;
  alt?: string;
  localPath?: string;
}): Promise<boolean> {
  if (!isTauri()) return false;

  try {
    const LABEL = "image-preview";

    // 用 URLSearchParams 拼 URL，值自动编码；缺省的 alt/localPath 传空串。
    const params = new URLSearchParams();
    params.set("view", "image-preview");
    params.set("src", payload.src);
    params.set("alt", payload.alt ?? "");
    params.set("localPath", payload.localPath ?? "");
    const url = `index.html?${params.toString()}`;

    // 先查已存在的预览窗口：命中则 emit 事件 + 聚焦复用。
    const windows = await getAllWebviewWindows();
    const existing = windows.find((w) => w.label === LABEL);
    if (existing) {
      await existing.emit("image-preview:show", payload);
      await existing.setFocus();
      return true;
    }

    // 否则新建独立预览窗口。
    new WebviewWindow(LABEL, {
      url,
      title: payload.alt && payload.alt.trim() ? payload.alt : "图片预览",
      width: 900,
      height: 700,
      minWidth: 480,
      minHeight: 360,
      resizable: true,
      decorations: true,
    });
    return true;
  } catch {
    // 任何异常都回退返回 false，让调用方走应用内浮层兜底。
    return false;
  }
}
