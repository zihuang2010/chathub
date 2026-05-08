import type { Customer } from "@/lib/types/customer";

import { STRINGS } from "./strings";

export type StageBadgeTone = "blue" | "violet" | "emerald" | "amber" | "slate" | "rose";

export interface StageBadge {
  label: string;
  tone: StageBadgeTone;
}

const PROMOTED_TAGS: { tag: string; tone: StageBadgeTone }[] = [
  { tag: "VIP", tone: "violet" },
  { tag: "重点客户", tone: "blue" },
  { tag: "合同已签", tone: "emerald" },
  { tag: "高意向", tone: "amber" },
  { tag: "新加好友", tone: "blue" },
];

const STAGE_TONE: Record<NonNullable<Customer["stage"]>, StageBadgeTone> = {
  lead: "slate",
  contacting: "slate",
  intent: "amber",
  negotiating: "blue",
  "deal-won": "emerald",
  "deal-lost": "rose",
};

/**
 * 计算客户阶段在 UI 上的显示徽章。
 * 优先级：tags 中匹配预设升格 tag → 升格；否则根据 stage 取中文标签。
 */
export function resolveStageBadge(customer: Pick<Customer, "stage" | "tags">): StageBadge | null {
  for (const { tag, tone } of PROMOTED_TAGS) {
    if (customer.tags.includes(tag)) {
      return { label: tag, tone };
    }
  }
  if (!customer.stage) return null;
  const label = STRINGS.detail.stageLabels[customer.stage];
  return { label, tone: STAGE_TONE[customer.stage] };
}

export const STAGE_BADGE_CLASS: Record<StageBadgeTone, string> = {
  blue: "bg-blue-50 text-blue-700 ring-blue-100",
  violet: "bg-violet-50 text-violet-700 ring-violet-100",
  emerald: "bg-emerald-50 text-emerald-700 ring-emerald-100",
  amber: "bg-amber-50 text-amber-700 ring-amber-100",
  slate: "bg-slate-100 text-slate-600 ring-slate-200",
  rose: "bg-rose-50 text-rose-700 ring-rose-100",
};
