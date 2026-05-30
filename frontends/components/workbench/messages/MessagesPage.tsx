import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ToastViewport, showToast } from "@/components/ui/toast";
import { WorkbenchPanel } from "@/components/workbench/WorkbenchPanel";
import type { Account } from "@/lib/types/account";
import { adaptFriendDetailToCustomer, type WecomFriend } from "@/lib/api/customers";
import { useFriendDetail } from "@/lib/api/useFriendDetail";
import { useQuickReplies } from "@/lib/api/useQuickReplies";
import { useRecentFriends, type RecentFriendListEntry } from "@/lib/api/useRecentFriends";
import { sendMessage } from "@/lib/api/messageHistory";
import { appReady } from "@/lib/data/appReady";
import { cn } from "@/lib/utils";

import { ChatArea } from "./ChatArea";
import { STRINGS } from "./strings";
import {
  CHAT_AREA_MIN_WIDTH,
  CONVERSATION_LIST_DEFAULT_WIDTH,
  CONVERSATION_LIST_MAX_WIDTH,
  CONVERSATION_LIST_MIN_WIDTH,
  CUSTOMER_DETAILS_WIDTH,
  RESIZE_HANDLE_WIDTH,
  RESIZE_KEYBOARD_STEP,
} from "./constants";
import { ConversationList } from "./ConversationList";
import { CustomerDetails } from "./CustomerDetails";
import type { Conversation, QuickReply } from "./data";
import { MessagesSkeleton } from "./MessagesSkeleton";
import { useChatMessages } from "./useChatMessages";
import { useDetailsWindow } from "./useDetailsWindow";

// 数据接口尚未对接,先用 module-level 空数组替代 MOCK 假数据。
// 引用稳定(同一模块级变量在 React render 间不变),下游 memo 不因每次 render 失效。
// 类型不用 readonly 以匹配 ChatArea/CustomerDetails 既有 props 形态;
// 通过 module-level 常量 + 不导出避免外部 mutation。
const EMPTY_MENTION_CANDIDATES: Conversation[] = [];
// 静态 props,hoist 到模块级避免每次 render 新建对象(被多个 ErrorBoundary 复用)。
const ERROR_BOUNDARY_PROPS = {
  title: STRINGS.errors.pageUnavailable,
  retryLabel: STRINGS.errors.retry,
};

/**
 * 把后端最近会话条目适配成 ConversationList 现有 `Conversation` 形态。
 *
 * 字段对接策略:
 *   - id / name / preview / unread:直映
 *   - account:用 wecomAlias 作显示名(跟 AccountDropdown 列表里的 `account.name` 对齐契机);
 *     缺失时 fallback wecomName。
 *   - time:lastMessageTimeMs → 相对时间字符串("HH:mm" / "昨天" / "周二" / "MM-dd")
 *   - online / avatarColor:接口未下发,留空(列表渲染按 name hash 上色)
 */
function formatRelativeTime(ms: number): string {
  if (ms <= 0) return "";
  const date = new Date(ms);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate()
  ) {
    return "昨天";
  }
  const diffDays = Math.floor((now.getTime() - date.getTime()) / 86_400_000);
  if (diffDays < 7) {
    const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    return weekdays[date.getDay()];
  }
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// 远端字段(客户可控:昵称 / 消息摘要)进渲染模型前的长度硬顶。行内 CSS truncate
// 只裁"显示",底层字符串原样驻留;一条被构造的超长摘要会按行占内存,这里在源头截断。
const MAX_FIELD_LEN = 256;
function clampField(value: string): string {
  return value.length > MAX_FIELD_LEN ? value.slice(0, MAX_FIELD_LEN) : value;
}

function adaptEntryToConversation(entry: RecentFriendListEntry): Conversation {
  const draftText = extractDraftPreview(entry.localDraftText);
  // 列表行时间用 max(lastMessageTimeMs, localDraftAtMs),与后端 list_top 的多键
  // 排序键一致:有草稿且新于最后消息时显示草稿时间,新消息进来反超
  // 草稿时间后自动切回消息时间。否则会出现"行按草稿时间排到顶部、但右上角
  // 时间字段是旧消息时间"的视觉错位(微信桌面端约定)。
  const effectiveTimeMs = Math.max(entry.lastMessageTimeMs, entry.localDraftAtMs);
  return {
    id: entry.conversationId,
    name: clampField(entry.externalName) || "(未命名)",
    avatar: entry.externalAvatar || undefined,
    preview: clampField(entry.lastMessageSummary),
    account: clampField(entry.wecomAlias || entry.wecomName),
    time: formatRelativeTime(effectiveTimeMs),
    unread: entry.unreadCount,
    online: false,
    draftText: draftText || undefined,
    pinned: entry.pinned,
    muted: entry.muted,
  };
}

/**
 * 把 SQLite 存的 TipTap JSON 字符串解析为 plain text 预览。
 * useDraftStore 双写时存的是 JSON.stringify(JSONContent) — 直接展示会显示 JSON 源码。
 * 解析失败时(非 JSON / 文档损坏) fallback 当 raw text 截断。
 *
 * 按 stored 原文做有界内容缓存:每个 hub 事件都会让 useRecentFriends 重读缓存 + 整表
 * 重新 adapt,草稿未变的行不必反复 JSON.parse。键用 stored 原文(内容键),跨 refetch
 * 的对象重建仍命中。超过上限直接清空(简单兜底,避免无界增长)。
 */
const DRAFT_PREVIEW_CACHE_MAX = 200;
const draftPreviewCache = new Map<string, string>();
function extractDraftPreview(stored: string): string {
  if (!stored) return "";
  const cached = draftPreviewCache.get(stored);
  if (cached !== undefined) return cached;
  let result: string;
  try {
    const doc = JSON.parse(stored);
    result = extractTextFromNode(doc).replace(/\s+/g, " ").trim().slice(0, 80);
  } catch {
    result = stored.slice(0, 80);
  }
  if (draftPreviewCache.size >= DRAFT_PREVIEW_CACHE_MAX) draftPreviewCache.clear();
  draftPreviewCache.set(stored, result);
  return result;
}

function extractTextFromNode(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const n = node as { type?: unknown; text?: unknown; content?: unknown };
  if (n.type === "image") return "[图片]";
  // useDraftStore 在合成后端草稿时把待发送文件附件作为 fileAttachment 节点
  // 追加在 doc.content 末尾(TipTap schema 未注册,但本函数只读不渲染)。
  if (n.type === "fileAttachment") return "[文件]";
  if (typeof n.text === "string") return n.text;
  if (Array.isArray(n.content)) {
    return n.content.map((c) => extractTextFromNode(c)).join("");
  }
  return "";
}

interface MessagesPageProps {
  /** 由 Workbench 提供的账号列表(来自 list_accounts)。下拉用 `account.id`(= `wecomAccountId`)
   *  做选项值与筛选状态,直接传给 useRecentFriends;展示名按 id 反查 accounts。 */
  accounts: readonly Account[];
}

export function MessagesPage({ accounts }: MessagesPageProps) {
  const [selectedId, setSelectedId] = useState<string>("");
  // 账号筛选状态直接存 `account.id`(= wecomAccountId,唯一);同名账号互不干扰。
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [conversationListWidth, setConversationListWidth] = useState(
    CONVERSATION_LIST_DEFAULT_WIDTH,
  );
  const [isResizing, setIsResizing] = useState(false);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const chatAreaRef = useRef<HTMLDivElement | null>(null);
  const dragStartRef = useRef({ x: 0, width: CONVERSATION_LIST_DEFAULT_WIDTH });

  const { detailsOpen, chatWidthLock, toggleDetails } = useDetailsWindow({
    chatAreaRef,
  });

  // 顶部账号选择器直接输出 wecomAccountId(= account.id),原样传给 useRecentFriends;
  // null = 全部账号。展示名在 RangePill/ConversationList 内按 id 反查 accounts。

  // SyncStatusBadge 现已搬到 Sidebar 用户名下方(全局可见),这里只消费数据相关字段。
  // resyncing / connectionState / lastEventAt / lastRefreshAt / error 由 Sidebar 的
  // useHubSyncStatus 单独管,不再从这里透传。
  const {
    items: recentEntries,
    filtered,
    initialFetched,
    switching,
    pin: pinRecent,
    remove: removeRecent,
    mute: muteRecent,
    markRead: markReadRecent,
    readingIds,
    loadMore,
    loadMoreFiltered,
    defaultLoading,
    filteredLoading,
    openFriend,
  } = useRecentFriends({
    accountFilter: selectedAccountId,
  });

  // "移除会话"持久化在 SQLite hub_conversation_recents.removed 列(V11);
  // 后端 list_top WHERE removed=0 已经把隐藏行过滤掉,前端不再二次过滤。
  // 自动恢复:远端事件 last_message_time_ms > removed_at_ms 时,UPSERT ON CONFLICT 自动清零。

  // 搜索激活时(filtered 非 null)渲染远端筛选结果,把"已加载窗口之外"的匹配也纳入;
  // 否则渲染默认列表。两者都是 RecentFriendListEntry[],经同一 adapter。
  const displayEntries = filtered ?? recentEntries;

  // 适配成 ConversationList 现有 `Conversation` 形态;源是稳定引用,按 displayEntries 记忆化。
  // readPending 由 useRecentFriends.readingIds 注入:markRead 远端往返期间抑制该行红标。
  const conversations = useMemo(
    () =>
      displayEntries.map((entry) => ({
        ...adaptEntryToConversation(entry),
        readPending: readingIds.has(entry.conversationId),
      })),
    [displayEntries, readingIds],
  );

  // 用户主动点开会话:置选中 + 仅当该会话有未读时调 markRead 清红标。
  // 启动时自动选中第一条走下方 effect(不经此 handler),天然不触发标已读 —— 保留红标供坐席自决是否接待。
  const handleSelectConversation = useCallback(
    (id: string) => {
      setSelectedId(id);
      const entry = displayEntries.find((e) => e.conversationId === id);
      if (entry && (entry.hasUnread || entry.unreadCount > 0)) void markReadRecent(id);
    },
    [displayEntries, markReadRecent],
  );

  // 关窗(点 X / Cmd-Q,优雅退出)不跑 React cleanup,故显式监听 onCloseRequested:
  // 关窗前对"当前打开且有未读"的会话补一次 markRead,让服务端收敛已读 ——
  // 覆盖"开着会话直接关闭、期间消息下次重现未读"的场景(闪退/强杀仍兜不住,接受现状)。
  // 闭包用 ref 读实时活动会话,避免 stale。
  const activeRef = useRef<{ id: string; unread: number }>({ id: "", unread: 0 });
  const activeEntryForClose = displayEntries.find((e) => e.conversationId === selectedId);
  const activeUnreadForClose =
    activeEntryForClose && (activeEntryForClose.hasUnread || activeEntryForClose.unreadCount > 0)
      ? Math.max(activeEntryForClose.unreadCount, 1)
      : 0;
  useEffect(() => {
    activeRef.current = { id: selectedId, unread: activeUnreadForClose };
  }, [selectedId, activeUnreadForClose]);
  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void win
      .onCloseRequested(async (event) => {
        const { id, unread } = activeRef.current;
        if (!id || unread <= 0) return; // 无未读直接放行默认关闭
        event.preventDefault();
        // markRead 失败/超时也无妨:关窗 best-effort,不让网络问题卡死关闭
        const synced = markReadRecent(id).catch(() => undefined);
        const timed = new Promise<void>((resolve) => setTimeout(resolve, 1500));
        await Promise.race([synced, timed]);
        await win.destroy();
      })
      .then((u) => {
        if (disposed) u();
        else unlisten = u;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [markReadRecent]);

  // 首次本地 cache 读出后通知 App 的 splash gate;splash 退场前数据已就绪,常规场景
  // 不再出现"splash → Skeleton → 真组件"的二次闪。极慢路径仍由 MessagesSkeleton 兜底。
  useEffect(() => {
    if (initialFetched) appReady.setMessagesReady();
  }, [initialFetched]);

  // 列表非空但 selectedId 不在列表中(初始挂载 / 切账号 / 数据更新后)→ 自动选第一项。
  // 这里就是"外部数据驱动 → 校正本地选中"的同步场景,无法 derive(selectedId 还要响应
  // 用户点击),所以 effect 内 setState 是必要的。lint 标 cascading-renders 是泛报警。
  useEffect(() => {
    if (conversations.length === 0) return;
    if (selectedId && conversations.some((c) => c.id === selectedId)) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedId(conversations[0].id);
  }, [conversations, selectedId]);

  // initialFetched 之前由顶层守卫挡住渲染,这里 conversation 可能 undefined(员工真无会话);
  // 不再 fallback MOCK_CONVERSATIONS[0] —— 避免假数据先画一帧的闪烁。
  const conversation = useMemo<Conversation | undefined>(
    () => conversations.find((c) => c.id === selectedId) ?? conversations[0],
    [conversations, selectedId],
  );
  // 当前选中会话归属的真实 (wecomAccountId, externalUserId);conversation 不存在时为 undefined,
  // useChatMessages 内部走 mock 空数组 fallback(由顶层守卫保证不会进入渲染)。
  // 选中会话归属在 displayEntries 里查:搜索态下用户可能点中"默认缓存之外"的远端结果,
  // 必须用 filtered 那份才能解析出 wecomAccountId / externalUserId 给 useChatMessages。
  const selectedEntry = useMemo(
    () =>
      conversation ? displayEntries.find((e) => e.conversationId === conversation.id) : undefined,
    [displayEntries, conversation],
  );
  const {
    messages,
    loading: messagesLoading,
    error: messagesError,
    hasMore: hasMoreMessages,
    loadMore: loadMoreMessages,
    retry: retryMessages,
  } = useChatMessages({
    conversationId: conversation?.id ?? "",
    wecomAccountId: selectedEntry?.wecomAccountId,
    externalUserId: selectedEntry?.externalUserId,
  });
  // 客户资料:按选中会话归属的 (wecomAccountId, externalUserId) 拉好友详情。
  // 两者缺一时 hook 不发请求、detail 为 null,CustomerDetails 渲染空态。
  // 用 detailsOpen 收口 id:面板收起时传 undefined → 不取数,避免切会话时白拉一份不展示的资料;
  // 面板展开才补齐 id 触发拉取(展开期间切会话会重新拉新客户资料)。
  const {
    detail: customerDetail,
    loading: customerLoading,
    refresh: refreshCustomer,
  } = useFriendDetail(
    detailsOpen ? selectedEntry?.wecomAccountId : undefined,
    detailsOpen ? selectedEntry?.externalUserId : undefined,
  );
  const customer = useMemo(
    () =>
      customerDetail
        ? adaptFriendDetailToCustomer(customerDetail, {
            accountName: selectedEntry?.wecomName ?? "—",
            accountId: selectedEntry?.wecomAccountId,
          })
        : null,
    [customerDetail, selectedEntry],
  );

  // 快捷回复(纯客户端本地表,按登录员工隔离):CRUD 全落本地,popover 内可增删改。
  // 行存 content 映射成 UI 的 preview(面板展示 + 选中即插入此文本)。
  const quickReplies = useQuickReplies();
  const quickReplyItems = useMemo<QuickReply[]>(
    () => quickReplies.replies.map((r) => ({ id: r.id, title: r.title, preview: r.content })),
    [quickReplies.replies],
  );

  // 真发送(text-only):后端落库出站气泡 + 发 conversation-messages ChangeNotice,
  // useChatMessages 重读缓存把这条消息收敛进权威列表。缺会话归属(account/user)时静默忽略。
  const handleSendMessage = useCallback(
    async (text: string, clientMsgId: string) => {
      if (!conversation || !selectedEntry?.wecomAccountId || !selectedEntry?.externalUserId) return;
      // 返回后端响应,供 ChatArea 用 localMessageId 作 serverId 收敛乐观气泡。
      return await sendMessage({
        conversationId: conversation.id,
        wecomAccountId: selectedEntry.wecomAccountId,
        externalUserId: selectedEntry.externalUserId,
        contentText: text,
        clientMsgId,
      });
    },
    [conversation, selectedEntry],
  );

  const clampConversationListWidth = useCallback(
    (nextWidth: number) => {
      const pageWidth = pageRef.current?.clientWidth ?? 0;
      const detailsWidth = detailsOpen ? CUSTOMER_DETAILS_WIDTH : 0;
      const layoutMaxWidth =
        pageWidth > 0
          ? Math.max(
              CONVERSATION_LIST_MIN_WIDTH,
              pageWidth - detailsWidth - CHAT_AREA_MIN_WIDTH - RESIZE_HANDLE_WIDTH,
            )
          : CONVERSATION_LIST_MAX_WIDTH;
      const maxWidth = Math.min(CONVERSATION_LIST_MAX_WIDTH, layoutMaxWidth);
      return Math.min(Math.max(nextWidth, CONVERSATION_LIST_MIN_WIDTH), maxWidth);
    },
    [detailsOpen],
  );

  // Window resize + detailsOpen toggles both invalidate the previously clamped
  // width. Re-running this effect when `clampConversationListWidth` identity
  // changes (i.e. detailsOpen flipped) covers the toggle case via the initial
  // `handleWindowResize()` call below.
  useEffect(() => {
    const handleWindowResize = () => {
      setConversationListWidth((width) => clampConversationListWidth(width));
    };

    handleWindowResize();
    window.addEventListener("resize", handleWindowResize);
    return () => window.removeEventListener("resize", handleWindowResize);
  }, [clampConversationListWidth]);

  useEffect(() => {
    if (!isResizing) return;

    const handlePointerMove = (event: PointerEvent) => {
      const deltaX = event.clientX - dragStartRef.current.x;
      setConversationListWidth(clampConversationListWidth(dragStartRef.current.width + deltaX));
    };
    const stopResizing = () => setIsResizing(false);
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResizing);
    window.addEventListener("pointercancel", stopResizing);

    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResizing);
      window.removeEventListener("pointercancel", stopResizing);
    };
  }, [clampConversationListWidth, isResizing]);

  const handleResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragStartRef.current = { x: event.clientX, width: conversationListWidth };
    setIsResizing(true);
  };

  const handleResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      event.key !== "ArrowLeft" &&
      event.key !== "ArrowRight" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }
    event.preventDefault();
    setConversationListWidth((width) => {
      if (event.key === "Home") return CONVERSATION_LIST_MIN_WIDTH;
      if (event.key === "End") return clampConversationListWidth(CONVERSATION_LIST_MAX_WIDTH);
      const direction = event.key === "ArrowLeft" ? -1 : 1;
      return clampConversationListWidth(width + direction * RESIZE_KEYBOARD_STEP);
    });
  };

  const handleAccountChange = useCallback(
    (accountId: string | null) => {
      setSelectedAccountId(accountId);
      // 当前会话已属该账号则不跳;account 归属用 entry.wecomAccountId 判定(唯一,不靠展示名)。
      if (!accountId || selectedEntry?.wecomAccountId === accountId) return;
      // 切到该账号下的第一条会话;useRecentFriends 跟随 selectedAccountId 重新拉取后,
      // useEffect 会再校正一次 selectedId。
      const next = displayEntries.find((e) => e.wecomAccountId === accountId);
      if (next) setSelectedId(next.conversationId);
    },
    [selectedEntry?.wecomAccountId, displayEntries],
  );

  // ─── 搜索客户 → 打开会话 ─────────────────────────────────────────────────
  // 顶部搜索框(MessagesContactSearch)直接搜 list_friends(全部客户),点击某客户后由后端
  // open_friend_conversation 一次性:recentFriends(externalUserId+includeFirstHistory)定位/建会话、
  // upsert 接待列表、首屏历史冷写入、set_opened 提到非置顶顶部、emit ChangeNotice。
  // conversationId 取服务端权威 requestConversationId(客户端不自算)。命令落地后行经 useResource
  // 重读进 recentEntries,可能慢于 await 返回,故挂 pendingOpenId,等行出现再选中(见下方 effect)。
  const pendingOpenIdRef = useRef<string | null>(null);
  const handleOpenCustomer = useCallback(
    async (friend: WecomFriend) => {
      // wecomName/wecomAlias 仅用于"无记录建空白行"时展示归属账号;从 accounts 反查。
      const accountName = accounts.find((a) => a.id === friend.wecomAccountId)?.name ?? "";
      try {
        const conversationId = await openFriend({
          wecomAccountId: friend.wecomAccountId,
          externalUserId: friend.externalUserId,
          externalName: friend.externalName,
          externalAvatar: friend.externalAvatar,
          externalMobile: friend.externalMobile,
          wecomName: accountName,
          wecomAlias: accountName,
        });
        pendingOpenIdRef.current = conversationId;
      } catch (e) {
        // 暴露后端原始错误,便于区分失败点(未登录 / list_recent_friends 网络异常 /
        // 服务端未返回会话 ID / 本地存储异常),通用 toast 看不出具体原因。
        console.error("[open_friend_conversation] 打开会话失败", e, { friend });
        showToast(STRINGS.conversationList.openConversationFailed, { type: "error" });
      }
    },
    [accounts, openFriend],
  );

  // openFriend 落地后,等 recentEntries 重读出该会话行再选中(+ 有未读则标已读)。
  // 不在 await 后直接 setSelectedId:行可能尚未随 ChangeNotice 重读进列表,直接设会被
  // "列表无此 id → 自动选第一项"的 effect 覆盖。行被 set_opened 提到非置顶顶部,出现即选中。
  useEffect(() => {
    const pid = pendingOpenIdRef.current;
    if (!pid) return;
    const entry = recentEntries.find((e) => e.conversationId === pid);
    if (!entry) return;
    pendingOpenIdRef.current = null;
    setSelectedId(pid);
    if (entry.hasUnread || entry.unreadCount > 0) void markReadRecent(pid);
  }, [recentEntries, markReadRecent]);

  // 搜索框清空:撤销待选中的打开请求(列表本就是默认态,无需额外处理)。
  const handleClearSearch = useCallback(() => {
    pendingOpenIdRef.current = null;
  }, []);

  // 滚动到底分派:筛选态翻 filtered 续页,否则翻默认列表续页。loading 同源切换防重入;
  // 是否到底由 hook 内部 cursor/hasMore 自守(loadMore/loadMoreFiltered 到底即 no-op)。
  const listLoading = filtered ? filteredLoading : defaultLoading;
  const handleLoadMore = useCallback(() => {
    if (filtered) void loadMoreFiltered();
    else void loadMore();
  }, [filtered, loadMore, loadMoreFiltered]);

  // 首屏数据门:本地 cache 还没读出来时渲染骨架,挡掉 ChatArea/CustomerDetails 拿空数据画一帧的闪烁。
  // initialFetched 单调向前(useResource 保证),后续切账号/refetch 不会再回退到 skeleton。
  if (!initialFetched) {
    return <MessagesSkeleton />;
  }

  return (
    <WorkbenchPanel panelRef={pageRef} className="relative">
      <ErrorBoundary {...ERROR_BOUNDARY_PROPS}>
        <ConversationList
          conversations={conversations}
          selectedId={selectedId}
          onSelect={handleSelectConversation}
          onTogglePin={pinRecent}
          onToggleMute={muteRecent}
          onRemove={removeRecent}
          width={conversationListWidth}
          accounts={accounts}
          selectedAccountId={selectedAccountId}
          onAccountChange={handleAccountChange}
          onOpenCustomer={handleOpenCustomer}
          onClearSearch={handleClearSearch}
          onLoadMore={handleLoadMore}
          loading={listLoading}
          switching={switching}
        />
      </ErrorBoundary>
      <div
        role="separator"
        aria-label={STRINGS.resize.listHandle}
        aria-orientation="vertical"
        aria-valuemin={CONVERSATION_LIST_MIN_WIDTH}
        aria-valuemax={CONVERSATION_LIST_MAX_WIDTH}
        aria-valuenow={Math.round(conversationListWidth)}
        tabIndex={0}
        onPointerDown={handleResizePointerDown}
        onKeyDown={handleResizeKeyDown}
        className={cn(
          "group flex h-full w-2 shrink-0 cursor-col-resize justify-center bg-workbench-surface outline-none transition-colors",
          isResizing
            ? "bg-workbench-surface-subtle"
            : "hover:bg-workbench-surface-subtle focus-visible:bg-workbench-surface-subtle",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "h-full w-px transition-colors",
            isResizing
              ? "bg-workbench-accent-soft"
              : "bg-workbench-line group-hover:bg-workbench-accent-soft group-focus-visible:bg-workbench-accent-soft",
          )}
        />
      </div>
      <div
        ref={chatAreaRef}
        className="flex h-full min-w-0 flex-1"
        // 聊天区最小宽护栏:窗口装不下更宽尺寸(squeeze)时,聊天列只缩到此宽度,
        // 再不够由最右内容裁切,而非把聊天压塌成不可用窄条。
        style={
          chatWidthLock
            ? {
                flex: `0 0 ${chatWidthLock}px`,
                width: chatWidthLock,
                minWidth: CHAT_AREA_MIN_WIDTH,
              }
            : { minWidth: CHAT_AREA_MIN_WIDTH }
        }
      >
        {conversation ? (
          <ErrorBoundary {...ERROR_BOUNDARY_PROPS}>
            <ChatArea
              conversation={conversation}
              messages={messages}
              accounts={accounts}
              selectedAccountId={selectedAccountId}
              onAccountChange={handleAccountChange}
              detailsOpen={detailsOpen}
              onToggleDetails={toggleDetails}
              loading={messagesLoading}
              error={messagesError}
              onRetry={retryMessages}
              hasMoreHistory={hasMoreMessages}
              onLoadMoreHistory={loadMoreMessages}
              onSendMessage={handleSendMessage}
              onLeaveMarkRead={markReadRecent}
              quickReplies={quickReplyItems}
              onCreateQuickReply={quickReplies.create}
              onUpdateQuickReply={quickReplies.update}
              onDeleteQuickReply={quickReplies.remove}
              // TODO(@mention API): 接通 useMentionCandidates(conversationId) 后透传
              mentionCandidates={EMPTY_MENTION_CANDIDATES}
            />
          </ErrorBoundary>
        ) : (
          <div className="flex min-w-0 flex-1 items-center justify-center bg-white text-wb-2xs text-workbench-text-muted">
            {STRINGS.conversationList.noConversation}
          </div>
        )}
      </div>
      {detailsOpen && (
        // 面板挂载只看 detailsOpen,不再 && conversation:无选中会话也能展开
        // (CustomerDetails 对 customer=null 渲染空态),避免"会话恰好为空 →
        // 面板挂不上 → React 状态与窗口尺寸不同步"。
        <ErrorBoundary {...ERROR_BOUNDARY_PROPS}>
          <CustomerDetails
            customer={customer}
            quickReplies={quickReplyItems}
            onRefresh={() => void refreshCustomer(true)}
            refreshing={customerLoading}
          />
        </ErrorBoundary>
      )}
      <ToastViewport />
    </WorkbenchPanel>
  );
}
