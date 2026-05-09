import { memo, useMemo } from "react";

import type { Account } from "@/lib/types/account";
import type { Customer } from "@/lib/types/customer";

import { BulkActionsBar } from "./BulkActionsBar";
import { WorkbenchScrollArea } from "../messages/WorkbenchScrollArea";
import type { CustomerTab } from "./constants";
import { CustomerListHeader } from "./CustomerListHeader";
import { CustomerListRow } from "./CustomerListRow";
import { CustomersPagination } from "./CustomersPagination";
import { STRINGS } from "./strings";

interface CustomerListProps {
  /** 当前页可见行（已分页切片）。 */
  paginatedCustomers: readonly Customer[];
  /** 所有过滤后的总数（跨页），用于 master checkbox 的「全选可见」语义。 */
  filteredTotal: number;
  accounts: readonly Account[];
  activeTab: CustomerTab;
  activeCustomerId: string | null;

  // pagination
  page: number;
  pageCount: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;

  // multi-select
  multiSelectActive: boolean;
  selectedIds: ReadonlySet<string>;
  allSelectedInView: boolean;
  selectedCount: number;
  allSelectedStarred: boolean;
  onSelectCustomer: (id: string) => void;
  onToggleMultiSelect: (id: string) => void;
  onSelectAllInView: () => void;
  onClearSelection: () => void;
  onCancelBulk: () => void;

  // bulk actions
  onApplyTagDiff: (diff: { addTags?: string[]; removeTags?: string[] }) => void;
  onReassign: (follower: string) => void;
  onBulkToggleStar: () => void;
  onExport: () => void;

  // row actions
  onOpenChat: (id: string) => void;
  onEditCustomer: (id: string) => void;
  onMoreRowAction: (id: string) => void;

  /** 标签筛选已知列表，BulkActionsBar 内的标签 popover 用。 */
  knownTags: readonly string[];
  /** 是否存在任意非 Tab 过滤。空列表时区分"无数据" vs "过滤无结果"。 */
  hasActiveFilters: boolean;
  /** "清除筛选" CTA 的回调。 */
  onClearFilters: () => void;
}

export const CustomerList = memo(function CustomerList({
  paginatedCustomers,
  filteredTotal,
  accounts,
  activeTab,
  activeCustomerId,
  page,
  pageCount,
  pageSize,
  onPageChange,
  onPageSizeChange,
  multiSelectActive,
  selectedIds,
  allSelectedInView,
  selectedCount,
  allSelectedStarred,
  onSelectCustomer,
  onToggleMultiSelect,
  onSelectAllInView,
  onClearSelection,
  onCancelBulk,
  onApplyTagDiff,
  onReassign,
  onBulkToggleStar,
  onExport,
  onOpenChat,
  onEditCustomer,
  onMoreRowAction,
  knownTags,
  hasActiveFilters,
  onClearFilters,
}: CustomerListProps) {
  const accountMap = useMemo(() => {
    const map = new Map<string, Account>();
    for (const a of accounts) map.set(a.id, a);
    return map;
  }, [accounts]);

  // v3：分页器始终常驻底部（即使只有 1 页），与参考稿一致；提供稳定的"共 N 条 + 页大小"
  // 视觉锚点。空列表时仍跳过（由上面的 EmptyList / FilteredEmpty 占位）。
  const showPagination = filteredTotal > 0;

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

      {filteredTotal === 0 ? (
        hasActiveFilters ? (
          <FilteredEmpty onClearFilters={onClearFilters} />
        ) : (
          <EmptyList tab={activeTab} />
        )
      ) : (
        <>
          <WorkbenchScrollArea
            className="flex-1"
            viewportClassName="px-0"
            contentClassName="flex flex-col"
          >
            <CustomerListHeader
              totalVisible={filteredTotal}
              selectedCount={selectedCount}
              allSelectedInView={allSelectedInView}
              onToggleSelectAll={
                allSelectedInView && multiSelectActive ? onClearSelection : onSelectAllInView
              }
            />
            <ul role="listbox" aria-label="客户列表" className="flex flex-col">
              {paginatedCustomers.map((customer) => {
                const account = customer.accountId ? accountMap.get(customer.accountId) : undefined;
                return (
                  <li
                    key={customer.id}
                    className="border-b border-workbench-line-subtle last:border-b-0"
                  >
                    <CustomerListRow
                      customer={customer}
                      account={account}
                      avatarColorToken={account?.colorToken}
                      selected={!multiSelectActive && customer.id === activeCustomerId}
                      multiSelectActive={multiSelectActive}
                      multiSelected={selectedIds.has(customer.id)}
                      onSelect={onSelectCustomer}
                      onToggleMultiSelect={onToggleMultiSelect}
                      onOpenChat={onOpenChat}
                      onEditCustomer={onEditCustomer}
                      onMore={onMoreRowAction}
                    />
                  </li>
                );
              })}
            </ul>
          </WorkbenchScrollArea>
          {showPagination && (
            <CustomersPagination
              page={page}
              pageCount={pageCount}
              pageSize={pageSize}
              totalCount={filteredTotal}
              onPageChange={onPageChange}
              onPageSizeChange={onPageSizeChange}
            />
          )}
        </>
      )}
    </div>
  );
});

function EmptyList({ tab }: { tab: CustomerTab }) {
  const map: Record<CustomerTab, { title: string; hint: string }> = {
    all: STRINGS.emptyStates.all,
    key: STRINGS.emptyStates.key,
    "today-new": STRINGS.emptyStates.todayNew,
    "stale-30d": STRINGS.emptyStates.stale30d,
    "pending-sign": STRINGS.emptyStates.pendingSign,
    lost: STRINGS.emptyStates.lost,
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
        当前的搜索 / 账号 / 标签 / 阶段 / 跟进状态筛选条件下没有结果。
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
