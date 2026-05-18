// 账号列表的"应用级单一数据源"。挂在 Workbench 一份,Accounts/Customers 等所有用到
// account 数组的子页面都从同一份 state 读 —— 避免每个页面各自 fetch 造成的不一致。
//
// 2026-05-17:Tauri 端 cache-first + Subscribe 流推 ACCOUNT_* 事件后 emit
// `accounts_changed`,这里 listen 后 refetch(无 force)即读本地 cache;手动刷新按钮
// 走 refetch(force=true)透传 listMine 全量重拉。

import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import type { Account } from "@/lib/types/account";

import { fetchAccounts } from "./accounts";

export interface UseAccountsResult {
  accounts: Account[];
  loading: boolean;
  /** 失败时的人读字符串;成功为 null。 */
  error: string | null;
  /** 手动刷新(账号页"刷新"按钮接通这里);默认透传 listMine 全量重拉。 */
  refetch: (opts?: { force?: boolean }) => Promise<void>;
}

export function useAccounts(): UseAccountsResult {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async (opts?: { force?: boolean }) => {
    setLoading(true);
    setError(null);
    try {
      const list = await fetchAccounts({ force: opts?.force });
      setAccounts(list);
    } catch (e) {
      const message =
        e && typeof e === "object" && "message" in e
          ? String((e as { message: unknown }).message)
          : String(e);
      setError(message);
      setAccounts([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refetch();
  }, [refetch]);

  // Subscribe 流推 ACCOUNT_* 事件后 Tauri 端写完 cache → emit("accounts_changed") →
  // 这里 refetch 读 cache(不带 force,本地读不走远程)。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void (async () => {
      unlisten = await listen("accounts_changed", () => {
        void refetch();
      });
    })();
    return () => {
      unlisten?.();
    };
  }, [refetch]);

  return { accounts, loading, error, refetch };
}
