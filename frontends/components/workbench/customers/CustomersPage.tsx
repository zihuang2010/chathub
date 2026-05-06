import { useCallback, useEffect, useMemo, useState } from "react";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ToastViewport, showToast } from "@/components/ui/toast";
import { WorkbenchPanel } from "@/components/workbench/WorkbenchPanel";

import { BulkActionsBar } from "./BulkActionsBar";
import { CustomerDetailPanel } from "./CustomerDetailPanel";
import { CustomerList } from "./CustomerList";
import { CustomersHeader } from "./CustomersHeader";
import { MOCK_ACCOUNTS, MOCK_CUSTOMERS, MOCK_RECENT_MESSAGES } from "./data";
import { STRINGS } from "./strings";
import { downloadCsv, toCsv } from "./utils";
import { useCustomersFilters } from "./useCustomersFilters";
import { useCustomerSelection } from "./useCustomerSelection";
import { useCustomerStore } from "./useCustomerStore";

export function CustomersPage() {
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

  // 切 Tab 时退出多选模式（计划 §10）。
  const exitSelection = selection.exit;
  useEffect(() => {
    exitSelection();
  }, [exitSelection, filters.activeTab]);

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

  const onSelectAllInView = useCallback(() => {
    selection.selectMany(filters.filteredCustomers.map((c) => c.id));
  }, [filters.filteredCustomers, selection]);

  const allSelectedInView = useMemo(() => {
    if (filters.filteredCustomers.length === 0) return false;
    return filters.filteredCustomers.every((c) => selection.selectedIds.has(c.id));
  }, [filters.filteredCustomers, selection.selectedIds]);

  const handleSelectCustomer = useCallback(
    (id: string) => {
      if (selection.isMultiSelectActive) {
        selection.toggle(id);
      } else {
        setRequestedCustomerId(id);
      }
    },
    [selection],
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
      if (activeCustomer.tags.includes(tag)) return;
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
    // 真实实现需要切到 messages 页并定位到对应会话。当前 Workbench 没有跨段路由
    // API，先用 toast 提示，后续接通时只改这里一处。
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

  return (
    <ErrorBoundary>
      <WorkbenchPanel>
        <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-workbench-surface">
          <CustomersHeader
            activeTab={filters.activeTab}
            onTabChange={filters.setActiveTab}
            tabCounts={filters.tabCounts}
            accounts={MOCK_ACCOUNTS}
            selectedAccountIds={filters.selectedAccountIds}
            accountCounts={filters.accountCounts}
            onToggleAccount={filters.toggleAccountId}
            onClearAccounts={filters.clearAccounts}
            knownTags={filters.knownTags}
            tagFilters={filters.tagFilters}
            onToggleTag={filters.toggleTag}
            onClearTags={filters.clearTags}
            sortKey={filters.sortKey}
            onSortChange={filters.setSortKey}
            searchTerm={filters.searchTerm}
            onSearchChange={filters.setSearchTerm}
            isMultiSelectActive={selection.isMultiSelectActive}
            onToggleBulk={selection.toggleMode}
          />

          {selection.isMultiSelectActive && (
            <BulkActionsBar
              selectedCount={selection.count}
              allStarred={allSelectedStarred}
              knownTags={filters.knownTags}
              onApplyTagDiff={handleBulkApplyTagDiff}
              onReassign={handleBulkReassign}
              onToggleStar={handleBulkToggleStar}
              onExport={handleBulkExport}
              onCancel={selection.exit}
            />
          )}

          <div className="flex min-h-0 flex-1 overflow-hidden">
            <div className="flex min-w-0 flex-1 flex-col">
              <CustomerList
                customers={filters.filteredCustomers}
                accounts={MOCK_ACCOUNTS}
                activeTab={filters.activeTab}
                activeCustomerId={activeCustomerId}
                multiSelectActive={selection.isMultiSelectActive}
                selectedIds={selection.selectedIds}
                allSelectedInView={allSelectedInView}
                onSelectCustomer={handleSelectCustomer}
                onToggleStar={handleToggleStar}
                onToggleMultiSelect={selection.toggle}
                onSelectAllInView={onSelectAllInView}
                onClearSelection={selection.clear}
              />
            </div>
            <CustomerDetailPanel
              customer={activeCustomer}
              account={activeAccount}
              recentMessages={recentMessages}
              onPatch={handlePatch}
              onAddTag={handleAddTag}
              onRemoveTag={handleRemoveTag}
              onToggleStar={() => activeCustomer && handleToggleStar(activeCustomer.id)}
              onOpenChat={handleOpenChat}
            />
          </div>
        </div>
        <ToastViewport />
      </WorkbenchPanel>
    </ErrorBoundary>
  );
}
