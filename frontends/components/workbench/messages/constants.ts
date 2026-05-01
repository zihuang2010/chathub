// Composer (message editor) sizing
export const COMPOSER_DEFAULT_HEIGHT = 244;
export const COMPOSER_MIN_HEIGHT = 184;
export const COMPOSER_MAX_HEIGHT = 360;

// Page-level layout
export const CONVERSATION_LIST_DEFAULT_WIDTH = 316;
export const CONVERSATION_LIST_MIN_WIDTH = 260;
export const CONVERSATION_LIST_MAX_WIDTH = 460;
export const CUSTOMER_DETAILS_WIDTH = 324;
export const CHAT_AREA_MIN_WIDTH = 360;
export const RESIZE_HANDLE_WIDTH = 8;
export const RESIZE_KEYBOARD_STEP = 16;
export const DETAILS_RESIZE_TOLERANCE = 12;

// Window width below which the details panel auto-closes.
export const DETAILS_AUTO_CLOSE_MIN_WIDTH =
  CONVERSATION_LIST_MIN_WIDTH + RESIZE_HANDLE_WIDTH + CHAT_AREA_MIN_WIDTH + CUSTOMER_DETAILS_WIDTH;
