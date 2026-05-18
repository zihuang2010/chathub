// 好友列表 hook —— 跟随 accountIds 变化自动重拉。
//
// **阶段 2:行存全量化**
//   - 返回全量 `friends: WecomFriend[]`,不再有分页 / filter 入参
//   - listen `friends_changed` 事件 → refetch(走行存,通常零远程往返)
//   - **keepPreviousData 语义**:loading / error / 空账号入参时不清空 `friends`,
//     避免下游 useCustomersFilters 的 tabCounts 闪 0
//   - 跟 useAccounts.ts 的 accounts_changed 同款 effect-driven fetch 风格

import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { fetchFriends, type WecomFriend } from "./customers";

export interface UseFriendsResult {
  friends: WecomFriend[];
  loading: boolean;
  /** 失败时人读字符串;成功为 null。 */
  error: string | null;
  /** 手动刷新(用户点"刷新"按钮)。force=true 跳过 Tauri 行存 TTL 直接透传业务后台。 */
  refetch: (opts?: { force?: boolean }) => Promise<void>;
}

export function useFriends(accountIds: string[]): UseFriendsResult {
  const [friends, setFriends] = useState<WecomFriend[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 入参指纹:账号 ID 顺序无关。useMemo 让 refetch dep 稳定,避免每次 render 重建。
  const accountKey = useMemo(() => [...accountIds].sort().join(","), [accountIds]);

  const refetch = useCallback(
    async (opts?: { force?: boolean }) => {
      // 空账号入参 → 不发请求,但保留 friends 与 error,只清 loading
      if (accountIds.length === 0) {
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const list = await fetchFriends({ accountIds, force: opts?.force });
        setFriends(list);
      } catch (e) {
        const message =
          e && typeof e === "object" && "message" in e
            ? String((e as { message: unknown }).message)
            : String(e);
        setError(message);
        // 不清 friends:保留上次成功的数据,UI 通过 error 做提示
      } finally {
        setLoading(false);
      }
    },
    // accountKey 是稳定指纹,代替 accountIds 做 dep。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accountKey],
  );

  // refetch 是 useCallback,内部 setLoading/setFriends/setError 是数据拉取的合理副作用;
  // 跟 useAccounts.ts 同款 effect-driven fetch 风格保持一致。React 19 的
  // react-hooks/set-state-in-effect 把这种间接 setState 也标为 error,就近豁免。
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refetch();
  }, [refetch]);

  // Subscribe 流推 FRIEND_* 事件后 Tauri 端写完行存 → emit("friends_changed") →
  // 这里 refetch 读行存(不带 force,本地读不走远程)。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void (async () => {
      unlisten = await listen("friends_changed", () => {
        void refetch();
      });
    })();
    return () => {
      unlisten?.();
    };
  }, [refetch]);

  return { friends, loading, error, refetch };
}
