// 接待好友列表 Hook(C5 迁移到 useResource)。
//
// 三态共存:
//   1. 默认列表(本地行存秒开 + 远端尾部 cursor 分页 + 多键 reorder)
//   2. 筛选列表(纯远端,搜索/onlyUnread 期间,不订阅事件)
//   3. cursor/hasMore 各自维护
//
// 数据流(C5 重构):
//   - **默认列表 cache 由 useResource 接管**:订阅 topic="recent-sessions",
//     scope={employeeId, wecomAccountId?},自动接 hub:change 事件刷
//   - mount + accountFilter 变化时,除 useResource 内部拉本地 cache 外,
//     手动调一次 refreshFirstPage(远端首页 + 写库) — 写完后端 emit LocalCommand
//     ChangeNotice → useResource 自动再读一次 cache 拿到最新数据
//   - lastEventAt / lastRefreshAt / connectionState / resyncing 全部来自 useResource
//   - 静默探活 / focus refresh / hub:resync 全部由 useResource 集中处理
//
// 保留的本地 state:
//   - remoteTailItems(loadMore 远端尾部 snapshot)
//   - filtered + cursor / loading / hasMore(搜索态独立)
//   - filteredQueryRef(区分默认/筛选模式)

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  fetchRecentFriendsCache,
  fetchRecentFriendsPage,
  pinConversation,
  setConversationDraft,
  setConversationRemoved,
  type RecentFriendItem,
  type RecentFriendListRecord,
} from "./recentFriends";
import { useCurrentEmployeeId } from "@/lib/data/useCurrentEmployeeId";
import { useResource, type HubConnectionState } from "@/lib/data/useResource";

// 重导出 HubConnectionState 供消费方(SyncStatusBadge)用
export type { HubConnectionState };

const DEFAULT_PAGE_SIZE = 20;

export interface RecentFriendsFilters {
  externalName?: string;
  externalMobile?: string;
  onlyUnread?: boolean;
}

export interface UseRecentFriendsOptions {
  /** 顶部账号选择器选中的账号 ID;`null` / 空 表示"全部"。 */
  accountFilter: string | null;
}

export interface UseRecentFriendsResult {
  items: RecentFriendListEntry[];
  defaultLoading: boolean;
  defaultHasMore: boolean;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;

  filtered: RecentFriendListEntry[] | null;
  filteredLoading: boolean;
  filteredHasMore: boolean;
  searchRemote: (filters: RecentFriendsFilters) => Promise<void>;
  loadMoreFiltered: () => Promise<void>;
  exitFilter: () => Promise<void>;

  pin: (conversationId: string, pinned: boolean) => Promise<void>;
  setDraft: (conversationId: string, text: string) => Promise<void>;
  /** V11:软移除会话。后端 UPDATE + ChangeNotice → useResource refetch → 行从默认列表消失。 */
  remove: (conversationId: string) => Promise<void>;

  error: string | null;
  lastEventAt: number | null;
  lastRefreshAt: number | null;
  resyncing: boolean;
  connectionState: HubConnectionState | null;
  /** 首次本地 cache 是否已读出。供消费方"首屏数据门"用,避免假数据闪。 */
  initialFetched: boolean;
}

export interface RecentFriendListEntry {
  conversationId: string;
  wecomAccountId: string;
  wecomName: string;
  wecomAccount: string;
  wecomAlias: string;
  externalUserId: string;
  externalName: string;
  externalAvatar: string;
  externalMobile: string;
  lastLocalMessageId: string;
  lastMessageType: number;
  lastMessageDirection: number;
  lastSendStatus: number;
  lastMessageSummary: string;
  lastMessageTimeMs: number;
  unreadCount: number;
  hasUnread: boolean;
  pinned: boolean;
  pinnedAtMs: number;
  localDraftAtMs: number;
  localDraftText: string;
  removed: boolean;
  removedAtMs: number;
}

function fromCacheItem(it: RecentFriendItem): RecentFriendListEntry {
  return {
    conversationId: it.conversationId,
    wecomAccountId: it.wecomAccountId,
    wecomName: it.wecomName,
    wecomAccount: it.wecomAccount,
    wecomAlias: it.wecomAlias,
    externalUserId: it.externalUserId,
    externalName: it.externalName,
    externalAvatar: it.externalAvatar,
    externalMobile: it.externalMobile,
    lastLocalMessageId: it.lastLocalMessageId,
    lastMessageType: it.lastMessageType,
    lastMessageDirection: it.lastMessageDirection,
    lastSendStatus: it.lastSendStatus,
    lastMessageSummary: it.lastMessageSummary,
    lastMessageTimeMs: it.lastMessageTimeMs,
    unreadCount: it.unreadCount,
    hasUnread: it.hasUnread,
    pinned: it.pinned,
    pinnedAtMs: it.pinnedAtMs,
    localDraftAtMs: it.localDraftAtMs,
    localDraftText: it.localDraftText,
    removed: it.removed,
    removedAtMs: it.removedAtMs,
  };
}

function fromRemoteRecord(r: RecentFriendListRecord): RecentFriendListEntry {
  return {
    conversationId: r.conversationId,
    wecomAccountId: r.wecomAccountId,
    wecomName: r.wecomName,
    wecomAccount: r.wecomAccount,
    wecomAlias: r.wecomAlias,
    externalUserId: r.externalUserId,
    externalName: r.externalName,
    externalAvatar: r.externalAvatar,
    externalMobile: r.externalMobile,
    lastLocalMessageId: r.lastLocalMessageId,
    lastMessageType: r.lastMessageType,
    lastMessageDirection: r.lastMessageDirection,
    lastSendStatus: r.lastSendStatus,
    lastMessageSummary: r.lastMessageSummary,
    lastMessageTimeMs: isoToMs(r.lastMessageTime),
    unreadCount: r.unreadCount,
    hasUnread: r.hasUnread,
    pinned: false,
    pinnedAtMs: 0,
    localDraftAtMs: 0,
    localDraftText: "",
    // 远端 record 没有"本地软移除"概念,搜索结果天然可见
    removed: false,
    removedAtMs: 0,
  };
}

function isoToMs(s: string): number {
  if (!s) return 0;
  const n = Date.parse(s);
  return Number.isFinite(n) ? n : 0;
}

function multiKeySort(items: RecentFriendListEntry[]): RecentFriendListEntry[] {
  return [...items].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.pinned && b.pinned) {
      const d = b.pinnedAtMs - a.pinnedAtMs;
      if (d !== 0) return d;
    }
    const effA = Math.max(a.lastMessageTimeMs, a.localDraftAtMs);
    const effB = Math.max(b.lastMessageTimeMs, b.localDraftAtMs);
    if (effA !== effB) return effB - effA;
    return b.lastMessageTimeMs - a.lastMessageTimeMs;
  });
}

function dedupeById(items: RecentFriendListEntry[]): RecentFriendListEntry[] {
  const map = new Map<string, RecentFriendListEntry>();
  for (const it of items) map.set(it.conversationId, it);
  return Array.from(map.values());
}

function errorMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}

export function useRecentFriends(opts: UseRecentFriendsOptions): UseRecentFriendsResult {
  const { accountFilter } = opts;
  const employeeId = useCurrentEmployeeId();

  // ─── 默认列表 cache(由 useResource 集中管理) ─────────────────────────────
  // 订阅 recent-sessions topic + scope=(employeeId, wecomAccountId?)。
  // 任何 ChangeNotice 匹配此 scope → useResource 自动调 queryFn 重读本地行存。
  const resource = useResource<RecentFriendListEntry[]>({
    topic: "recent-sessions",
    scope: {
      employeeId: employeeId ?? "",
      // accountFilter 为空 = 订阅全部账号(scope.wecomAccountId 缺省匹配任何 account)
      wecomAccountId: accountFilter || undefined,
    },
    queryFn: async () => {
      const list = await fetchRecentFriendsCache(accountFilter);
      return list.map(fromCacheItem);
    },
    enabled: !!employeeId,
  });

  // `resource.data ?? []` 每次 render 创建新数组会让下游 useMemo 失效;用 useMemo 锁住引用。
  const cacheItems = useMemo(() => resource.data ?? [], [resource.data]);

  // ─── 默认列表本地 state(远端尾部 snapshot + 加载状态)──────────────────
  const [remoteTailItems, setRemoteTailItems] = useState<RecentFriendListEntry[]>([]);
  const [defaultNextCursor, setDefaultNextCursor] = useState<string>("");
  const [defaultHasMore, setDefaultHasMore] = useState(false);
  const [defaultLoading, setDefaultLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  // ─── 筛选 state(纯本地,不订阅事件)────────────────────────────────────
  const [filtered, setFiltered] = useState<RecentFriendListEntry[] | null>(null);
  const [filteredNextCursor, setFilteredNextCursor] = useState<string>("");
  const [filteredHasMore, setFilteredHasMore] = useState(false);
  const [filteredLoading, setFilteredLoading] = useState(false);
  const filteredQueryRef = useRef<RecentFriendsFilters | null>(null);

  /**
   * 强制远端拉首页 + 写库。后端 persist=true 时会 emit LocalCommand ChangeNotice,
   * useResource 自动 refetch 本地 cache。我们这里仅负责 cursor/hasMore + 清远端尾部。
   *
   * D8: 用 seq 编号防 stale race —— accountFilter 在 in-flight 期间切换时,旧请求
   * 的 response 落后到达会覆盖新请求的结果。每次调用 ++seq,write 前比对,不等才写。
   */
  const reqSeqRef = useRef(0);
  const refreshFirstPage = useCallback(async () => {
    if (filteredQueryRef.current) return;
    const seq = ++reqSeqRef.current;
    setDefaultLoading(true);
    setLocalError(null);
    try {
      const resp = await fetchRecentFriendsPage(
        {
          size: DEFAULT_PAGE_SIZE,
          cursor: "",
          externalName: "",
          externalMobile: "",
          wecomAccountId: accountFilter || "",
          onlyUnread: false,
        },
        true,
      );
      if (seq !== reqSeqRef.current) return; // 已被更新请求接力,丢弃旧结果
      setDefaultNextCursor(resp.nextCursor);
      setDefaultHasMore(resp.hasMore);
      setRemoteTailItems([]);
      await resource.refresh();
    } catch (e) {
      if (seq !== reqSeqRef.current) return;
      setLocalError(errorMessage(e));
    } finally {
      if (seq === reqSeqRef.current) setDefaultLoading(false);
    }
  }, [accountFilter, resource]);

  // mount + accountFilter / employeeId 变化时,主动远端首页拉一次(冷启动对齐)
  // useResource 自身已在 mount 时调 queryFn 读本地 cache,这里补"远端首页 → 写库"。
  // refreshFirstPage 内部 setState 是异步触发的(经过 await fetchRecentFriendsPage 网络往返),
  // 不算"同步 setState in effect";但 lint 仍标 set-state-in-effect。就近豁免。
  useEffect(() => {
    if (!employeeId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshFirstPage();
    // 不依赖 refreshFirstPage(它的依赖是 accountFilter + resource,resource 引用每次变会循环触发)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId, accountFilter]);

  /** 滚动加载更多(默认列表)。走 persist=false,不写库;前端 append 后多键 reorder。 */
  const loadMore = useCallback(async () => {
    if (filteredQueryRef.current) return;
    if (!defaultHasMore || !defaultNextCursor || defaultLoading) return;
    setDefaultLoading(true);
    setLocalError(null);
    try {
      const resp = await fetchRecentFriendsPage(
        {
          size: DEFAULT_PAGE_SIZE,
          cursor: defaultNextCursor,
          externalName: "",
          externalMobile: "",
          wecomAccountId: accountFilter || "",
          onlyUnread: false,
        },
        false,
      );
      setRemoteTailItems((prev) => [...prev, ...resp.records.map(fromRemoteRecord)]);
      setDefaultNextCursor(resp.nextCursor);
      setDefaultHasMore(resp.hasMore);
    } catch (e) {
      setLocalError(errorMessage(e));
    } finally {
      setDefaultLoading(false);
    }
  }, [accountFilter, defaultHasMore, defaultLoading, defaultNextCursor]);

  const refresh = useCallback(async () => {
    await refreshFirstPage();
  }, [refreshFirstPage]);

  // 默认列表合成:cache(权威本地态)+ 远端尾部 snapshot,dedupe 后多键 reorder。
  const items = useMemo(
    () => multiKeySort(dedupeById([...cacheItems, ...remoteTailItems])),
    [cacheItems, remoteTailItems],
  );

  /** 远端筛选/搜索。维护独立 state,不串到默认列表。 */
  const searchRemote = useCallback(
    async (filters: RecentFriendsFilters) => {
      filteredQueryRef.current = filters;
      setFilteredLoading(true);
      setLocalError(null);
      try {
        const resp = await fetchRecentFriendsPage(
          {
            size: DEFAULT_PAGE_SIZE,
            cursor: "",
            externalName: filters.externalName || "",
            externalMobile: filters.externalMobile || "",
            wecomAccountId: accountFilter || "",
            onlyUnread: filters.onlyUnread || false,
          },
          false,
        );
        setFiltered(resp.records.map(fromRemoteRecord));
        setFilteredNextCursor(resp.nextCursor);
        setFilteredHasMore(resp.hasMore);
      } catch (e) {
        setLocalError(errorMessage(e));
      } finally {
        setFilteredLoading(false);
      }
    },
    [accountFilter],
  );

  const loadMoreFiltered = useCallback(async () => {
    const query = filteredQueryRef.current;
    if (!query) return;
    if (!filteredHasMore || !filteredNextCursor || filteredLoading) return;
    setFilteredLoading(true);
    setLocalError(null);
    try {
      const resp = await fetchRecentFriendsPage(
        {
          size: DEFAULT_PAGE_SIZE,
          cursor: filteredNextCursor,
          externalName: query.externalName || "",
          externalMobile: query.externalMobile || "",
          wecomAccountId: accountFilter || "",
          onlyUnread: query.onlyUnread || false,
        },
        false,
      );
      setFiltered((prev) => [...(prev ?? []), ...resp.records.map(fromRemoteRecord)]);
      setFilteredNextCursor(resp.nextCursor);
      setFilteredHasMore(resp.hasMore);
    } catch (e) {
      setLocalError(errorMessage(e));
    } finally {
      setFilteredLoading(false);
    }
  }, [accountFilter, filteredHasMore, filteredLoading, filteredNextCursor]);

  const exitFilter = useCallback(async () => {
    filteredQueryRef.current = null;
    setFiltered(null);
    setFilteredNextCursor("");
    setFilteredHasMore(false);
    await refreshFirstPage();
  }, [refreshFirstPage]);

  const pin = useCallback(async (conversationId: string, pinned: boolean) => {
    try {
      await pinConversation(conversationId, pinned);
      // 后端 emit LocalCommand ChangeNotice → useResource 自动 refetch
    } catch (e) {
      setLocalError(errorMessage(e));
    }
  }, []);

  const setDraft = useCallback(async (conversationId: string, text: string) => {
    try {
      await setConversationDraft(conversationId, text);
    } catch (e) {
      setLocalError(errorMessage(e));
    }
  }, []);

  const remove = useCallback(async (conversationId: string) => {
    try {
      await setConversationRemoved(conversationId, true);
      // 后端 emit ChangeNotice → useResource 自动 refetch;无需乐观更新
    } catch (e) {
      setLocalError(errorMessage(e));
    }
  }, []);

  return {
    items,
    defaultLoading,
    defaultHasMore,
    loadMore,
    refresh,
    filtered,
    filteredLoading,
    filteredHasMore,
    searchRemote,
    loadMoreFiltered,
    exitFilter,
    pin,
    setDraft,
    remove,
    // useResource 的 error 与本地操作 error 合并(任一非空都展示)
    error: resource.error ?? localError,
    // 同步状态全部由 useResource 集中提供
    lastEventAt: resource.lastEventAt,
    lastRefreshAt: resource.lastRefreshAt,
    resyncing: resource.resyncing,
    connectionState: resource.connectionState,
    initialFetched: resource.initialFetched,
  };
}
