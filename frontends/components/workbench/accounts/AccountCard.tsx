import { memo, type KeyboardEvent } from "react";
import {
  AlertTriangle,
  BadgeCheck,
  CheckCircle2,
  MinusCircle,
  MoreHorizontal,
  type LucideIcon,
} from "lucide-react";

import type { Account } from "@/lib/types/account";
import { cn } from "@/lib/utils";

import { AccountTrendChart } from "./AccountTrendChart";
import { formatNumber, getStatusMeta } from "./utils";

interface AccountCardProps {
  account: Account;
  onOpen: (id: string) => void;
}

const STATUS_ICONS: Record<ReturnType<typeof getStatusMeta>["pillIconName"], LucideIcon> = {
  CheckCircle2,
  AlertTriangle,
  MinusCircle,
};

export const AccountCard = memo(function AccountCard({ account, onOpen }: AccountCardProps) {
  const status = getStatusMeta(account.status);
  const StatusIcon = STATUS_ICONS[status.pillIconName];

  // 趋势图配色：状态决定。在线/未登录用 accent，异常用 amber。
  const trendColorClass =
    account.status === "abnormal" ? "text-amber-500 dark:text-amber-400" : "text-workbench-accent";

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen(account.id);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(account.id)}
      onKeyDown={handleKeyDown}
      aria-label={`查看 ${account.name} 的客户`}
      className={cn(
        "focus-ring group relative flex flex-col rounded-lg border border-workbench-line bg-workbench-surface p-3.5 text-left",
        "cursor-pointer transition-colors hover:border-workbench-line-strong hover:bg-workbench-surface-subtle/40",
      )}
    >
      {/* 顶部：城市头像 + 名称信息 + 状态 pill */}
      <header className="flex items-start gap-3">
        <CityAvatar account={account} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            <span className="truncate text-[14px] font-semibold leading-tight text-workbench-text">
              {account.name}
            </span>
            {account.verified && (
              <BadgeCheck
                size={14}
                className="shrink-0 fill-workbench-accent text-white dark:text-workbench-surface"
                aria-label="已认证"
              />
            )}
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-[12px] leading-tight text-workbench-text-secondary">
            <span className="min-w-0 truncate">别名：{account.wecomAlias || "—"}</span>
            <span className="shrink-0 text-workbench-line-strong">·</span>
            <span className="shrink-0">岗位：{account.position || "员工"}</span>
          </div>
        </div>
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
            status.pillBgClass,
            status.pillTextClass,
          )}
        >
          <StatusIcon size={12} strokeWidth={2.5} />
          {status.pillLabel}
        </span>
      </header>

      {/* 顶部点缀：迷你趋势 sparkline（无坐标轴，全宽细条） */}
      <AccountTrendChart values={account.trend7d ?? []} className={cn("mt-3", trendColorClass)} />

      {/* KPI：客户数 / 会话数 横排放大，作为卡片视觉重点 */}
      <div className="mt-2.5 grid grid-cols-2 gap-3">
        <Kpi label="客户数" value={formatNumber(account.customerCount ?? 0)} />
        <Kpi label="会话数" value={formatNumber(account.sessionCount ?? 0)} />
      </div>

      {/* 底部：更新时间 + ⋯ overflow */}
      <div className="mt-3 flex items-center justify-between gap-2 border-t border-workbench-line/60 pt-2.5 text-[11px] text-workbench-text-muted">
        <span className="truncate">
          更新时间：<span className="wb-num tabular-nums">{account.createdAt ?? "—"}</span>
        </span>
        <button
          type="button"
          aria-label="更多操作"
          onClick={(e) => e.stopPropagation()}
          className="focus-ring grid size-6 shrink-0 place-items-center rounded text-workbench-text-muted opacity-0 transition-opacity hover:bg-workbench-surface-active hover:text-workbench-text focus-visible:opacity-100 group-hover:opacity-100"
        >
          <MoreHorizontal size={14} />
        </button>
      </div>
    </div>
  );
});

function CityAvatar({ account }: { account: Account }) {
  // 头像展示账号名称的第一个字符（如"任亚奇"→"任"）。
  const label = Array.from(account.name)[0] ?? "";
  return (
    <div
      className="grid size-10 shrink-0 place-items-center rounded-xl text-[13px] font-semibold text-workbench-text"
      style={{ background: `hsl(var(--wb-avatar-${account.colorToken}))` }}
      aria-hidden
    >
      {label}
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="wb-num truncate text-[19px] font-semibold tabular-nums leading-none text-workbench-text">
        {value}
      </div>
      <div className="mt-1 text-[11px] leading-none text-workbench-text-muted">{label}</div>
    </div>
  );
}
