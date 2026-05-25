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
//   - localTailItems(loadMore 本地深读尾部:滑过头部 cache 后的 offset 续页,零网络)
//   - localExhausted(本地行存已读到底标志)
//   - filtered + cursor / loading / hasMore(搜索态独立,仍走远端 cursor)
//   - filteredQueryRef(区分默认/筛选模式)

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  fetchRecentFriendsCache,
  fetchRecentFriendsLocalPage,
  fetchRecentFriendsPage,
  markConversationRead,
  muteConversation,
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

// 头部 cache 上限(与后端 RECENT_FRIENDS_LIST_LIMIT=200 对齐):本地深读 offset 的起点。
const HEAD_CACHE_LIMIT = 200;
// 本地深读单页大小 —— 滑过头部后每次从本地行存多读这么多行(零网络往返)。
const LOCAL_PAGE_SIZE = 200;

// 远端首页刷新节流:同一 (employeeId, accountFilter) 在该窗口内只打一次 recentFriends 业务接口。
// mount / 账号切换的自动刷新走节流;用户显式「刷新」与退出搜索走 force 绕过。
const REMOTE_REFRESH_TTL_MS = 30_000;
// 跨组件 mount / 账号切换共享的"上次远端首页刷新时间戳"。键 = `${employeeId}|${accountFilter}`。
const lastRemoteRefreshAt = new Map<string, number>();

// 稳定空引用:无 markRead 进行中时复用,避免每 render 新建 Map/Set 让下游 memo 失效。
const EMPTY_READING_SNAP: ReadonlyMap<string, number> = new Map();
const EMPTY_READING_IDS: ReadonlySet<string> = new Set();

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
  /** V12:消息免打扰。后端 UPDATE + ChangeNotice → useResource refetch → 行 muted 态更新。 */
  mute: (conversationId: string, muted: boolean) => Promise<void>;
  /** 标记会话已读。后端远端 markRead + 本地清零 + ChangeNotice → useResource refetch → 红标消失。 */
  markRead: (conversationId: string) => Promise<void>;
  /** markRead 远端往返进行中、且该行未读数尚未被 refetch 改变的会话 id。消费方据此在
   *  远端清零落地前继续抑制红标,消除"切走会话时红点先现后灭"的闪烁。 */
  readingIds: ReadonlySet<string>;

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
  muted: boolean;
  mutedAtMs: number;
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
    muted: it.muted,
    mutedAtMs: it.mutedAtMs,
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
    // 远端 record 无本地免打扰态
    muted: false,
    mutedAtMs: 0,
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

  // ─── 默认列表本地深读尾部(头部 cache 由 useResource 管;滑过 200 行后从本地行存续页)──
  // localTailItems = 头部 top-200 之后的本地行(offset 续页 append,零网络)。
  // localExhausted = 本地行存已读到底(某页返回行数 < 一页);到底即停止下拉,不再联网。
  const [localTailItems, setLocalTailItems] = useState<RecentFriendListEntry[]>([]);
  const [localExhausted, setLocalExhausted] = useState(false);
  const [defaultLoading, setDefaultLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  // markRead 闪烁抑制:id → 调用 markRead 时的 unreadCount 快照。远端往返期间该行因
  // 不再 selected 会解除红标抑制、却要等 refetch 才清零 → 中间闪一下。记下快照,在
  // 渲染未读数仍等于快照期间继续抑制;refetch 让未读数变化(清零 / 被新消息再抬)后
  // 由 readingIds 自动放行。远端失败则在 markRead 的 catch 里立即撤销(红标复现可重试)。
  const [readingSnap, setReadingSnap] = useState<ReadonlyMap<string, number>>(EMPTY_READING_SNAP);

  // ─── 筛选 state(纯本地,不订阅事件)────────────────────────────────────
  const [filtered, setFiltered] = useState<RecentFriendListEntry[] | null>(null);
  const [filteredNextCursor, setFilteredNextCursor] = useState<string>("");
  const [filteredHasMore, setFilteredHasMore] = useState(false);
  const [filteredLoading, setFilteredLoading] = useState(false);
  const filteredQueryRef = useRef<RecentFriendsFilters | null>(null);

  /**
   * 远端拉首页 + 写库。后端 persist=true 时会 emit LocalCommand ChangeNotice,
   * useResource 自动 refetch 本地 cache。我们这里仅负责 cursor/hasMore + 清远端尾部。
   *
   * 节流:`force=false`(mount / 账号切换的自动刷新)在 REMOTE_REFRESH_TTL_MS 窗口内跳过远端,
   * 仅靠 useResource 已读出的本地 cache 秒开 —— 避免快速切账号 / 频繁重挂时反复打业务接口。
   * `force=true`(显式刷新 / 退出搜索)无视窗口直接拉。失败时清掉时间戳允许立即重试。
   *
   * D8: 用 seq 编号防 stale race —— accountFilter 在 in-flight 期间切换时,旧请求
   * 的 response 落后到达会覆盖新请求的结果。每次调用 ++seq,write 前比对,不等才写。
   */
  const reqSeqRef = useRef(0);
  const refreshFirstPage = useCallback(
    async (force = false) => {
      if (filteredQueryRef.current) return;
      const refreshKey = `${employeeId ?? ""}|${accountFilter ?? ""}`;
      if (!force) {
        const last = lastRemoteRefreshAt.get(refreshKey);
        if (last !== undefined && Date.now() - last < REMOTE_REFRESH_TTL_MS) {
          return; // 窗口内:跳过远端业务接口,本地 cache 已由 useResource 秒开
        }
      }
      const seq = ++reqSeqRef.current;
      lastRemoteRefreshAt.set(refreshKey, Date.now());
      setDefaultLoading(true);
      setLocalError(null);
      try {
        await fetchRecentFriendsPage(
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
        // 远端首页对齐后 cacheItems(top-200)会刷到最新;本地深读尾部回到顶部状态重来。
        setLocalTailItems([]);
        setLocalExhausted(false);
        await resource.refresh();
      } catch (e) {
        if (seq !== reqSeqRef.current) return;
        lastRemoteRefreshAt.delete(refreshKey); // 失败:清时间戳,下次不被节流挡住
        setLocalError(errorMessage(e));
      } finally {
        if (seq === reqSeqRef.current) setDefaultLoading(false);
      }
    },
    [accountFilter, employeeId, resource],
  );

  // 切账号重置本地深读尾部:localTail 按账号维护(useResource 的 cacheItems 已按账号 scope,
  // 但 localTailItems 不会自动换 scope)。在 render 期重置(而非 effect):切账号当帧即清,
  // 不会让旧账号深读的尾部行(items 合并 localTailItems)闪一帧再消失。
  const [prevAccountFilter, setPrevAccountFilter] = useState(accountFilter);
  if (accountFilter !== prevAccountFilter) {
    setPrevAccountFilter(accountFilter);
    setLocalTailItems([]);
    setLocalExhausted(false);
  }

  // 切员工/登出:清掉非当前 employeeId 的远端刷新时间戳。lastRemoteRefreshAt 是模块级 Map
  // (键 `${employeeId}|${accountFilter}`),不清会跨员工累积、整个会话期不回收。
  // 操作的是外部 Map(非 React state),不触发 set-state-in-effect。
  useEffect(() => {
    const prefix = `${employeeId ?? ""}|`;
    for (const key of [...lastRemoteRefreshAt.keys()]) {
      if (!key.startsWith(prefix)) lastRemoteRefreshAt.delete(key);
    }
  }, [employeeId]);

  // 冷启动门(消掉每次启动那一发 recentFriends):首次本地 cache 读出(initialFetched)后,
  // 仅当缓存为空(无任何本地行)才远端首页拉一发作初始快照。非空 → 不拉:回放路径接管
  // (有新事件 → applier 写库 → useResource 重读;无事件则本就无变化)。
  // cacheItems.length(0↔非空)变化驱动重判:切到空缓存账号会在 cache settle 后补拉。
  useEffect(() => {
    if (!employeeId) return;
    if (!resource.initialFetched) return;
    if (cacheItems.length > 0) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshFirstPage();
    // refreshFirstPage 依赖 resource(引用每 render 变),入 deps 会死循环;
    // 需要反应的量(空缓存 / scope / 首读完成)已在 deps。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId, accountFilter, resource.initialFetched, cacheItems.length]);

  // Resync 门:relay 报 gap 超出 retention(resyncing false→true)→ 本地 cache 可能缺事件,
  // 必须远端 full pull 对齐(force 绕过节流)。useResource 自身在 resync 时只重读本地 cache,
  // 补不上缺失的事件,故这里追加远端快照。
  const prevResyncingRef = useRef(false);
  useEffect(() => {
    const was = prevResyncingRef.current;
    prevResyncingRef.current = resource.resyncing;
    if (was || !resource.resyncing) return; // 只在 false→true 跃迁触发
    void refreshFirstPage(true);
    // 同上:refreshFirstPage 不入 deps(防 resource 引用变循环);只反应 resyncing 跃迁。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resource.resyncing]);

  /** 滚动加载更多(默认列表)—— 本地深读:头部 top-200 之后从本地行存 offset 续页,零网络。
   *  本地读到底(某页返回行数 < 一页)即永久 no-op,不再联网:本地表上限即全部可见数据。
   *  offset = 头部 200 + 已 append 的尾部行数,与头部 cache 无缝衔接(排序同 list_top)。 */
  const loadMore = useCallback(async () => {
    if (filteredQueryRef.current) return; // 搜索态走 loadMoreFiltered
    if (defaultLoading) return;
    if (localExhausted) return; // 本地到底:永久 no-op
    setDefaultLoading(true);
    setLocalError(null);
    try {
      const offset = HEAD_CACHE_LIMIT + localTailItems.length;
      const rows = await fetchRecentFriendsLocalPage(accountFilter, offset, LOCAL_PAGE_SIZE);
      setLocalTailItems((prev) => [...prev, ...rows.map(fromCacheItem)]);
      if (rows.length < LOCAL_PAGE_SIZE) setLocalExhausted(true);
    } catch (e) {
      setLocalError(errorMessage(e));
    } finally {
      setDefaultLoading(false);
    }
  }, [accountFilter, defaultLoading, localExhausted, localTailItems.length]);

  const refresh = useCallback(async () => {
    await refreshFirstPage(true);
  }, [refreshFirstPage]);

  // 默认列表合成:本地深读尾部 + 头部 cache(权威本地态),dedupe 后多键 reorder。
  // cacheItems 放末位:dedupeById 后者覆盖前者,故新消息冒泡进 top-200 时,cache 的最新
  // 版本压过 localTail 的旧快照(避免尾部旧行覆盖头部权威态)。
  const items = useMemo(
    () => multiKeySort(dedupeById([...localTailItems, ...cacheItems])),
    [cacheItems, localTailItems],
  );

  // markRead 取快照时读实时 items,不入 markRead deps(保持回调引用稳定)。
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  // refetch 让某行未读数偏离快照(成功清零 / 被新消息再抬)即移除该 pending —— 既收敛
  // 内存,也防"未读数日后恰好回到快照值"误触发抑制。失败路径已在 markRead catch 里移除。
  // 这是"权威 items 刷新 → 校正本地 pending"的同步,setState 必要;lint 的 cascading 报警泛报。
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReadingSnap((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Map(prev);
      for (const [id, snap] of prev) {
        const it = items.find((x) => x.conversationId === id);
        if (!it || it.unreadCount !== snap) {
          next.delete(id);
          changed = true;
        }
      }
      if (!changed) return prev;
      return next.size === 0 ? EMPTY_READING_SNAP : next;
    });
  }, [items]);

  // 当前应抑制红标的会话:pending 中且渲染未读数仍等于快照(>0 由 markRead 入栈时保证)。
  const readingIds = useMemo<ReadonlySet<string>>(() => {
    if (readingSnap.size === 0) return EMPTY_READING_IDS;
    const s = new Set<string>();
    for (const [id, snap] of readingSnap) {
      const it = items.find((x) => x.conversationId === id);
      if (it && it.unreadCount === snap) s.add(id);
    }
    return s.size === 0 ? EMPTY_READING_IDS : s;
  }, [readingSnap, items]);

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
    await refreshFirstPage(true);
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

  const mute = useCallback(async (conversationId: string, muted: boolean) => {
    try {
      await muteConversation(conversationId, muted);
      // 后端 emit ChangeNotice → useResource 自动 refetch
    } catch (e) {
      setLocalError(errorMessage(e));
    }
  }, []);

  const markRead = useCallback(async (conversationId: string) => {
    // 入栈未读快照:仅当前确有未读才需要抑制(无未读不会闪)。远端往返期间用它压住红标。
    const snapshot =
      itemsRef.current.find((x) => x.conversationId === conversationId)?.unreadCount ?? 0;
    if (snapshot > 0) {
      setReadingSnap((prev) => new Map(prev).set(conversationId, snapshot));
    }
    try {
      await markConversationRead(conversationId);
      // 后端远端 markRead 成功 → 本地清零 + emit ChangeNotice → useResource 自动 refetch 清红标。
      // 抑制不在此处解除:留给 readingIds(未读数偏离快照即放行),避免 refetch 落地前先闪一帧。
    } catch (e) {
      setLocalError(errorMessage(e));
      // 远端失败:未读数不会变,readingIds 不会自动放行 → 这里立即撤销抑制让红标复现(可重试)。
      if (snapshot > 0) {
        setReadingSnap((prev) => {
          if (!prev.has(conversationId)) return prev;
          const next = new Map(prev);
          next.delete(conversationId);
          return next.size === 0 ? EMPTY_READING_SNAP : next;
        });
      }
    }
  }, []);

  return {
    items,
    defaultLoading,
    // 本地还没读到底就还能下拉;读到底即 false(本地表上限即全部可见数据)。
    defaultHasMore: !localExhausted,
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
    mute,
    markRead,
    readingIds,
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
