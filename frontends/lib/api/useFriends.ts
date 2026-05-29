// 好友(客户)列表 hook —— cursor keyset 分页 + 前端页缓存 + 上一页/下一页。
//
// 数据流:
//   - 首页(page 0)由 useResource 接管:订阅 ChangeBus topic="friends" +
//     scope={employeeId, wecomAccountId?},FRIEND_* 事件 → 自动重拉首页并清缓存。
//     新增好友按 add_time DESC 天然浮顶,首页重拉即可见;删除好友重拉后消失。
//   - 续页(page 1..N)由 nextPage 远端 cursor 续拉,push 进本地 tailPages 缓存。
//   - **上一页纯命中缓存**(cursor 单向无法回退,已翻页面必须缓存);下一页只在未缓存时请求。
//   - 当前展示 = allPages[pageIndex] 单页(不再跨页累积)。
//
// **降自动重拉**:刻意关闭 useResource 的 focus 刷新 + 90s 静默探活(refetchOnFocus=false,
//   silentProbeMs=0)。客户数据非实时,只靠"显式刷新 + FRIEND_* 事件失效"驱动重拉,
//   避免每次窗口聚焦/空闲探活都打 listFriends 业务接口。
//
// **scope 选择**:
//   - 单 account 入参 → scope.wecomAccountId 带,精准 match(其他账号事件不刷新)
//   - 多 account 入参 → scope 仅 employee 维度,任何 account 事件都刷新(广义订阅)
//   - 空 accountIds → enabled=false,不拉不订阅
//
// **fullScope(全量,按 token 圈定)**:置 true 时不按账号过滤 —— 请求体省略 wecomAccountIds,
//   由业务后台按登录账号(Bearer token)纬度返回全部好友。此时空 accountIds 不再表示禁用,
//   而是「全量拉取」。默认 false 保持原「空 accountIds = 禁用」语义,调用方零改动。
//
// 筛选(externalName / 加好友时间区间)与 pageSize 下推服务端;任一变化 → 重置 cursor 从首页重拉。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useCurrentEmployeeId } from "@/lib/data/useCurrentEmployeeId";
import { useResource } from "@/lib/data/useResource";

import { fetchFriends, type WecomFriend } from "./customers";

const DEFAULT_PAGE_SIZE = 20;

export interface UseFriendsFilters {
  /** 按名称模糊匹配。 */
  externalName?: string;
  /** 加好友时间下界 `yyyy-MM-dd HH:mm:ss`。 */
  addStartTime?: string;
  /** 加好友时间上界 `yyyy-MM-dd HH:mm:ss`。 */
  addEndTime?: string;
}

export interface UseFriendsResult {
  /** 当前页的客户(单页,非累积)。 */
  friends: WecomFriend[];
  loading: boolean;
  error: string | null;
  /** 1-based 当前页码。 */
  page: number;
  /** 能否回上一页(pageIndex>0,纯缓存命中)。 */
  canPrev: boolean;
  /** 能否去下一页(已缓存下一页 或 末页 hasMore)。 */
  canNext: boolean;
  prevPage: () => void;
  nextPage: () => Promise<void>;
  refresh: () => Promise<void>;
}

/** 一页的本地快照:服务端已按 keyset 排好序,无需再排。 */
interface FriendsPage {
  records: WecomFriend[];
  nextCursor: string;
  hasMore: boolean;
}

export function useFriends(
  accountIds: string[],
  filters?: UseFriendsFilters,
  pageSize: number = DEFAULT_PAGE_SIZE,
  fullScope: boolean = false,
): UseFriendsResult {
  const employeeId = useCurrentEmployeeId();
  const sortedAccountIds = useMemo(() => [...accountIds].sort(), [accountIds]);
  // 请求体账号集:fullScope → 空(请求体省略 wecomAccountIds,后台按 token 全量);否则按选中账号过滤。
  const requestAccountIds = useMemo(
    () => (fullScope ? [] : sortedAccountIds),
    [fullScope, sortedAccountIds],
  );
  // 能否拉取:fullScope 恒可拉(空集合=全量);否则维持「空 accountIds = 禁用」原语义。
  const enabledByAccounts = fullScope || sortedAccountIds.length > 0;
  const accountKey = requestAccountIds.join(",");
  const scopeAccount = requestAccountIds.length === 1 ? requestAccountIds[0] : undefined;

  const externalName = filters?.externalName ?? "";
  const addStartTime = filters?.addStartTime ?? "";
  const addEndTime = filters?.addEndTime ?? "";
  // 重拉指纹:筛选 / pageSize 任一变化都从首页重拉(它们不进 scope)。
  const resetKey = `${externalName}|${addStartTime}|${addEndTime}|${pageSize}`;
  // queryFn / nextPage 经 ref 读最新筛选 + pageSize,避免 stale closure。
  const paramsRef = useRef({ externalName, addStartTime, addEndTime, pageSize });
  useEffect(() => {
    paramsRef.current = { externalName, addStartTime, addEndTime, pageSize };
  }, [externalName, addStartTime, addEndTime, pageSize]);

  // 续页缓存(page 1..N)+ 当前页指针。page 0 由 useResource 持有。
  const [tailPages, setTailPages] = useState<FriendsPage[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [tailLoading, setTailLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  // 每次首页重拉自增;nextPage 捕获当代,首页 reset 后旧续页结果丢弃。
  const genRef = useRef(0);

  const resource = useResource<FriendsPage>({
    topic: "friends",
    scope: {
      employeeId: employeeId ?? "",
      wecomAccountId: scopeAccount,
    },
    queryFn: async () => {
      if (!enabledByAccounts) {
        return { records: [], nextCursor: "", hasMore: false };
      }
      const gen = ++genRef.current;
      const p = paramsRef.current;
      const resp = await fetchFriends({
        accountIds: requestAccountIds,
        cursor: "",
        size: p.pageSize,
        externalName: p.externalName,
        addStartTime: p.addStartTime,
        addEndTime: p.addEndTime,
      });
      // 首页落地:清续页缓存 + 回到第一页(仅当仍是最新代)。
      if (gen === genRef.current) {
        setTailPages([]);
        setPageIndex(0);
      }
      return { records: resp.records, nextCursor: resp.nextCursor, hasMore: resp.hasMore };
    },
    enabled: !!employeeId && enabledByAccounts,
    // 降自动重拉:客户数据非实时,关掉聚焦刷新 + 静默探活,只靠事件 + 显式刷新。
    refetchOnFocus: false,
    silentProbeMs: 0,
  });

  const page0 = resource.data;
  const allPages = useMemo<FriendsPage[]>(
    () => (page0 ? [page0, ...tailPages] : []),
    [page0, tailPages],
  );

  // pageIndex 超出范围(首页重拉清缓存 / pageSize 变小)时收敛到末页。
  const safeIndex = allPages.length === 0 ? 0 : Math.min(pageIndex, allPages.length - 1);
  const currentPage = allPages[safeIndex] ?? null;
  const friends = useMemo(() => currentPage?.records ?? [], [currentPage]);

  const lastPage = allPages[allPages.length - 1];
  const canPrev = safeIndex > 0;
  const canNext = safeIndex + 1 < allPages.length || (lastPage?.hasMore ?? false);

  const prevPage = useCallback(() => {
    setPageIndex((i) => (i > 0 ? i - 1 : 0));
  }, []);

  const nextPage = useCallback(async () => {
    if (tailLoading) return;
    // 已缓存:纯指针前移,不请求。
    if (safeIndex + 1 < allPages.length) {
      setPageIndex(safeIndex + 1);
      return;
    }
    const tail = allPages[allPages.length - 1];
    if (!tail || !tail.hasMore || !tail.nextCursor) return;
    if (!enabledByAccounts) return;
    const gen = genRef.current;
    const targetIndex = allPages.length; // 追加后新页所在下标
    setTailLoading(true);
    setLocalError(null);
    try {
      const p = paramsRef.current;
      const resp = await fetchFriends({
        accountIds: requestAccountIds,
        cursor: tail.nextCursor,
        size: p.pageSize,
        externalName: p.externalName,
        addStartTime: p.addStartTime,
        addEndTime: p.addEndTime,
      });
      if (gen !== genRef.current) return; // 首页已重拉,旧续页丢弃
      setTailPages((prev) => [
        ...prev,
        { records: resp.records, nextCursor: resp.nextCursor, hasMore: resp.hasMore },
      ]);
      setPageIndex(targetIndex);
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : String(e));
    } finally {
      setTailLoading(false);
    }
  }, [tailLoading, safeIndex, allPages, requestAccountIds, enabledByAccounts]);

  const refresh = resource.refresh;

  // accountIds 变化时 scope(多账号 scope 不含 wecomAccountId)不变 → useResource 不重拉,
  // 这里主动 refresh。resetKey(筛选 + pageSize,不进 scope)变化同理。跳过 mount(useResource 已拉一次)。
  const prevKeyRef = useRef(`${accountKey}|${resetKey}`);
  useEffect(() => {
    const key = `${accountKey}|${resetKey}`;
    if (prevKeyRef.current === key) return;
    prevKeyRef.current = key;
    if (!employeeId || !enabledByAccounts) return;
    void refresh();
  }, [accountKey, resetKey, employeeId, refresh, enabledByAccounts]);

  return {
    friends,
    loading: resource.loading || tailLoading,
    error: resource.error ?? localError,
    page: safeIndex + 1,
    canPrev,
    canNext,
    prevPage,
    nextPage,
    refresh,
  };
}
