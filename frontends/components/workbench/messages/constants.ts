// Composer (message editor) sizing
// Inner content (P0-2 升级后): 36 (toolbar) + 12 (gap) + 64 (textarea min) +
// 12 (gap) + 36 (bottom buttons) = 160px,加 py-3 上下 24px = 184px 最低门槛。
// Default 给 textarea ~80px 舒适空间,Max 保持 360px 不变。
export const COMPOSER_DEFAULT_HEIGHT = 200;
export const COMPOSER_MIN_HEIGHT = 184;
export const COMPOSER_MAX_HEIGHT = 360;

// Page-level layout
// 会话(接待)列表宽度改为「按窗口宽度比例驱动」:渲染宽 = clamp(ratio × innerWidth, MIN, MAX),
// 其中 MAX 再受面板布局上限(面板宽 − 详情 − 聊天区最小 − 手柄)钳制以防挤塌聊天区。
// 窗口缩放时按比例平滑联动(丝滑),不再是定长 px;拖拽/键盘仍可手动调,拖动即记住新比例。
// DEFAULT_RATIO ≈ 0.21:标准窗口(~1250)落到 ≈262,与历史默认 260 基本一致;小屏按比例
// 收窄到 MIN(220),大屏放宽到 MAX(460)。MIN 由 260 下调到 220 让小屏能真正变窄
// (ConversationList 行内均 min-w-0 truncate,较窄仅截断不错位)。
export const CONVERSATION_LIST_DEFAULT_WIDTH = 260;
export const CONVERSATION_LIST_DEFAULT_RATIO = 0.21;
export const CONVERSATION_LIST_MIN_WIDTH = 220;
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

// 企业微信服务端硬限:单条文本最多 2000 字符,超出服务端返回 WECOM_SEND_CONTENT_TOO_LONG
// 直接拒收。故此阈值即企微上限——达到即由发送链路(buildSendUnits→textToSendUnit)自动落成
// .txt 文件附件发出(文件消息不受 2000 字文本限制),≤1999 仍按普通文本发送。
export const COMPOSER_MAX_CHARS = 2000;
export const COMPOSER_WARN_CHARS = 1800;

// 翻更旧页每次条数。页越小,单次 prepend 撑高越少 → 残余惯性覆盖锚点的概率与幅度都更低,
// 网络也更快。首屏仍走 useMessageHistory 的 DEFAULT_PAGE_SIZE(=20),保证首屏撑满视口可滚;
// 只有"上滑翻更旧"这一步用本值,二者解耦(见 useMessageHistory.loadMore)。
export const OLDER_PAGE_SIZE = 10;

// 上拉预取提前量(px)。实际阈值取 max(本值, 一个视口高度) ≈ 一屏:距顶 ≤ 该阈值即后台加载更旧页。
// 提前预取的意义在于 —— 数据在用户滚到顶**之前**就位、prepend 在「远离顶部边界、下方仍有滚动
// 余量」时落地,锚定补偿不被 scrollTop=0 钳制、也不与边界惯性相争,当前视口内容真正不动(消除
// 「下一页最后一条挤压当前页」的跳帧),同时大幅提升触发灵敏度。取 max 给极小视口兜底一个下限提前量。
export const HISTORY_PREFETCH_MIN_PX = 400;

// 有限重断言:prepend 后锚点恢复不再单次设置 scrollTop,改为有界 rAF 重断言,压住残余惯性把
// scrollTop 扳回锚点。双上限(连续稳定即停 / 帧数硬上限)确保只在 prepend 后 ~100ms 窗口内对抗
// 惯性,窗口外完全静默 —— 不会退化成此前被删掉的"持续逐帧稳定器"那种常驻抖动源。
export const SETTLE_SCROLLTOP_EPSILON = 1; // |Δtop| <= 1px 视为已对齐(亚像素抖动容差)
export const REASSERT_MAX_FRAMES = 6; // 最多重断言 6 帧(~100ms@60Hz)
export const REASSERT_STABLE_FRAMES = 2; // 连续 2 帧落点稳定即提前停
