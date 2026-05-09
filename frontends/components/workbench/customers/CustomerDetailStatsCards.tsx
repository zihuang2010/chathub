import type { Customer } from "@/lib/types/customer";

import { FOLLOW_UP_BADGE_CLASS, resolveFollowUpBadge } from "./followUpBadge";
import { STAGE_BADGE_CLASS } from "./stageBadge";
import { STRINGS } from "./strings";
import type { StageBadgeTone } from "./stageBadge";
import type { CustomerLevel, CustomerStage } from "@/lib/types/customer";

const STAGE_TONE: Record<CustomerStage, StageBadgeTone> = {
  lead: "slate",
  contacting: "slate",
  intent: "amber",
  negotiating: "blue",
  "deal-won": "emerald",
  "deal-lost": "rose",
};

/**
 * 客户级别配色（v3 加深）：A 用 amber 强调，与参考图一致；B/C/D 递减权重。
 */
const LEVEL_CLASS: Record<CustomerLevel, string> = {
  A: "bg-amber-100 text-amber-800 ring-amber-300",
  B: "bg-blue-100 text-blue-800 ring-blue-300",
  C: "bg-slate-200 text-slate-700 ring-slate-300",
  D: "bg-slate-100 text-slate-500 ring-slate-200",
};

interface CustomerDetailStatsCardsProps {
  customer: Customer;
}

/**
 * 详情面板顶部 4 张并排 stat 卡：客户阶段 / 跟进状态 / 成交金额 / 客户级别。
 *
 * v3 排版：value 在上（主显眼）+ caption 在下（小标说明），与参考稿一致。
 * 注意：每个 pill 必须 whitespace-nowrap，否则 CJK 文本会按字断行（"跟进 中"）。
 */
export function CustomerDetailStatsCards({ customer }: CustomerDetailStatsCardsProps) {
  const stageTone = customer.stage ? STAGE_TONE[customer.stage] : null;
  const stageLabel = customer.stage ? STRINGS.detail.stageLabels[customer.stage] : null;
  const followUp = resolveFollowUpBadge(customer);
  const dealAmount = customer.dealAmount;
  const level = customer.level;

  return (
    <div className="grid grid-cols-4 gap-2">
      <StatCard
        caption={STRINGS.detail.statsCards.stage}
        value={
          stageLabel && stageTone ? (
            <span
              className={`inline-flex items-center whitespace-nowrap rounded px-1.5 py-0.5 text-[13px] font-medium ring-1 ${STAGE_BADGE_CLASS[stageTone]}`}
            >
              {stageLabel}
            </span>
          ) : (
            <Dash />
          )
        }
      />
      <StatCard
        caption={STRINGS.detail.statsCards.followUp}
        value={
          followUp ? (
            <span
              className={`inline-flex items-center whitespace-nowrap rounded px-1.5 py-0.5 text-[13px] font-medium ring-1 ${FOLLOW_UP_BADGE_CLASS[followUp.tone]}`}
            >
              {followUp.label}
            </span>
          ) : (
            <Dash />
          )
        }
      />
      <StatCard
        caption={STRINGS.detail.statsCards.dealAmount}
        value={
          typeof dealAmount === "number" && dealAmount > 0 ? (
            <span className="wb-num whitespace-nowrap text-[15px] font-semibold tabular-nums text-workbench-text">
              ¥{dealAmount.toLocaleString("en-US")}
            </span>
          ) : (
            <Dash />
          )
        }
      />
      <StatCard
        caption={STRINGS.detail.statsCards.level}
        value={
          level ? (
            <span
              className={`grid size-9 place-items-center whitespace-nowrap rounded-md text-[16px] font-semibold ring-1 ${LEVEL_CLASS[level]}`}
            >
              {level}
            </span>
          ) : (
            <Dash />
          )
        }
      />
    </div>
  );
}

/**
 * v3 排版：value 顶部（主显示）+ caption 底部（小标）。卡片高度自适应，
 * 用 padding + gap 控制视觉权重。
 */
function StatCard({ caption, value }: { caption: string; value: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col items-start justify-between gap-1.5 rounded-lg bg-workbench-surface-subtle px-2.5 py-2">
      <div className="leading-none">{value}</div>
      <span className="text-[11px] text-workbench-text-muted">{caption}</span>
    </div>
  );
}

function Dash() {
  return <span className="text-[15px] font-semibold text-workbench-text-muted">—</span>;
}
