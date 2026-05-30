import { convertFileSrc, isTauri } from "@tauri-apps/api/core";

/**
 * 本地缩略图绝对路径 → Tauri asset 协议 URL。
 * 非 Tauri 环境 / 空路径 → undefined（调用方回退到 cachedImageSrc）。
 *
 * @param localPath - 后端 image_meta 注入的磁盘绝对路径（如 /var/…/img-cache/xxx.jpg）
 */
export function assetImageSrc(localPath: string | undefined | null): string | undefined {
  if (!localPath) return undefined;
  if (!isTauri()) return undefined;
  return convertFileSrc(localPath);
}
