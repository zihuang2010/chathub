import { memo } from "react";
import { Star } from "lucide-react";

import type { Customer } from "@/lib/types/customer";
import { cn } from "@/lib/utils";

import { ROW_MAX_TAGS } from "./constants";
import { STRINGS } from "./strings";
import { formatNextFollowUp, formatRelativeTime, type FollowUpTone } from "./utils";

const FOLLOW_UP_TONE_CLASS: Record<FollowUpTone, string> = {
  overdue: "text-workbench-danger font-medium",
  today: "text-workbench-danger font-medium",
  tomorrow: "text-workbench-warning font-medium",
  soon: "text-workbench-text-secondary",
  later: "text-workbench-text-muted",
};

interface CustomerListRowProps {
  customer: Customer;
  selected: boolean;
  multiSelectActive: boolean;
  multiSelected: boolean;
  showFollowUpReason: boolean;
  /** 头像配色 token，决定头像底色。 */
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
  const visibleTags = customer.tags.slice(0, ROW_MAX_TAGS);
  const overflow = customer.tags.length - visibleTags.length;
  const followUp = formatNextFollowUp(customer.nextFollowUpAt);
  const lastTimeLabel = formatRelativeTime(customer.lastContactAt ?? customer.addedAt);
  const timeLabel = followUp?.label ?? lastTimeLabel;
  const timeClass = followUp ? FOLLOW_UP_TONE_CLASS[followUp.tone] : "text-workbench-text-muted";
  const timeAriaLabel = followUp ? `下次跟进 ${followUp.label}` : `最近联系 ${lastTimeLabel}`;
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
      className={cn(
        "group relative grid h-[60px] cursor-pointer grid-cols-[28px_36px_minmax(0,1fr)_auto] items-center gap-3 px-4 transition-colors",
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
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-semibold text-workbench-text">
            {customer.name}
          </span>
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

      <div className="flex shrink-0 items-center gap-3">
        <div className="hidden min-w-[88px] items-center justify-end gap-1 sm:flex">
          {visibleTags.map((tag) => (
            <span
              key={tag}
              className="rounded-full border border-workbench-line bg-workbench-surface-subtle px-2 py-0.5 text-wb-3xs text-workbench-text-secondary"
            >
              {tag}
            </span>
          ))}
          {overflow > 0 && (
            <span className="text-wb-3xs text-workbench-text-muted">
              {STRINGS.list.overflowTagsLabel(overflow)}
            </span>
          )}
        </div>
        <span
          aria-label={timeAriaLabel}
          className={cn("min-w-[56px] text-right font-numeric text-wb-3xs tabular-nums", timeClass)}
        >
          {timeLabel}
        </span>
      </div>
    </div>
  );
});

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
