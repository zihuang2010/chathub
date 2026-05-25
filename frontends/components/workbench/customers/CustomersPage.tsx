import { useCallback, useEffect, useMemo, useState } from "react";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ToastViewport, showToast } from "@/components/ui/toast";
import { WorkbenchPanel } from "@/components/workbench/WorkbenchPanel";
import { adaptFriendDetailToCustomer, adaptFriendToCustomer } from "@/lib/api/customers";
import { useFriendDetail } from "@/lib/api/useFriendDetail";
import { useFriends } from "@/lib/api/useFriends";
import type { Account } from "@/lib/types/account";

import { DEFAULT_CARD_DENSITY, DEFAULT_PAGE_SIZE, type CardDensity } from "./constants";
import { CustomerDetailPanel } from "./CustomerDetailPanel";
import { CustomerList } from "./CustomerList";
import { CustomersHeader } from "./CustomersHeader";
import { downloadCsv, toCsv } from "./utils";
import { useCustomerSelection } from "./useCustomerSelection";
import { useCustomerStore } from "./useCustomerStore";
import { STRINGS } from "./strings";

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
const SEARCH_DEBOUNCE_MS = 350;

export function CustomersPage({
  accounts,
  pendingAccountFilter,
  onConsumePendingFilter,
}: CustomersPageProps) {
  // 受控的账号筛选 state:同时驱动 API 入参(列表请求)与详情归属解析。
  const [selectedAccountIds, setSelectedAccountIds] =
    useState<ReadonlySet<string>>(EMPTY_ACCOUNTS_SET);

  // API 入参账号:UI 没选时拉所有可见账号。
  const apiAccountIds = useMemo(() => {
    if (selectedAccountIds.size > 0) {
      return [...selectedAccountIds].sort();
    }
    return accounts.map((a) => a.id);
  }, [selectedAccountIds, accounts]);

  // 搜索:输入即时回显,防抖 350ms 后下推服务端 externalId(名称/手机号统一模糊匹配)。
  const [searchInput, setSearchInput] = useState("");
  const [externalId, setExternalId] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setExternalId(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [searchInput]);

  // cursor keyset 分页 + 前端页缓存。账号集 / externalId / pageSize 变化 → 重置 cursor 从首页重拉。
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const { friends, loading, error, page, canPrev, canNext, prevPage, nextPage } = useFriends(
    apiAccountIds,
    { externalId },
    pageSize,
  );

  // 卡片网格密度（舒适 / 紧凑），对应头部右上角两个视图切换按钮。
  const [density, setDensity] = useState<CardDensity>(DEFAULT_CARD_DENSITY);

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

  // 本地态(星标 / 标签)叠加层。loadMore / refresh 重拉时按 React 官方 prop-reset
  // 模式重置 —— 真接口暂无 patch API,本地编辑会被下一次重拉覆盖,属预期行为。
  const store = useCustomerStore(adapted);
  const visibleCustomers = store.customers;
  const selection = useCustomerSelection();

  const [requestedCustomerId, setRequestedCustomerId] = useState<string | null>(null);

  // 渲染期派生有效的激活客户:若用户选中的客户被过滤掉,则回退到第一条;空列表为 null。
  const activeCustomerId = useMemo(() => {
    if (visibleCustomers.length === 0) return null;
    if (requestedCustomerId && visibleCustomers.some((c) => c.id === requestedCustomerId)) {
      return requestedCustomerId;
    }
    return visibleCustomers[0].id;
  }, [requestedCustomerId, visibleCustomers]);

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

  // 可见集变化(账号/搜索/翻页)把当前多选收敛到交集。
  const pruneSelection = selection.pruneTo;
  useEffect(() => {
    const visibleIds = new Set(visibleCustomers.map((c) => c.id));
    pruneSelection(visibleIds);
  }, [visibleCustomers, pruneSelection]);

  const activeCustomer = useMemo(
    () => visibleCustomers.find((c) => c.id === activeCustomerId) ?? null,
    [activeCustomerId, visibleCustomers],
  );

  const activeAccount = activeCustomer?.accountId
    ? accounts.find((a) => a.id === activeCustomer.accountId)
    : undefined;

  // 选中客户的好友详情:按 (accountId, externalUserId=id) 拉取,刷新按钮走强制刷新。
  const {
    detail: activeDetail,
    loading: detailLoading,
    refresh: refreshDetail,
  } = useFriendDetail(activeCustomer?.accountId, activeCustomer?.id);
  const handleRefreshDetail = useCallback(() => {
    void refreshDetail(true);
  }, [refreshDetail]);

  // 详情到达后,仅覆盖只读展示字段;starred / tags 仍由 store 负责本地交互,不被覆盖。
  const panelCustomer = useMemo(() => {
    if (!activeCustomer) return null;
    if (!activeDetail) return activeCustomer;
    const d = adaptFriendDetailToCustomer(activeDetail, {
      accountName: activeCustomer.account,
      accountId: activeCustomer.accountId,
    });
    return {
      ...activeCustomer,
      remark: d.remark,
      phone: d.phone,
      company: d.company,
      source: d.source,
      addedAt: d.addedAt,
    };
  }, [activeCustomer, activeDetail]);

  // ── 账号筛选 ─────────────────────────────────────────────────────────────
  const toggleAccount = useCallback((id: string) => {
    setSelectedAccountIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const clearAccounts = useCallback(() => setSelectedAccountIds(EMPTY_ACCOUNTS_SET), []);

  // ── 选中相关 ─────────────────────────────────────────────────────────────
  const selectExactly = selection.selectExactly;
  const isMultiSelectActive = selection.isMultiSelectActive;
  const toggleSelectionMode = selection.toggleMode;

  const onSelectAllInView = useCallback(() => {
    if (!isMultiSelectActive) {
      toggleSelectionMode();
    }
    selectExactly(visibleCustomers.map((c) => c.id));
  }, [visibleCustomers, isMultiSelectActive, selectExactly, toggleSelectionMode]);

  const allSelectedInView = useMemo(() => {
    if (visibleCustomers.length === 0) return false;
    return visibleCustomers.every((c) => selection.selectedIds.has(c.id));
  }, [visibleCustomers, selection.selectedIds]);

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

  const handleOpenChat = useCallback((customerId: string) => {
    showToast(`将打开与该客户的会话(${customerId})`, { type: "info" });
  }, []);

  const handleCall = useCallback(
    (customerId: string) => {
      const phone = store.customers.find((c) => c.id === customerId)?.phone;
      showToast(STRINGS.toasts.callStub(phone || "—"), { type: "info" });
    },
    [store.customers],
  );

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

  const hasActiveFilters = searchInput.trim().length > 0 || selectedAccountIds.size > 0;

  const handleClearFilters = useCallback(() => {
    setSearchInput("");
    setSelectedAccountIds(EMPTY_ACCOUNTS_SET);
  }, []);

  const handleEditCustomer = useCallback((id: string) => {
    showToast(`将打开客户编辑面板(${id})`, { type: "info" });
  }, []);
  const handleRowMore = useCallback(() => {
    showToast(STRINGS.toasts.moreActionsStub, { type: "info" });
  }, []);
  const handleSeeMoreRecords = useCallback(() => {
    showToast(STRINGS.toasts.seeMoreRecordsStub, { type: "info" });
  }, []);

  return (
    <ErrorBoundary>
      <WorkbenchPanel>
        <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
          <CustomersHeader
            searchTerm={searchInput}
            onSearchChange={setSearchInput}
            accounts={accounts}
            selectedAccountIds={selectedAccountIds}
            onToggleAccount={toggleAccount}
            onClearAccounts={clearAccounts}
            onReset={handleClearFilters}
            density={density}
            onDensityChange={setDensity}
          />

          <div className="flex min-h-0 flex-1 gap-2 overflow-hidden bg-workbench-surface-subtle p-2">
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-workbench-line bg-workbench-surface shadow-wb-card">
              <CustomerList
                customers={visibleCustomers}
                loadedCount={visibleCustomers.length}
                loading={loading}
                accounts={accounts}
                activeCustomerId={activeCustomerId}
                density={density}
                page={page}
                pageSize={pageSize}
                canPrev={canPrev}
                canNext={canNext}
                onPrevPage={prevPage}
                onNextPage={nextPage}
                onPageSizeChange={setPageSize}
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
                onCall={handleCall}
                onMore={handleRowMore}
                hasActiveFilters={hasActiveFilters}
                onClearFilters={handleClearFilters}
              />
            </div>
            <div className="overflow-hidden rounded-lg border border-workbench-line bg-workbench-surface shadow-wb-card">
              <CustomerDetailPanel
                customer={panelCustomer}
                account={activeAccount}
                onAddTag={handleAddTag}
                onRemoveTag={handleRemoveTag}
                onToggleStar={() => {
                  if (activeCustomer) handleToggleStar(activeCustomer.id);
                }}
                onOpenChat={handleOpenChat}
                onCall={handleCall}
                onEditCustomer={handleEditCustomer}
                onMore={handleRowMore}
                onSeeMoreRecords={handleSeeMoreRecords}
                onRefresh={handleRefreshDetail}
                refreshing={detailLoading}
              />
            </div>
          </div>
        </div>
        <ToastViewport />
      </WorkbenchPanel>
    </ErrorBoundary>
  );
}
