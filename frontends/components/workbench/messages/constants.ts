// Composer (message editor) sizing
// Inner content (P0-2 升级后): 36 (toolbar) + 12 (gap) + 64 (textarea min) +
// 12 (gap) + 36 (bottom buttons) = 160px,加 py-3 上下 24px = 184px 最低门槛。
// Default 给 textarea ~80px 舒适空间,Max 保持 360px 不变。
export const COMPOSER_DEFAULT_HEIGHT = 200;
export const COMPOSER_MIN_HEIGHT = 184;
export const COMPOSER_MAX_HEIGHT = 360;

// Page-level layout
export const CONVERSATION_LIST_DEFAULT_WIDTH = 260;
export const CONVERSATION_LIST_MIN_WIDTH = 260;
export const CONVERSATION_LIST_MAX_WIDTH = 460;
export const CUSTOMER_DETAILS_WIDTH = 324;
export const CHAT_AREA_MIN_WIDTH = 360;
export const RESIZE_HANDLE_WIDTH = 8;
export const RESIZE_KEYBOARD_STEP = 16;
export const DETAILS_RESIZE_TOLERANCE = 12;

// AT_BOTTOM_THRESHOLD determines how many pixels from the foot still counts as
// "parked at bottom" for auto-follow.
export const AT_BOTTOM_THRESHOLD = 24;

// Time-burst gap: messages from the same sender within this window collapse
// their avatars/timestamps. 5 minutes follows IM convention (WeChat / iMessage).
export const TIME_BURST_GAP_MS = 5 * 60 * 1000;

export const COMPOSER_MAX_CHARS = 5000;
export const COMPOSER_WARN_CHARS = 4500;

// 翻更旧页每次条数。页越小,单次 prepend 撑高越少 → 残余惯性覆盖锚点的概率与幅度都更低,
// 网络也更快。首屏仍走 useMessageHistory 的 DEFAULT_PAGE_SIZE(=20),保证首屏撑满视口可滚;
// 只有"上滑翻更旧"这一步用本值,二者解耦(见 useMessageHistory.loadMore)。
export const OLDER_PAGE_SIZE = 10;

// 停稳门控:到顶后"滚动是否停稳(惯性结束)"的判定。用 requestAnimationFrame 连续帧观察
// scrollTop —— 连续若干帧不再变化即视为惯性结束、可安全翻页。用帧数而非纯时长,跨刷新率更稳;
// 再叠一个时长上限兜底,防极端长尾惯性下"永远等不到停稳"而漏触发。
export const SETTLE_STABLE_FRAMES = 3; // 连续 3 帧 scrollTop 不变即停稳(~50ms@60Hz)
export const SETTLE_SCROLLTOP_EPSILON = 1; // |Δtop| <= 1px 视为未变(亚像素抖动容差)
export const SETTLE_MAX_WAIT_MS = 220; // 兜底:最久等 220ms 必触发一次判定

// 有限重断言:prepend 后锚点恢复不再单次设置 scrollTop,改为有界 rAF 重断言,压住残余惯性把
// scrollTop 扳回锚点。双上限(连续稳定即停 / 帧数硬上限)确保只在 prepend 后 ~100ms 窗口内对抗
// 惯性,窗口外完全静默 —— 不会退化成此前被删掉的"持续逐帧稳定器"那种常驻抖动源。
export const REASSERT_MAX_FRAMES = 6; // 最多重断言 6 帧(~100ms@60Hz)
export const REASSERT_STABLE_FRAMES = 2; // 连续 2 帧落点稳定即提前停
