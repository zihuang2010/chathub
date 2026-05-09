import { useCallback, useMemo, useState } from "react";

import type { Customer } from "@/lib/types/customer";

import type { CustomerTab, SortKey } from "./constants";
import { compareCustomers, isNewFriend, matchAnyTag, matchSearch, needsFollowUp } from "./utils";

export interface CustomersFiltersState {
  activeTab: CustomerTab;
  selectedAccountIds: ReadonlySet<string>;
  searchTerm: string;
  tagFilters: readonly string[];
  sortKey: SortKey;
}

export interface CustomersFiltersResult extends CustomersFiltersState {
  /** 根据当前所有过滤条件计算后的客户列表，已排序。 */
  filteredCustomers: Customer[];
  /** 各 Tab 的计数，UI 用于展示徽章数字。 */
  tabCounts: Record<CustomerTab, number>;
  /** 各账号的计数（仅基于 Tab + 搜索 + 标签，不含账号自身的过滤），chips 用。 */
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
  setSortKey: (key: SortKey) => void;
}

interface Options {
  source: readonly Customer[];
  initialSort?: SortKey;
}

const EMPTY_ACCOUNTS: ReadonlySet<string> = new Set();

export function useCustomersFilters({
  source,
  initialSort = "lastContact",
}: Options): CustomersFiltersResult {
  const [activeTab, setActiveTab] = useState<CustomerTab>("all");
  const [selectedAccountIds, setSelectedAccountIds] = useState<ReadonlySet<string>>(EMPTY_ACCOUNTS);
  const [searchTerm, setSearchTerm] = useState("");
  const [tagFilters, setTagFilters] = useState<readonly string[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>(initialSort);

  const knownTags = useMemo(() => {
    const set = new Set<string>();
    for (const c of source) for (const t of c.tags) set.add(t);
    return Array.from(set).sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
  }, [source]);

  const matchesTab = useCallback((c: Customer, tab: CustomerTab): boolean => {
    switch (tab) {
      case "all":
        return true;
      case "needs-followup":
        return needsFollowUp(c);
      case "new-friend":
        return isNewFriend(c);
      case "starred":
        return Boolean(c.starred);
    }
  }, []);

  // 顺序：账号 → Tab → 标签 → 搜索 → 排序。
  const filteredCustomers = useMemo(() => {
    const result = source.filter((c) => {
      if (selectedAccountIds.size > 0) {
        if (!c.accountId || !selectedAccountIds.has(c.accountId)) return false;
      }
      if (!matchesTab(c, activeTab)) return false;
      if (!matchAnyTag(c, tagFilters)) return false;
      if (!matchSearch(c, searchTerm)) return false;
      return true;
    });
    result.sort((a, b) => compareCustomers(a, b, sortKey));
    return result;
  }, [activeTab, matchesTab, searchTerm, selectedAccountIds, sortKey, source, tagFilters]);

  const tabCounts = useMemo<Record<CustomerTab, number>>(() => {
    let all = 0;
    let needsFollow = 0;
    let newFriend = 0;
    let starred = 0;
    for (const c of source) {
      // Tab 计数仅按账号过滤，让用户能看到"切到该账号有几个待跟进/新加好友"。
      if (selectedAccountIds.size > 0) {
        if (!c.accountId || !selectedAccountIds.has(c.accountId)) continue;
      }
      all += 1;
      if (needsFollowUp(c)) needsFollow += 1;
      if (isNewFriend(c)) newFriend += 1;
      if (c.starred) starred += 1;
    }
    return {
      all,
      "needs-followup": needsFollow,
      "new-friend": newFriend,
      starred,
    };
  }, [selectedAccountIds, source]);

  const accountCounts = useMemo<Record<string, number>>(() => {
    const counts: Record<string, number> = {};
    for (const c of source) {
      if (!matchesTab(c, activeTab)) continue;
      if (!matchAnyTag(c, tagFilters)) continue;
      if (!matchSearch(c, searchTerm)) continue;
      const id = c.accountId ?? "__unknown";
      counts[id] = (counts[id] ?? 0) + 1;
    }
    return counts;
  }, [activeTab, matchesTab, searchTerm, source, tagFilters]);

  const toggleAccountId = useCallback((id: string) => {
    setSelectedAccountIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const clearAccounts = useCallback(() => {
    setSelectedAccountIds(EMPTY_ACCOUNTS);
  }, []);

  const setSelectedAccountIdsExact = useCallback((ids: ReadonlySet<string>) => {
    setSelectedAccountIds(ids);
  }, []);

  const toggleTag = useCallback((tag: string) => {
    setTagFilters((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
  }, []);

  const clearTags = useCallback(() => {
    setTagFilters([]);
  }, []);

  return {
    activeTab,
    selectedAccountIds,
    searchTerm,
    tagFilters,
    sortKey,
    filteredCustomers,
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
    setSortKey,
  };
}
