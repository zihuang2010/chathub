import { memo } from "react";
import { Mars, MessageCircle, MoreHorizontal, Pencil, Venus } from "lucide-react";

import type { Account } from "@/lib/types/account";
import type { Customer } from "@/lib/types/customer";
import { cn } from "@/lib/utils";

import { CustomerAvatar } from "./CustomerAvatar";
import { ROW_GRID_TEMPLATE, ROW_HEIGHT, ROW_MAX_TAGS } from "./constants";
import { STRINGS } from "./strings";
import { tagColorClass } from "./tagColor";
import { parseDate } from "./utils";

interface CustomerListRowProps {
  customer: Customer;
  account: Account | undefined;
  selected: boolean;
  multiSelectActive: boolean;
  multiSelected: boolean;
  /** 客户头像配色 token，决定头像底色（fallback 来自 accountColor）。 */
  avatarColorToken?: number;
  onSelect: (id: string) => void;
  onToggleMultiSelect: (id: string) => void;
  onOpenChat: (id: string) => void;
  onEditCustomer: (id: string) => void;
  onMore: (id: string) => void;
}

/**
 * 客户列表的 7 列行（v6 修订：去掉 客户阶段 + 跟进状态，标签后增加 来源）：
 *   ☐  客户名称(avatar+name+性别+phone)  所属账号(company+owner)
 *   彩色标签 chips(+N)  来源 chip  最近跟进(date+follower)  操作图标
 */
export const CustomerListRow = memo(function CustomerListRow({
  customer,
  account,
  selected,
  multiSelectActive,
  multiSelected,
  avatarColorToken,
  onSelect,
  onToggleMultiSelect,
  onOpenChat,
  onEditCustomer,
  onMore,
}: CustomerListRowProps) {
  const visibleTags = customer.tags.slice(0, ROW_MAX_TAGS);
  const overflowTags = customer.tags.length - visibleTags.length;
  const lastContactDate = formatLastContact(customer.lastContactAt ?? null);

  return (
    <div
      role="button"
      tabIndex={0}
      aria-selected={selected}
      onClick={() => onSelect(customer.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(customer.id);
        }
      }}
      style={{ gridTemplateColumns: ROW_GRID_TEMPLATE, height: ROW_HEIGHT }}
      className={cn(
        "group relative grid cursor-pointer items-center gap-2 px-3 transition-colors",
        "hover:bg-workbench-surface-subtle focus-visible:bg-workbench-surface-subtle focus-visible:outline-none",
        selected && !multiSelectActive && "bg-workbench-surface-active",
        multiSelected && "bg-workbench-surface-active/70",
      )}
    >
      {selected && !multiSelectActive && (
        <span
          aria-hidden
          className="absolute inset-y-2 left-0 w-[2px] rounded-full bg-workbench-accent"
        />
      )}

      {/* col 1: checkbox */}
      <Checkbox
        checked={multiSelected}
        onChange={() => onToggleMultiSelect(customer.id)}
        aria-label={`选择 ${customer.name}`}
      />

      {/* col 2: 客户名称 */}
      <div className="flex min-w-0 items-center gap-2">
        <CustomerAvatar
          customerId={customer.id}
          name={customer.name}
          colorToken={avatarColorToken}
          size={28}
          online={account?.status === "online"}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1 truncate">
            <span className="truncate text-[13px] font-semibold text-workbench-text">
              {customer.name}
            </span>
            <GenderIcon gender={customer.gender} />
          </div>
          {customer.phone && (
            <div className="wb-num truncate text-[11px] tabular-nums text-workbench-text-muted">
              {customer.phone}
            </div>
          )}
        </div>
      </div>

      {/* col 3: 所属账号 — online 状态由 avatar 右下角点承担，此 cell 不再画点 */}
      <div className="min-w-0">
        {customer.company && (
          <div className="truncate text-[13px] text-workbench-text">{customer.company}</div>
        )}
        {account?.ownerName && (
          <div className="truncate text-[11px] text-workbench-text-muted">{account.ownerName}</div>
        )}
      </div>

      {/* col 4: 彩色标签 */}
      <div className="flex min-w-0 flex-wrap items-center gap-1 overflow-hidden">
        {visibleTags.map((tag) => (
          <span
            key={tag}
            className={cn(
              "inline-flex max-w-full items-center truncate whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium",
              tagColorClass(tag),
            )}
          >
            {tag}
          </span>
        ))}
        {overflowTags > 0 && (
          <span className="inline-flex shrink-0 items-center whitespace-nowrap rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500 ring-1 ring-inset ring-slate-200/60">
            {STRINGS.list.overflowTagsLabel(overflowTags)}
          </span>
        )}
      </div>

      {/* col 5: 来源 — 空字段不渲染（保留 grid cell 占位） */}
      <div className="min-w-0">
        {customer.source && (
          <span className="inline-flex max-w-full items-center truncate whitespace-nowrap rounded bg-slate-50 px-1.5 py-0.5 text-[11px] text-slate-600 ring-1 ring-inset ring-slate-200/70">
            {customer.source}
          </span>
        )}
      </div>

      {/* col 6: 最近跟进 — 空字段不渲染（保留 grid cell 占位） */}
      <div className="min-w-0">
        {lastContactDate && (
          <div className="wb-num truncate text-[12px] tabular-nums text-workbench-text">
            {lastContactDate}
          </div>
        )}
        {customer.follower && (
          <div className="truncate text-[11px] text-workbench-text-muted">{customer.follower}</div>
        )}
      </div>

      {/* col 7: 操作 — pr-1.5 与列头同步，避免 header 与 icons 6px 错位 */}
      <div className="flex items-center justify-end gap-0.5 pr-1.5">
        <RowIconButton
          ariaLabel={STRINGS.rowMore.chat}
          onClick={(e) => {
            e.stopPropagation();
            onOpenChat(customer.id);
          }}
        >
          <MessageCircle size={14} />
        </RowIconButton>
        <RowIconButton
          ariaLabel={STRINGS.rowMore.edit}
          onClick={(e) => {
            e.stopPropagation();
            onEditCustomer(customer.id);
          }}
        >
          <Pencil size={14} />
        </RowIconButton>
        <RowIconButton
          ariaLabel={STRINGS.rowMore.more}
          onClick={(e) => {
            e.stopPropagation();
            onMore(customer.id);
          }}
        >
          <MoreHorizontal size={14} />
        </RowIconButton>
      </div>
    </div>
  );
});

function formatLastContact(value: string | null | undefined): string | null {
  const d = parseDate(value ?? null);
  if (!d) return null;
  const Y = d.getFullYear();
  const M = pad(d.getMonth() + 1);
  const D = pad(d.getDate());
  const h = pad(d.getHours());
  const m = pad(d.getMinutes());
  return `${Y}-${M}-${D} ${h}:${m}`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function GenderIcon({ gender }: { gender?: "male" | "female" }) {
  if (gender === "male") {
    return <Mars size={12} className="shrink-0 text-blue-500" aria-label="男" />;
  }
  if (gender === "female") {
    return <Venus size={12} className="shrink-0 text-pink-500" aria-label="女" />;
  }
  return null;
}

function RowIconButton({
  ariaLabel,
  onClick,
  children,
}: {
  ariaLabel: string;
  onClick: (e: React.MouseEvent) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      title={ariaLabel}
      onClick={onClick}
      className={cn(
        "focus-ring grid size-6 place-items-center rounded text-workbench-text-muted transition-colors",
        "hover:bg-workbench-surface hover:text-workbench-text",
      )}
    >
      {children}
    </button>
  );
}

function Checkbox({
  checked,
  onChange,
  ...props
}: {
  checked: boolean;
  onChange: () => void;
} & React.AriaAttributes) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={(e) => {
        e.stopPropagation();
        onChange();
      }}
      className={cn(
        "focus-ring grid size-4 place-items-center rounded-[4px] border transition-colors",
        checked
          ? "border-workbench-accent bg-workbench-accent text-workbench-surface"
          : "border-workbench-line bg-workbench-surface text-transparent hover:border-workbench-line-strong",
      )}
      {...props}
    >
      <svg viewBox="0 0 12 12" className="size-2.5" aria-hidden>
        <path
          d="M2.5 6.2 5 8.6 9.6 3.4"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
