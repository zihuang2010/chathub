import type { Customer } from "@/lib/types/customer";

import { FOLLOW_UP_HOURS_THRESHOLD, NEW_FRIEND_DAYS, type SortKey } from "./constants";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// ─── 时间相关 ───────────────────────────────────────────────────────────────

/** 解析 mock 中两种格式：ISO 字符串、或 "2024-05-20 10:15"。 */
export function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const direct = new Date(value);
  if (!Number.isNaN(direct.getTime())) return direct;
  // "2024-05-20 10:15" 这种本地形式，加 T 让 JS 当作本地时间。
  const massaged = value.replace(" ", "T");
  const fallback = new Date(massaged);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

const RELATIVE_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric",
  day: "numeric",
});

/** 下次跟进的紧迫色调。 */
export type FollowUpTone = "overdue" | "today" | "tomorrow" | "soon" | "later";

export interface FollowUpDescriptor {
  /** 用于行内/状态卡的简短文案，例如「今天」「3 天后」「逾期 2 天」。 */
  label: string;
  tone: FollowUpTone;
}

/**
 * 基于 nextFollowUpAt 计算紧迫度。今天/明天的 tone 用于上色；
 * 7 天内 soon、再往后 later、过去时间 overdue。
 */
export function formatNextFollowUp(
  value: string | null | undefined,
  now: Date = new Date(),
): FollowUpDescriptor | null {
  const d = parseDate(value);
  if (!d) return null;

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfTarget = new Date(d);
  startOfTarget.setHours(0, 0, 0, 0);
  const dayDiff = Math.round((startOfTarget.getTime() - startOfToday.getTime()) / DAY_MS);

  if (dayDiff < 0) {
    return { label: `逾期 ${Math.abs(dayDiff)} 天`, tone: "overdue" };
  }
  if (dayDiff === 0) return { label: "今天", tone: "today" };
  if (dayDiff === 1) return { label: "明天", tone: "tomorrow" };
  if (dayDiff <= 7) return { label: `${dayDiff} 天后`, tone: "soon" };
  if (d.getFullYear() === now.getFullYear()) {
    return { label: RELATIVE_FORMATTER.format(d), tone: "later" };
  }
  return {
    label: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    tone: "later",
  };
}

/** 把日期渲染成"5 分钟前 / 昨天 / 3 天前 / 6 月 12 日"。 */
export function formatRelativeTime(
  value: string | null | undefined,
  now: Date = new Date(),
): string {
  const d = parseDate(value);
  if (!d) return "—";
  const diff = now.getTime() - d.getTime();
  if (diff < 60 * 1000) return "刚刚";
  if (diff < HOUR_MS) return `${Math.floor(diff / (60 * 1000))} 分钟前`;
  if (diff < 6 * HOUR_MS) return `${Math.floor(diff / HOUR_MS)} 小时前`;
  if (sameDay(d, now)) return formatHHMM(d);
  if (sameDay(d, addDays(now, -1))) return "昨天";
  if (diff < 7 * DAY_MS) return `${Math.floor(diff / DAY_MS)} 天前`;
  if (d.getFullYear() === now.getFullYear()) return RELATIVE_FORMATTER.format(d);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function sameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function pad(n: number) {
  return n < 10 ? `0${n}` : `${n}`;
}

function formatHHMM(d: Date) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ─── 视图判定 ───────────────────────────────────────────────────────────────

/** 是否在"新加好友"窗口内（默认最近 7 天）。 */
export function isNewFriend(c: Customer, now: Date = new Date()): boolean {
  const added = parseDate(c.addedAt);
  if (!added) return false;
  return now.getTime() - added.getTime() < NEW_FRIEND_DAYS * DAY_MS;
}

/** 是否需要跟进。规则：显式 followUpReason，或 lastContactAt 超过阈值。 */
export function needsFollowUp(c: Customer, now: Date = new Date()): boolean {
  if (c.followUpReason && c.followUpReason.length > 0) return true;
  const last = parseDate(c.lastContactAt ?? null);
  if (!last) return false;
  return now.getTime() - last.getTime() > FOLLOW_UP_HOURS_THRESHOLD * HOUR_MS;
}

// ─── 过滤 / 搜索 / 排序 ─────────────────────────────────────────────────────

/** 文本是否命中：在 name / company / remark / follower / accountName 中找。 */
export function matchSearch(c: Customer, term: string): boolean {
  const t = term.trim().toLowerCase();
  if (!t) return true;
  return [c.name, c.company, c.remark, c.follower, c.account]
    .map((v) => v?.toLowerCase() ?? "")
    .some((v) => v.includes(t));
}

/** 是否含全部要求的标签（AND 语义；空则恒真）。 */
export function matchAllTags(c: Customer, requiredTags: readonly string[]): boolean {
  if (requiredTags.length === 0) return true;
  return requiredTags.every((t) => c.tags.includes(t));
}

export function compareCustomers(a: Customer, b: Customer, key: SortKey): number {
  switch (key) {
    case "lastContact": {
      const ta = parseDate(a.lastContactAt ?? a.addedAt)?.getTime() ?? 0;
      const tb = parseDate(b.lastContactAt ?? b.addedAt)?.getTime() ?? 0;
      return tb - ta; // 最近在前
    }
    case "addedAt": {
      const ta = parseDate(a.addedAt)?.getTime() ?? 0;
      const tb = parseDate(b.addedAt)?.getTime() ?? 0;
      return tb - ta;
    }
    case "company":
      return a.company.localeCompare(b.company, "zh-Hans-CN");
    case "follower":
      return a.follower.localeCompare(b.follower, "zh-Hans-CN");
  }
}

// ─── CSV 导出 ───────────────────────────────────────────────────────────────

const CSV_COLUMNS: { header: string; pick: (c: Customer) => string }[] = [
  { header: "姓名", pick: (c) => c.name },
  { header: "公司", pick: (c) => c.company },
  { header: "归属账号", pick: (c) => c.account },
  { header: "跟进人", pick: (c) => c.follower },
  { header: "标签", pick: (c) => c.tags.join("、") },
  { header: "手机", pick: (c) => c.phone },
  { header: "微信", pick: (c) => c.weChat },
  { header: "来源", pick: (c) => c.source },
  { header: "添加于", pick: (c) => c.addedAt },
  { header: "最近联系", pick: (c) => c.lastContactAt ?? "" },
];

function escapeCsv(v: string): string {
  if (/[",\n]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

export function toCsv(customers: readonly Customer[]): string {
  const lines: string[] = [];
  lines.push(CSV_COLUMNS.map((c) => escapeCsv(c.header)).join(","));
  for (const customer of customers) {
    lines.push(CSV_COLUMNS.map((c) => escapeCsv(c.pick(customer))).join(","));
  }
  return lines.join("\n");
}

/** 触发浏览器下载。Tauri 环境同样支持（Blob URL）。 */
export function downloadCsv(filename: string, content: string): void {
  const bom = "﻿"; // 让 Excel 正确识别 UTF-8
  const blob = new Blob([bom, content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${filename}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
