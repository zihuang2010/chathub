import { STRINGS } from "./strings";

/**
 * 客户管理页 6 个 KPI Tab。语义：
 * - all          全部客户（仅按账号过滤计数）
 * - key          重点客户：tags 含 "重点客户" / "VIP" 或 level === "A"
 * - today-new    今日新增：addedAt 落在本地"今天"
 * - stale-30d    30 天未跟进：lastContactAt > 30 天前 或为 null
 * - pending-sign 待签约：stage === "negotiating"
 * - lost         流失：stage === "deal-lost"
 */
export type CustomerTab = "all" | "key" | "today-new" | "stale-30d" | "pending-sign" | "lost";

export interface TabOption {
  value: CustomerTab;
  label: string;
}

export const TAB_OPTIONS: TabOption[] = [
  { value: "all", label: STRINGS.tabs.all },
  { value: "key", label: STRINGS.tabs.key },
  { value: "today-new", label: STRINGS.tabs.todayNew },
  { value: "stale-30d", label: STRINGS.tabs.stale30d },
  { value: "pending-sign", label: STRINGS.tabs.pendingSign },
  { value: "lost", label: STRINGS.tabs.lost },
];

/**
 * 排序键。Header 顶层排序按钮在 v2 中下沉到「更多筛选」popover；类型与
 * compareCustomers 仍保留，让 useCustomersFilters 与现有 utils 不需要破坏性改动。
 */
export type SortKey = "lastContact" | "addedAt" | "company" | "follower";

export interface SortOption {
  value: SortKey;
  label: string;
}

export const SORT_OPTIONS: SortOption[] = [
  { value: "lastContact", label: STRINGS.sort.lastContact },
  { value: "addedAt", label: STRINGS.sort.addedAt },
  { value: "company", label: STRINGS.sort.company },
  { value: "follower", label: STRINGS.sort.follower },
];

/** 卡片视图的密度。comfortable=舒适（卡片更宽，列更少），compact=紧凑（卡片更窄，列更多）。 */
export type CardDensity = "comfortable" | "compact";

/**
 * 卡片网格按 `repeat(auto-fill, minmax(N, 1fr))` 自适应列数；N 由密度决定。
 * 舒适 260px 在主区 ≈ 800px 时落 3 列（与设计稿一致），紧凑 208px 落 4 列。
 */
export const CARD_MIN_WIDTH: Record<CardDensity, number> = {
  comfortable: 260,
  compact: 208,
};

/** 默认卡片密度（对齐设计稿的 3 列舒适视图）。 */
export const DEFAULT_CARD_DENSITY: CardDensity = "comfortable";

/** 详情侧栏宽度（像素）。卡片视图详情信息更丰富，较列表版 280 加宽到 320。 */
export const DETAIL_PANEL_WIDTH = 320;

/** 「待跟进」判定：lastContactAt 超过多少小时未联系。 */
export const FOLLOW_UP_HOURS_THRESHOLD = 72;

/** 「30 天未跟进」Tab 阈值。 */
export const STALE_DAYS_THRESHOLD = 30;

/** 卡片最多展示多少个标签，超过显示 +N。 */
export const CARD_MAX_TAGS = 3;

/** 备注未编辑态最多显示多少行后折叠。 */
export const NOTE_COLLAPSE_LINES = 4;

/** 详情中"最近会话"展示的消息条数。 */
export const RECENT_MESSAGE_LIMIT = 2;

/** 详情中"客户轨迹"展示的最多条数。 */
export const TIMELINE_LIMIT = 5;

/** 分页可选页大小。 */
export const PAGE_SIZE_OPTIONS = [20, 50, 100] as const;

/** 默认每页条数。 */
export const DEFAULT_PAGE_SIZE = 20;

/**
 * 详情面板内的子 tab。v7：跟进记录 / 相关联系人 / 相关订单 暂未交付，先撤掉，
 * 只留 `info` 与 `timeline` 两个有真实内容的 tab。后续上线时按需再加回。
 */
export type DetailTab = "info" | "timeline";

export interface DetailTabOption {
  value: DetailTab;
  label: string;
}

export const DETAIL_TAB_OPTIONS: DetailTabOption[] = [
  { value: "info", label: STRINGS.detail.subTabs.info },
  { value: "timeline", label: STRINGS.detail.subTabs.timeline },
];
