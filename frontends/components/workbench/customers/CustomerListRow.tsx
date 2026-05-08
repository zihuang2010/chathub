import { memo } from "react";
import { Star } from "lucide-react";

import type { Customer } from "@/lib/types/customer";
import { cn } from "@/lib/utils";

import { ROW_GRID_TEMPLATE } from "./constants";
import { STAGE_BADGE_CLASS, resolveStageBadge } from "./stageBadge";
import { STRINGS } from "./strings";
import { formatNextFollowUp, formatRelativeTime, type FollowUpTone } from "./utils";

const FOLLOW_UP_TONE_CLASS: Record<FollowUpTone, string> = {
  overdue: "text-workbench-danger font-semibold",
  today: "text-workbench-danger font-semibold",
  tomorrow: "text-workbench-warning font-semibold",
  soon: "text-workbench-text font-medium",
  later: "text-workbench-text-secondary font-medium",
};

interface CustomerListRowProps {
  customer: Customer;
  selected: boolean;
  multiSelectActive: boolean;
  multiSelected: boolean;
  showFollowUpReason: boolean;
  /** 客户头像配色 token，决定头像底色。 */
  avatarColorToken?: number;
  onSelect: (id: string) => void;
  onToggleStar: (id: string) => void;
  onToggleMultiSelect: (id: string) => void;
}

export const CustomerListRow = memo(function CustomerListRow({
  customer,
  selected,
  multiSelectActive,
  multiSelected,
  showFollowUpReason,
  avatarColorToken,
  onSelect,
  onToggleStar,
  onToggleMultiSelect,
}: CustomerListRowProps) {
  const followUp = formatNextFollowUp(customer.nextFollowUpAt);
  const stageBadge = resolveStageBadge(customer);
  const meta = [customer.company, customer.follower && `跟进人 ${customer.follower}`]
    .filter(Boolean)
    .join(" · ");

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
      style={{ gridTemplateColumns: ROW_GRID_TEMPLATE }}
      className={cn(
        "group relative grid h-[60px] cursor-pointer items-center gap-3 px-4 transition-colors",
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

      {multiSelectActive ? (
        <Checkbox
          checked={multiSelected}
          onChange={() => onToggleMultiSelect(customer.id)}
          aria-label={`选择 ${customer.name}`}
        />
      ) : (
        <StarToggle
          starred={Boolean(customer.starred)}
          onClick={(e) => {
            e.stopPropagation();
            onToggleStar(customer.id);
          }}
        />
      )}

      <Avatar name={customer.name} colorToken={avatarColorToken} />

      <div className="min-w-0">
        <div className="truncate text-[13px] font-semibold text-workbench-text">
          {customer.name}
        </div>
        <div className="flex items-center gap-1 truncate text-[11px] text-workbench-text-secondary">
          <span className="truncate">{meta}</span>
          {showFollowUpReason && customer.followUpReason && (
            <span className="ml-1 inline-flex items-center gap-1 whitespace-nowrap text-workbench-danger">
              <span aria-hidden className="size-1.5 rounded-full bg-workbench-danger" />
              {customer.followUpReason}
            </span>
          )}
        </div>
      </div>

      <div className="min-w-0">
        {stageBadge && (
          <span
            className={cn(
              "inline-flex max-w-full items-center truncate rounded-full px-2 py-0.5 text-[11.5px] font-medium ring-1",
              STAGE_BADGE_CLASS[stageBadge.tone],
            )}
          >
            {stageBadge.label}
          </span>
        )}
      </div>

      <FollowUpCell followUp={followUp} fallbackTime={customer.lastContactAt ?? customer.addedAt} />
    </div>
  );
});

function FollowUpCell({
  followUp,
  fallbackTime,
}: {
  followUp: { label: string; tone: FollowUpTone } | null;
  fallbackTime: string | null | undefined;
}) {
  // 双行版式：上行小灰字标签（下次跟进 / 最近联系），下行带 tone 着色的值。
  // 以前只渲染单行的值，但 92px 宽的列原本就是为双行设计的（见 constants），
  // 而且没有标签时"超期 4 天"和"3 天前"难以区分语义，导致用户要么记规则要么误读。
  if (followUp) {
    const caption = STRINGS.list.columnNextFollowUp;
    return (
      <div
        aria-label={`${caption} ${followUp.label}`}
        className="flex flex-col items-end gap-2.5 text-right leading-tight"
      >
        <span className="text-[10.5px] text-workbench-text-muted">{caption}</span>
        <span
          className={cn(
            "wb-num truncate text-[10.5px] tabular-nums",
            FOLLOW_UP_TONE_CLASS[followUp.tone],
          )}
        >
          {followUp.label}
        </span>
      </div>
    );
  }
  const lastTimeLabel = formatRelativeTime(fallbackTime);
  const caption = STRINGS.list.columnLastContact;
  return (
    <div
      aria-label={`${caption} ${lastTimeLabel}`}
      className="flex flex-col items-end gap-2.5 text-right leading-tight"
    >
      <span className="text-[10.5px] text-workbench-text-muted">{caption}</span>
      <span className="wb-num truncate text-[10.5px] font-medium tabular-nums text-workbench-text-secondary">
        {lastTimeLabel}
      </span>
    </div>
  );
}

function StarToggle({
  starred,
  onClick,
}: {
  starred: boolean;
  onClick: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      aria-label={starred ? "取消关注" : "关注"}
      onClick={onClick}
      className={cn(
        "focus-ring grid size-7 place-items-center rounded-md transition-all",
        starred
          ? "text-workbench-warning hover:bg-workbench-surface-subtle"
          : cn(
              "text-workbench-text-muted hover:bg-workbench-surface-subtle hover:text-workbench-warning",
              "opacity-0 focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100",
            ),
      )}
    >
      <Star size={15} fill={starred ? "currentColor" : "none"} strokeWidth={1.6} />
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
        "focus-ring grid size-5 place-items-center rounded-[5px] border transition-colors",
        checked
          ? "border-workbench-accent bg-workbench-accent text-workbench-surface"
          : "border-workbench-line bg-workbench-surface text-transparent hover:border-workbench-line-strong",
      )}
      {...props}
    >
      <svg viewBox="0 0 12 12" className="size-3" aria-hidden>
        <path
          d="M2.5 6.2 5 8.6 9.6 3.4"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

function Avatar({ name, colorToken }: { name: string; colorToken?: number }) {
  const bg = colorToken ? `hsl(var(--wb-avatar-${colorToken}))` : "hsl(var(--wb-surface-active))";
  return (
    <div
      className="grid size-9 place-items-center rounded-full text-[13px] font-medium text-workbench-text"
      style={{ background: bg }}
    >
      {name.slice(0, 1)}
    </div>
  );
}
