import { useCallback, useEffect, useMemo, useState } from "react";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ToastViewport, showToast } from "@/components/ui/toast";
import { WorkbenchPanel } from "@/components/workbench/WorkbenchPanel";

import { CustomerDetailPanel } from "./CustomerDetailPanel";
import { CustomerList } from "./CustomerList";
import { CustomersHeader } from "./CustomersHeader";
import { MOCK_ACCOUNTS, MOCK_CUSTOMERS, MOCK_RECENT_MESSAGES } from "./data";
import { STRINGS } from "./strings";
import { downloadCsv, toCsv } from "./utils";
import { useCustomersFilters } from "./useCustomersFilters";
import { useCustomerSelection } from "./useCustomerSelection";
import { useCustomerStore } from "./useCustomerStore";

interface CustomersPageProps {
  /**
   * 来自其他页面（账号页卡片点击）的"锁定该账号过滤"意图。CustomersPage 在
   * useEffect 中一次性消费并调 onConsumePendingFilter 通知 Workbench 清空，
   * 之后用户在 AccountPicker 中正常增删该选中集。
   */
  pendingAccountFilter?: string | null;
  onConsumePendingFilter?: () => void;
}

export function CustomersPage({
  pendingAccountFilter,
  onConsumePendingFilter,
}: CustomersPageProps = {}) {
  const store = useCustomerStore(MOCK_CUSTOMERS);
  const filters = useCustomersFilters({ source: store.customers });
  const selection = useCustomerSelection();

  const [requestedCustomerId, setRequestedCustomerId] = useState<string | null>(
    () => MOCK_CUSTOMERS[0]?.id ?? null,
  );

  // 渲染期派生有效的激活客户：若用户选中的客户被过滤掉，则回退到第一条；空列表为 null。
  // 用户的选择仍保留在 requestedCustomerId 中，筛选恢复后可重新生效。
  const activeCustomerId = useMemo(() => {
    if (filters.filteredCustomers.length === 0) return null;
    if (
      requestedCustomerId &&
      filters.filteredCustomers.some((c) => c.id === requestedCustomerId)
    ) {
      return requestedCustomerId;
    }
    return filters.filteredCustomers[0].id;
  }, [requestedCustomerId, filters.filteredCustomers]);

  // 切 Tab 时退出多选模式。
  const exitSelection = selection.exit;
  useEffect(() => {
    exitSelection();
  }, [exitSelection, filters.activeTab]);

  // 一次性消费"账号页跳过来的锁定意图"：写入选中账号集 + 提示，调回调清空，
  // 让用户后续可以在 AccountPicker 中自由增删。
  const setSelectedAccountIdsExact = filters.setSelectedAccountIdsExact;
  useEffect(() => {
    if (!pendingAccountFilter) return;
    const account = MOCK_ACCOUNTS.find((a) => a.id === pendingAccountFilter);
    setSelectedAccountIdsExact(new Set([pendingAccountFilter]));
    if (account) {
      showToast(`已锁定账号「${account.name}」的客户列表`, { type: "info" });
    }
    onConsumePendingFilter?.();
  }, [pendingAccountFilter, setSelectedAccountIdsExact, onConsumePendingFilter]);

  // 任意筛选变化（账号/标签/搜索/Tab）会改变可见集，把当前选中收敛到交集。
  // 否则用户对"看不见的项"批量操作的语义不可控（导出/移交/星标都会包含隐藏行）。
  const pruneSelection = selection.pruneTo;
  useEffect(() => {
    const visibleIds = new Set(filters.filteredCustomers.map((c) => c.id));
    pruneSelection(visibleIds);
  }, [filters.filteredCustomers, pruneSelection]);

  const activeCustomer = useMemo(
    () => store.customers.find((c) => c.id === activeCustomerId) ?? null,
    [activeCustomerId, store.customers],
  );

  const activeAccount = activeCustomer?.accountId
    ? MOCK_ACCOUNTS.find((a) => a.id === activeCustomer.accountId)
    : undefined;

  const recentMessages = useMemo(() => {
    if (!activeCustomer) return [];
    return MOCK_RECENT_MESSAGES.filter((m) => m.customerId === activeCustomer.id);
  }, [activeCustomer]);

  // ── 选中相关 ─────────────────────────────────────────────────────────────
  const selectExactly = selection.selectExactly;
  const isMultiSelectActive = selection.isMultiSelectActive;
  const toggleSelectionMode = selection.toggleMode;

  /**
   * 工具栏 master checkbox：未在多选时点击 → 进入多选并选中可见全部；
   * 已选完则清空回到 0；否则补齐到全选可见集。
   */
  const onSelectAllInView = useCallback(() => {
    if (!isMultiSelectActive) {
      toggleSelectionMode();
    }
    selectExactly(filters.filteredCustomers.map((c) => c.id));
  }, [filters.filteredCustomers, isMultiSelectActive, selectExactly, toggleSelectionMode]);

  const allSelectedInView = useMemo(() => {
    if (filters.filteredCustomers.length === 0) return false;
    return filters.filteredCustomers.every((c) => selection.selectedIds.has(c.id));
  }, [filters.filteredCustomers, selection.selectedIds]);

  // 拆出方法引用，深依赖 selection 对象会让该 callback 每次选中改变都重建
  // → 传给 memoized CustomerListRow 的 onSelect 也跟着抖，memo 失效。
  const toggleSelection = selection.toggle;
  const handleSelectCustomer = useCallback(
    (id: string) => {
      if (isMultiSelectActive) {
        toggleSelection(id);
      } else {
        setRequestedCustomerId(id);
      }
    },
    [isMultiSelectActive, toggleSelection],
  );

  const handleToggleStar = useCallback(
    (id: string) => {
      const next = store.toggleStarred(id);
      const customer = store.customers.find((c) => c.id === id);
      if (customer) {
        showToast(next ? `已关注 ${customer.name}` : `已取消关注 ${customer.name}`, {
          type: "success",
        });
      }
    },
    [store],
  );

  const handleAddTag = useCallback(
    (tag: string) => {
      if (!activeCustomer) return;
      const folded = tag.toLocaleLowerCase();
      if (activeCustomer.tags.some((t) => t.toLocaleLowerCase() === folded)) return;
      store.patchCustomer(activeCustomer.id, { tags: [...activeCustomer.tags, tag] });
    },
    [activeCustomer, store],
  );

  const handleRemoveTag = useCallback(
    (tag: string) => {
      if (!activeCustomer) return;
      store.patchCustomer(activeCustomer.id, {
        tags: activeCustomer.tags.filter((t) => t !== tag),
      });
    },
    [activeCustomer, store],
  );

  const handlePatch = useCallback(
    (patch: Parameters<typeof store.patchCustomer>[1]) => {
      if (!activeCustomer) return;
      store.patchCustomer(activeCustomer.id, patch);
    },
    [activeCustomer, store],
  );

  const handleOpenChat = useCallback((customerId: string) => {
    showToast(`将打开与该客户的会话（${customerId}）`, { type: "info" });
  }, []);

  // ── 批量动作 ─────────────────────────────────────────────────────────────
  const selectedIdsArray = useMemo(
    () => Array.from(selection.selectedIds),
    [selection.selectedIds],
  );

  const allSelectedStarred = useMemo(() => {
    if (selectedIdsArray.length === 0) return false;
    return selectedIdsArray.every((id) => store.customers.find((c) => c.id === id)?.starred);
  }, [selectedIdsArray, store.customers]);

  const handleBulkApplyTagDiff = useCallback(
    (diff: { addTags?: string[]; removeTags?: string[] }) => {
      store.applyTagDiff(selectedIdsArray, diff);
      showToast(STRINGS.toasts.tagsUpdated(selectedIdsArray.length));
    },
    [selectedIdsArray, store],
  );

  const handleBulkReassign = useCallback(
    (follower: string) => {
      store.patchMany(selectedIdsArray, { follower });
      showToast(STRINGS.toasts.reassigned(selectedIdsArray.length, follower));
    },
    [selectedIdsArray, store],
  );

  const handleBulkToggleStar = useCallback(() => {
    const next = !allSelectedStarred;
    store.patchMany(selectedIdsArray, { starred: next });
    showToast(
      next
        ? STRINGS.toasts.starred(selectedIdsArray.length)
        : STRINGS.toasts.unstarred(selectedIdsArray.length),
    );
  }, [allSelectedStarred, selectedIdsArray, store]);

  const handleBulkExport = useCallback(() => {
    const ids = new Set(selectedIdsArray);
    const rows = store.customers.filter((c) => ids.has(c.id));
    if (rows.length === 0) return;
    const csv = toCsv(rows);
    downloadCsv(STRINGS.bulk.csvFileName, csv);
    showToast(STRINGS.toasts.exported(rows.length));
  }, [selectedIdsArray, store.customers]);

  const hasActiveFilters =
    filters.searchTerm.trim().length > 0 ||
    filters.selectedAccountIds.size > 0 ||
    filters.tagFilters.length > 0 ||
    filters.stageFilter.size > 0 ||
    filters.followUpFilter.size > 0;

  const handleClearFilters = useCallback(() => {
    filters.setSearchTerm("");
    filters.clearAccounts();
    filters.clearTags();
    filters.clearStages();
    filters.clearFollowUps();
  }, [filters]);

  const handleCreateCustomer = useCallback(() => {
    showToast(STRINGS.toasts.newCustomerStub, { type: "info" });
  }, []);
  const handleToggleView = useCallback(() => {
    showToast(STRINGS.toasts.viewToggleStub, { type: "info" });
  }, []);
  const handleStubExport = useCallback(() => {
    showToast(STRINGS.toasts.exportStub, { type: "info" });
  }, []);

  const handleEditCustomer = useCallback((id: string) => {
    showToast(`将打开客户编辑面板（${id}）`, { type: "info" });
  }, []);
  const handleRowMore = useCallback((id: string) => {
    showToast(`更多操作菜单（${id}）`, { type: "info" });
  }, []);
  const handleFollowUpHistory = useCallback((id: string) => {
    showToast(`将打开跟进记录（${id}）`, { type: "info" });
  }, []);

  return (
    <ErrorBoundary>
      <WorkbenchPanel>
        <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
          <CustomersHeader
            activeTab={filters.activeTab}
            onTabChange={filters.setActiveTab}
            tabCounts={filters.tabCounts}
            searchTerm={filters.searchTerm}
            onSearchChange={filters.setSearchTerm}
            accounts={MOCK_ACCOUNTS}
            selectedAccountIds={filters.selectedAccountIds}
            accountCounts={filters.accountCounts}
            onToggleAccount={filters.toggleAccountId}
            onClearAccounts={filters.clearAccounts}
            stageFilter={filters.stageFilter}
            onToggleStage={filters.toggleStage}
            onClearStages={filters.clearStages}
            knownTags={filters.knownTags}
            tagFilters={filters.tagFilters}
            onToggleTag={filters.toggleTag}
            onClearTags={filters.clearTags}
            followUpFilter={filters.followUpFilter}
            onToggleFollowUp={filters.toggleFollowUp}
            onClearFollowUps={filters.clearFollowUps}
            sortKey={filters.sortKey}
            onSortChange={filters.setSortKey}
            hasActiveFilters={hasActiveFilters}
            onReset={handleClearFilters}
            onCreateCustomer={handleCreateCustomer}
            onToggleView={handleToggleView}
            onExport={handleStubExport}
          />

          <div className="flex min-h-0 flex-1 overflow-hidden">
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
              <CustomerList
                paginatedCustomers={filters.paginatedCustomers}
                filteredTotal={filters.filteredCustomers.length}
                accounts={MOCK_ACCOUNTS}
                activeTab={filters.activeTab}
                activeCustomerId={activeCustomerId}
                page={filters.page}
                pageCount={filters.pageCount}
                pageSize={filters.pageSize}
                onPageChange={filters.setPage}
                onPageSizeChange={filters.setPageSize}
                multiSelectActive={selection.isMultiSelectActive}
                selectedIds={selection.selectedIds}
                allSelectedInView={allSelectedInView}
                selectedCount={selection.count}
                allSelectedStarred={allSelectedStarred}
                onSelectCustomer={handleSelectCustomer}
                onToggleMultiSelect={selection.toggle}
                onSelectAllInView={onSelectAllInView}
                onClearSelection={selection.clear}
                onCancelBulk={selection.exit}
                onApplyTagDiff={handleBulkApplyTagDiff}
                onReassign={handleBulkReassign}
                onBulkToggleStar={handleBulkToggleStar}
                onExport={handleBulkExport}
                onOpenChat={handleOpenChat}
                onEditCustomer={handleEditCustomer}
                onMoreRowAction={handleRowMore}
                knownTags={filters.knownTags}
                hasActiveFilters={hasActiveFilters}
                onClearFilters={handleClearFilters}
              />
            </div>
            <CustomerDetailPanel
              customer={activeCustomer}
              account={activeAccount}
              recentMessages={recentMessages}
              onPatch={handlePatch}
              onAddTag={handleAddTag}
              onRemoveTag={handleRemoveTag}
              onToggleStar={() => {
                if (activeCustomer) handleToggleStar(activeCustomer.id);
              }}
              onOpenChat={handleOpenChat}
              onEditCustomer={handleEditCustomer}
              onFollowUpHistory={handleFollowUpHistory}
            />
          </div>
        </div>
        <ToastViewport />
      </WorkbenchPanel>
    </ErrorBoundary>
  );
}
