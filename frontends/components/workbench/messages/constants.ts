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
