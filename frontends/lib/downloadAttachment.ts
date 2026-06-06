import { invoke, isTauri } from "@tauri-apps/api/core";

import { showToast } from "@/components/ui/toast";
import { isSafeUrl } from "@/components/workbench/messages/utils";

import { openExternal } from "./openExternal";

/**
 * 下载附件到本地。
 *
 * - 非 Tauri（浏览器开发态）：用原生 `<a download>` 程序化点击触发下载。
 * - Tauri：先弹「另存为」对话框让用户选保存路径，再走后端 `download_attachment`
 *   命令落盘；成功 toast 提示，失败时兜底用系统应用打开 URL（系统浏览器拉起下载）。
 *
 * @param url 附件地址。
 * @param fileName 建议的文件名（对话框默认名 / 浏览器下载名）。
 */
export async function downloadAttachment(url: string, fileName?: string): Promise<void> {
  // 浏览器开发态：没有 Tauri 后端,用原生 <a download> 触发下载。
  if (!isTauri()) {
    // 纵深防御:a.href 赋值前校验协议,拦掉 javascript:/file:/data: 等不安全 URL。
    if (!isSafeUrl(url, "link")) {
      console.warn("downloadAttachment:已拦截不安全协议的 URL", url);
      return;
    }
    const a = document.createElement("a");
    a.href = url;
    if (fileName) a.download = fileName;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    document.body.appendChild(a);
    a.click();
    a.remove();
    return;
  }

  // Tauri：弹「另存为」对话框拿目标路径;异常按用户取消处理(不打扰)。
  const { save } = await import("@tauri-apps/plugin-dialog");
  let dest: string | null | undefined;
  try {
    dest = await save({ defaultPath: fileName });
  } catch {
    return;
  }

  // 用户取消(空路径)：静默返回,不提示。
  if (!dest) return;

  try {
    // 注意:后端命令名 `download_attachment`,参数键 `url` / `destPath`(camelCase)。
    await invoke("download_attachment", { url, destPath: dest });
    showToast("下载完成");
  } catch {
    showToast("下载失败，已用系统打开", { type: "error" });
    void openExternal(url);
  }
}
