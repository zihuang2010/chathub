// 图片固有宽高的模块级缓存(按图片 URL)。
//
// 由 MessageImage 在 <img> 加载后测得写入;比例盒渲染(MessageContent)与虚拟列表估高
// (virtualListSizing)共用同一份缓存,使「滚出视口再滚回 / 切会话重渲」时重新挂载的图片行
// 首帧即按真实比例就位 —— 渲染盒不再「方盒→比例盒」跳变,虚拟器估高也与实测一致,
// 杜绝两者引起的页面重排抖动。
//
// 与 loadedImageSrcs 同款简单 LRU:超上限淘汰最旧(Map 迭代序即插入序)。

export interface ImageDims {
  w: number;
  h: number;
}

const CACHE_LIMIT = 512;
const cache = new Map<string, ImageDims>();

/** 写入一张图的固有宽高(首次写入即固定,后续同 URL 不覆盖)。 */
export function rememberMeasuredDims(url: string, dims: ImageDims): void {
  if (!url || cache.has(url)) return;
  cache.set(url, dims);
  if (cache.size <= CACHE_LIMIT) return;
  const oldest = cache.keys().next().value;
  if (oldest) cache.delete(oldest);
}

/** 读取已缓存的固有宽高;未命中返回 undefined。 */
export function getMeasuredDims(url: string | undefined): ImageDims | undefined {
  if (!url) return undefined;
  return cache.get(url);
}

/** 清空全部缓存。切员工(chatStore.reset)时调用,使该模块级辅助缓存与数据真相
 *  生命周期一致,避免上一员工同 URL 图片的固有宽高残留影响下一员工首帧。 */
export function clearImageDimsCache(): void {
  cache.clear();
}
