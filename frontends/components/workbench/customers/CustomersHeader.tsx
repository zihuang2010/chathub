import { memo, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown, ListChecks, Search, Tag, X } from "lucide-react";

import type { Account } from "@/lib/types/account";
import { cn } from "@/lib/utils";

import { AccountPicker } from "./AccountPicker";
import { SORT_OPTIONS, TAB_OPTIONS, type CustomerTab, type SortKey } from "./constants";
import { STRINGS } from "./strings";

interface CustomersHeaderProps {
  activeTab: CustomerTab;
  onTabChange: (tab: CustomerTab) => void;
  tabCounts: Record<CustomerTab, number>;
  sortKey: SortKey;
  onSortChange: (key: SortKey) => void;
  searchTerm: string;
  onSearchChange: (term: string) => void;

  accounts: readonly Account[];
  selectedAccountIds: ReadonlySet<string>;
  accountCounts: Record<string, number>;
  onToggleAccount: (id: string) => void;
  onClearAccounts: () => void;

  // 标签筛选 + 批量入口（合并自原 CustomerListToolbar）
  knownTags: readonly string[];
  tagFilters: readonly string[];
  onToggleTag: (tag: string) => void;
  onClearTags: () => void;
  isMultiSelectActive: boolean;
  onToggleBulk: () => void;
}

export const CustomersHeader = memo(function CustomersHeader({
  activeTab,
  onTabChange,
  tabCounts,
  sortKey,
  onSortChange,
  searchTerm,
  onSearchChange,
  accounts,
  selectedAccountIds,
  accountCounts,
  onToggleAccount,
  onClearAccounts,
  knownTags,
  tagFilters,
  onToggleTag,
  onClearTags,
  isMultiSelectActive,
  onToggleBulk,
}: CustomersHeaderProps) {
  return (
    <header className="flex flex-col border-b border-workbench-line bg-workbench-surface">
      <div className="flex items-center gap-2 px-4 py-3">
        <AccountPicker
          accounts={accounts}
          selectedIds={selectedAccountIds}
          accountCounts={accountCounts}
          needsFollowUpInScope={tabCounts["needs-followup"]}
          onToggle={onToggleAccount}
          onClearAll={onClearAccounts}
          recentIds={accounts.slice(0, 3).map((a) => a.id)}
        />
        <SearchInput value={searchTerm} onChange={onSearchChange} />
        <TagFilterButton
          knownTags={knownTags}
          tagFilters={tagFilters}
          onToggle={onToggleTag}
          onClear={onClearTags}
        />
        <BulkToggleButton active={isMultiSelectActive} onClick={onToggleBulk} />
        <SortButton sortKey={sortKey} onChange={onSortChange} />
      </div>
      <nav role="tablist" aria-label="客户视图" className="flex min-w-0 gap-2 overflow-x-auto px-4">
        {TAB_OPTIONS.map((tab) => {
          const active = tab.value === activeTab;
          const count = tabCounts[tab.value] ?? 0;
          return (
            <button
              key={tab.value}
              role="tab"
              type="button"
              aria-selected={active}
              onClick={() => onTabChange(tab.value)}
              className={cn(
                "focus-ring relative flex h-10 shrink-0 items-center gap-1.5 px-1 text-[13px] transition-colors",
                active
                  ? "font-semibold text-workbench-text"
                  : "text-workbench-text-secondary hover:text-workbench-text",
              )}
            >
              <span>{tab.label}</span>
              <span
                className={cn(
                  "font-numeric text-[12px] tabular-nums",
                  active ? "text-workbench-accent" : "text-workbench-text-muted",
                )}
              >
                {count}
              </span>
              {active && (
                <span
                  aria-hidden
                  className="absolute inset-x-0 bottom-0 h-[2px] rounded-md bg-workbench-accent"
                />
              )}
            </button>
          );
        })}
      </nav>
    </header>
  );
});

function SearchInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const hasValue = value.length > 0;
  return (
    <div className="relative w-[280px] min-w-[160px] shrink">
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

function HeaderIconButton({
  active,
  badge,
  ariaLabel,
  title,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
  badge?: number;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      title={title ?? ariaLabel}
      {...rest}
      className={cn(
        "focus-ring relative grid size-9 place-items-center rounded-md border transition-colors",
        active
          ? "border-workbench-accent bg-workbench-surface-active text-workbench-accent"
          : "border-workbench-line bg-workbench-surface text-workbench-text-secondary hover:border-workbench-line-strong hover:text-workbench-text",
      )}
    >
      {children}
      {typeof badge === "number" && badge > 0 && (
        <span
          aria-hidden
          className="absolute -right-0.5 -top-0.5 grid h-4 min-w-[16px] place-items-center rounded-md bg-workbench-accent px-1 font-numeric text-[10px] font-medium tabular-nums text-workbench-surface"
        >
          {badge}
        </span>
      )}
    </button>
  );
}

function TagFilterButton({
  knownTags,
  tagFilters,
  onToggle,
  onClear,
}: {
  knownTags: readonly string[];
  tagFilters: readonly string[];
  onToggle: (tag: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <HeaderIconButton
          active={open || tagFilters.length > 0}
          badge={tagFilters.length}
          ariaLabel={STRINGS.toolbar.tagFilter}
        >
          <Tag size={14} />
        </HeaderIconButton>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="z-20 w-[240px] rounded-lg border border-workbench-line bg-workbench-surface p-2 shadow-wb-popover-strong outline-none"
        >
          <div className="flex items-center justify-between px-1 pb-1">
            <span className="text-[11px] font-medium uppercase tracking-wider text-workbench-text-muted">
              {STRINGS.toolbar.tagFilter}
            </span>
            {tagFilters.length > 0 && (
              <button
                type="button"
                onClick={onClear}
                className="text-wb-3xs text-workbench-accent hover:underline"
              >
                清空
              </button>
            )}
          </div>
          {knownTags.length === 0 ? (
            <div className="px-2 py-3 text-center text-wb-2xs text-workbench-text-muted">
              暂无标签
            </div>
          ) : (
            <ul className="flex max-h-[280px] flex-col gap-0.5 overflow-y-auto">
              {knownTags.map((tag) => {
                const checked = tagFilters.includes(tag);
                return (
                  <li key={tag}>
                    <button
                      type="button"
                      onClick={() => onToggle(tag)}
                      className={cn(
                        "focus-ring flex h-8 w-full items-center justify-between rounded-md px-2 text-left text-[12px] transition-colors",
                        checked
                          ? "bg-workbench-surface-active text-workbench-accent"
                          : "text-workbench-text-secondary hover:bg-workbench-surface-subtle",
                      )}
                    >
                      <span className="truncate">{tag}</span>
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

function BulkToggleButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <HeaderIconButton
      active={active}
      ariaLabel={active ? STRINGS.toolbar.exitBulk : STRINGS.toolbar.enterBulk}
      onClick={onClick}
    >
      <ListChecks size={14} />
    </HeaderIconButton>
  );
}

function SortButton({ sortKey, onChange }: { sortKey: SortKey; onChange: (k: SortKey) => void }) {
  const [open, setOpen] = useState(false);
  const current = SORT_OPTIONS.find((o) => o.value === sortKey)?.label ?? STRINGS.toolbar.sortLabel;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="focus-ring ml-auto inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-workbench-line bg-workbench-surface px-3 text-[13px] text-workbench-text transition-colors hover:border-workbench-line-strong"
        >
          <span>{current}</span>
          <ChevronDown size={14} className="text-workbench-text-muted" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="z-20 min-w-[160px] rounded-lg border border-workbench-line bg-workbench-surface p-1.5 shadow-wb-popover-strong outline-none"
        >
          <div className="px-1.5 pb-1 text-wb-3xs font-medium uppercase tracking-wider text-workbench-text-muted">
            {STRINGS.toolbar.sortMenuTitle}
          </div>
          {SORT_OPTIONS.map((opt) => {
            const active = opt.value === sortKey;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                className={cn(
                  "focus-ring flex h-8 w-full items-center justify-between gap-2 rounded-md px-2 text-left text-[12px] transition-colors",
                  active
                    ? "bg-workbench-surface-active text-workbench-accent"
                    : "text-workbench-text-secondary hover:bg-workbench-surface-subtle",
                )}
              >
                <span>{opt.label}</span>
                {active && <Check size={12} />}
              </button>
            );
          })}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
