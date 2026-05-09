import { useCallback, useMemo, useState } from "react";

import type { Account, AccountStatus } from "@/lib/types/account";

import {
  DEFAULT_PAGE_SIZE,
  type KpiKey,
  type SortKey,
  type TabValue,
  type ViewMode,
} from "./constants";
import { parseStamp } from "./utils";

// ─── Filter / 视图状态形状 ─────────────────────────────────────────────────

export interface DateRange {
  from?: Date;
  to?: Date;
}

interface UseAccountsViewOptions {
  accounts: readonly Account[];
}

interface FilterOption {
  value: string;
  label: string;
}

export interface AccountsKpis {
  totalAccounts: number;
  onlineAccounts: number;
  totalCustomers: number;
  activeCustomers: number;
  totalSessions: number;
  /** "在线率" / "活跃率" 的小数值（0–1），由 KPI 条做百分比格式化。 */
  rates: { online: number; active: number };
  /** "今日新增"系子值（mock 阶段全是固定数）。 */
  today: { newAccounts: number; newCustomers: number; newSessions: number };
}

interface UseAccountsViewResult {
  // ── filter 状态 + setter ──────────────────────────────────────────────
  searchTerm: string;
  setSearchTerm: (s: string) => void;

  activeTab: TabValue;
  setActiveTab: (t: TabValue) => void;

  statusSet: ReadonlySet<AccountStatus>;
  toggleStatus: (s: AccountStatus) => void;
  clearStatus: () => void;

  enterpriseSet: ReadonlySet<string>;
  toggleEnterprise: (e: string) => void;
  clearEnterprise: () => void;

  ownerSet: ReadonlySet<string>;
  toggleOwner: (o: string) => void;
  clearOwner: () => void;

  dateRange: DateRange;
  setDateRange: (r: DateRange) => void;
  clearDateRange: () => void;

  sortKey: SortKey;
  setSortKey: (k: SortKey) => void;

  viewMode: ViewMode;
  setViewMode: (v: ViewMode) => void;

  page: number;
  setPage: (p: number) => void;
  pageSize: number;
  setPageSize: (n: number) => void;

  // ── 派生输出 ──────────────────────────────────────────────────────────
  /** 已 filter+sort 的所有行（不分页），导出 CSV 用。 */
  filteredRows: Account[];
  /** 当前页的行。 */
  pageRows: Account[];
  totalCount: number;
  pageCount: number;
  tabCounts: Record<TabValue, number>;
  kpis: AccountsKpis;
  enterpriseOptions: FilterOption[];
  ownerOptions: FilterOption[];
  hasActiveFilters: boolean;

  // ── 重置 ───────────────────────────────────────────────────────────────
  reset: () => void;
}

// ─── Hook 实现 ──────────────────────────────────────────────────────────────

export function useAccountsView({ accounts }: UseAccountsViewOptions): UseAccountsViewResult {
  const [searchTerm, setSearchTerm] = useState("");
  const [activeTab, setActiveTabState] = useState<TabValue>("all");
  const [statusSet, setStatusSet] = useState<ReadonlySet<AccountStatus>>(new Set());
  const [enterpriseSet, setEnterpriseSet] = useState<ReadonlySet<string>>(new Set());
  const [ownerSet, setOwnerSet] = useState<ReadonlySet<string>>(new Set());
  const [dateRange, setDateRangeState] = useState<DateRange>({});
  const [sortKey, setSortKey] = useState<SortKey>("lastActive");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [page, setPageState] = useState(1);
  const [pageSize, setPageSizeState] = useState<number>(DEFAULT_PAGE_SIZE);

  // 任何过滤变化都把 page 重置到 1，避免"翻到第 3 页后筛掉一半数据→空白页"。
  const setPage = useCallback((p: number) => setPageState(Math.max(1, p)), []);
  const resetToPage1 = useCallback(() => setPageState(1), []);

  const setActiveTab = useCallback(
    (t: TabValue) => {
      setActiveTabState(t);
      resetToPage1();
    },
    [resetToPage1],
  );

  const toggleStatus = useCallback(
    (s: AccountStatus) => {
      setStatusSet((prev) => toggleSet(prev, s));
      resetToPage1();
    },
    [resetToPage1],
  );
  const clearStatus = useCallback(() => {
    setStatusSet(new Set());
    resetToPage1();
  }, [resetToPage1]);

  const toggleEnterprise = useCallback(
    (e: string) => {
      setEnterpriseSet((prev) => toggleSet(prev, e));
      resetToPage1();
    },
    [resetToPage1],
  );
  const clearEnterprise = useCallback(() => {
    setEnterpriseSet(new Set());
    resetToPage1();
  }, [resetToPage1]);

  const toggleOwner = useCallback(
    (o: string) => {
      setOwnerSet((prev) => toggleSet(prev, o));
      resetToPage1();
    },
    [resetToPage1],
  );
  const clearOwner = useCallback(() => {
    setOwnerSet(new Set());
    resetToPage1();
  }, [resetToPage1]);

  const setDateRange = useCallback(
    (r: DateRange) => {
      setDateRangeState(r);
      resetToPage1();
    },
    [resetToPage1],
  );
  const clearDateRange = useCallback(() => {
    setDateRangeState({});
    resetToPage1();
  }, [resetToPage1]);

  const setSearchTermAndReset = useCallback(
    (s: string) => {
      setSearchTerm(s);
      resetToPage1();
    },
    [resetToPage1],
  );

  const setPageSize = useCallback(
    (n: number) => {
      setPageSizeState(n);
      resetToPage1();
    },
    [resetToPage1],
  );

  // ── 派生 filter options（企业 / 负责人）────────────────────────────────
  const enterpriseOptions = useMemo<FilterOption[]>(() => {
    const set = new Set<string>();
    for (const a of accounts) {
      if (a.enterprise) set.add(a.enterprise);
    }
    return Array.from(set)
      .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"))
      .map((v) => ({ value: v, label: v }));
  }, [accounts]);

  const ownerOptions = useMemo<FilterOption[]>(() => {
    const set = new Set<string>();
    for (const a of accounts) {
      if (a.ownerName) set.add(a.ownerName);
    }
    return Array.from(set)
      .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"))
      .map((v) => ({ value: v, label: v }));
  }, [accounts]);

  // ── 应用全部 filter ────────────────────────────────────────────────────
  const filteredRows = useMemo<Account[]>(() => {
    const q = searchTerm.trim().toLowerCase();
    const fromTime = dateRange.from ? startOfDay(dateRange.from).getTime() : -Infinity;
    const toTime = dateRange.to ? endOfDay(dateRange.to).getTime() : Infinity;

    const filtered = accounts.filter((a) => {
      // Tab 优先；activeTab 选择会把状态 set 限定到一个值，但 statusSet 的多选独立。
      if (activeTab !== "all" && a.status !== activeTab) return false;
      if (statusSet.size > 0 && !statusSet.has(a.status ?? "offline")) return false;
      if (enterpriseSet.size > 0 && !enterpriseSet.has(a.enterprise ?? "")) return false;
      if (ownerSet.size > 0 && !ownerSet.has(a.ownerName ?? "")) return false;

      if (a.createdAt) {
        const t = parseStamp(a.createdAt).getTime();
        if (t < fromTime || t > toTime) return false;
      } else if (dateRange.from || dateRange.to) {
        // 没有 createdAt 的账号在用日期范围筛时不应该出现
        return false;
      }

      if (q) {
        const haystack = [a.name, a.ownerName, a.enterprise]
          .filter((v): v is string => Boolean(v))
          .map((v) => v.toLowerCase());
        if (!haystack.some((h) => h.includes(q))) return false;
      }
      return true;
    });

    return filtered.sort((a, b) => compareAccounts(a, b, sortKey));
  }, [accounts, searchTerm, activeTab, statusSet, enterpriseSet, ownerSet, dateRange, sortKey]);

  const totalCount = filteredRows.length;
  const pageCount = Math.max(1, Math.ceil(totalCount / pageSize));
  const safePage = Math.min(page, pageCount);
  const pageRows = useMemo(
    () => filteredRows.slice((safePage - 1) * pageSize, safePage * pageSize),
    [filteredRows, safePage, pageSize],
  );

  // ── KPI（从全量 accounts，不受 filter 影响）──────────────────────────────
  const kpis = useMemo<AccountsKpis>(() => {
    const total = accounts.length;
    const online = accounts.filter((a) => a.status === "online").length;
    const totalCustomers = sum(accounts.map((a) => a.customerCount ?? 0));
    const totalSessions = sum(accounts.map((a) => a.sessionCount ?? 0));
    const activeCustomers = Math.round(totalCustomers * 0.281); // 28.1% 活跃率（参考图）
    return {
      totalAccounts: total,
      onlineAccounts: online,
      totalCustomers,
      activeCustomers,
      totalSessions,
      rates: {
        online: total === 0 ? 0 : online / total,
        active: totalCustomers === 0 ? 0 : activeCustomers / totalCustomers,
      },
      today: { newAccounts: 2, newCustomers: 342, newSessions: 589 },
    };
  }, [accounts]);

  // ── Tab 计数（不算其它 filter，单纯 status 维度）────────────────────────
  const tabCounts = useMemo<Record<TabValue, number>>(() => {
    const out: Record<TabValue, number> = {
      all: accounts.length,
      online: 0,
      abnormal: 0,
      offline: 0,
    };
    for (const a of accounts) {
      const s = a.status ?? "offline";
      out[s] += 1;
    }
    return out;
  }, [accounts]);

  const hasActiveFilters =
    searchTerm.trim().length > 0 ||
    activeTab !== "all" ||
    statusSet.size > 0 ||
    enterpriseSet.size > 0 ||
    ownerSet.size > 0 ||
    Boolean(dateRange.from || dateRange.to);

  const reset = useCallback(() => {
    setSearchTerm("");
    setActiveTabState("all");
    setStatusSet(new Set());
    setEnterpriseSet(new Set());
    setOwnerSet(new Set());
    setDateRangeState({});
    resetToPage1();
  }, [resetToPage1]);

  return {
    searchTerm,
    setSearchTerm: setSearchTermAndReset,
    activeTab,
    setActiveTab,
    statusSet,
    toggleStatus,
    clearStatus,
    enterpriseSet,
    toggleEnterprise,
    clearEnterprise,
    ownerSet,
    toggleOwner,
    clearOwner,
    dateRange,
    setDateRange,
    clearDateRange,
    sortKey,
    setSortKey,
    viewMode,
    setViewMode,
    page: safePage,
    setPage,
    pageSize,
    setPageSize,
    filteredRows,
    pageRows,
    totalCount,
    pageCount,
    tabCounts,
    kpis,
    enterpriseOptions,
    ownerOptions,
    hasActiveFilters,
    reset,
  };
}

// ─── KPI helper：根据 KpiKey 拿格式化后的字符串 ─────────────────────────────
// 由 AccountsKpiStrip 调用。

export function getKpiValue(kpis: AccountsKpis, key: KpiKey): string {
  switch (key) {
    case "totalAccounts":
      return String(kpis.totalAccounts);
    case "onlineAccounts":
      return String(kpis.onlineAccounts);
    case "totalCustomers":
      return kpis.totalCustomers.toLocaleString("en-US");
    case "activeCustomers":
      return kpis.activeCustomers.toLocaleString("en-US");
    case "totalSessions":
      return kpis.totalSessions.toLocaleString("en-US");
  }
}

export function getKpiSubValue(kpis: AccountsKpis, key: KpiKey): string {
  switch (key) {
    case "totalAccounts":
      return String(kpis.today.newAccounts);
    case "onlineAccounts":
      return `${(kpis.rates.online * 100).toFixed(1)}%`;
    case "totalCustomers":
      return String(kpis.today.newCustomers);
    case "activeCustomers":
      return `${(kpis.rates.active * 100).toFixed(1)}%`;
    case "totalSessions":
      return String(kpis.today.newSessions);
  }
}

// ─── 内部工具 ───────────────────────────────────────────────────────────────

function toggleSet<T>(prev: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(prev);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function sum(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

function compareAccounts(a: Account, b: Account, key: SortKey): number {
  const byName = a.name.localeCompare(b.name, "zh-Hans-CN");
  switch (key) {
    case "lastActive": {
      const at = a.lastActiveAt ? Date.parse(a.lastActiveAt) : 0;
      const bt = b.lastActiveAt ? Date.parse(b.lastActiveAt) : 0;
      return bt - at || byName;
    }
    case "customers":
      return (b.customerCount ?? 0) - (a.customerCount ?? 0) || byName;
    case "sessions":
      return (b.sessionCount ?? 0) - (a.sessionCount ?? 0) || byName;
    case "createdAt": {
      const at = a.createdAt ? parseStamp(a.createdAt).getTime() : 0;
      const bt = b.createdAt ? parseStamp(b.createdAt).getTime() : 0;
      return bt - at || byName;
    }
    case "name":
      return byName;
  }
}
