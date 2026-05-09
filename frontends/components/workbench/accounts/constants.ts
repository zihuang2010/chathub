import type { AccountStatus } from "@/lib/types/account";

// ─── Tab ───────────────────────────────────────────────────────────────────
export type TabValue = "all" | AccountStatus;

export const TAB_OPTIONS: ReadonlyArray<{ value: TabValue; label: string }> = [
  { value: "all", label: "全部账号" },
  { value: "online", label: "正常" },
  { value: "abnormal", label: "异常" },
  { value: "offline", label: "未登录" },
];

// ─── Sort ──────────────────────────────────────────────────────────────────
export type SortKey = "lastActive" | "customers" | "sessions" | "createdAt" | "name";

export const SORT_OPTIONS: ReadonlyArray<{ value: SortKey; label: string }> = [
  { value: "lastActive", label: "最近活跃" },
  { value: "customers", label: "客户数" },
  { value: "sessions", label: "会话数" },
  { value: "createdAt", label: "创建时间" },
  { value: "name", label: "名称" },
];

// ─── 分页 ──────────────────────────────────────────────────────────────────
export const PAGE_SIZE_OPTIONS: readonly number[] = [12, 24, 48];
export const DEFAULT_PAGE_SIZE = 12;

// ─── 视图模式 ──────────────────────────────────────────────────────────────
export type ViewMode = "grid" | "list";

// ─── KPI 配置 ──────────────────────────────────────────────────────────────
// 6 张 KPI 卡的样式与图标；数值由 useAccountsView 计算。
// "delta"（较昨日变化）在 mock 阶段直接硬编码，不需要历史数据。

export type KpiKey =
  | "totalAccounts"
  | "onlineAccounts"
  | "totalCustomers"
  | "activeCustomers"
  | "totalSessions";

interface KpiCardConfig {
  key: KpiKey;
  label: string;
  iconName: "IdCard" | "MessageSquareText" | "Users" | "UserCheck" | "MessagesSquare";
  /** Tailwind 背景色（图标块）。 */
  iconBgClass: string;
  /** Tailwind 文字色（图标）。 */
  iconColorClass: string;
  /** 子统计行的 label，例如"今日新增 / 在线率"。 */
  subLabel: string;
  /** 子统计值 / "delta" 颜色（绿涨红跌）。 */
  delta: { direction: "up" | "down"; percent: number };
}

export const KPI_CONFIG: ReadonlyArray<KpiCardConfig> = [
  {
    key: "totalAccounts",
    label: "绑定账号数",
    iconName: "IdCard",
    iconBgClass: "bg-blue-50 dark:bg-blue-500/10",
    iconColorClass: "text-blue-500 dark:text-blue-400",
    subLabel: "今日新增",
    delta: { direction: "up", percent: 12.5 },
  },
  {
    key: "onlineAccounts",
    label: "在线账号数",
    iconName: "MessageSquareText",
    iconBgClass: "bg-emerald-50 dark:bg-emerald-500/10",
    iconColorClass: "text-emerald-500 dark:text-emerald-400",
    subLabel: "在线率",
    delta: { direction: "up", percent: 5.2 },
  },
  {
    key: "totalCustomers",
    label: "客户总数",
    iconName: "Users",
    iconBgClass: "bg-violet-50 dark:bg-violet-500/10",
    iconColorClass: "text-violet-500 dark:text-violet-400",
    subLabel: "今日新增",
    delta: { direction: "up", percent: 4.1 },
  },
  {
    key: "activeCustomers",
    label: "活跃客户数",
    iconName: "UserCheck",
    iconBgClass: "bg-orange-50 dark:bg-orange-500/10",
    iconColorClass: "text-orange-500 dark:text-orange-400",
    subLabel: "活跃率",
    delta: { direction: "up", percent: 2.3 },
  },
  {
    key: "totalSessions",
    label: "会话总数",
    iconName: "MessagesSquare",
    iconBgClass: "bg-teal-50 dark:bg-teal-500/10",
    iconColorClass: "text-teal-500 dark:text-teal-400",
    subLabel: "今日新增",
    delta: { direction: "up", percent: 6.7 },
  },
];
