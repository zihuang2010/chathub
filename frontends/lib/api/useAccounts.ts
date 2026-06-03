// 账号列表的"应用级单一数据源"(C5 迁移到 useResource)。
//
// 数据流:
//   - mount 时拉一次(cache-first,走 Tauri 本地缓存)
//   - 订阅 ChangeBus topic="accounts" + scope={employeeId} → 自动 refetch
//   - refetch({force:true}) 一次性透传 listMine 全量(覆盖 cache)
//
// C5 前是自己 listen("accounts_changed") + 自管 loading/error;
// C5 后这些都由 useResource 集中处理,本 hook 只负责"绑 employeeId + queryFn + 兼容旧 API"。

import { useCallback, useEffect, useMemo, useRef } from "react";

import { useCurrentEmployeeId } from "@/lib/data/useCurrentEmployeeId";
import { useResource } from "@/lib/data/useResource";
import type { Account } from "@/lib/types/account";

import { fetchAccounts } from "./accounts";

export interface UseAccountsResult {
  accounts: Account[];
  loading: boolean;
  error: string | null;
  /** force=true 时绕 cache 透传 listMine。其他场景 cache-first。 */
  refetch: (opts?: { force?: boolean }) => Promise<void>;
}

export function useAccounts(): UseAccountsResult {
  const employeeId = useCurrentEmployeeId();
  // force=true 的"一次性绕 cache"语义:用 ref 跨 queryFn 调用传递,避免改 useResource API
  const forceNextRef = useRef(false);

  const result = useResource<Account[]>({
    topic: "accounts",
    scope: { employeeId: employeeId ?? "" },
    queryFn: async () => {
      const force = forceNextRef.current;
      forceNextRef.current = false;
      return fetchAccounts({ force });
    },
    enabled: !!employeeId,
  });

  // 安全网 #2(spec §6.4-2):resync 路径强制拉 listMine 而非读 cache。useResource 的 resync
  // 分支会 setResyncing(true) 后立即 doFetch();这里在 resyncing false→true 跃迁时置
  // forceNextRef,使紧随(及后续直到下次成功)的 queryFn 透传 force=true 绕 cache。
  // 注:effect 跑在 render 之后,故慢一拍——该次 doFetch 仍 force=false,下一次才 force。
  // 计划已接受该取舍(方案 a 最小改动;严格即时需升级方案 b 改 useResource 公共签名)。
  const prevResyncingRef = useRef(false);
  useEffect(() => {
    const was = prevResyncingRef.current;
    prevResyncingRef.current = result.resyncing;
    if (!was && result.resyncing) {
      forceNextRef.current = true;
    }
  }, [result.resyncing]);

  // refresh 是 useResource 内部 useCallback,引用稳定。但 result 对象每次 render 新,
  // 所以 useCallback 用 result.refresh 而不是 result 作 dep,避免下游闭包/effect 不稳。
  const refresh = result.refresh;
  const refetch = useCallback(
    async (opts?: { force?: boolean }) => {
      if (opts?.force) forceNextRef.current = true;
      await refresh();
    },
    [refresh],
  );

  // 关键:`result.data ?? []` 每次 render 创建新 [],下游 useMemo([accounts]) 会失效引发
  // 死循环("Too many re-renders")。用 useMemo 锁住引用。
  const accounts = useMemo(() => result.data ?? [], [result.data]);

  return {
    accounts,
    loading: result.loading,
    error: result.error,
    refetch,
  };
}
