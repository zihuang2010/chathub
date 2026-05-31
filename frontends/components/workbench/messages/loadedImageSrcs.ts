// 「已加载过的图片源」集合(模块级,跨 mount 持久)。
//
// MessageImage 在 <img> 加载完成后写入;切回看过的图片时初始即 loaded 态,不再画骨架那一帧。
// 与 imageDimsCache 同款简单 LRU:超上限淘汰最旧(Set 迭代序即插入序)。
// 独立成模块(而非内联 MessageContent)便于:① 非组件导出不破坏 MessageContent 的 fast-refresh;
// ② useMessageHistory 切员工 reset 时清空,无需从组件文件反向 import。

const LOADED_IMAGE_SRC_LIMIT = 512;
const loadedImageSrcs = new Set<string>();

/** 记一个已加载完成的图片源。 */
export function rememberLoadedImageSrc(src: string): void {
  loadedImageSrcs.add(src);
  if (loadedImageSrcs.size <= LOADED_IMAGE_SRC_LIMIT) return;
  const oldest = loadedImageSrcs.values().next().value;
  if (oldest) loadedImageSrcs.delete(oldest);
}

/** 该源此前是否已加载完成(命中则首帧直接 loaded、不画骨架)。 */
export function hasLoadedImageSrc(src: string): boolean {
  return loadedImageSrcs.has(src);
}

/** 清空集合。切员工(chatStore.reset)时调用,避免上一员工的已加载标记影响下一员工
 *  同 URL 图片的首帧渲染态(骨架/渐显)。 */
export function clearLoadedImageSrcs(): void {
  loadedImageSrcs.clear();
}
