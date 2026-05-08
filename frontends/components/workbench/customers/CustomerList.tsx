import { memo, useMemo } from "react";

import type { Account } from "@/lib/types/account";
import type { Customer } from "@/lib/types/customer";

import { BulkActionsBar } from "./BulkActionsBar";
import { WorkbenchScrollArea } from "../messages/WorkbenchScrollArea";
import type { CustomerTab } from "./constants";
import { CustomerListRow } from "./CustomerListRow";
import { STRINGS } from "./strings";

interface CustomerListProps {
  customers: readonly Customer[];
  accounts: readonly Account[];
  activeTab: CustomerTab;
  activeCustomerId: string | null;

  // multi-select
  multiSelectActive: boolean;
  selectedIds: ReadonlySet<string>;
  allSelectedInView: boolean;
  selectedCount: number;
  allSelectedStarred: boolean;
  onSelectCustomer: (id: string) => void;
  onToggleStar: (id: string) => void;
  onToggleMultiSelect: (id: string) => void;
  onSelectAllInView: () => void;
  onClearSelection: () => void;
  onCancelBulk: () => void;

  // bulk actions
  onApplyTagDiff: (diff: { addTags?: string[]; removeTags?: string[] }) => void;
  onReassign: (follower: string) => void;
  onBulkToggleStar: () => void;
  onExport: () => void;

  /** 标签筛选已知列表，BulkActionsBar 内的标签 popover 用。 */
  knownTags: readonly string[];
  /** 是否存在任意非 Tab 过滤。空列表时区分"无数据" vs "过滤无结果"。 */
  hasActiveFilters: boolean;
  /** "清除筛选" CTA 的回调。 */
  onClearFilters: () => void;
}

export const CustomerList = memo(function CustomerList({
  customers,
  accounts,
  activeTab,
  activeCustomerId,
  multiSelectActive,
  selectedIds,
  allSelectedInView,
  selectedCount,
  allSelectedStarred,
  onSelectCustomer,
  onToggleStar,
  onToggleMultiSelect,
  onSelectAllInView,
  onClearSelection,
  onCancelBulk,
  onApplyTagDiff,
  onReassign,
  onBulkToggleStar,
  onExport,
  knownTags,
  hasActiveFilters,
  onClearFilters,
}: CustomerListProps) {
  const accountMap = useMemo(() => {
    const map = new Map<string, Account>();
    for (const a of accounts) map.set(a.id, a);
    return map;
  }, [accounts]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {multiSelectActive && (
        <BulkActionsBar
          selectedCount={selectedCount}
          allStarred={allSelectedStarred}
          knownTags={knownTags}
          onApplyTagDiff={onApplyTagDiff}
          onReassign={onReassign}
          onToggleStar={onBulkToggleStar}
          onExport={onExport}
          onCancel={onCancelBulk}
        />
      )}

      {customers.length === 0 ? (
        hasActiveFilters ? (
          <FilteredEmpty onClearFilters={onClearFilters} />
        ) : (
          <EmptyList tab={activeTab} />
        )
      ) : (
        <WorkbenchScrollArea
          className="flex-1"
          viewportClassName="px-0"
          contentClassName="flex flex-col"
        >
          {multiSelectActive && (
            <SelectAllRow
              totalVisible={customers.length}
              allSelected={allSelectedInView}
              onSelectAll={onSelectAllInView}
              onClear={onClearSelection}
            />
          )}
          <ul role="listbox" aria-label="客户列表" className="flex flex-col">
            {customers.map((customer) => {
              const account = customer.accountId ? accountMap.get(customer.accountId) : undefined;
              return (
                <li
                  key={customer.id}
                  className="border-b border-workbench-line-subtle last:border-b-0"
                >
                  <CustomerListRow
                    customer={customer}
                    avatarColorToken={account?.colorToken}
                    selected={!multiSelectActive && customer.id === activeCustomerId}
                    multiSelectActive={multiSelectActive}
                    multiSelected={selectedIds.has(customer.id)}
                    showFollowUpReason={activeTab === "needs-followup"}
                    onSelect={onSelectCustomer}
                    onToggleStar={onToggleStar}
                    onToggleMultiSelect={onToggleMultiSelect}
                  />
                </li>
              );
            })}
          </ul>
        </WorkbenchScrollArea>
      )}
    </div>
  );
});

function SelectAllRow({
  totalVisible,
  allSelected,
  onSelectAll,
  onClear,
}: {
  totalVisible: number;
  allSelected: boolean;
  onSelectAll: () => void;
  onClear: () => void;
}) {
  return (
    <div className="sticky top-0 z-[1] flex items-center gap-3 border-b border-workbench-line bg-workbench-surface-subtle px-4 py-2 text-[12px] text-workbench-text">
      <button
        type="button"
        onClick={allSelected ? onClear : onSelectAll}
        className="focus-ring inline-flex items-center gap-2 rounded-md px-1 py-0.5 hover:bg-workbench-surface"
      >
        <span
          className={
            allSelected
              ? "grid size-4 place-items-center rounded-[4px] border border-workbench-accent bg-workbench-accent text-workbench-surface"
              : "grid size-4 place-items-center rounded-[4px] border border-workbench-line"
          }
        >
          {allSelected && (
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
          )}
        </span>
        <span>{STRINGS.list.selectAll(totalVisible)}</span>
      </button>
    </div>
  );
}

function EmptyList({ tab }: { tab: CustomerTab }) {
  const map: Record<CustomerTab, { title: string; hint: string }> = {
    all: STRINGS.emptyStates.all,
    "needs-followup": STRINGS.emptyStates.needsFollowUp,
    "new-friend": STRINGS.emptyStates.newFriend,
    starred: STRINGS.emptyStates.starred,
  };
  const empty = map[tab];
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <p className="text-[14px] font-medium text-workbench-text">{empty.title}</p>
      <p className="max-w-[280px] text-[12px] text-workbench-text-muted">{empty.hint}</p>
    </div>
  );
}

function FilteredEmpty({ onClearFilters }: { onClearFilters: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <p className="text-[14px] font-medium text-workbench-text">没有匹配的客户</p>
      <p className="max-w-[280px] text-[12px] text-workbench-text-muted">
        当前的搜索 / 账号 / 标签筛选条件下没有结果。
      </p>
      <button
        type="button"
        onClick={onClearFilters}
        className="focus-ring mt-1 inline-flex h-7 items-center rounded-md bg-workbench-surface-active px-3 text-wb-2xs font-medium text-workbench-accent transition-colors hover:bg-workbench-accent hover:text-white"
      >
        清除筛选
      </button>
    </div>
  );
}
