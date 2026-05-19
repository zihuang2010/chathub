import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ToastViewport } from "@/components/ui/toast";
import { WorkbenchPanel } from "@/components/workbench/WorkbenchPanel";
import type { Account } from "@/lib/types/account";
import { useRecentFriends, type RecentFriendListEntry } from "@/lib/api/useRecentFriends";
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
import type { Conversation } from "./data";
import {
  MOCK_CONVERSATIONS,
  MOCK_CUSTOMERS_BY_CONVERSATION,
  MOCK_MESSAGES_BY_CONVERSATION,
  MOCK_QUICK_REPLIES,
} from "./data";
import { MessagesSkeleton } from "./MessagesSkeleton";
import { useChatMessages } from "./useChatMessages";
import { useDetailsWindow } from "./useDetailsWindow";

/**
 * 把后端最近会话条目适配成 ConversationList 现有 `Conversation` 形态。
 *
 * 字段对接策略:
 *   - id / name / preview / unread:直映
 *   - account:用 wecomAlias 作显示名(跟 AccountDropdown 列表里的 `account.name` 对齐契机);
 *     缺失时 fallback wecomName。
 *   - time:lastMessageTimeMs → 相对时间字符串("HH:mm" / "昨天" / "周二" / "M/d")
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
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function adaptEntryToConversation(entry: RecentFriendListEntry): Conversation {
  const draftText = extractDraftPreview(entry.localDraftText);
  // 列表行时间用 max(lastMessageTimeMs, localDraftAtMs),与 useRecentFriends 的
  // multiKeySort 排序键一致:有草稿且新于最后消息时显示草稿时间,新消息进来反超
  // 草稿时间后自动切回消息时间。否则会出现"行按草稿时间排到顶部、但右上角
  // 时间字段是旧消息时间"的视觉错位(微信桌面端约定)。
  const effectiveTimeMs = Math.max(entry.lastMessageTimeMs, entry.localDraftAtMs);
  return {
    id: entry.conversationId,
    name: entry.externalName || "(未命名)",
    preview: entry.lastMessageSummary,
    account: entry.wecomAlias || entry.wecomName,
    time: formatRelativeTime(effectiveTimeMs),
    unread: entry.unreadCount,
    online: false,
    draftText: draftText || undefined,
    pinned: entry.pinned,
  };
}

/**
 * 把 SQLite 存的 TipTap JSON 字符串解析为 plain text 预览。
 * useDraftStore 双写时存的是 JSON.stringify(JSONContent) — 直接展示会显示 JSON 源码。
 * 解析失败时(非 JSON / 文档损坏) fallback 当 raw text 截断。
 */
function extractDraftPreview(stored: string): string {
  if (!stored) return "";
  let doc: unknown;
  try {
    doc = JSON.parse(stored);
  } catch {
    return stored.slice(0, 80);
  }
  return extractTextFromNode(doc).replace(/\s+/g, " ").trim().slice(0, 80);
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
  /** 由 Workbench 提供的账号列表(来自 list_accounts)。下拉用 `account.name` 做选项值;
   *  接 useRecentFriends 时按 name 反查 `account.id`(= `wecomAccountId`)再传给后端。 */
  accounts: readonly Account[];
}

export function MessagesPage({ accounts }: MessagesPageProps) {
  const [selectedId, setSelectedId] = useState<string>("");
  const [selectedAccount, setSelectedAccount] = useState<string | null>(null);
  const [conversationListWidth, setConversationListWidth] = useState(
    CONVERSATION_LIST_DEFAULT_WIDTH,
  );
  const [isResizing, setIsResizing] = useState(false);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const chatAreaRef = useRef<HTMLDivElement | null>(null);
  const dragStartRef = useRef({ x: 0, width: CONVERSATION_LIST_DEFAULT_WIDTH });

  const { detailsOpen, chatWidthLock, toggleDetails, markManualResizeIfNeeded } = useDetailsWindow({
    chatAreaRef,
  });

  // 顶部账号选择器输出的是 Account.name(跟 conversation.account 同形态),
  // 接 useRecentFriends 需要 wecomAccountId,从 accounts 表反查;null/未命中传 null = 全部账号。
  const selectedAccountId = useMemo(() => {
    if (!selectedAccount) return null;
    const acct = accounts.find((a) => a.name === selectedAccount);
    return acct?.id ?? null;
  }, [accounts, selectedAccount]);

  // SyncStatusBadge 现已搬到 Sidebar 用户名下方(全局可见),这里只消费数据相关字段。
  // resyncing / connectionState / lastEventAt / lastRefreshAt / error 由 Sidebar 的
  // useHubSyncStatus 单独管,不再从这里透传。
  const {
    items: recentEntries,
    initialFetched,
    pin: pinRecent,
    remove: removeRecent,
  } = useRecentFriends({
    accountFilter: selectedAccountId,
  });

  // "移除会话"持久化在 SQLite hub_conversation_recents.removed 列(V11);
  // 后端 list_top WHERE removed=0 已经把隐藏行过滤掉,前端不再二次过滤。
  // 自动恢复:远端事件 last_message_time_ms > removed_at_ms 时,UPSERT ON CONFLICT 自动清零。

  // 适配成 ConversationList 现有 `Conversation` 形态;一次性 useMemo,源是稳定引用。
  const conversations = useMemo(() => recentEntries.map(adaptEntryToConversation), [recentEntries]);

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
  const selectedEntry = useMemo(
    () =>
      conversation ? recentEntries.find((e) => e.conversationId === conversation.id) : undefined,
    [recentEntries, conversation],
  );
  const {
    messages,
    loading: messagesLoading,
    error: messagesError,
    hasMore: hasMoreMessages,
    loadMore: loadMoreMessages,
    retry: retryMessages,
  } = useChatMessages({
    source: MOCK_MESSAGES_BY_CONVERSATION,
    conversationId: conversation?.id ?? "",
    wecomAccountId: selectedEntry?.wecomAccountId,
    externalUserId: selectedEntry?.externalUserId,
  });
  // 客户详情真实接口未落地;短期保留 MOCK_CUSTOMERS_BY_CONVERSATION.c1 作开发期 placeholder。
  // TODO(customer-details API): 接通后改为 null + 组件层空态。
  const customer = useMemo(
    () =>
      conversation
        ? (MOCK_CUSTOMERS_BY_CONVERSATION[conversation.id] ?? MOCK_CUSTOMERS_BY_CONVERSATION.c1)
        : null,
    [conversation],
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
      if (detailsOpen) markManualResizeIfNeeded();
      setConversationListWidth((width) => clampConversationListWidth(width));
    };

    handleWindowResize();
    window.addEventListener("resize", handleWindowResize);
    return () => window.removeEventListener("resize", handleWindowResize);
  }, [clampConversationListWidth, detailsOpen, markManualResizeIfNeeded]);

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
    (account: string | null) => {
      setSelectedAccount(account);
      if (!account || conversation?.account === account) return;
      // 切到该账号下的第一条会话;useRecentFriends 跟随 selectedAccountId 重新拉取后,
      // useEffect 会再校正一次 selectedId。
      const next = conversations.find((item) => item.account === account);
      if (next) setSelectedId(next.id);
    },
    [conversation?.account, conversations],
  );

  const errorBoundaryProps = {
    title: STRINGS.errors.pageUnavailable,
    retryLabel: STRINGS.errors.retry,
  };

  // 首屏数据门:本地 cache 还没读出来时渲染骨架,挡掉 ChatArea/CustomerDetails 拿空数据画一帧的闪烁。
  // initialFetched 单调向前(useResource 保证),后续切账号/refetch 不会再回退到 skeleton。
  if (!initialFetched) {
    return <MessagesSkeleton />;
  }

  return (
    <WorkbenchPanel panelRef={pageRef} className="relative">
      <ErrorBoundary {...errorBoundaryProps}>
        <ConversationList
          conversations={conversations}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onTogglePin={pinRecent}
          onRemove={removeRecent}
          width={conversationListWidth}
          accounts={accounts}
          selectedAccount={selectedAccount}
          onAccountChange={handleAccountChange}
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
        style={chatWidthLock ? { flex: `0 0 ${chatWidthLock}px`, width: chatWidthLock } : undefined}
      >
        {conversation ? (
          <ErrorBoundary {...errorBoundaryProps}>
            <ChatArea
              conversation={conversation}
              messages={messages}
              accounts={accounts}
              selectedAccount={selectedAccount}
              onAccountChange={handleAccountChange}
              detailsOpen={detailsOpen}
              onToggleDetails={toggleDetails}
              loading={messagesLoading}
              error={messagesError}
              onRetry={retryMessages}
              hasMoreHistory={hasMoreMessages}
              loadingHistory={messagesLoading}
              onLoadMoreHistory={loadMoreMessages}
              quickReplies={MOCK_QUICK_REPLIES}
              mentionCandidates={MOCK_CONVERSATIONS}
            />
          </ErrorBoundary>
        ) : (
          <div className="flex min-w-0 flex-1 items-center justify-center bg-white text-wb-2xs text-workbench-text-muted">
            {STRINGS.conversationList.noConversation}
          </div>
        )}
      </div>
      {detailsOpen && conversation && customer && (
        <ErrorBoundary {...errorBoundaryProps}>
          <CustomerDetails customer={customer} quickReplies={MOCK_QUICK_REPLIES} />
        </ErrorBoundary>
      )}
      <ToastViewport />
    </WorkbenchPanel>
  );
}
