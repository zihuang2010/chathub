// 接待好友列表 Hook —— 本地行存为唯一真相源 + 远端水位预填。
//
// 两态:
//   1. 默认列表:本地行存(list_top(limit))是唯一渲染源。向下滚动 = 纯本地加深 limit
//      (零网络)→ useResource 重读;本地读不满 limit 即见底(更早会话走搜索)。远端整页
//      仅在冷启动/低水位时"水位预填"补到目标深度(后端循环),日常/重启保鲜全靠事件 backfill。
//   2. 筛选列表:纯远端搜索(externalName/externalMobile/onlyUnread),独立游标,
//      persist=false 不写库不污染"最近",临时内存态;退出即回默认列表。
//
// 数据流:
//   - **默认列表渲染源 = 本地 cache,由 useResource 接管**:订阅 topic="recent-sessions",
//     scope={employeeId, wecomAccountId?},queryFn 读 list_top(limit);任何 ChangeNotice
//     匹配 scope → 自动按当前 limit 重读(新消息冒泡、未读更新、事件 backfill)。
//   - loadMore:纯本地 —— 本地已填满当前 limit 才把 limit += PAGE_STEP 并重读;读不满
//     当前 limit ⇒ 本地见底,no-op。limit 触顶 MAX_DEFAULT_LIST(对齐后端 trim 上限)。
//   - 水位预填(prefillWatermark):本地 < 触发线时调后端 prefill_recent_friends 一次,
//     后端循环远端续拉写库到目标水位/耗尽。filledScopes 标记本会话每 scope 只预填一次,
//     形成闭环(小列表远端耗尽也不反复拉)。resync / 手动刷新 force 重新对齐。
//   - lastEventAt / lastRefreshAt / connectionState / resyncing 全部来自 useResource。
//
// 本地 state:
//   - limit:当前渲染深度(随滚动生长);limitRef 供 useResource 的 queryFn 读最新值。
//   - filtered + filteredNextCursor / filteredHasMore / filteredLoading(搜索态独立)。
//   - filteredQueryRef(区分默认/筛选模式)。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  fetchRecentFriendsCache,
  fetchRecentFriendsPage,
  openFriendConversation,
  prefillRecentFriends,
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

// 搜索/筛选态的远端单页大小(纯临时视图,不写库)。
const DEFAULT_PAGE_SIZE = 20;

// 首屏渲染深度 + 向下滚动的翻页步长:列表只读本地 list_top(limit),滚动到底 limit 逐步生长。
const INITIAL_LIMIT = 200;
const PAGE_STEP = 200;
// 默认列表渲染深度封顶(对齐后端全局 trim 上限 RECENT_SESSIONS_GLOBAL_LIMIT=2000):
// limit 触顶即停止本地深读,更早/特定会话一律走搜索。
const MAX_DEFAULT_LIST = 2000;

// 水位触发线:本地(当前 scope)行数低于它,mount 触发一次远端水位预填(后端补到目标水位)。
// 取值低于后端目标(RECENT_FRIENDS_WATERMARK_TARGET=200,见 backends/src/lib.rs)形成滞回,
// 避免在目标边界频繁触发。
const WATERMARK_TRIGGER = 100;

// 跨组件 mount / 账号切换共享的"本会话已预填"标记。键 = `${employeeId}|${accountFilter}`。
// 每个 scope 本会话最多自动预填一次,形成闭环:小列表(远端总量 < 触发线)拉一次即止,不反复拉。
const filledScopes = new Set<string>();

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

  /**
   * 从搜索点开某客户 → 定位/创建其会话并提到非置顶区顶部,返回服务端权威 conversationId。
   * 后端 upsert + set_opened + emit ChangeNotice → useResource 自动重读;调用方拿到 id 后选中即可。
   */
  openFriend: (args: {
    wecomAccountId: string;
    externalUserId: string;
    externalName: string;
    externalAvatar: string;
    externalMobile: string;
    wecomName: string;
    wecomAlias: string;
  }) => Promise<string>;

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
  /** 切账号筛选后、新 scope 列表尚未返回的窗口期(此刻 items 仍是上一个账号的旧数据)。
   *  消费方据此渲染骨架,避免"旧账号列表残留一瞬再突变"的闪烁。透传自 useResource.isStale。 */
  switching: boolean;
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

function errorMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}

export function useRecentFriends(opts: UseRecentFriendsOptions): UseRecentFriendsResult {
  const { accountFilter } = opts;
  const employeeId = useCurrentEmployeeId();

  // ─── 默认列表渲染深度 ─────────────────────────────────────────────────────
  // limit = 当前渲染深度(随向下滚动生长);limitRef 供 useResource 的 queryFn 在调用时读
  // 最新深度(queryFn 闭包稳定,不能靠重建闭包传 limit,故走 ref)。
  const [limit, setLimit] = useState(INITIAL_LIMIT);
  const limitRef = useRef(limit);
  useEffect(() => {
    limitRef.current = limit;
  }, [limit]);
  const [defaultLoading, setDefaultLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  // ─── 默认列表 cache(由 useResource 集中管理,唯一渲染源) ──────────────────
  // 订阅 recent-sessions topic + scope=(employeeId, wecomAccountId?)。queryFn 读
  // list_top(limit):任何 ChangeNotice 匹配此 scope → 自动按当前深度重读本地行存
  // (新消息冒泡、未读更新、置顶/草稿/移除态变化、事件 backfill 都经此重读落地)。
  const resource = useResource<RecentFriendListEntry[]>({
    topic: "recent-sessions",
    scope: {
      employeeId: employeeId ?? "",
      // accountFilter 为空 = 订阅全部账号(scope.wecomAccountId 缺省匹配任何 account)
      wecomAccountId: accountFilter || undefined,
    },
    queryFn: async () => {
      const list = await fetchRecentFriendsCache(accountFilter, limitRef.current);
      return list.map(fromCacheItem);
    },
    enabled: !!employeeId,
  });

  // `resource.data ?? []` 每次 render 创建新数组会让下游 useMemo 失效;用 useMemo 锁住引用。
  const cacheItems = useMemo(() => resource.data ?? [], [resource.data]);

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
   * 水位预填:本地(当前 scope)深度不足时,调后端 `prefill_recent_friends` 一次,后端循环
   * 远端续拉写库到目标水位 / 远端耗尽 / 安全上限。
   *
   * 闭环:`filledScopes` 标记同一 (employeeId, accountFilter) 本会话只自动预填一次 ——
   * 小列表(远端总量低于水位)拉一次拿全部即止,不反复拉。`force=true`(resync / 手动刷新)
   * 绕过标记重新对齐。`fillSeqRef` 防切账号 in-flight race:旧 scope 在途结果作废。
   * 失败回滚标记,允许下次重试。搜索态下不预填(filteredQueryRef 非空直接返回)。
   */
  const fillSeqRef = useRef(0);
  const prefillWatermark = useCallback(
    async (force = false) => {
      if (filteredQueryRef.current) return;
      if (!employeeId) return;
      const key = `${employeeId}|${accountFilter ?? ""}`;
      if (!force && filledScopes.has(key)) return;
      const seq = ++fillSeqRef.current;
      filledScopes.add(key); // 乐观标记:先占位防并发重复,失败再回滚
      setDefaultLoading(true);
      setLocalError(null);
      try {
        await prefillRecentFriends(accountFilter, force);
        if (seq !== fillSeqRef.current) return; // 已被更新请求(如切账号)接力,丢弃
        // 后端写库后会 emit ChangeNotice;这里仍显式重读一次,保证即使 ChangeNotice
        // 延迟/丢失也能立刻按当前 limit 读出预填结果。
        await resource.refresh();
      } catch (e) {
        if (seq !== fillSeqRef.current) return;
        filledScopes.delete(key); // 失败:撤销标记,下次可重试
        setLocalError(errorMessage(e));
      } finally {
        if (seq === fillSeqRef.current) setDefaultLoading(false);
      }
    },
    [accountFilter, employeeId, resource],
  );

  // 切账号:渲染深度回到首屏窗口。render 期复位(标准「prop 变化即调整 state」惯用法),
  // 切账号当帧即复位,limitRef 同步 effect(声明在 useResource 之前)会先把 limitRef 刷成
  // 首屏深度,故 scope 变化触发的那次重读读到的就是复位后的深度。
  const [prevAccountFilter, setPrevAccountFilter] = useState(accountFilter);
  if (accountFilter !== prevAccountFilter) {
    setPrevAccountFilter(accountFilter);
    setLimit(INITIAL_LIMIT);
  }

  // 切员工/登出:清掉非当前 employeeId 的已预填标记。filledScopes 是模块级 Set
  // (键 `${employeeId}|${accountFilter}`),不清会跨员工累积、整个会话期不回收。
  useEffect(() => {
    const prefix = `${employeeId ?? ""}|`;
    for (const key of [...filledScopes]) {
      if (!key.startsWith(prefix)) filledScopes.delete(key);
    }
  }, [employeeId]);

  // 冷启动 / 低水位:本地 cache 秒开(initialFetched)后,若本地(当前 scope)行数低于触发线,
  // 预填一次补到目标水位。filledScopes 闭环防重复(温缓存重启 = 零远端;小列表只拉一次)。
  useEffect(() => {
    if (!employeeId) return;
    if (!resource.initialFetched) return;
    if (cacheItems.length >= WATERMARK_TRIGGER) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void prefillWatermark(false);
    // prefillWatermark 依赖 resource(引用每 render 变),入 deps 会死循环;
    // 需要反应的量(scope / 首读完成 / 本地深度)已在 deps。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId, accountFilter, resource.initialFetched, cacheItems.length]);

  // Resync 门:relay 报 gap 超出 retention(resyncing false→true)→ 本地 cache 可能缺事件,
  // force 预填全量对齐(绕过 filledScopes)。useResource 自身在 resync 时只重读本地 cache,
  // 补不上缺失的事件,故这里追加远端水位预填。
  const prevResyncingRef = useRef(false);
  useEffect(() => {
    const was = prevResyncingRef.current;
    prevResyncingRef.current = resource.resyncing;
    if (was || !resource.resyncing) return; // 只在 false→true 跃迁触发
    void prefillWatermark(true);
    // 同上:prefillWatermark 不入 deps(防 resource 引用变循环);只反应 resyncing 跃迁。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resource.resyncing]);

  /** 滚动到底加载更多(默认列表)—— 纯本地深读,零网络:
   *  - 搜索态走 loadMoreFiltered。
   *  - limit 触顶 MAX_DEFAULT_LIST → no-op(更早会话走搜索)。
   *  - 本地读出行数 < 当前 limit ⇒ 本地见底(list_top 没有更深的行了)→ no-op。
   *  - 否则 limit += PAGE_STEP 并重读 list_top(limit)(写库由事件/预填负责,这里不联网)。 */
  const loadMore = useCallback(async () => {
    if (filteredQueryRef.current) return; // 搜索态走 loadMoreFiltered
    if (limitRef.current >= MAX_DEFAULT_LIST) return; // 渲染深度封顶:更早会话走搜索
    if (cacheItems.length < limitRef.current) return; // 本地见底:读不满当前深度,无更深行
    const next = Math.min(limitRef.current + PAGE_STEP, MAX_DEFAULT_LIST);
    limitRef.current = next;
    setLimit(next);
    await resource.refresh();
  }, [cacheItems.length, resource]);

  // 显式刷新 = force 水位预填(重新对齐远端)+ 重读本地。给 UI 按钮 / SyncStatusBadge 用。
  const refresh = useCallback(async () => {
    await prefillWatermark(true);
  }, [prefillWatermark]);

  // 默认列表渲染源 = 本地 list_top(limit),已由 SQL 多键排序 + dedupe(conversation_id 为 PK),
  // 前端无需再排序/去重;直接用 cacheItems 作为 items。
  const items = cacheItems;

  // markRead 取快照时读实时 items,不入 markRead deps(保持回调引用稳定)。
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  // refetch 让某行未读数偏离快照(成功清零 / 被新消息再抬)即移除该 pending —— 既收敛
  // 内存,也防"未读数日后恰好回到快照值"误触发抑制。失败路径已在 markRead catch 里移除。
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
    setLocalError(null);
    // 退出搜索回默认列表:重读本地 cache 即可(默认列表数据由 mount 预填 + 事件保鲜)。
    await resource.refresh();
  }, [resource]);

  const openFriend = useCallback<UseRecentFriendsResult["openFriend"]>(async (args) => {
    // 失败抛给调用方(由 UI toast);后端 emit ChangeNotice → useResource 自动重读列表。
    return await openFriendConversation(args);
  }, []);

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
    // 本地填满当前渲染深度、且未触顶即可继续下拉深读;读不满当前深度 = 本地见底 → false。
    defaultHasMore: cacheItems.length >= limit && limit < MAX_DEFAULT_LIST,
    loadMore,
    refresh,
    filtered,
    filteredLoading,
    filteredHasMore,
    searchRemote,
    loadMoreFiltered,
    exitFilter,
    openFriend,
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
    switching: resource.isStale,
  };
}
