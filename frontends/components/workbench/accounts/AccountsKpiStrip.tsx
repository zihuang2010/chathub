import { memo } from "react";
import {
  IdCard,
  MessageSquareText,
  Users,
  UserCheck,
  MessagesSquare,
  TrendingUp,
  TrendingDown,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";

import { KPI_CONFIG } from "./constants";
import { type AccountsKpis, getKpiSubValue, getKpiValue } from "./useAccountsView";

interface AccountsKpiStripProps {
  kpis: AccountsKpis;
}

const ICONS: Record<(typeof KPI_CONFIG)[number]["iconName"], LucideIcon> = {
  IdCard,
  MessageSquareText,
  Users,
  UserCheck,
  MessagesSquare,
};

export const AccountsKpiStrip = memo(function AccountsKpiStrip({ kpis }: AccountsKpiStripProps) {
  return (
    // 5 卡片始终一行,不随窗口宽度换行(用户需求)。卡片内部都有 min-w-0 + truncate
    // 兜底,窄屏下数字会按 tabular-nums 等比例收缩,文字 truncate。
    <div className="grid grid-cols-5 gap-3 px-4 py-4">
      {KPI_CONFIG.map((cfg) => {
        const Icon = ICONS[cfg.iconName];
        const value = getKpiValue(kpis, cfg.key);
        const sub = getKpiSubValue(kpis, cfg.key);
        return (
          <KpiCard
            key={cfg.key}
            Icon={Icon}
            label={cfg.label}
            value={value}
            iconBgClass={cfg.iconBgClass}
            iconColorClass={cfg.iconColorClass}
            subLabel={cfg.subLabel}
            subValue={sub}
            deltaDirection={cfg.delta.direction}
            deltaPercent={cfg.delta.percent}
          />
        );
      })}
    </div>
  );
});

interface KpiCardProps {
  Icon: LucideIcon;
  label: string;
  value: string;
  iconBgClass: string;
  iconColorClass: string;
  subLabel: string;
  subValue: string;
  deltaDirection: "up" | "down";
  deltaPercent: number;
}

function KpiCard({
  Icon,
  label,
  value,
  iconBgClass,
  iconColorClass,
  subLabel,
  subValue,
  deltaDirection,
  deltaPercent,
}: KpiCardProps) {
  const DeltaIcon = deltaDirection === "up" ? TrendingUp : TrendingDown;
  const deltaColor =
    deltaDirection === "up"
      ? "text-emerald-500 dark:text-emerald-400"
      : "text-rose-500 dark:text-rose-400";

  return (
    <div className="flex items-start gap-3 rounded-lg border border-workbench-line bg-workbench-surface p-4 shadow-wb-card-soft">
      <span
        aria-hidden
        className={cn(
          "grid size-10 shrink-0 place-items-center rounded-lg",
          iconBgClass,
          iconColorClass,
        )}
      >
        <Icon size={18} strokeWidth={2} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[12px] leading-tight text-workbench-text-muted">{label}</div>
        <div className="wb-num mt-1 text-[24px] font-semibold tabular-nums leading-none text-workbench-text">
          {value}
        </div>
        <div className="mt-2 flex flex-col gap-0.5 text-[11px]">
          <div className="flex items-center gap-1.5 text-workbench-text-muted">
            <span>{subLabel}</span>
            <span className={cn("wb-num tabular-nums", iconColorClass)}>{subValue}</span>
          </div>
          <div className="flex items-center gap-1 text-workbench-text-muted">
            <span>较昨日</span>
            <DeltaIcon size={11} className={deltaColor} strokeWidth={2.5} />
            <span className={cn("wb-num tabular-nums", deltaColor)}>
              {deltaPercent.toFixed(1)}%
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
