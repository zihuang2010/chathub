import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ToastViewport } from "@/components/ui/toast";
import { WorkbenchPanel } from "@/components/workbench/WorkbenchPanel";
import type { Account } from "@/lib/types/account";
import { useRecentFriends, type RecentFriendListEntry } from "@/lib/api/useRecentFriends";
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
  return {
    id: entry.conversationId,
    name: entry.externalName || "(未命名)",
    preview: entry.lastMessageSummary,
    account: entry.wecomAlias || entry.wecomName,
    time: formatRelativeTime(entry.lastMessageTimeMs),
    unread: entry.unreadCount,
    online: false,
    draftText: draftText || undefined,
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
  const { items: recentEntries } = useRecentFriends({ accountFilter: selectedAccountId });

  // 适配成 ConversationList 现有 `Conversation` 形态;一次性 useMemo,源是稳定引用。
  const conversations = useMemo(() => recentEntries.map(adaptEntryToConversation), [recentEntries]);

  // 列表非空但 selectedId 不在列表中(初始挂载 / 切账号 / 数据更新后)→ 自动选第一项。
  // 这里就是"外部数据驱动 → 校正本地选中"的同步场景,无法 derive(selectedId 还要响应
  // 用户点击),所以 effect 内 setState 是必要的。lint 标 cascading-renders 是泛报警。
  useEffect(() => {
    if (conversations.length === 0) return;
    if (selectedId && conversations.some((c) => c.id === selectedId)) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedId(conversations[0].id);
  }, [conversations, selectedId]);

  // 列表为空时(初次加载 / 无数据)用 MOCK 兜底,避免 ChatArea / CustomerDetails 拿 null。
  // 真实消息列表对接是后续 PR 范畴,本次仅打通会话列表入口。
  const conversation = useMemo(
    () =>
      conversations.find((c) => c.id === selectedId) ?? conversations[0] ?? MOCK_CONVERSATIONS[0],
    [conversations, selectedId],
  );
  // 当前选中会话归属的真实 (wecomAccountId, externalUserId);若是 MOCK 兜底返回为 undefined,
  // useChatMessages 内部会 fallback 到 mock 数据源。两个值都非空时走 fetch_message_history。
  const selectedEntry = useMemo(
    () => recentEntries.find((e) => e.conversationId === conversation.id),
    [recentEntries, conversation.id],
  );
  const {
    messages,
    loading: messagesLoading,
    error: messagesError,
    retry: retryMessages,
  } = useChatMessages({
    source: MOCK_MESSAGES_BY_CONVERSATION,
    conversationId: conversation.id,
    wecomAccountId: selectedEntry?.wecomAccountId,
    externalUserId: selectedEntry?.externalUserId,
  });
  const customer = useMemo(
    () => MOCK_CUSTOMERS_BY_CONVERSATION[conversation.id] ?? MOCK_CUSTOMERS_BY_CONVERSATION.c1,
    [conversation.id],
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
      if (!account || conversation.account === account) return;
      // 切到该账号下的第一条会话(优先真实数据,无数据时再 fallback MOCK 兼容旧 UI);
      // useRecentFriends 跟随 selectedAccountId 重新拉取后,useEffect 会再校正一次 selectedId。
      const next =
        conversations.find((item) => item.account === account) ??
        MOCK_CONVERSATIONS.find((item) => item.account === account);
      if (next) setSelectedId(next.id);
    },
    [conversation.account, conversations],
  );

  const errorBoundaryProps = {
    title: STRINGS.errors.pageUnavailable,
    retryLabel: STRINGS.errors.retry,
  };

  return (
    <WorkbenchPanel panelRef={pageRef} className="relative">
      <ErrorBoundary {...errorBoundaryProps}>
        <ConversationList
          conversations={conversations}
          selectedId={selectedId}
          onSelect={setSelectedId}
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
            quickReplies={MOCK_QUICK_REPLIES}
            mentionCandidates={MOCK_CONVERSATIONS}
          />
        </ErrorBoundary>
      </div>
      {detailsOpen && (
        <ErrorBoundary {...errorBoundaryProps}>
          <CustomerDetails customer={customer} quickReplies={MOCK_QUICK_REPLIES} />
        </ErrorBoundary>
      )}
      <ToastViewport />
    </WorkbenchPanel>
  );
}
