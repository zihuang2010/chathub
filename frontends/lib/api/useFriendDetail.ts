// 好友详情 hook —— 单个外部联系人的详情拉取 + 强制刷新。
//
// 详情非事件驱动(不像 friends/recentFriends 有 ChangeNotice),故不接 useResource:
//   - 两个 id 齐全时自动拉一次(isForceRefresh=false)
//   - id 变化先清空旧详情(避免切客户时残留上一个客户的资料),再重新拉
//   - refresh(true) 走强制刷新(打破一天一次的自动刷新限制)
//   - 代际守卫(genRef)丢弃在途的过期响应

import { useCallback, useEffect, useRef, useState } from "react";

import { fetchFriendDetail, type WecomFriendDetail } from "./customers";

export interface UseFriendDetailResult {
  detail: WecomFriendDetail | null;
  loading: boolean;
  error: string | null;
  /** force 默认 true:用户点刷新按钮即强制刷新。 */
  refresh: (force?: boolean) => Promise<void>;
}

export function useFriendDetail(
  wecomAccountId?: string,
  externalUserId?: string,
): UseFriendDetailResult {
  const [detail, setDetail] = useState<WecomFriendDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const genRef = useRef(0);

  // 切客户(id 变化):渲染期同步清空上一个客户的详情/错误,避免切换瞬间残留旧资料。
  // 用 React 官方「prop 变化时调整 state」模式(useState 跟踪键 + 渲染期比较),而非在
  // effect 里 setState —— 后者触发 cascading renders(eslint react-hooks/set-state-in-effect)。
  // 有 id 时直接进 loading 态等下方 effect 拉取;无 id 时 loading=false 收尾。
  const idKey = `${wecomAccountId ?? ""}|${externalUserId ?? ""}`;
  const [trackedKey, setTrackedKey] = useState(idKey);
  if (trackedKey !== idKey) {
    setTrackedKey(idKey);
    setDetail(null);
    setError(null);
    setLoading(Boolean(wecomAccountId && externalUserId));
  }

  const fetchDetail = useCallback(
    async (force: boolean) => {
      if (!wecomAccountId || !externalUserId) return;
      const gen = ++genRef.current;
      setLoading(true);
      setError(null);
      try {
        const resp = await fetchFriendDetail({
          wecomAccountId,
          externalUserId,
          isForceRefresh: force,
        });
        if (gen !== genRef.current) return;
        setDetail(resp);
      } catch (e) {
        if (gen !== genRef.current) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (gen === genRef.current) setLoading(false);
      }
    },
    [wecomAccountId, externalUserId],
  );

  // id 变化:齐全则自动拉一次(非强制)。清空旧详情/置 loading 已在渲染期完成,
  // 本 effect 只触发「拉取」这一外部副作用。fetchDetail 内部自增 genRef 作废在途响应;
  // 切到无 id 时这里补一次自增,丢弃上一个客户尚未返回的请求。
  useEffect(() => {
    if (!wecomAccountId || !externalUserId) {
      genRef.current++;
      return;
    }
    // fetchDetail 是真实外部副作用(IPC 取数),只能在 effect 触发;其内部「取数前同步置
    // loading=true / 清 error」是标准取数模式。lint 会追踪进 fetchDetail 把这视作 effect 内
    // 同步 setState —— 此处取数确需如此(本 hook 用本地 useState 而非外部 store),按规豁免。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchDetail(false);
  }, [wecomAccountId, externalUserId, fetchDetail]);

  const refresh = useCallback((force = true) => fetchDetail(force), [fetchDetail]);

  return { detail, loading, error, refresh };
}
