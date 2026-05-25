import { memo, useCallback, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import type { Account } from "@/lib/types/account";
import type { Customer } from "@/lib/types/customer";

import { BulkActionsBar } from "./BulkActionsBar";
import { WorkbenchScrollArea } from "../messages/WorkbenchScrollArea";
import { CARD_COLUMNS, type CardDensity } from "./constants";
import { CustomerCard } from "./CustomerCard";
import { CustomersPagination } from "./CustomersPagination";
import { STRINGS } from "./strings";

// ─── 卡片网格虚拟化 ───────────────────────────────────────────────────────────
// 卡片网格用 @tanstack/react-virtual 按「行」虚拟化:每个虚拟项是一整行卡片,
// 行内列数由密度固定(CARD_COLUMNS,不随窗口宽度跳列;卡片等比缩放)。只渲染可视
// 行 + 上下 overscan,长列表(pageSize 最大 100)滚动时 DOM 节点恒定,不再一次性挂载全部卡片。
const CARD_GAP_PX = 10; // 列间距(对应原 gap-2.5)
const ROW_GAP_PX = 10; // 行间距(对应原 gap-2.5),以行 wrapper 的 paddingBottom 实现
const ESTIMATED_ROW_PX = 168; // 行高初始估值;measureElement 会按真实高度校正
const OVERSCAN_ROWS = 6; // 视口上下额外预渲染的行数,滚动时减少白屏

interface CustomerListProps {
  /** 当前页的客户（cursor keyset 分页，单页展示）。 */
  customers: readonly Customer[];
  /** 当前页行数；「全选本页」语义。 */
  loadedCount: number;
  /** 首页或翻页加载中。 */
  loading: boolean;
  accounts: readonly Account[];
  activeCustomerId: string | null;
  /** 卡片网格密度（舒适 / 紧凑）。 */
  density: CardDensity;

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

  // card actions
  onOpenChat: (id: string) => void;
  onCall: (id: string) => void;
  onMore: (id: string) => void;

  /** 是否存在任意筛选（搜索 / 账号）。空列表时区分"无数据" vs "筛选无结果"。 */
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
  density,
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
  onCall,
  onMore,
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
          allSelectedInView={allSelectedInView}
          knownTags={[]}
          onToggleSelectAll={allSelectedInView ? onClearSelection : onSelectAllInView}
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
          <VirtualizedCardGrid
            customers={customers}
            accountMap={accountMap}
            activeCustomerId={activeCustomerId}
            density={density}
            multiSelectActive={multiSelectActive}
            selectedIds={selectedIds}
            onSelectCustomer={onSelectCustomer}
            onToggleMultiSelect={onToggleMultiSelect}
            onOpenChat={onOpenChat}
            onCall={onCall}
            onMore={onMore}
          />
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

interface VirtualizedCardGridProps {
  customers: readonly Customer[];
  accountMap: ReadonlyMap<string, Account>;
  activeCustomerId: string | null;
  density: CardDensity;
  multiSelectActive: boolean;
  selectedIds: ReadonlySet<string>;
  onSelectCustomer: (id: string) => void;
  onToggleMultiSelect: (id: string) => void;
  onOpenChat: (id: string) => void;
  onCall: (id: string) => void;
  onMore: (id: string) => void;
}

const VirtualizedCardGrid = memo(function VirtualizedCardGrid({
  customers,
  accountMap,
  activeCustomerId,
  density,
  multiSelectActive,
  selectedIds,
  onSelectCustomer,
  onToggleMultiSelect,
  onOpenChat,
  onCall,
  onMore,
}: VirtualizedCardGridProps) {
  // 滚动容器:由 WorkbenchScrollArea 通过 scrollRef 回调把 viewport DOM 桥接进来,
  // 供 virtualizer 的 getScrollElement 读取(与 ConversationList 同模式)。
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const setScrollViewport = useCallback((node: HTMLDivElement | null) => {
    if (node) scrollRef.current = node;
  }, []);

  // 每行列数由密度固定(舒适 4 列 / 紧凑 5 列),不随窗口宽度跳列;
  // 卡片用 `minmax(0, 1fr)` 平分容器宽,窗口缩放时等比变宽 / 变窄。
  const columnCount = CARD_COLUMNS[density];
  const rowCount = Math.ceil(customers.length / columnCount);

  // useVirtualizer 返回的方法无法被 React Compiler 安全 memo,编译器会跳过对本组件的
  // 自动 memo。这里安全:组件已手动 memo() 包裹,且 virtualizer 的产物(start/key/
  // measureElement)只喂给普通 div、不流入任何 memo 子组件,不存在 stale UI 风险。
  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_PX,
    overscan: OVERSCAN_ROWS,
    // 用行首卡片 id 作 stable key:列数变化(拖窗 / 切密度)时行首卡片随之改变,
    // key 变化让 react-virtual 丢弃过期测量并重新 measureElement,无需手动 measure()。
    getItemKey: (rowIndex) => customers[rowIndex * columnCount]?.id ?? rowIndex,
  });

  const virtualRows = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();

  return (
    <WorkbenchScrollArea
      className="flex-1"
      viewportClassName="px-3 py-3"
      scrollRef={setScrollViewport}
    >
      <div
        role="listbox"
        aria-label="客户列表"
        style={{ height: totalSize, position: "relative", width: "100%" }}
      >
        {virtualRows.map((virtualRow) => {
          const start = virtualRow.index * columnCount;
          const rowItems = customers.slice(start, start + columnCount);
          return (
            <div
              key={virtualRow.key}
              ref={rowVirtualizer.measureElement}
              data-index={virtualRow.index}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                paddingBottom: ROW_GAP_PX,
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <div
                className="grid"
                style={{
                  gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
                  gap: CARD_GAP_PX,
                }}
              >
                {rowItems.map((customer) => {
                  const account = customer.accountId
                    ? accountMap.get(customer.accountId)
                    : undefined;
                  return (
                    <CustomerCard
                      key={customer.id}
                      customer={customer}
                      account={account}
                      avatarColorToken={account?.colorToken}
                      selected={!multiSelectActive && customer.id === activeCustomerId}
                      multiSelectActive={multiSelectActive}
                      multiSelected={selectedIds.has(customer.id)}
                      onSelect={onSelectCustomer}
                      onToggleMultiSelect={onToggleMultiSelect}
                      onOpenChat={onOpenChat}
                      onCall={onCall}
                      onMore={onMore}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </WorkbenchScrollArea>
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
