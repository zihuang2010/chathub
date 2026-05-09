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

import { formatNumber, formatRelative, getCityLabel, getStatusMeta } from "./utils";

interface AccountListRowProps {
  account: Account;
  onOpen: (id: string) => void;
}

const STATUS_ICONS: Record<ReturnType<typeof getStatusMeta>["pillIconName"], LucideIcon> = {
  CheckCircle2,
  AlertTriangle,
  MinusCircle,
};

/**
 * List 视图的紧凑行：一行装下所有关键信息，整行可点跳客户页。
 */
export const AccountListRow = memo(function AccountListRow({
  account,
  onOpen,
}: AccountListRowProps) {
  const status = getStatusMeta(account.status);
  const StatusIcon = STATUS_ICONS[status.pillIconName];

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
        "focus-ring group grid cursor-pointer items-center gap-4 border-b border-workbench-line/60 bg-workbench-surface px-4 py-3 transition-colors hover:bg-workbench-surface-subtle/50",
        "grid-cols-[auto_minmax(180px,2fr)_minmax(80px,1fr)_minmax(160px,2fr)_repeat(2,minmax(80px,1fr))_minmax(110px,1fr)_minmax(80px,auto)_auto]",
      )}
    >
      {/* 城市头像 */}
      <div
        className="grid size-9 shrink-0 place-items-center rounded-md text-[12px] font-semibold text-workbench-text"
        style={{ background: `hsl(var(--wb-avatar-${account.colorToken}))` }}
        aria-hidden
      >
        {getCityLabel(account)}
      </div>

      {/* 名称 + verified */}
      <div className="flex min-w-0 items-center gap-1">
        <span className="truncate text-[13px] font-medium text-workbench-text">{account.name}</span>
        {account.verified && (
          <BadgeCheck
            size={13}
            className="shrink-0 fill-workbench-accent text-white dark:text-workbench-surface"
            aria-label="已认证"
          />
        )}
      </div>

      {/* 负责人 */}
      <span className="truncate text-[12px] text-workbench-text-secondary">
        {account.ownerName ?? "—"}
      </span>

      {/* 企业 */}
      <span className="truncate text-[12px] text-workbench-text-secondary">
        {account.enterprise ?? "—"}
      </span>

      {/* 客户数 / 会话数 */}
      <NumCell value={account.customerCount} />
      <NumCell value={account.sessionCount} />

      {/* 最后登录 */}
      <span className="text-right text-[12px] text-workbench-text-muted">
        {formatRelative(account.lastActiveAt)}
      </span>

      {/* 状态 pill */}
      <span
        className={cn(
          "inline-flex shrink-0 items-center justify-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
          status.pillBgClass,
          status.pillTextClass,
        )}
      >
        <StatusIcon size={11} strokeWidth={2.5} />
        {status.pillLabel}
      </span>

      {/* 更多 */}
      <button
        type="button"
        aria-label="更多操作"
        onClick={(e) => e.stopPropagation()}
        className="focus-ring grid size-7 place-items-center rounded text-workbench-text-muted opacity-0 transition-opacity hover:bg-workbench-surface-active hover:text-workbench-text focus-visible:opacity-100 group-hover:opacity-100"
      >
        <MoreHorizontal size={14} />
      </button>
    </div>
  );
});

function NumCell({ value }: { value: number | undefined }) {
  return (
    <span className="wb-num text-right text-[13px] font-medium tabular-nums text-workbench-text">
      {formatNumber(value ?? 0)}
    </span>
  );
}
