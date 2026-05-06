import { memo, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { ArrowUpDown, Check, ListChecks, Search, Tag, Users, X } from "lucide-react";

import type { Account } from "@/lib/types/account";
import { cn } from "@/lib/utils";

import { SORT_OPTIONS, TAB_OPTIONS, type CustomerTab, type SortKey } from "./constants";
import { STRINGS } from "./strings";

interface CustomersHeaderProps {
  activeTab: CustomerTab;
  onTabChange: (tab: CustomerTab) => void;
  tabCounts: Record<CustomerTab, number>;
  accounts: readonly Account[];
  selectedAccountIds: ReadonlySet<string>;
  accountCounts: Record<string, number>;
  onToggleAccount: (id: string) => void;
  onClearAccounts: () => void;
  knownTags: readonly string[];
  tagFilters: readonly string[];
  onToggleTag: (tag: string) => void;
  onClearTags: () => void;
  sortKey: SortKey;
  onSortChange: (key: SortKey) => void;
  searchTerm: string;
  onSearchChange: (term: string) => void;
  isMultiSelectActive: boolean;
  onToggleBulk: () => void;
}

export const CustomersHeader = memo(function CustomersHeader({
  activeTab,
  onTabChange,
  tabCounts,
  accounts,
  selectedAccountIds,
  accountCounts,
  onToggleAccount,
  onClearAccounts,
  knownTags,
  tagFilters,
  onToggleTag,
  onClearTags,
  sortKey,
  onSortChange,
  searchTerm,
  onSearchChange,
  isMultiSelectActive,
  onToggleBulk,
}: CustomersHeaderProps) {
  return (
    <header className="flex items-center gap-2 border-b border-workbench-line bg-workbench-surface px-3 py-2">
      <nav
        role="tablist"
        aria-label="客户视图"
        className="flex min-w-0 flex-1 gap-1 overflow-x-auto"
      >
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
                "focus-ring relative flex h-10 shrink-0 items-center gap-1.5 rounded-t-md px-3 text-[13px] transition-colors",
                active
                  ? "font-semibold text-workbench-text"
                  : "text-workbench-text-secondary hover:text-workbench-text",
              )}
            >
              <span>{tab.label}</span>
              <span
                className={cn(
                  "font-numeric text-wb-3xs tabular-nums",
                  active ? "text-workbench-accent" : "text-workbench-text-muted",
                )}
              >
                {count}
              </span>
              {active && (
                <span
                  aria-hidden
                  className="absolute inset-x-2 bottom-0 h-[2px] rounded-full bg-workbench-accent"
                />
              )}
            </button>
          );
        })}
      </nav>

      <div className="flex shrink-0 items-center gap-0.5 rounded-lg border border-workbench-line bg-workbench-surface-subtle/60 px-1 py-0.5">
        <AccountFilterMenu
          accounts={accounts}
          selectedIds={selectedAccountIds}
          counts={accountCounts}
          onToggle={onToggleAccount}
          onClearAll={onClearAccounts}
        />
        <TagFilterMenu
          knownTags={knownTags}
          selected={tagFilters}
          onToggle={onToggleTag}
          onClear={onClearTags}
        />
        <SortMenu sortKey={sortKey} onChange={onSortChange} />
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        <SearchPopover value={searchTerm} onChange={onSearchChange} />
        <button
          type="button"
          onClick={onToggleBulk}
          aria-pressed={isMultiSelectActive}
          aria-label={isMultiSelectActive ? STRINGS.toolbar.exitBulk : STRINGS.toolbar.enterBulk}
          title={isMultiSelectActive ? STRINGS.toolbar.exitBulk : STRINGS.toolbar.enterBulk}
          className={cn(
            "focus-ring grid size-8 place-items-center rounded-md transition-colors",
            isMultiSelectActive
              ? "bg-workbench-surface-active text-workbench-accent"
              : "text-workbench-text-secondary hover:bg-workbench-surface-subtle hover:text-workbench-text",
          )}
        >
          <ListChecks size={14} />
        </button>
      </div>
    </header>
  );
});

function AccountFilterMenu({
  accounts,
  selectedIds,
  counts,
  onToggle,
  onClearAll,
}: {
  accounts: readonly Account[];
  selectedIds: ReadonlySet<string>;
  counts: Record<string, number>;
  onToggle: (id: string) => void;
  onClearAll: () => void;
}) {
  const [open, setOpen] = useState(false);
  const hasSelection = selectedIds.size > 0;
  const label = hasSelection ? `账号 · ${selectedIds.size}` : STRINGS.accountChips.allAccounts;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={cn(
            "focus-ring inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12px] transition-colors hover:bg-workbench-surface-subtle",
            hasSelection ? "text-workbench-accent" : "text-workbench-text-secondary",
          )}
        >
          <Users size={13} />
          {label}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="z-20 w-[260px] rounded-lg border border-workbench-line bg-workbench-surface p-2 shadow-wb-popover-strong outline-none"
        >
          <div className="flex items-center justify-between px-1 pb-1.5">
            <span className="text-wb-3xs font-medium uppercase tracking-wider text-workbench-text-muted">
              {STRINGS.accountChips.label}
            </span>
            {hasSelection && (
              <button
                type="button"
                onClick={onClearAll}
                className="text-wb-3xs text-workbench-accent hover:underline"
              >
                清空
              </button>
            )}
          </div>
          {accounts.length === 0 ? (
            <div className="px-2 py-3 text-center text-wb-2xs text-workbench-text-muted">
              暂无账号
            </div>
          ) : (
            <ul className="flex max-h-[280px] flex-col gap-0.5 overflow-y-auto">
              {accounts.map((account) => {
                const checked = selectedIds.has(account.id);
                return (
                  <li key={account.id}>
                    <button
                      type="button"
                      onClick={() => onToggle(account.id)}
                      className={cn(
                        "focus-ring flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] transition-colors",
                        checked
                          ? "bg-workbench-surface-active text-workbench-accent"
                          : "text-workbench-text-secondary hover:bg-workbench-surface-subtle",
                      )}
                    >
                      <span
                        aria-hidden
                        className="size-2 shrink-0 rounded-full"
                        style={{ background: `hsl(var(--wb-avatar-${account.colorToken}))` }}
                      />
                      <span className="flex-1 truncate">{account.name}</span>
                      <span className="font-numeric text-wb-3xs tabular-nums text-workbench-text-muted">
                        {counts[account.id] ?? 0}
                      </span>
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

function TagFilterMenu({
  knownTags,
  selected,
  onToggle,
  onClear,
}: {
  knownTags: readonly string[];
  selected: readonly string[];
  onToggle: (tag: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const buttonLabel =
    selected.length === 0
      ? STRINGS.toolbar.tagFilter
      : `${STRINGS.toolbar.tagFilter} · ${selected.length}`;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={cn(
            "focus-ring inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12px] transition-colors hover:bg-workbench-surface-subtle",
            selected.length > 0 ? "text-workbench-accent" : "text-workbench-text-secondary",
          )}
        >
          <Tag size={13} />
          {buttonLabel}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="z-20 min-w-[200px] max-w-[280px] rounded-lg border border-workbench-line bg-workbench-surface p-2 shadow-wb-popover-strong outline-none"
        >
          {knownTags.length === 0 ? (
            <div className="px-2 py-3 text-center text-wb-2xs text-workbench-text-muted">
              暂无标签
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between px-1 pb-1.5">
                <span className="text-wb-3xs font-medium uppercase tracking-wider text-workbench-text-muted">
                  {STRINGS.toolbar.tagFilter}
                </span>
                {selected.length > 0 && (
                  <button
                    type="button"
                    onClick={onClear}
                    className="text-wb-3xs text-workbench-accent hover:underline"
                  >
                    清空
                  </button>
                )}
              </div>
              <ul className="flex max-h-[280px] flex-col gap-0.5 overflow-y-auto">
                {knownTags.map((tag) => {
                  const checked = selected.includes(tag);
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
            </>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function SortMenu({ sortKey, onChange }: { sortKey: SortKey; onChange: (k: SortKey) => void }) {
  const [open, setOpen] = useState(false);
  const current = SORT_OPTIONS.find((o) => o.value === sortKey)?.label ?? "";

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="focus-ring inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12px] text-workbench-text-secondary transition-colors hover:bg-workbench-surface-subtle hover:text-workbench-text"
        >
          <ArrowUpDown size={13} />
          <span>
            {STRINGS.toolbar.sortLabel} · {current}
          </span>
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

function SearchPopover({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const hasValue = value.length > 0;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="搜索"
          title="搜索"
          className={cn(
            "focus-ring relative grid size-8 place-items-center rounded-md transition-colors",
            hasValue || open
              ? "bg-workbench-surface-active text-workbench-accent"
              : "text-workbench-text-secondary hover:bg-workbench-surface-subtle hover:text-workbench-text",
          )}
        >
          <Search size={14} />
          {hasValue && !open && (
            <span
              aria-hidden
              className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-workbench-accent"
            />
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="z-20 w-[280px] rounded-lg border border-workbench-line bg-workbench-surface p-2 shadow-wb-popover-strong outline-none"
        >
          <div className="relative">
            <Search
              size={13}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-workbench-text-muted"
            />
            <input
              autoFocus
              type="search"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder={STRINGS.toolbar.searchPlaceholder}
              className={cn(
                "focus-ring h-8 w-full rounded-md border border-workbench-line bg-workbench-surface-subtle pl-7 pr-8 text-[12px] text-workbench-text placeholder:text-workbench-text-muted",
                "transition-colors hover:border-workbench-line-strong focus:bg-workbench-surface",
              )}
            />
            {hasValue && (
              <button
                type="button"
                onClick={() => onChange("")}
                aria-label="清空搜索"
                className="focus-ring absolute right-1.5 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-workbench-text-muted hover:bg-workbench-surface hover:text-workbench-text"
              >
                <X size={12} />
              </button>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
