import type { Customer, FollowUpStatus } from "@/lib/types/customer";

import { STRINGS } from "./strings";

export type FollowUpBadgeTone = "blue" | "amber" | "emerald" | "slate";

export interface FollowUpBadge {
  label: string;
  tone: FollowUpBadgeTone;
}

const FOLLOW_UP_TONE: Record<FollowUpStatus, FollowUpBadgeTone> = {
  pending: "amber", // 待跟进 — 待办色
  "in-progress": "blue", // 跟进中 — 推进色
  done: "emerald", // 已跟进 — 完成色
};

/**
 * 计算跟进状态徽章。无 followUpStatus 时返回 null，由调用方决定是否渲染占位。
 */
export function resolveFollowUpBadge(c: Pick<Customer, "followUpStatus">): FollowUpBadge | null {
  if (!c.followUpStatus) return null;
  return {
    label: STRINGS.detail.followUpStatusLabels[c.followUpStatus],
    tone: FOLLOW_UP_TONE[c.followUpStatus],
  };
}

/** Tailwind 类：v4 配色加深，参考稿一致（bg-100 + text-700/800 + ring-200）。 */
export const FOLLOW_UP_BADGE_CLASS: Record<FollowUpBadgeTone, string> = {
  blue: "bg-blue-100 text-blue-700 ring-blue-200",
  amber: "bg-amber-100 text-amber-800 ring-amber-200",
  emerald: "bg-emerald-100 text-emerald-800 ring-emerald-200",
  slate: "bg-slate-100 text-slate-600 ring-slate-200",
};
