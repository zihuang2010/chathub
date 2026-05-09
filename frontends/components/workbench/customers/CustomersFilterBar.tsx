import { memo, useState, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import {
  ArrowUpDown,
  Check,
  ChevronDown,
  Download,
  LayoutGrid,
  Plus,
  Search,
  X,
} from "lucide-react";

import type { Account } from "@/lib/types/account";
import type { CustomerStage, FollowUpStatus } from "@/lib/types/customer";
import { cn } from "@/lib/utils";

import { AccountPicker } from "./AccountPicker";
import { SORT_OPTIONS, type SortKey } from "./constants";
import { STRINGS } from "./strings";

interface CustomersFilterBarProps {
  searchTerm: string;
  onSearchChange: (term: string) => void;

  accounts: readonly Account[];
  selectedAccountIds: ReadonlySet<string>;
  accountCounts: Record<string, number>;
  onToggleAccount: (id: string) => void;
  onClearAccounts: () => void;

  stageFilter: ReadonlySet<CustomerStage>;
  onToggleStage: (stage: CustomerStage) => void;
  onClearStages: () => void;

  knownTags: readonly string[];
  tagFilters: readonly string[];
  onToggleTag: (tag: string) => void;
  onClearTags: () => void;

  followUpFilter: ReadonlySet<FollowUpStatus>;
  onToggleFollowUp: (status: FollowUpStatus) => void;
  onClearFollowUps: () => void;

  sortKey: SortKey;
  onSortChange: (key: SortKey) => void;

  hasActiveFilters: boolean;
  onReset: () => void;

  onCreateCustomer: () => void;
  onToggleView: () => void;
  onExport: () => void;
}

const STAGE_OPTIONS: { value: CustomerStage; label: string }[] = [
  { value: "lead", label: STRINGS.detail.stageLabels.lead },
  { value: "contacting", label: STRINGS.detail.stageLabels.contacting },
  { value: "intent", label: STRINGS.detail.stageLabels.intent },
  { value: "negotiating", label: STRINGS.detail.stageLabels.negotiating },
  { value: "deal-won", label: STRINGS.detail.stageLabels["deal-won"] },
  { value: "deal-lost", label: STRINGS.detail.stageLabels["deal-lost"] },
];

const FOLLOW_UP_OPTIONS: { value: FollowUpStatus; label: string }[] = [
  { value: "pending", label: STRINGS.detail.followUpStatusLabels.pending },
  { value: "in-progress", label: STRINGS.detail.followUpStatusLabels["in-progress"] },
  { value: "done", label: STRINGS.detail.followUpStatusLabels.done },
];

/**
 * 客户管理页主筛选栏。从左到右：
 *   搜索 + 全部账号 + 客户阶段 + 标签 + 跟进状态 + 更多筛选 + 重置 +
 *   新增客户 + 视图切换 + 导出
 *
 * 「更多筛选」承载排序选项（v2 把顶层 sort 下拉迁到这里）。
 */
export const CustomersFilterBar = memo(function CustomersFilterBar({
  searchTerm,
  onSearchChange,
  accounts,
  selectedAccountIds,
  accountCounts,
  onToggleAccount,
  onClearAccounts,
  stageFilter,
  onToggleStage,
  onClearStages,
  knownTags,
  tagFilters,
  onToggleTag,
  onClearTags,
  followUpFilter,
  onToggleFollowUp,
  onClearFollowUps,
  sortKey,
  onSortChange,
  hasActiveFilters,
  onReset,
  onCreateCustomer,
  onToggleView,
  onExport,
}: CustomersFilterBarProps) {
  const followUpInScope = followUpFilter.size; // 用于 AccountPicker trigger 角标占位
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-3">
      <SearchInput value={searchTerm} onChange={onSearchChange} />

      <AccountPicker
        accounts={accounts}
        selectedIds={selectedAccountIds}
        accountCounts={accountCounts}
        needsFollowUpInScope={followUpInScope}
        onToggle={onToggleAccount}
        onClearAll={onClearAccounts}
        recentIds={accounts.slice(0, 3).map((a) => a.id)}
      />

      <MultiSelectPopover<CustomerStage>
        label={STRINGS.toolbar.stageFilter}
        options={STAGE_OPTIONS}
        selected={stageFilter}
        onToggle={onToggleStage}
        onClear={onClearStages}
      />

      <MultiSelectPopover<string>
        label={STRINGS.toolbar.tagFilter}
        options={knownTags.map((t) => ({ value: t, label: t }))}
        selected={new Set(tagFilters)}
        onToggle={onToggleTag}
        onClear={onClearTags}
      />

      <MultiSelectPopover<FollowUpStatus>
        label={STRINGS.toolbar.followUpFilter}
        options={FOLLOW_UP_OPTIONS}
        selected={followUpFilter}
        onToggle={onToggleFollowUp}
        onClear={onClearFollowUps}
      />

      <MoreFiltersPopover sortKey={sortKey} onSortChange={onSortChange} />

      {hasActiveFilters && (
        <button
          type="button"
          onClick={onReset}
          className="focus-ring inline-flex h-9 items-center px-1 text-[13px] text-workbench-text-secondary transition-colors hover:text-workbench-accent hover:underline"
        >
          {STRINGS.toolbar.reset}
        </button>
      )}

      <span aria-hidden className="ml-auto" />

      <button
        type="button"
        onClick={onCreateCustomer}
        className="focus-ring inline-flex h-9 items-center gap-1 rounded-md bg-workbench-accent px-3 text-[13px] font-medium text-workbench-surface transition-colors hover:bg-workbench-accent-hover"
      >
        <Plus size={14} />
        <span>{STRINGS.toolbar.newCustomer}</span>
      </button>

      <IconActionButton ariaLabel={STRINGS.toolbar.viewToggle} onClick={onToggleView}>
        <LayoutGrid size={14} />
      </IconActionButton>

      <IconActionButton ariaLabel={STRINGS.toolbar.export} onClick={onExport}>
        <Download size={14} />
      </IconActionButton>
    </div>
  );
});

function SearchInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const hasValue = value.length > 0;
  return (
    <div className="relative w-[280px] min-w-[200px] shrink">
      <Search
        size={14}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-workbench-text-muted"
      />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={STRINGS.toolbar.searchPlaceholder}
        className={cn(
          "focus-ring h-9 w-full rounded-md border border-workbench-line bg-workbench-surface-subtle pl-8 pr-8 text-[13px] text-workbench-text placeholder:text-workbench-text-muted",
          "transition-colors hover:border-workbench-line-strong focus:border-workbench-accent focus:bg-workbench-surface",
        )}
      />
      {hasValue && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="清空搜索"
          className="focus-ring absolute right-2 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-workbench-text-muted hover:bg-workbench-surface hover:text-workbench-text"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}

interface MultiSelectOption<T> {
  value: T;
  label: string;
}

interface MultiSelectPopoverProps<T> {
  label: string;
  options: readonly MultiSelectOption<T>[];
  selected: ReadonlySet<T>;
  onToggle: (value: T) => void;
  onClear: () => void;
}

function MultiSelectPopover<T extends string>({
  label,
  options,
  selected,
  onToggle,
  onClear,
}: MultiSelectPopoverProps<T>) {
  const [open, setOpen] = useState(false);
  const count = selected.size;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={cn(
            "focus-ring inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border px-3 text-[13px] transition-colors",
            count > 0 || open
              ? "border-workbench-accent bg-workbench-surface-active text-workbench-accent"
              : "border-workbench-line bg-workbench-surface text-workbench-text hover:border-workbench-line-strong",
          )}
        >
          <span>{label}</span>
          {count > 0 && (
            <span className="grid h-4 min-w-[16px] place-items-center rounded-full bg-workbench-accent px-1 font-numeric text-[10px] font-medium tabular-nums leading-none text-workbench-surface">
              {count}
            </span>
          )}
          <ChevronDown size={14} className="text-workbench-text-muted" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="z-30 w-[220px] rounded-lg border border-workbench-line bg-workbench-surface p-2 shadow-wb-popover-strong outline-none"
        >
          <div className="flex items-center justify-between px-1 pb-1">
            <span className="text-[11px] font-medium uppercase tracking-wider text-workbench-text-muted">
              {label}
            </span>
            {count > 0 && (
              <button
                type="button"
                onClick={onClear}
                className="text-wb-3xs text-workbench-accent hover:underline"
              >
                清空
              </button>
            )}
          </div>
          {options.length === 0 ? (
            <div className="px-2 py-3 text-center text-wb-2xs text-workbench-text-muted">
              暂无选项
            </div>
          ) : (
            <ul className="flex max-h-[280px] flex-col gap-0.5 overflow-y-auto">
              {options.map((opt) => {
                const checked = selected.has(opt.value);
                return (
                  <li key={String(opt.value)}>
                    <button
                      type="button"
                      onClick={() => onToggle(opt.value)}
                      className={cn(
                        "focus-ring flex h-8 w-full items-center justify-between rounded-md px-2 text-left text-[12px] transition-colors",
                        checked
                          ? "bg-workbench-surface-active text-workbench-accent"
                          : "text-workbench-text-secondary hover:bg-workbench-surface-subtle",
                      )}
                    >
                      <span className="truncate">{opt.label}</span>
                      {checked && <Check size={12} className="shrink-0" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function MoreFiltersPopover({
  sortKey,
  onSortChange,
}: {
  sortKey: SortKey;
  onSortChange: (key: SortKey) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={cn(
            "focus-ring inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border px-3 text-[13px] transition-colors",
            open
              ? "border-workbench-accent bg-workbench-surface-active text-workbench-accent"
              : "border-workbench-line bg-workbench-surface text-workbench-text hover:border-workbench-line-strong",
          )}
        >
          <span>{STRINGS.toolbar.moreFilters}</span>
          <ChevronDown size={14} className="text-workbench-text-muted" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="z-30 w-[240px] rounded-lg border border-workbench-line bg-workbench-surface p-2 shadow-wb-popover-strong outline-none"
        >
          <div className="flex items-center gap-1 px-1 pb-1 text-[11px] font-medium uppercase tracking-wider text-workbench-text-muted">
            <ArrowUpDown size={11} />
            <span>{STRINGS.toolbar.sortMenuTitle}</span>
          </div>
          <ul className="flex flex-col gap-0.5">
            {SORT_OPTIONS.map((opt) => {
              const active = opt.value === sortKey;
              return (
                <li key={opt.value}>
                  <button
                    type="button"
                    onClick={() => {
                      onSortChange(opt.value);
                      setOpen(false);
                    }}
                    className={cn(
                      "focus-ring flex h-8 w-full items-center justify-between rounded-md px-2 text-left text-[12px] transition-colors",
                      active
                        ? "bg-workbench-surface-active text-workbench-accent"
                        : "text-workbench-text-secondary hover:bg-workbench-surface-subtle",
                    )}
                  >
                    <span>{opt.label}</span>
                    {active && <Check size={12} />}
                  </button>
                </li>
              );
            })}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function IconActionButton({
  ariaLabel,
  onClick,
  children,
}: {
  ariaLabel: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      title={ariaLabel}
      onClick={onClick}
      className={cn(
        "focus-ring grid size-9 shrink-0 place-items-center rounded-md border border-workbench-line bg-workbench-surface text-workbench-text-secondary transition-colors",
        "hover:border-workbench-line-strong hover:bg-workbench-surface-subtle hover:text-workbench-text",
      )}
    >
      {children}
    </button>
  );
}
