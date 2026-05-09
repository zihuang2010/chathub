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

/** 列表行的固定高度（像素）。v6：72 → 56，向桌面客户端 CRM 对齐密度。 */
export const ROW_HEIGHT = 56;

/**
 * 列表行 grid 模板（v7：客户名称 / 所属账号 / 来源 / 最近跟进 / 操作 都按实际
 * 内容压缩，给 1fr tags 列让位）。
 *
 * 从左至右：
 * 1) 32px  master checkbox / 单行 checkbox（保持手感）
 * 2) 144px 客户名称（avatar 28 + gap 8 + 两行文本）
 * 3) 128px 所属账号（公司名 + follower 副行）
 * 4) 1fr   标签列（彩色 chip，最少 120px，超出走 +N 溢出）
 * 5) 96px  来源 chip
 * 6) 124px 最近跟进（日期 16 字 tabular + follower 副行）
 * 7) 80px  操作（3 个 size-6 图标按钮）
 *
 * 主区可用宽度 = viewport − 280（详情面板）。固定列合 604px + tags(min 120) = 724
 * → 1280px 视口（主区 1000px）富余度更高，1fr tags ≈ 396px。
 */
export const ROW_GRID_TEMPLATE = "32px 144px 128px minmax(120px,1fr) 96px 124px 80px";

/** 详情侧栏宽度（像素）。v7：324 → 280，让出 44px 给左侧列表呼吸。messages 页保留 324px。 */
export const DETAIL_PANEL_WIDTH = 280;

/** 「待跟进」判定：lastContactAt 超过多少小时未联系。 */
export const FOLLOW_UP_HOURS_THRESHOLD = 72;

/** 「30 天未跟进」Tab 阈值。 */
export const STALE_DAYS_THRESHOLD = 30;

/** 列表行最多展示多少个标签，超过显示 +N。 */
export const ROW_MAX_TAGS = 2;

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
