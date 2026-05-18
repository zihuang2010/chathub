import { useCallback, useEffect, useMemo, useState } from "react";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ToastViewport, showToast } from "@/components/ui/toast";
import { WorkbenchPanel } from "@/components/workbench/WorkbenchPanel";
import { adaptFriendToCustomer } from "@/lib/api/customers";
import { useFriends } from "@/lib/api/useFriends";
import type { Account } from "@/lib/types/account";

import { CustomerDetailPanel } from "./CustomerDetailPanel";
import { CustomerList } from "./CustomerList";
import { CustomersHeader } from "./CustomersHeader";
import { MOCK_RECENT_MESSAGES } from "./data";
import { STRINGS } from "./strings";
import { downloadCsv, toCsv } from "./utils";
import { useCustomerSelection } from "./useCustomerSelection";
import { useCustomersFilters } from "./useCustomersFilters";
import { useCustomerStore } from "./useCustomerStore";

interface CustomersPageProps {
  /** 由 Workbench 提供的账号列表(来自 list_accounts);为空数组时筛选下拉空,UI 仍可用。 */
  accounts: readonly Account[];
  /**
   * 来自其他页面(账号页卡片点击)的"锁定该账号过滤"意图。CustomersPage 在
   * useEffect 中一次性消费并调 onConsumePendingFilter 通知 Workbench 清空,
   * 之后用户在 AccountPicker 中正常增删该选中集。
   */
  pendingAccountFilter?: string | null;
  onConsumePendingFilter?: () => void;
}

const EMPTY_ACCOUNTS_SET: ReadonlySet<string> = new Set();

export function CustomersPage({
  accounts,
  pendingAccountFilter,
  onConsumePendingFilter,
}: CustomersPageProps) {
  // 受控的账号筛选 state:由 CustomersPage 持有,同时驱动 API 入参 + 本地 filter,
  // 避免 selectedAccountIds 被 filter 内部持有导致的循环依赖。
  const [selectedAccountIds, setSelectedAccountIds] =
    useState<ReadonlySet<string>>(EMPTY_ACCOUNTS_SET);

  // API 入参账号:UI 没选时拉所有可见账号。
  const apiAccountIds = useMemo(() => {
    if (selectedAccountIds.size > 0) {
      return [...selectedAccountIds].sort();
    }
    return accounts.map((a) => a.id);
  }, [selectedAccountIds, accounts]);

  // 阶段 2:Tauri `list_friends` 返全量(行存)。分页 / 筛选 / 排序均本地完成。
  const { friends, error, refetch } = useFriends(apiAccountIds);

  useEffect(() => {
    if (error) showToast(`加载客户列表失败: ${error}`, { type: "error" });
  }, [error]);

  // 行存每条带 wecomAccountId,adapter 用 map 查账号显示名;多账号 / 单账号一致路径。
  const accountNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of accounts) m.set(a.id, a.name);
    return m;
  }, [accounts]);

  const adapted = useMemo(() => {
    return friends.map((r) =>
      adaptFriendToCustomer(r, {
        accountName: accountNameById.get(r.wecomAccountId) ?? "—",
      }),
    );
  }, [friends, accountNameById]);

  const store = useCustomerStore(adapted);
  const filters = useCustomersFilters({
    source: store.customers,
    selectedAccountIdsValue: selectedAccountIds,
    onSelectedAccountIdsChange: setSelectedAccountIds,
  });
  const selection = useCustomerSelection();

  const [requestedCustomerId, setRequestedCustomerId] = useState<string | null>(null);

  // 渲染期派生有效的激活客户:若用户选中的客户被过滤掉,则回退到第一条;空列表为 null。
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

  // 一次性消费"账号页跳过来的锁定意图":在 render 阶段对比 lastConsumedPending 做 set,
  // 再用 useEffect 触发 toast + 通知父级,避开 react-hooks/set-state-in-effect。
  const [lastConsumedPending, setLastConsumedPending] = useState<string | null>(null);
  const isNewPending = !!pendingAccountFilter && pendingAccountFilter !== lastConsumedPending;
  if (isNewPending) {
    setLastConsumedPending(pendingAccountFilter);
    setSelectedAccountIds(new Set([pendingAccountFilter!]));
  }
  useEffect(() => {
    if (!isNewPending) return;
    const account = accounts.find((a) => a.id === pendingAccountFilter);
    if (account) {
      showToast(`已锁定账号「${account.name}」的客户列表`, { type: "info" });
    }
    onConsumePendingFilter?.();
  }, [isNewPending, pendingAccountFilter, accounts, onConsumePendingFilter]);

  // 任意筛选变化(账号/标签/搜索/Tab)会改变可见集,把当前选中收敛到交集。
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
    ? accounts.find((a) => a.id === activeCustomer.accountId)
    : undefined;

  const recentMessages = useMemo(() => {
    if (!activeCustomer) return [];
    return MOCK_RECENT_MESSAGES.filter((m) => m.customerId === activeCustomer.id);
  }, [activeCustomer]);

  // ── 选中相关 ─────────────────────────────────────────────────────────────
  const selectExactly = selection.selectExactly;
  const isMultiSelectActive = selection.isMultiSelectActive;
  const toggleSelectionMode = selection.toggleMode;

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

  // 真接口暂无 patch API,本地态会被下一次 useFriends 重拉覆盖,先保留交互手感。
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
    showToast(`将打开与该客户的会话(${customerId})`, { type: "info" });
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
    void refetch({ force: true });
    showToast("已强制刷新客户列表", { type: "info" });
  }, [refetch]);

  const handleEditCustomer = useCallback((id: string) => {
    showToast(`将打开客户编辑面板(${id})`, { type: "info" });
  }, []);
  const handleRowMore = useCallback((id: string) => {
    showToast(`更多操作菜单(${id})`, { type: "info" });
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
            accounts={accounts}
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
            onReset={handleClearFilters}
            onCreateCustomer={handleCreateCustomer}
            onToggleView={handleToggleView}
            onExport={handleStubExport}
          />

          <div className="flex min-h-0 flex-1 gap-2 overflow-hidden bg-workbench-surface-subtle p-2">
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-workbench-line bg-workbench-surface shadow-wb-card">
              <CustomerList
                paginatedCustomers={filters.paginatedCustomers}
                filteredTotal={filters.filteredCustomers.length}
                accounts={accounts}
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
            <div className="overflow-hidden rounded-lg border border-workbench-line bg-workbench-surface shadow-wb-card">
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
              />
            </div>
          </div>
        </div>
        <ToastViewport />
      </WorkbenchPanel>
    </ErrorBoundary>
  );
}
