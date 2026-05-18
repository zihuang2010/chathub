import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";

import { showToast } from "@/components/ui/toast";
import type { Account } from "@/lib/types/account";
import { cn } from "@/lib/utils";

import { ChatEmptyState, ChatErrorState, ChatLoadingState } from "./ChatStates";
import { ChatHeader } from "./ChatHeader";
import { COMPOSER_DEFAULT_HEIGHT, TIME_BURST_GAP_MS } from "./constants";
import type { Conversation, Message, MessageAttachment, MessageBlock, QuickReply } from "./data";
import { DateDivider, MessageBubble, type ReplyTarget, UnreadDivider } from "./MessageBubble";
import { MessageComposer } from "./MessageComposer";
import { type MessageActionType } from "./MessageContextMenu";
import { RangePill } from "./RangePill";
import { STRINGS } from "./strings";
import { formatMessageDate, getMessageDayKey } from "./utils";
import { type ScrollMetrics, WorkbenchScrollArea } from "./WorkbenchScrollArea";

interface ChatAreaProps {
  conversation: Conversation;
  messages: Message[];
  accounts: readonly Account[];
  selectedAccount: string | null;
  onAccountChange: (account: string | null) => void;
  detailsOpen: boolean;
  onToggleDetails: () => void;
  /** Set when an external store reports loading the message history. */
  loading?: boolean;
  /** Set when an external store reports a fetch error. */
  error?: Error | null;
  /** Called when the user clicks "retry" inside the error state. */
  onRetry?: () => void;
  /** Quick-reply templates surfaced in the composer popover. */
  quickReplies?: QuickReply[];
  /** Conversations available as @mention candidates in the composer. */
  mentionCandidates?: Conversation[];
}

type TimelineItem =
  | { type: "date-divider"; id: string; label: string }
  | { type: "unread-divider"; id: string; count: number }
  | {
      type: "message";
      id: string;
      message: Message;
      replyTarget?: ReplyTarget;
      /** First message of a same-sender burst — gets extra top margin so
       *  consecutive messages from the same person feel grouped. */
      isFirstInBurst: boolean;
    };

const MOCK_SEND_LATENCY_MS = 800;

function buildTimelineItems(messages: Message[], conversation: Conversation): TimelineItem[] {
  const items: TimelineItem[] = [];
  let previousDayKey: string | null = null;

  let firstUnreadIdx: number | null = null;
  let unreadCount = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].direction === "in" && messages[i].isUnread) {
      if (firstUnreadIdx === null) firstUnreadIdx = i;
      unreadCount++;
    }
  }

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];

    const dayKey = getMessageDayKey(message.sentAt);
    if (dayKey !== previousDayKey) {
      items.push({
        type: "date-divider",
        id: `date-${dayKey}-${message.id}`,
        label: formatMessageDate(message.sentAt),
      });
      previousDayKey = dayKey;
    }

    if (i === firstUnreadIdx && unreadCount > 0) {
      items.push({ type: "unread-divider", id: "unread-divider", count: unreadCount });
    }

    let replyTarget: ReplyTarget | undefined;
    if (message.replyTo) {
      const replied = messages.find((m) => m.id === message.replyTo);
      if (replied) {
        replyTarget = {
          senderName:
            replied.direction === "out" ? STRINGS.status.selfSenderName : conversation.name,
          text: replied.text,
        };
      }
    }

    const prev = messages[i - 1];
    const isFirstInBurst =
      !prev ||
      prev.direction !== message.direction ||
      new Date(message.sentAt).getTime() - new Date(prev.sentAt).getTime() > TIME_BURST_GAP_MS;

    items.push({
      type: "message",
      id: message.id,
      message,
      replyTarget,
      isFirstInBurst,
    });
  }

  return items;
}

export const ChatArea = memo(function ChatArea({
  conversation,
  messages,
  accounts,
  selectedAccount,
  onAccountChange,
  detailsOpen,
  onToggleDetails,
  loading,
  error,
  onRetry,
  quickReplies,
  mentionCandidates,
}: ChatAreaProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const wasAtBottomRef = useRef(true);
  const sendTimersRef = useRef<Map<string, number>>(new Map());
  const previousMessageCountRef = useRef(messages.length);
  // 记录当前活动会话，给定时器/异步回调判断"我所属的会话是否还活着"。
  const activeConversationIdRef = useRef(conversation.id);
  const [composerHeight, setComposerHeight] = useState(COMPOSER_DEFAULT_HEIGHT);
  const [localMessages, setLocalMessages] = useState<Message[]>(messages);
  const [replyDraft, setReplyDraft] = useState<
    (ReplyTarget & { id: string; conversationId: string }) | null
  >(null);
  // `atBottom` mirrors the ref into render state so the scroll-to-bottom
  // button can show/hide reactively. The ref is still the source of truth
  // for non-render code paths (auto-follow on send).
  const [atBottom, setAtBottom] = useState(true);
  // Counts incoming messages that arrived while the user is scrolled up.
  // Cleared when the user clicks the floating button or returns to bottom.
  const [unreadBelow, setUnreadBelow] = useState(0);

  // 当父组件传入新会话的 messages 时，把本地副本同步过去。原版用
  // useEffect + queueMicrotask 包裹会引入一帧 stale 渲染；改用 React 官方
  // "渲染期同步"模式：把上一次同步过的 props 也存进 useState，渲染中比对、
  // 不一致就 setState——React 会丢弃当前渲染并立即用新 state 重新渲染，
  // 不产生 stale 帧、也不会无限循环。
  // 参考 https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [lastSyncedMessages, setLastSyncedMessages] = useState(messages);
  if (lastSyncedMessages !== messages) {
    setLastSyncedMessages(messages);
    setLocalMessages(messages);
  }

  // Clean up pending mock send timers on unmount.
  useEffect(() => {
    const timers = sendTimersRef.current;
    return () => {
      timers.forEach((id) => window.clearTimeout(id));
      timers.clear();
    };
  }, []);

  const timelineItems = useMemo(
    () => buildTimelineItems(localMessages, conversation),
    [localMessages, conversation],
  );

  const handleScrollMetrics = useCallback((m: ScrollMetrics) => {
    wasAtBottomRef.current = m.atBottom;
    setAtBottom((prev) => (prev === m.atBottom ? prev : m.atBottom));
    if (m.atBottom) setUnreadBelow(0);
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior });
    wasAtBottomRef.current = true;
    setUnreadBelow(0);
  }, []);

  // Switching conversations always jumps to the latest message.
  useLayoutEffect(() => {
    activeConversationIdRef.current = conversation.id;
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
    wasAtBottomRef.current = true;
    setAtBottom(true);
    setUnreadBelow(0);
    previousMessageCountRef.current = localMessages.length;
    // localMessages dep is intentionally omitted — we only want to snap on
    // conversation change, not every message append.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.id]);

  // Stale drafts from a prior conversation are ignored at render time rather
  // than cleared via effect — keeps state mutations off the conversation-switch
  // path and out of React's "setState in effect" lint surface.
  const activeReplyDraft = replyDraft?.conversationId === conversation.id ? replyDraft : null;

  // New messages: auto-follow if at bottom, else bump the unread counter.
  useEffect(() => {
    const previousCount = previousMessageCountRef.current;
    previousMessageCountRef.current = localMessages.length;
    if (localMessages.length <= previousCount) return;
    const arrived = localMessages.length - previousCount;
    if (wasAtBottomRef.current) {
      const node = scrollRef.current;
      if (node) node.scrollTop = node.scrollHeight;
      return;
    }
    // Only count INCOMING bumps — sending out a message that you can see in
    // the composer doesn't need a "scroll down" hint.
    const incomingArrivals = localMessages
      .slice(-arrived)
      .filter((m) => m.direction === "in").length;
    if (incomingArrivals > 0) {
      setUnreadBelow((current) => current + incomingArrivals);
    }
  }, [localMessages]);

  const completeMockSend = useCallback(
    (messageId: string) => {
      // 把发送时所属会话 id 闭包进 timer，触发时与 ref 中的"当前活跃会话"比对。
      // 若 800ms 内用户切到其他会话，跳过 setState——localMessages 已被 sync 覆盖，
      // 误更新会污染当前会话状态。接入真后端后该判断同样适用（请求 settle
      // 必须按 conversationId 路由，避免响应回到错误会话）。
      const owningConversationId = conversation.id;
      const timer = window.setTimeout(() => {
        sendTimersRef.current.delete(messageId);
        if (owningConversationId !== activeConversationIdRef.current) return;
        setLocalMessages((current) =>
          current.map((m) => (m.id === messageId ? { ...m, status: "sent" } : m)),
        );
      }, MOCK_SEND_LATENCY_MS);
      sendTimersRef.current.set(messageId, timer);
    },
    [conversation.id],
  );

  const handleSend = useCallback(
    (
      text: string,
      blocks?: MessageBlock[],
      attachments?: MessageAttachment[],
      replyTo?: string,
    ) => {
      const id = `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const newMessage: Message = {
        id,
        conversationId: conversation.id,
        direction: "out",
        text,
        blocks: blocks && blocks.length > 0 ? blocks : undefined,
        sentAt: new Date().toISOString(),
        status: "sending",
        attachments: attachments && attachments.length > 0 ? attachments : undefined,
        replyTo,
      };
      setLocalMessages((current) => [...current, newMessage]);
      wasAtBottomRef.current = true;
      setReplyDraft(null);
      completeMockSend(id);
    },
    [conversation.id, completeMockSend],
  );

  const handleAction = useCallback(
    (action: MessageActionType, message: Message) => {
      switch (action) {
        case "resend":
          setLocalMessages((current) =>
            current.map((m) => (m.id === message.id ? { ...m, status: "sending" } : m)),
          );
          completeMockSend(message.id);
          break;
        case "delete":
          setLocalMessages((current) => current.filter((m) => m.id !== message.id));
          // 若引用预览正指向被删消息，发送时 replyTo 会指向不存在的 id
          // → buildTimelineItems 解析不到 replyTarget 静默丢失。同步清空。
          setReplyDraft((draft) => (draft?.id === message.id ? null : draft));
          break;
        case "recall":
          setLocalMessages((current) =>
            current.map((m) =>
              m.id === message.id ? { ...m, isRecalled: true, status: undefined } : m,
            ),
          );
          // 撤回的消息不再适合作为引用对象，同样清空。
          setReplyDraft((draft) => (draft?.id === message.id ? null : draft));
          showToast(STRINGS.toast.recallSuccess, { type: "success" });
          break;
        case "copy":
          // Already handled inside MessageContextMenu; this is just telemetry.
          break;
        case "reply":
          setReplyDraft({
            id: message.id,
            conversationId: conversation.id,
            senderName:
              message.direction === "out" ? STRINGS.status.selfSenderName : conversation.name,
            text: message.text,
          });
          break;
        case "scroll-to":
          // 由 ChatHeader 的内部跳转处理，此处不需要额外动作。
          break;
      }
    },
    [completeMockSend, conversation.id, conversation.name],
  );

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-workbench-surface">
      <ChatHeader conversation={conversation} />
      <RangePill
        accounts={accounts}
        selectedAccount={selectedAccount}
        onAccountChange={onAccountChange}
      />
      {loading ? (
        <ChatLoadingState />
      ) : error ? (
        <ChatErrorState error={error} onRetry={onRetry ?? (() => undefined)} />
      ) : localMessages.length === 0 ? (
        <ChatEmptyState />
      ) : (
        <WorkbenchScrollArea
          scrollRef={scrollRef}
          onScrollMetrics={handleScrollMetrics}
          className="flex-1 bg-workbench-surface"
          viewportClassName="bg-workbench-surface px-4 py-5 pr-6"
          contentClassName="flex w-full flex-col"
        >
          <div role="log" aria-live="polite" aria-atomic="false" className="flex flex-col">
            {timelineItems.map((item, idx) => {
              if (item.type === "date-divider") {
                return (
                  <div key={item.id} className={idx === 0 ? "" : "mt-7"}>
                    <DateDivider label={item.label} />
                  </div>
                );
              }
              if (item.type === "unread-divider") {
                return (
                  <div key={item.id} className={idx === 0 ? "" : "mt-7"}>
                    <UnreadDivider count={item.count} />
                  </div>
                );
              }
              const spacing = idx === 0 ? "" : item.isFirstInBurst ? "mt-7" : "mt-6";
              return (
                <div key={item.id} className={spacing}>
                  <MessageBubble
                    message={item.message}
                    avatarName={conversation.name}
                    avatarColor={conversation.avatarColor}
                    account={conversation.account}
                    replyTarget={item.replyTarget}
                    onAction={handleAction}
                  />
                </div>
              );
            })}
          </div>
        </WorkbenchScrollArea>
      )}
      {!loading && !error && localMessages.length > 0 && !atBottom && (
        <ScrollToBottomButton
          count={unreadBelow}
          bottomOffset={composerHeight + 12}
          onClick={() => scrollToBottom("smooth")}
        />
      )}
      <MessageComposer
        key={conversation.id}
        conversationId={conversation.id}
        height={composerHeight}
        onHeightChange={setComposerHeight}
        detailsOpen={detailsOpen}
        onToggleDetails={onToggleDetails}
        onSend={handleSend}
        quickReplies={quickReplies}
        mentionCandidates={mentionCandidates}
        replyDraft={activeReplyDraft}
        onCancelReply={() => setReplyDraft(null)}
      />
    </div>
  );
});

// ─── Floating scroll-to-bottom pill ─────────────────────────────────────────

function ScrollToBottomButton({
  count,
  bottomOffset,
  onClick,
}: {
  count: number;
  bottomOffset: number;
  onClick: () => void;
}) {
  const hasUnread = count > 0;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={
        hasUnread
          ? `${STRINGS.status.scrollToBottom},${STRINGS.status.newMessagesBelow(count)}`
          : STRINGS.status.scrollToBottom
      }
      style={{ bottom: bottomOffset }}
      className={cn(
        "focus-ring absolute right-4 z-20 inline-flex items-center gap-1.5 rounded-full border border-workbench-line bg-workbench-surface px-2.5 py-1 text-wb-2xs font-medium text-workbench-text-secondary shadow-wb-popover transition-all hover:bg-workbench-surface-subtle hover:text-workbench-accent",
        "animate-in fade-in slide-in-from-bottom-2",
      )}
    >
      <ArrowDown size={14} className="shrink-0" aria-hidden />
      {hasUnread ? (
        <>
          <span className="wb-num font-medium text-workbench-accent">
            {count > 99 ? "99+" : count}
          </span>
          <span>{STRINGS.status.newMessagesBelow(count).replace(/^\d+\+?\s*/, "")}</span>
        </>
      ) : (
        <span>{STRINGS.status.scrollToBottom}</span>
      )}
    </button>
  );
}
