import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";

import { showToast } from "@/components/ui/toast";
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
import { TypingIndicator } from "./TypingIndicator";
import { formatMessageDate, getMessageDayKey } from "./utils";
import { type ScrollMetrics, WorkbenchScrollArea } from "./WorkbenchScrollArea";

interface ChatAreaProps {
  conversation: Conversation;
  messages: Message[];
  accountOptions: string[];
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
  accountOptions,
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
  const [composerHeight, setComposerHeight] = useState(COMPOSER_DEFAULT_HEIGHT);
  const [localMessages, setLocalMessages] = useState<Message[]>(messages);
  // `atBottom` mirrors the ref into render state so the scroll-to-bottom
  // button can show/hide reactively. The ref is still the source of truth
  // for non-render code paths (auto-follow on send).
  const [atBottom, setAtBottom] = useState(true);
  // Counts incoming messages that arrived while the user is scrolled up.
  // Cleared when the user clicks the floating button or returns to bottom.
  const [unreadBelow, setUnreadBelow] = useState(0);

  // Replace local copy when the parent swaps in a different conversation's data.
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setLocalMessages(messages);
    });
    return () => {
      cancelled = true;
    };
  }, [messages]);

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

  const completeMockSend = useCallback((messageId: string) => {
    const timer = window.setTimeout(() => {
      setLocalMessages((current) =>
        current.map((m) => (m.id === messageId ? { ...m, status: "sent" } : m)),
      );
      sendTimersRef.current.delete(messageId);
    }, MOCK_SEND_LATENCY_MS);
    sendTimersRef.current.set(messageId, timer);
  }, []);

  const handleSend = useCallback(
    (text: string, blocks?: MessageBlock[], attachments?: MessageAttachment[]) => {
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
      };
      setLocalMessages((current) => [...current, newMessage]);
      wasAtBottomRef.current = true;
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
          break;
        case "recall":
          setLocalMessages((current) =>
            current.map((m) =>
              m.id === message.id ? { ...m, isRecalled: true, status: undefined } : m,
            ),
          );
          showToast(STRINGS.toast.recallSuccess, { type: "success" });
          break;
        case "copy":
          // Already handled inside MessageContextMenu; this is just telemetry.
          break;
        case "reply":
        case "forward":
        case "details":
        case "scroll-to":
        default:
          if (typeof console !== "undefined") {
            console.warn(`[ChatArea] action "${action}" not yet wired for ${message.id}`);
          }
      }
    },
    [completeMockSend],
  );

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-workbench-surface">
      <ChatHeader conversation={conversation} />
      <RangePill
        accountOptions={accountOptions}
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
              const spacing = idx === 0 ? "" : item.isFirstInBurst ? "mt-7" : "mt-4";
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
          bottomOffset={composerHeight + (conversation.isTyping ? 36 : 12)}
          onClick={() => scrollToBottom("smooth")}
        />
      )}
      {conversation.isTyping && !loading && !error && <TypingIndicator />}
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
