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

/** Tailwind 类：与 stageBadge 保持视觉同款（pill: bg-50 text-700 ring-1 ring-100）。 */
export const FOLLOW_UP_BADGE_CLASS: Record<FollowUpBadgeTone, string> = {
  blue: "bg-blue-50 text-blue-700 ring-blue-100",
  amber: "bg-amber-50 text-amber-700 ring-amber-100",
  emerald: "bg-emerald-50 text-emerald-700 ring-emerald-100",
  slate: "bg-slate-100 text-slate-600 ring-slate-200",
};
