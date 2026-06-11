// dropFiles.ts — 聊天区拖拽文件的分类与落点判定(纯函数,不碰 DOM/Tauri,便于单测)。
// 分类规则与发送按钮/粘贴完全同源:扩展名白名单见 data.ts。

import { DOC_EXTS, extOf, IMAGE_EXTS, VOICE_EXTS } from "./data";

export interface DroppedFileGroups {
  /** 内联进编辑器(同图片按钮/粘贴)。 */
  images: File[];
  /** 进待发送托盘(同文件按钮)。 */
  docs: File[];
  /** 语音独占语义(仅纯语音拖入时生效)。 */
  voices: File[];
  /** 白名单之外,忽略并 toast。 */
  unsupported: File[];
}

export function classifyDroppedFiles(files: File[]): DroppedFileGroups {
  const groups: DroppedFileGroups = { images: [], docs: [], voices: [], unsupported: [] };
  for (const file of files) {
    const ext = extOf(file.name);
    if ((IMAGE_EXTS as readonly string[]).includes(ext)) groups.images.push(file);
    else if ((DOC_EXTS as readonly string[]).includes(ext)) groups.docs.push(file);
    else if ((VOICE_EXTS as readonly string[]).includes(ext)) groups.voices.push(file);
    else groups.unsupported.push(file);
  }
  return groups;
}

export interface Point {
  x: number;
  y: number;
}

/** Tauri 拖拽事件坐标是物理像素;除以 devicePixelRatio 得 CSS 逻辑像素。scale<=0 兜底原样返回。 */
export function physicalToLogical(p: Point, scale: number): Point {
  return scale > 0 ? { x: p.x / scale, y: p.y / scale } : p;
}

export function pointInRect(
  p: Point,
  rect: Pick<DOMRect, "left" | "top" | "right" | "bottom">,
): boolean {
  return p.x >= rect.left && p.x <= rect.right && p.y >= rect.top && p.y <= rect.bottom;
}
