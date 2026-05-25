import { isTauri } from "@tauri-apps/api/core";

import { isWindows } from "@/lib/platform";

// Tauri 自定义协议在不同平台的 URL 形态不同:macOS/Linux 为 `scheme://localhost/`,
// Windows 为 `http://scheme.localhost/`。

/**
 * 远程图片的本地缓存地址。
 *
 * - Tauri 环境 + https 远程图 → 返回 `cachedimg://` 自定义协议地址,由 Rust 下载、缩放成
 *   缩略图并落盘缓存(webview 只解码小图,不把原图全尺寸位图灌进内存)。
 * - 非 Tauri(纯 web 预览)或非 https URL → 原样返回,优雅退化。
 *
 * @param url   远程图片 https URL(可为空/undefined,空值原样返回)。
 * @param width 期望缩略图宽度(px),Rust 据此缩放。建议传显示宽度的 ~2 倍以适配高分屏。
 */
export function cachedImageSrc(url: string, width: number): string;
export function cachedImageSrc(url: string | undefined | null, width: number): string | undefined;
export function cachedImageSrc(url: string | undefined | null, width: number): string | undefined {
  if (!url) return url ?? undefined;
  if (!isTauri() || !/^https:\/\//i.test(url)) return url;
  const base = isWindows ? "http://cachedimg.localhost" : "cachedimg://localhost";
  return `${base}/?w=${Math.round(width)}&u=${encodeURIComponent(url)}`;
}
