import { useCallback, useState } from "react";

import type { Customer } from "@/lib/types/customer";

export interface CustomerStore {
  customers: Customer[];
  /** 找到 id 对应客户并合并 patch；id 不存在则忽略。 */
  patchCustomer: (id: string, patch: Partial<Customer>) => void;
  /** 一次性给多个 id 应用 patch；用于批量操作。 */
  patchMany: (ids: readonly string[], patch: Partial<Customer>) => void;
  /** 切换关注；返回新值，便于调用方决定 toast 文案。 */
  toggleStarred: (id: string) => boolean;
  /** 批量增删标签：addTags 与 removeTags 可并存。 */
  applyTagDiff: (
    ids: readonly string[],
    diff: { addTags?: readonly string[]; removeTags?: readonly string[] },
  ) => void;
}

/**
 * 客户列表的本地数据源。所有 UI 修改（标签、备注、关注、移交）都走这里，
 * 集中后续接入后端时只改一个地方。
 */
export function useCustomerStore(initial: readonly Customer[]): CustomerStore {
  const [customers, setCustomers] = useState<Customer[]>(() => initial.map((c) => ({ ...c })));

  const patchCustomer = useCallback((id: string, patch: Partial<Customer>) => {
    setCustomers((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }, []);

  const patchMany = useCallback((ids: readonly string[], patch: Partial<Customer>) => {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    setCustomers((prev) => prev.map((c) => (idSet.has(c.id) ? { ...c, ...patch } : c)));
  }, []);

  const toggleStarred = useCallback((id: string): boolean => {
    let nextValue = false;
    setCustomers((prev) =>
      prev.map((c) => {
        if (c.id !== id) return c;
        nextValue = !c.starred;
        return { ...c, starred: nextValue };
      }),
    );
    return nextValue;
  }, []);

  const applyTagDiff = useCallback(
    (
      ids: readonly string[],
      diff: { addTags?: readonly string[]; removeTags?: readonly string[] },
    ) => {
      if (ids.length === 0) return;
      const adds = diff.addTags ?? [];
      const removes = new Set(diff.removeTags ?? []);
      const idSet = new Set(ids);
      setCustomers((prev) =>
        prev.map((c) => {
          if (!idSet.has(c.id)) return c;
          const merged = c.tags.filter((t) => !removes.has(t));
          for (const t of adds) {
            if (!merged.includes(t)) merged.push(t);
          }
          return { ...c, tags: merged };
        }),
      );
    },
    [],
  );

  return { customers, patchCustomer, patchMany, toggleStarred, applyTagDiff };
}
