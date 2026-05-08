import type { ComponentType } from "react";
import { CalendarCheck, Clock, TrendingUp, Wallet, type LucideProps } from "lucide-react";

import type { Customer } from "@/lib/types/customer";
import { cn } from "@/lib/utils";

import { STAGE_BADGE_CLASS, resolveStageBadge } from "./stageBadge";
import { STRINGS } from "./strings";
import { formatNextFollowUp, parseDate, type FollowUpTone } from "./utils";

type Tone = "emerald" | "violet" | "blue" | "amber" | "rose" | "slate";

const TONE_BG: Record<Tone, string> = {
  emerald: "bg-emerald-50",
  violet: "bg-violet-50",
  blue: "bg-blue-50",
  amber: "bg-amber-50",
  rose: "bg-rose-50",
  slate: "bg-slate-100",
};

const TONE_FG: Record<Tone, string> = {
  emerald: "text-emerald-600",
  violet: "text-violet-600",
  blue: "text-blue-600",
  amber: "text-amber-600",
  rose: "text-rose-600",
  slate: "text-slate-500",
};

const FOLLOW_UP_VALUE_CLASS: Record<FollowUpTone, string> = {
  overdue: "text-rose-600",
  today: "text-rose-600",
  tomorrow: "text-amber-600",
  soon: "text-workbench-text",
  later: "text-workbench-text",
};

interface CustomerStatusCardProps {
  customer: Customer;
}

export function CustomerStatusCard({ customer }: CustomerStatusCardProps) {
  const c = STRINGS.detail.statusCard;
  const stageBadge = resolveStageBadge(customer);

  const dealAmountLabel = customer.dealAmount != null ? formatCny(customer.dealAmount) : c.empty;
  const signedLabel = customer.contractSignedAt
    ? formatDateOnly(customer.contractSignedAt)
    : c.empty;
  const followUp = formatNextFollowUp(customer.nextFollowUpAt);

  return (
    <div className="grid grid-cols-2 gap-2 rounded-lg border border-workbench-line bg-workbench-surface p-2">
      <Cell
        icon={TrendingUp}
        tone="emerald"
        label={c.stage}
        value={stageBadge?.label ?? c.empty}
        renderValue={
          stageBadge
            ? () => (
                <span
                  className={cn(
                    "inline-flex max-w-full items-center truncate rounded-full px-2 py-0.5 text-[11.5px] font-medium ring-1",
                    STAGE_BADGE_CLASS[stageBadge.tone],
                  )}
                >
                  {stageBadge.label}
                </span>
              )
            : undefined
        }
      />
      <Cell icon={Wallet} tone="violet" label={c.dealAmount} value={dealAmountLabel} />
      <Cell icon={CalendarCheck} tone="blue" label={c.contractSignedAt} value={signedLabel} />
      <Cell
        icon={Clock}
        tone={followUp?.tone === "overdue" || followUp?.tone === "today" ? "rose" : "amber"}
        label={c.nextFollowUp}
        value={followUp?.label ?? c.empty}
        valueClassName={followUp ? FOLLOW_UP_VALUE_CLASS[followUp.tone] : undefined}
        badge={followUp?.tone === "overdue" ? c.overdueBadge : undefined}
      />
    </div>
  );
}

function Cell({
  icon: Icon,
  tone,
  label,
  value,
  valueClassName,
  badge,
  renderValue,
}: {
  icon: ComponentType<LucideProps>;
  tone: Tone;
  label: string;
  value: string;
  valueClassName?: string;
  badge?: string;
  renderValue?: () => React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-md p-1.5">
      <span className={cn("grid size-9 shrink-0 place-items-center rounded-full", TONE_BG[tone])}>
        <Icon size={16} strokeWidth={1.8} className={TONE_FG[tone]} />
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[11px] text-workbench-text-muted">{label}</span>
        <div className="flex min-w-0 items-center gap-1">
          {renderValue ? (
            renderValue()
          ) : (
            <span
              className={cn(
                "truncate text-[13px] font-semibold text-workbench-text",
                valueClassName,
              )}
            >
              {value}
            </span>
          )}
          {badge && (
            <span className="shrink-0 rounded bg-rose-50 px-1 py-px text-[10px] font-medium text-rose-600">
              {badge}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function formatCny(amount: number): string {
  return `¥${amount.toLocaleString("zh-CN")}`;
}

function formatDateOnly(value: string): string {
  const d = parseDate(value);
  if (!d) return value;
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return `${d.getFullYear()}-${m < 10 ? `0${m}` : m}-${day < 10 ? `0${day}` : day}`;
}
