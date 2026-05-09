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

/** 列表行的固定高度（像素）。v3：64 → 72 提供更舒展的呼吸感。 */
export const ROW_HEIGHT = 72;

/**
 * 列表行 grid 模板（v3 修订：加回 客户阶段 + 跟进状态，去掉 来源 列）。
 * 来源 现在仅在详情面板的 客户来源 字段展示。
 *
 * 从左至右：
 * 1) 32px  master checkbox / 单行 checkbox
 * 2) 180px 客户名称（avatar + name + 性别 + 手机号副行）
 * 3) 180px 所属账号（公司名 + follower 副行）
 * 4) 96px  客户阶段 badge
 * 5) 96px  跟进状态 badge
 * 6) 1fr   标签列（最少 120px，超出走 +N 溢出）
 * 7) 130px 最近跟进（日期 + follower 副行）
 * 8) 92px  操作（chat / 编辑 / 更多）
 *
 * 主区可用宽度 = viewport − 324（详情面板）。固定列合 806px + tags(min 120) = 926
 * → 1280px 视口（主区 956px）也能容纳，1fr tags ≈ 150px（1 chip + +N）。
 */
export const ROW_GRID_TEMPLATE = "32px 180px 180px 96px 96px minmax(120px,1fr) 130px 92px";

/** 详情侧栏宽度（像素），与 messages 页 CustomerDetails 对齐（324px）以保持视觉一致。 */
export const DETAIL_PANEL_WIDTH = 324;

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
 * 详情面板内的 5 个子 tab。仅 `info` 会渲染真实内容，其余渲染占位
 * 以便和参考图视觉一致并预留未来扩展。
 */
export type DetailTab = "info" | "follow-up" | "contacts" | "orders" | "more";

export interface DetailTabOption {
  value: DetailTab;
  label: string;
}

export const DETAIL_TAB_OPTIONS: DetailTabOption[] = [
  { value: "info", label: STRINGS.detail.subTabs.info },
  { value: "follow-up", label: STRINGS.detail.subTabs.followUp },
  { value: "contacts", label: STRINGS.detail.subTabs.contacts },
  { value: "orders", label: STRINGS.detail.subTabs.orders },
  { value: "more", label: STRINGS.detail.subTabs.more },
];
