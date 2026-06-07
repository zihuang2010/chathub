// firstItemIndex 锚定增量算法(从 ChatArea 抽出,纯函数无副作用)。
//
// react-virtuoso 往上翻历史用 firstItemIndex 做 prepend 锚定:列表头部插入 N 行就把
// firstItemIndex 减 N,Virtuoso 据此保持视口不跳。锚改为「最旧消息行」而非「首行」——
// 首行恒是日期分隔条,其 key 含「当日首条消息 id」,同日 prepend 更旧消息后该 key 既变更
// 又从列表消失(findIndex=-1)漏锚 → 视口跳;消息 id 稳定,更旧消息恒插其上方,故锚在
// 「最旧消息行」可靠。本算法据「旧锚行新位置 vs 旧位置」算 firstItemIndex 增量并重锚。

export interface FirstItemIndexAnchor {
  /** 旧锚「消息」行的 timelineRowKey;"" 表示尚未建立锚。 */
  anchorKey: string;
  /** 旧锚行在 timelineItems 中的下标;-1 表示当前无消息行。 */
  anchorIndex: number;
  /** 传给 Virtuoso 的 firstItemIndex 当前值。 */
  firstItemIndex: number;
}

/**
 * 据「旧锚消息行的新位置 vs 旧位置」算出 prepend 后的 firstItemIndex 与新锚。
 * 纯函数,无副作用,供 ChatArea 渲染期调用 + 单测。仅处理同会话内的 prepend/append/塌缩;
 * 切会话重置由调用方处理。
 *
 * @param prev 上一帧锚定状态
 * @param rowKeys 当前 timelineItems 各行的 timelineRowKey(顺序与 timelineItems 一致)
 * @param oldestMessageIndex 当前 timelineItems 中第一条「消息」行的下标(无消息行=-1)
 */
export function resolvePrependShift(
  prev: FirstItemIndexAnchor,
  rowKeys: readonly string[],
  oldestMessageIndex: number,
): FirstItemIndexAnchor & { changed: boolean } {
  const oldestKey = oldestMessageIndex >= 0 ? rowKeys[oldestMessageIndex] : "";

  if (prev.anchorKey !== "") {
    // 已有锚:旧锚消息行(id 稳定)在新列表中的位置。
    const prevNow = rowKeys.indexOf(prev.anchorKey);
    let firstItemIndex = prev.firstItemIndex;
    // 旧锚下移 = 头部插入了行(prepend),按下移量减 firstItemIndex 抵消视口位移。
    // prevNow=-1(旧锚消失/整窗塌缩)时 -1 > anchorIndex 为 false,自然不调整。
    if (prevNow > prev.anchorIndex) {
      firstItemIndex -= prevNow - prev.anchorIndex;
    }
    const next: FirstItemIndexAnchor = {
      anchorKey: oldestKey,
      anchorIndex: oldestMessageIndex,
      firstItemIndex,
    };
    const changed =
      next.anchorKey !== prev.anchorKey ||
      next.anchorIndex !== prev.anchorIndex ||
      next.firstItemIndex !== prev.firstItemIndex;
    return { ...next, changed };
  }

  if (oldestKey !== "") {
    // 首次建立锚:firstItemIndex 沿用上一帧(INITIAL),仅记下锚行。
    return {
      anchorKey: oldestKey,
      anchorIndex: oldestMessageIndex,
      firstItemIndex: prev.firstItemIndex,
      changed: true,
    };
  }

  // 无消息行:保持原状。
  return { ...prev, changed: false };
}
