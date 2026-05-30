import type { Account, AccountStatus } from "@/lib/types/account";

// ─── 时间戳解析 ──────────────────────────────────────────────────────────────
// Customer.addedAt 历史上是 "YYYY-MM-DD HH:mm"（无 T、无时区），新写的账号
// lastActiveAt 是 ISO。Safari 对前者会返回 Invalid Date，统一在这里收敛。

export function parseStamp(stamp: string): Date {
  if (stamp.includes("T")) return new Date(stamp);
  return new Date(stamp.replace(" ", "T"));
}

const pad = (n: number) => String(n).padStart(2, "0");

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** 按"自然日"算，比较 stamp 与 now 的日历日差（今天=0、昨天=1…）。 */
export function calendarDaysAgo(stamp: string, now: Date = new Date()): number {
  const d = startOfDay(parseStamp(stamp));
  const today = startOfDay(now);
  return Math.round((today.getTime() - d.getTime()) / 86_400_000);
}

/** 把一组时间戳分桶到近 7 日：返回 [6天前, …, 昨天, 今天]。 */
export function bucketLast7Days(stamps: readonly string[], now: Date = new Date()): number[] {
  const buckets = [0, 0, 0, 0, 0, 0, 0];
  for (const stamp of stamps) {
    const days = calendarDaysAgo(stamp, now);
    if (days >= 0 && days <= 6) buckets[6 - days] += 1;
  }
  return buckets;
}

// ─── 相对时间格式化 ──────────────────────────────────────────────────────────
// "刚刚" / "5 分钟前" / "1 小时前" / "昨天 14:32" / "MM-DD"

export function formatRelative(stamp: string | undefined, now: Date = new Date()): string {
  if (!stamp) return "—";
  const d = parseStamp(stamp);
  if (Number.isNaN(d.getTime())) return "—";
  const diffMs = now.getTime() - d.getTime();
  if (diffMs < 60_000) return "刚刚";
  const min = Math.floor(diffMs / 60_000);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const days = calendarDaysAgo(stamp, now);
  if (days === 1) return `昨天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (days < 7) return `${days} 天前`;
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 千分位格式化，10000 → "10,000"。 */
export function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/** "MM-DD"，给折线图 x 轴 tick。now 默认今天，offset 是相对 today 的天数（负数=过去）。 */
export function formatMonthDay(offsetDays: number, now: Date = new Date()): string {
  const d = new Date(now);
  d.setDate(d.getDate() + offsetDays);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ─── 状态映射 ───────────────────────────────────────────────────────────────
// 参考图：tab 用"正常 / 异常 / 未登录"，pill 用"在线 / 异常 / 未登录"。
// pill 与 tab 文案分离，但底层 status 类型不变。

interface StatusMeta {
  /** Tab 文案：正常 / 异常 / 未登录。 */
  tabLabel: string;
  /** Pill 文案：在线 / 异常 / 未登录。 */
  pillLabel: string;
  /** 头像状态点 background。 */
  dotClass: string;
  /** Pill 背景。 */
  pillBgClass: string;
  /** Pill 文字 / icon 颜色。 */
  pillTextClass: string;
  /** Pill 左侧 icon 名（Lucide 名）。 */
  pillIconName: "CheckCircle2" | "AlertTriangle" | "MinusCircle";
}

const STATUS_META: Record<AccountStatus, StatusMeta> = {
  online: {
    tabLabel: "正常",
    pillLabel: "在线",
    dotClass: "bg-workbench-online",
    pillBgClass: "bg-emerald-50 dark:bg-emerald-500/10",
    pillTextClass: "text-emerald-600 dark:text-emerald-400",
    pillIconName: "CheckCircle2",
  },
  abnormal: {
    tabLabel: "异常",
    pillLabel: "异常",
    dotClass: "bg-workbench-warning",
    pillBgClass: "bg-amber-50 dark:bg-amber-500/10",
    pillTextClass: "text-amber-600 dark:text-amber-400",
    pillIconName: "AlertTriangle",
  },
  offline: {
    tabLabel: "未登录",
    pillLabel: "未登录",
    dotClass: "bg-workbench-text-muted",
    pillBgClass: "bg-slate-100 dark:bg-slate-500/15",
    pillTextClass: "text-slate-600 dark:text-slate-300",
    pillIconName: "MinusCircle",
  },
};

export function getStatusMeta(status: AccountStatus | undefined): StatusMeta {
  return STATUS_META[status ?? "offline"];
}

// ─── 头像 initials & 城市 ──────────────────────────────────────────────────
// 取首段而非末段，避免与 ownerName 副标题撞字。
// "杭州企微·小美" → "杭州"；"北京客服·阿哲" → "北京"；"Acme" → "Ac"。

export function getInitials(name: string): string {
  const parts = name.split(/[·\-/\s]+/).filter(Boolean);
  const head = parts[0] ?? name;
  return Array.from(head).slice(0, 2).join("");
}

/** 优先 account.city，没有则降级用 getInitials(name)。 */
export function getCityLabel(account: Pick<Account, "city" | "name">): string {
  if (account.city && account.city.trim()) return account.city.slice(0, 2);
  return getInitials(account.name);
}

// ─── CSV 导出列定义 ─────────────────────────────────────────────────────────
// downloadCsv 复用 customers/utils.ts 的实现，这里只负责把账号行映射成对象。

const CSV_COLUMNS: ReadonlyArray<{ key: string; label: string; pick: (a: Account) => string }> = [
  { key: "name", label: "账号名称", pick: (a) => a.name },
  { key: "alias", label: "昵称", pick: (a) => a.wecomAlias ?? "" },
  { key: "position", label: "职业", pick: (a) => a.position || "员工" },
  { key: "status", label: "状态", pick: (a) => getStatusMeta(a.status).pillLabel },
  { key: "customerCount", label: "客户数", pick: (a) => String(a.customerCount ?? 0) },
  { key: "sessionCount", label: "会话数", pick: (a) => String(a.sessionCount ?? 0) },
  { key: "createdAt", label: "创建时间", pick: (a) => a.createdAt ?? "" },
  { key: "lastActiveAt", label: "最后登录", pick: (a) => formatRelative(a.lastActiveAt) },
];

function escapeCsvField(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** 把账号数组序列化成 CSV 字符串。BOM 由 downloadCsv 统一加。 */
export function toAccountsCsv(rows: readonly Account[]): string {
  const header = CSV_COLUMNS.map((c) => c.label)
    .map(escapeCsvField)
    .join(",");
  const body = rows
    .map((r) => CSV_COLUMNS.map((c) => escapeCsvField(c.pick(r))).join(","))
    .join("\n");
  return header + "\n" + body;
}
