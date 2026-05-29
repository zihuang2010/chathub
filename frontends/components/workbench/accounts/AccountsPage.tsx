import { useCallback } from "react";
import { Plus, RefreshCw } from "lucide-react";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ToastViewport, showToast } from "@/components/ui/toast";
import { WorkbenchPanel } from "@/components/workbench/WorkbenchPanel";
import { downloadCsv } from "@/components/workbench/customers/utils";
import type { UseAccountsResult } from "@/lib/api/useAccounts";

import { AccountCard } from "./AccountCard";
import { AccountListRow } from "./AccountListRow";
import { AccountsKpiStrip } from "./AccountsKpiStrip";
import { AccountsPagination } from "./AccountsPagination";
import { AccountsTabs } from "./AccountsTabs";
import { AccountsToolbar } from "./AccountsToolbar";
import { useAccountsView } from "./useAccountsView";
import { toAccountsCsv } from "./utils";

interface AccountsPageProps {
  /** Workbench 持有的共享账号状态(accounts/loading/error/refetch)。 */
  accountsState: UseAccountsResult;
  /** 卡片点击 → 跳客户页并锁定该账号过滤的回调；状态由 Workbench 持有。 */
  onOpenInCustomers: (accountId: string) => void;
}

export function AccountsPage({ accountsState, onOpenInCustomers }: AccountsPageProps) {
  const { accounts, loading, error, refetch } = accountsState;
  const view = useAccountsView({ accounts });

  const handleExport = useCallback(() => {
    if (view.filteredRows.length === 0) {
      showToast("当前筛选下没有可导出的账号", { type: "info" });
      return;
    }
    const csv = toAccountsCsv(view.filteredRows);
    downloadCsv("accounts", csv);
    showToast(`已导出 ${view.filteredRows.length} 个账号`, { type: "success" });
  }, [view.filteredRows]);

  const handleRefresh = useCallback(async () => {
    // 用户主动点刷新 = 走 force=true 强制透传 listMine,绕过本地 cache
    await refetch({ force: true });
    showToast("已刷新账号列表", { type: "success" });
  }, [refetch]);

  const isFilteredEmpty = !loading && !error && view.totalCount === 0 && view.hasActiveFilters;
  const isTrulyEmpty = !loading && !error && view.totalCount === 0 && !view.hasActiveFilters;

  return (
    <ErrorBoundary>
      <WorkbenchPanel>
        <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
          <PageHeader
            totalAccounts={view.kpis.totalAccounts}
            onlineAccounts={view.kpis.onlineAccounts}
            onRefresh={handleRefresh}
            refreshing={loading}
          />
          <div className="min-h-0 flex-1 overflow-y-auto">
            <AccountsKpiStrip kpis={view.kpis} />

            <AccountsTabs
              activeTab={view.activeTab}
              onTabChange={view.setActiveTab}
              tabCounts={view.tabCounts}
            />

            <AccountsToolbar
              statusSet={view.statusSet}
              toggleStatus={view.toggleStatus}
              clearStatus={view.clearStatus}
              hasActiveFilters={view.hasActiveFilters}
              onReset={view.reset}
              viewMode={view.viewMode}
              setViewMode={view.setViewMode}
              onExport={handleExport}
            />

            <div className="px-4 pb-4">
              {loading ? (
                <LoadingState />
              ) : error ? (
                <ErrorState message={error} onRetry={refetch} />
              ) : isTrulyEmpty ? (
                <EmptyState />
              ) : isFilteredEmpty ? (
                <FilteredEmpty onReset={view.reset} />
              ) : view.viewMode === "grid" ? (
                <div
                  className="grid gap-3"
                  style={{ gridTemplateColumns: "repeat(auto-fill, minmax(264px, 1fr))" }}
                >
                  {view.pageRows.map((row) => (
                    <AccountCard key={row.id} account={row} onOpen={onOpenInCustomers} />
                  ))}
                </div>
              ) : (
                <div className="overflow-hidden rounded-lg border border-workbench-line bg-workbench-surface">
                  {view.pageRows.map((row) => (
                    <AccountListRow key={row.id} account={row} onOpen={onOpenInCustomers} />
                  ))}
                </div>
              )}
            </div>

            {view.totalCount > 0 && (
              <AccountsPagination
                page={view.page}
                pageCount={view.pageCount}
                pageSize={view.pageSize}
                totalCount={view.totalCount}
                onPageChange={view.setPage}
                onPageSizeChange={view.setPageSize}
              />
            )}
          </div>
        </div>
        <ToastViewport />
      </WorkbenchPanel>
    </ErrorBoundary>
  );
}

interface PageHeaderProps {
  totalAccounts: number;
  onlineAccounts: number;
  onRefresh: () => void | Promise<void>;
  refreshing: boolean;
}

function PageHeader({ totalAccounts, onlineAccounts, onRefresh, refreshing }: PageHeaderProps) {
  const handleBind = () => showToast("绑定账号功能开发中", { type: "info" });

  return (
    <header className="flex items-center justify-between gap-4 border-b border-workbench-line bg-workbench-surface px-4 py-4">
      <div className="min-w-0">
        <h1 className="text-[16px] font-semibold leading-tight text-workbench-text">账号管理</h1>
        <p className="mt-1 text-[12px] text-workbench-text-muted">
          管理已绑定的企业微信账号，共
          <span className="wb-num mx-0.5 tabular-nums text-workbench-text-secondary">
            {totalAccounts}
          </span>
          个 · 当前
          <span className="wb-num mx-0.5 tabular-nums text-emerald-600 dark:text-emerald-400">
            {onlineAccounts}
          </span>
          个在线
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => void onRefresh()}
          disabled={refreshing}
          className="focus-ring inline-flex h-9 items-center gap-1.5 rounded-md border border-workbench-line bg-workbench-surface px-3 text-[13px] text-workbench-text transition-colors hover:border-workbench-line-strong disabled:cursor-not-allowed disabled:opacity-60"
        >
          <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
          刷新
        </button>
        <button
          type="button"
          onClick={handleBind}
          className="focus-ring inline-flex h-9 items-center gap-1.5 rounded-md bg-workbench-accent px-3 text-[13px] font-medium text-white transition-colors hover:opacity-90"
        >
          <Plus size={14} strokeWidth={2.5} />
          绑定账号
        </button>
      </div>
    </header>
  );
}

function EmptyState() {
  return (
    <div className="flex h-[280px] flex-col items-center justify-center gap-2 px-6 text-center">
      <p className="text-[14px] font-medium text-workbench-text">还没有账号</p>
      <p className="max-w-[280px] text-[12px] text-workbench-text-muted">
        绑定企业微信账号后，将在此查看每个账号下的客户活跃情况。
      </p>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex h-[280px] flex-col items-center justify-center gap-2 px-6 text-center">
      <RefreshCw size={20} className="animate-spin text-workbench-text-muted" />
      <p className="text-[12px] text-workbench-text-muted">正在加载账号列表…</p>
    </div>
  );
}

function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void | Promise<void>;
}) {
  return (
    <div className="flex h-[280px] flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-[14px] font-medium text-workbench-text">加载账号失败</p>
      <p className="max-w-[360px] break-all text-[12px] text-workbench-text-muted">{message}</p>
      <button
        type="button"
        onClick={() => void onRetry()}
        className="focus-ring mt-1 inline-flex h-7 items-center rounded-md bg-workbench-surface-active px-3 text-[12px] font-medium text-workbench-accent transition-colors hover:bg-workbench-accent hover:text-white"
      >
        点击重试
      </button>
    </div>
  );
}

function FilteredEmpty({ onReset }: { onReset: () => void }) {
  return (
    <div className="flex h-[280px] flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-[14px] font-medium text-workbench-text">没有匹配的账号</p>
      <p className="max-w-[280px] text-[12px] text-workbench-text-muted">
        当前的账号状态筛选条件下没有结果。
      </p>
      <button
        type="button"
        onClick={onReset}
        className="focus-ring mt-1 inline-flex h-7 items-center rounded-md bg-workbench-surface-active px-3 text-[12px] font-medium text-workbench-accent transition-colors hover:bg-workbench-accent hover:text-white"
      >
        重置筛选
      </button>
    </div>
  );
}
