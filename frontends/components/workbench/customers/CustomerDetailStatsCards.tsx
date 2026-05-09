import type { Customer } from "@/lib/types/customer";

import { FOLLOW_UP_BADGE_CLASS, resolveFollowUpBadge } from "./followUpBadge";
import { STAGE_BADGE_CLASS } from "./stageBadge";
import { STRINGS } from "./strings";
import type { StageBadgeTone } from "./stageBadge";
import type { CustomerStage } from "@/lib/types/customer";

const STAGE_TONE: Record<CustomerStage, StageBadgeTone> = {
  lead: "slate",
  contacting: "slate",
  intent: "amber",
  negotiating: "blue",
  "deal-won": "emerald",
  "deal-lost": "rose",
};

interface CustomerDetailStatsCardsProps {
  customer: Customer;
}

/**
 * 详情面板顶部 4 张并排 stat 卡：客户阶段 / 跟进状态 / 成交金额 / 客户级别。
 * 每张卡：上部小标（caption），下部主值（accent 色，pill / amount / letter）。
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
        body={
          stageLabel && stageTone ? (
            <span
              className={`inline-flex items-center rounded px-1.5 py-0.5 text-[12px] font-medium ring-1 ${STAGE_BADGE_CLASS[stageTone]}`}
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
        body={
          followUp ? (
            <span
              className={`inline-flex items-center rounded px-1.5 py-0.5 text-[12px] font-medium ring-1 ${FOLLOW_UP_BADGE_CLASS[followUp.tone]}`}
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
        body={
          typeof dealAmount === "number" && dealAmount > 0 ? (
            <span className="wb-num text-[13px] font-semibold tabular-nums text-workbench-text">
              ¥{dealAmount.toLocaleString("en-US")}
            </span>
          ) : (
            <Dash />
          )
        }
      />
      <StatCard
        caption={STRINGS.detail.statsCards.level}
        body={
          level ? (
            <span className="grid size-6 place-items-center rounded-md bg-workbench-surface text-[13px] font-semibold text-workbench-accent ring-1 ring-workbench-accent/30">
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

function StatCard({ caption, body }: { caption: string; body: React.ReactNode }) {
  return (
    <div className="flex h-[58px] flex-col items-start justify-between rounded-lg bg-workbench-surface-subtle px-2.5 py-2">
      <span className="text-[11px] text-workbench-text-muted">{caption}</span>
      <div className="leading-none">{body}</div>
    </div>
  );
}

function Dash() {
  return <span className="text-[13px] text-workbench-text-muted">—</span>;
}
