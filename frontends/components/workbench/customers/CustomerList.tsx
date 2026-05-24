import { memo, useCallback, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import type { Account } from "@/lib/types/account";
import type { Customer } from "@/lib/types/customer";

import { BulkActionsBar } from "./BulkActionsBar";
import { WorkbenchScrollArea } from "../messages/WorkbenchScrollArea";
import { ROW_HEIGHT } from "./constants";
import { CustomerListHeader } from "./CustomerListHeader";
import { CustomerListRow } from "./CustomerListRow";
import { CustomersPagination } from "./CustomersPagination";
import { STRINGS } from "./strings";

// 列表表头 sticky 常驻在滚动视口内(CustomerListHeader 是 h-8 = 32px),虚拟化时行的
// 偏移量要扣掉这段表头高度,故作为 virtualizer 的 scrollMargin。
const LIST_HEADER_HEIGHT = 32;

interface CustomerListProps {
  /** 当前页的行(cursor keyset 分页,单页展示)。 */
  customers: readonly Customer[];
  /** 当前页行数;master checkbox「全选可见」语义 + 列头计数。 */
  loadedCount: number;
  /** 首页或翻页加载中。 */
  loading: boolean;
  accounts: readonly Account[];
  activeCustomerId: string | null;

  // pagination (cursor keyset)
  page: number;
  pageSize: number;
  canPrev: boolean;
  canNext: boolean;
  onPrevPage: () => void;
  onNextPage: () => void;
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

  /** 是否存在任意筛选(搜索 / 账号)。空列表时区分"无数据" vs "筛选无结果"。 */
  hasActiveFilters: boolean;
  /** "清除筛选" CTA 的回调。 */
  onClearFilters: () => void;
}

export const CustomerList = memo(function CustomerList({
  customers,
  loadedCount,
  loading,
  accounts,
  activeCustomerId,
  page,
  pageSize,
  canPrev,
  canNext,
  onPrevPage,
  onNextPage,
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
  hasActiveFilters,
  onClearFilters,
}: CustomerListProps) {
  const accountMap = useMemo(() => {
    const map = new Map<string, Account>();
    for (const a of accounts) map.set(a.id, a);
    return map;
  }, [accounts]);

  // 行虚拟化:行高固定 ROW_HEIGHT,单页最多 100 行也只渲染可见窗口 + overscan,避免整页
  // DOM 驻留撑高渲染内存(与消息区 ChatArea 同一 TanStack Virtual 方案)。
  const scrollElRef = useRef<HTMLDivElement | null>(null);
  // callback ref 忽略 null(旧视口卸载时 React 会回传 null),保持 ref 始终指向当前视口。
  const setScrollEl = useCallback((node: HTMLDivElement | null) => {
    if (node) scrollElRef.current = node;
  }, []);
  // React Compiler 无法 memo useVirtualizer 返回的函数(会 stale),故对本组件跳过自动 memo;
  // 组件本身已用 memo() 包裹、虚拟化后重渲极轻量,无影响。
  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: customers.length,
    getScrollElement: () => scrollElRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
    getItemKey: (index) => customers[index].id,
    scrollMargin: LIST_HEADER_HEIGHT,
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {multiSelectActive && (
        <BulkActionsBar
          selectedCount={selectedCount}
          allStarred={allSelectedStarred}
          knownTags={[]}
          onApplyTagDiff={onApplyTagDiff}
          onReassign={onReassign}
          onToggleStar={onBulkToggleStar}
          onExport={onExport}
          onCancel={onCancelBulk}
        />
      )}

      {loadedCount === 0 ? (
        loading ? (
          <ListStatus text="加载中…" />
        ) : hasActiveFilters ? (
          <FilteredEmpty onClearFilters={onClearFilters} />
        ) : (
          <EmptyList />
        )
      ) : (
        <>
          <WorkbenchScrollArea
            scrollRef={setScrollEl}
            className="flex-1"
            viewportClassName="px-0"
            contentClassName="flex flex-col"
          >
            <CustomerListHeader
              totalVisible={loadedCount}
              selectedCount={selectedCount}
              allSelectedInView={allSelectedInView}
              onToggleSelectAll={
                allSelectedInView && multiSelectActive ? onClearSelection : onSelectAllInView
              }
            />
            {/* 虚拟化:ul 撑出全量高度(getTotalSize),仅渲染可见行 + overscan;行用 translateY
                绝对定位,偏移扣掉 scrollMargin(表头 32px)使第一行紧贴表头之下。 */}
            <ul
              role="listbox"
              aria-label="客户列表"
              className="relative w-full"
              style={{ height: rowVirtualizer.getTotalSize() }}
            >
              {rowVirtualizer.getVirtualItems().map((vi) => {
                const customer = customers[vi.index];
                const account = customer.accountId ? accountMap.get(customer.accountId) : undefined;
                const isLast = vi.index === customers.length - 1;
                return (
                  <li
                    key={customer.id}
                    data-index={vi.index}
                    ref={rowVirtualizer.measureElement}
                    className={`absolute left-0 top-0 w-full ${
                      isLast ? "" : "border-b border-workbench-line-subtle"
                    }`}
                    style={{ transform: `translateY(${vi.start - LIST_HEADER_HEIGHT}px)` }}
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
          <CustomersPagination
            page={page}
            pageSize={pageSize}
            canPrev={canPrev}
            canNext={canNext}
            loading={loading}
            onPrev={onPrevPage}
            onNext={onNextPage}
            onPageSizeChange={onPageSizeChange}
          />
        </>
      )}
    </div>
  );
});

function ListStatus({ text }: { text: string }) {
  if (!text) return <div className="h-6" aria-hidden />;
  return (
    <div className="flex h-10 items-center justify-center text-[12px] text-workbench-text-muted">
      {text}
    </div>
  );
}

function EmptyList() {
  const empty = STRINGS.emptyStates.all;
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
        当前的搜索 / 账号筛选条件下没有结果。
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
