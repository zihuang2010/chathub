import { useCallback, useMemo, useState } from "react";

import type { Customer, CustomerStage, FollowUpStatus } from "@/lib/types/customer";

import { DEFAULT_PAGE_SIZE, type CustomerTab, type SortKey } from "./constants";
import {
  compareCustomers,
  isKeyCustomer,
  isLost,
  isPendingSign,
  isStale30d,
  isTodayNew,
  matchAnyTag,
  matchSearch,
} from "./utils";

export interface CustomersFiltersState {
  activeTab: CustomerTab;
  selectedAccountIds: ReadonlySet<string>;
  searchTerm: string;
  tagFilters: readonly string[];
  stageFilter: ReadonlySet<CustomerStage>;
  followUpFilter: ReadonlySet<FollowUpStatus>;
  sortKey: SortKey;
  page: number;
  pageSize: number;
}

export interface CustomersFiltersResult extends CustomersFiltersState {
  /** 根据当前所有过滤条件计算后的客户列表，已排序。 */
  filteredCustomers: Customer[];
  /** filteredCustomers 的当前页切片。 */
  paginatedCustomers: Customer[];
  /** 总页数（≥1）。 */
  pageCount: number;
  /** 各 Tab 的计数，UI 用于展示徽章数字。 */
  tabCounts: Record<CustomerTab, number>;
  /** 各账号的计数（仅基于 Tab + 搜索 + 标签 + 阶段 + 跟进，不含账号自身的过滤），chips 用。 */
  accountCounts: Record<string, number>;
  /** 现有所有客户中出现过的标签去重列表，给"标签 ▾"下拉用。 */
  knownTags: string[];

  setActiveTab: (tab: CustomerTab) => void;
  toggleAccountId: (id: string) => void;
  clearAccounts: () => void;
  /** 一次性原子写入选中账号集，给跨页跳转（账号页 → 客户页）锁定单账号过滤用。 */
  setSelectedAccountIdsExact: (ids: ReadonlySet<string>) => void;
  setSearchTerm: (term: string) => void;
  toggleTag: (tag: string) => void;
  clearTags: () => void;
  toggleStage: (stage: CustomerStage) => void;
  clearStages: () => void;
  toggleFollowUp: (status: FollowUpStatus) => void;
  clearFollowUps: () => void;
  setSortKey: (key: SortKey) => void;
  setPage: (page: number) => void;
  setPageSize: (size: number) => void;
}

interface Options {
  source: readonly Customer[];
  initialSort?: SortKey;
}

const EMPTY_ACCOUNTS: ReadonlySet<string> = new Set();
const EMPTY_STAGES: ReadonlySet<CustomerStage> = new Set();
const EMPTY_FOLLOW_UPS: ReadonlySet<FollowUpStatus> = new Set();

export function useCustomersFilters({
  source,
  initialSort = "lastContact",
}: Options): CustomersFiltersResult {
  const [activeTab, setActiveTabState] = useState<CustomerTab>("all");
  const [selectedAccountIds, setSelectedAccountIds] = useState<ReadonlySet<string>>(EMPTY_ACCOUNTS);
  const [searchTerm, setSearchTermState] = useState("");
  const [tagFilters, setTagFilters] = useState<readonly string[]>([]);
  const [stageFilter, setStageFilter] = useState<ReadonlySet<CustomerStage>>(EMPTY_STAGES);
  const [followUpFilter, setFollowUpFilter] =
    useState<ReadonlySet<FollowUpStatus>>(EMPTY_FOLLOW_UPS);
  const [sortKey, setSortKeyState] = useState<SortKey>(initialSort);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeState] = useState(DEFAULT_PAGE_SIZE);

  const knownTags = useMemo(() => {
    const set = new Set<string>();
    for (const c of source) for (const t of c.tags) set.add(t);
    return Array.from(set).sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
  }, [source]);

  const matchesTab = useCallback((c: Customer, tab: CustomerTab): boolean => {
    switch (tab) {
      case "all":
        return true;
      case "key":
        return isKeyCustomer(c);
      case "today-new":
        return isTodayNew(c);
      case "stale-30d":
        return isStale30d(c);
      case "pending-sign":
        return isPendingSign(c);
      case "lost":
        return isLost(c);
    }
  }, []);

  // 顺序：账号 → Tab → 阶段 → 跟进 → 标签 → 搜索 → 排序。
  const filteredCustomers = useMemo(() => {
    const result = source.filter((c) => {
      if (selectedAccountIds.size > 0) {
        if (!c.accountId || !selectedAccountIds.has(c.accountId)) return false;
      }
      if (!matchesTab(c, activeTab)) return false;
      if (stageFilter.size > 0) {
        if (!c.stage || !stageFilter.has(c.stage)) return false;
      }
      if (followUpFilter.size > 0) {
        if (!c.followUpStatus || !followUpFilter.has(c.followUpStatus)) return false;
      }
      if (!matchAnyTag(c, tagFilters)) return false;
      if (!matchSearch(c, searchTerm)) return false;
      return true;
    });
    result.sort((a, b) => compareCustomers(a, b, sortKey));
    return result;
  }, [
    activeTab,
    followUpFilter,
    matchesTab,
    searchTerm,
    selectedAccountIds,
    sortKey,
    source,
    stageFilter,
    tagFilters,
  ]);

  const pageCount = Math.max(1, Math.ceil(filteredCustomers.length / pageSize));

  // 数据/筛选缩小但 page 还在大值时收敛到末页；不在 setter 里做，避免外部状态串
  // 一致性问题。这里渲染期派生即可。
  const safePage = Math.min(page, pageCount);

  const paginatedCustomers = useMemo(() => {
    const start = (safePage - 1) * pageSize;
    return filteredCustomers.slice(start, start + pageSize);
  }, [filteredCustomers, pageSize, safePage]);

  const tabCounts = useMemo<Record<CustomerTab, number>>(() => {
    const counts: Record<CustomerTab, number> = {
      all: 0,
      key: 0,
      "today-new": 0,
      "stale-30d": 0,
      "pending-sign": 0,
      lost: 0,
    };
    for (const c of source) {
      // Tab 计数仅按账号过滤，让用户能看到"切到该账号有几个待签约/流失"。
      if (selectedAccountIds.size > 0) {
        if (!c.accountId || !selectedAccountIds.has(c.accountId)) continue;
      }
      counts.all += 1;
      if (isKeyCustomer(c)) counts.key += 1;
      if (isTodayNew(c)) counts["today-new"] += 1;
      if (isStale30d(c)) counts["stale-30d"] += 1;
      if (isPendingSign(c)) counts["pending-sign"] += 1;
      if (isLost(c)) counts.lost += 1;
    }
    return counts;
  }, [selectedAccountIds, source]);

  const accountCounts = useMemo<Record<string, number>>(() => {
    const counts: Record<string, number> = {};
    for (const c of source) {
      if (!matchesTab(c, activeTab)) continue;
      if (stageFilter.size > 0) {
        if (!c.stage || !stageFilter.has(c.stage)) continue;
      }
      if (followUpFilter.size > 0) {
        if (!c.followUpStatus || !followUpFilter.has(c.followUpStatus)) continue;
      }
      if (!matchAnyTag(c, tagFilters)) continue;
      if (!matchSearch(c, searchTerm)) continue;
      const id = c.accountId ?? "__unknown";
      counts[id] = (counts[id] ?? 0) + 1;
    }
    return counts;
  }, [activeTab, followUpFilter, matchesTab, searchTerm, source, stageFilter, tagFilters]);

  // 任意筛选变化都把 page 拉回 1。集中在 setter 里 wrap，避免在 useEffect 里追依赖
  // 又触发额外重渲染或与 selection prune 竞争。
  const setActiveTab = useCallback((tab: CustomerTab) => {
    setActiveTabState(tab);
    setPage(1);
  }, []);

  const toggleAccountId = useCallback((id: string) => {
    setSelectedAccountIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setPage(1);
  }, []);

  const clearAccounts = useCallback(() => {
    setSelectedAccountIds(EMPTY_ACCOUNTS);
    setPage(1);
  }, []);

  const setSelectedAccountIdsExact = useCallback((ids: ReadonlySet<string>) => {
    setSelectedAccountIds(ids);
    setPage(1);
  }, []);

  const setSearchTerm = useCallback((term: string) => {
    setSearchTermState(term);
    setPage(1);
  }, []);

  const toggleTag = useCallback((tag: string) => {
    setTagFilters((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
    setPage(1);
  }, []);

  const clearTags = useCallback(() => {
    setTagFilters([]);
    setPage(1);
  }, []);

  const toggleStage = useCallback((stage: CustomerStage) => {
    setStageFilter((prev) => {
      const next = new Set(prev);
      if (next.has(stage)) next.delete(stage);
      else next.add(stage);
      return next;
    });
    setPage(1);
  }, []);

  const clearStages = useCallback(() => {
    setStageFilter(EMPTY_STAGES);
    setPage(1);
  }, []);

  const toggleFollowUp = useCallback((status: FollowUpStatus) => {
    setFollowUpFilter((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
    setPage(1);
  }, []);

  const clearFollowUps = useCallback(() => {
    setFollowUpFilter(EMPTY_FOLLOW_UPS);
    setPage(1);
  }, []);

  const setSortKey = useCallback((key: SortKey) => {
    setSortKeyState(key);
    // 排序变化不需要重置页：用户期望"在当前结果集排序"而非"跳到第一页"。
  }, []);

  const setPageSize = useCallback((size: number) => {
    setPageSizeState(size);
    setPage(1);
  }, []);

  return {
    activeTab,
    selectedAccountIds,
    searchTerm,
    tagFilters,
    stageFilter,
    followUpFilter,
    sortKey,
    page: safePage,
    pageSize,
    filteredCustomers,
    paginatedCustomers,
    pageCount,
    tabCounts,
    accountCounts,
    knownTags,
    setActiveTab,
    toggleAccountId,
    clearAccounts,
    setSelectedAccountIdsExact,
    setSearchTerm,
    toggleTag,
    clearTags,
    toggleStage,
    clearStages,
    toggleFollowUp,
    clearFollowUps,
    setSortKey,
    setPage,
    setPageSize,
  };
}
