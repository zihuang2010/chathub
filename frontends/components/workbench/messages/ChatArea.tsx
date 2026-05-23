import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Loader2 } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";

import { showToast } from "@/components/ui/toast";
import type { Account } from "@/lib/types/account";
import { TRANSITION_DURATIONS, TRANSITION_EASE } from "@/lib/theme";
import { cn } from "@/lib/utils";

import { ChatEmptyState, ChatErrorState, ChatLoadingState } from "./ChatStates";
import { ChatHeader } from "./ChatHeader";
import { AT_BOTTOM_THRESHOLD, COMPOSER_DEFAULT_HEIGHT, TIME_BURST_GAP_MS } from "./constants";
import type { Conversation, Message, MessageAttachment, MessageBlock, QuickReply } from "./data";
import { DateDivider, MessageBubble, type ReplyTarget, UnreadDivider } from "./MessageBubble";
import { MessageComposer } from "./MessageComposer";
import { type MessageActionType } from "./MessageContextMenu";
import { RangePill } from "./RangePill";
import { STRINGS } from "./strings";
import { formatMessageDate, getMessageDayKey, messageReplyPreview } from "./utils";
import { type ScrollMetrics, WorkbenchScrollArea } from "./WorkbenchScrollArea";

interface ChatAreaProps {
  conversation: Conversation;
  messages: Message[];
  accounts: readonly Account[];
  selectedAccount: string | null;
  onAccountChange: (account: string | null) => void;
  detailsOpen: boolean;
  onToggleDetails: () => void;
  /**
   * 来自外部 history store 的"任意 fetch 进行中"信号。同时承担两个语义:
   *   - 初次加载: `loading && localMessages.length === 0` → 渲染 ChatLoadingState
   *   - 翻页加载: maybeLoadOlderHistory 用它做"重入 guard"
   * (旧 API 用 `loading` + `loading` 双 flag 表达同一份数据,合并后语义更清晰。)
   */
  loading?: boolean;
  /** Set when an external store reports a fetch error. */
  error?: Error | null;
  /** Called when the user clicks "retry" inside the error state. */
  onRetry?: () => void;
  /** Whether older history exists above the currently loaded timeline. */
  hasMoreHistory?: boolean;
  /** Called when the user scrolls near the top and older messages should be loaded. */
  onLoadMoreHistory?: () => Promise<void> | void;
  /** Quick-reply templates surfaced in the composer popover. */
  quickReplies?: QuickReply[];
  /** Conversations available as @mention candidates in the composer. */
  mentionCandidates?: Conversation[];
  /**
   * 真发送回调(text-only)。成功后后端落库 + 发 conversation-messages ChangeNotice,
   * 整窗 REPLACE 把这条收敛进权威列表(乐观气泡随之被替换)。失败则把该气泡标 failed。
   */
  onSendMessage?: (text: string) => Promise<void>;
  /** 切走/卸载该会话时回调,补一次 markRead(只在 leave 同步服务端,不按消息打)。 */
  onLeaveMarkRead?: (conversationId: string) => void | Promise<void>;
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

// 距顶 600px 即触发加载更早消息(而非贴顶 80px 才发):用户还在向上滑、上方仍有
// 缓冲内容时数据已在路上,新内容 prepend 后由 anchor-restore 校正,消除"滑到顶卡一下"。
const HISTORY_TOP_LOAD_THRESHOLD = 600;

interface PrependAnchor {
  conversationId: string;
  messageCount: number;
  scrollHeight: number;
  scrollTop: number;
}

interface ConversationCount {
  conversationId: string;
  count: number;
}

function buildTimelineItems(
  messages: Message[],
  conversation: Conversation,
  unreadAnchorId: string | null,
  unreadCount: number,
): TimelineItem[] {
  const items: TimelineItem[] = [];
  let previousDayKey: string | null = null;

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

    if (unreadCount > 0 && message.id === unreadAnchorId) {
      items.push({ type: "unread-divider", id: "unread-divider", count: unreadCount });
    }

    let replyTarget: ReplyTarget | undefined;
    if (message.replyTo) {
      const replied = messages.find((m) => m.id === message.replyTo);
      if (replied) {
        replyTarget = {
          senderName:
            replied.direction === "out" ? STRINGS.status.selfSenderName : conversation.name,
          text: messageReplyPreview(replied),
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
  hasMoreHistory = false,
  onLoadMoreHistory,
  quickReplies,
  mentionCandidates,
  onSendMessage,
  onLeaveMarkRead,
}: ChatAreaProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // 切会话时 AnimatePresence 的 crossfade 让旧/新两个 motion.div 暂时并存,
  // 共享同一个 scrollRef。React 在旧 viewport unmount 时会把 ref 写成 null,
  // 把新 viewport 写入的真实 DOM 清掉 —— 之后 scrollToBottom、IntersectionObserver
  // 的 root 都拿到 null 失效。用 callback ref 拒绝 null 调用,只接受非空 DOM,
  // 让 scrollRef.current 始终指向当前 viewport(新的写入会覆盖旧的)。
  const setScrollNode = useCallback((node: HTMLDivElement | null) => {
    if (node) scrollRef.current = node;
  }, []);
  const wasAtBottomRef = useRef(true);
  const metricsFromUserScrollRef = useRef(false);
  const previousMessageCountRef = useRef(messages.length);
  const pendingInitialScrollToLatestRef = useRef(true);
  const prependAnchorRef = useRef<PrependAnchor | null>(null);
  const historyLoadInFlightRef = useRef(false);
  const historyPrependAppliedMessageCountRef = useRef<number | null>(null);
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
  // 进入会话时累积的未读条数(顶部浮动 pill 显示);用户滚到/穿过 UnreadDivider
  // 后由 IntersectionObserver 清零。与 unreadBelow 对称——一个表示"视口下方
  // 有新到的消息",一个表示"视口上方有历史未读"。
  const [unreadAboveState, setUnreadAboveState] = useState<ConversationCount>({
    conversationId: conversation.id,
    count: 0,
  });
  const unreadAbove =
    unreadAboveState.conversationId === conversation.id ? unreadAboveState.count : 0;
  // UnreadDivider 的 DOM ref,用于 (1) handleUserScroll 内 getBoundingClientRect
  // 判 divider 与视口位置关系, (2) "↑ X 条未读" pill 点击时 scrollIntoView。
  // motion.div crossfade 期间旧/新 divider 共享同一个 ref,旧 unmount 时 React
  // 会写 null 进来 — 跟 scrollRef 同样的竞态。用 callback ref 拒绝 null,保证
  // unreadDividerRef.current 始终指向当前 motion 内的真实 divider DOM。
  const unreadDividerRef = useRef<HTMLDivElement | null>(null);
  const setUnreadDividerNode = useCallback((node: HTMLDivElement | null) => {
    if (node) unreadDividerRef.current = node;
  }, []);
  // 本会话内 divider 是否已经被用户"看到过"(进入视口或滚到下方)。
  // 一次性提示语义:只要看过一次,pill 在本会话内不再触发,避免反复闪烁。
  // 切会话 useLayoutEffect 清回 false。
  const hasSeenDividerRef = useRef(false);
  // 当父组件传入新会话的 messages 时，把本地副本同步过去。原版用
  // useEffect + queueMicrotask 包裹会引入一帧 stale 渲染；改用 React 官方
  // "渲染期同步"模式：把上一次同步过的 props 也存进 useState，渲染中比对、
  // 不一致就 setState——React 会丢弃当前渲染并立即用新 state 重新渲染，
  // 不产生 stale 帧、也不会无限循环。
  // 参考 https://react.dev/reference/react/useState#storing-information-from-previous-renders
  //
  // 同时跟踪 conversation.id：用户切会话时 messages prop 通常先停留在旧值,
  // useChatMessages 的 effect 才把它清空 → 拉新 → 三次渲染。
  // 渲染 1 中如不主动过滤,localMessages 仍是旧会话的消息(同 reference,跳过 sync),
  // 头部已变新会话 → "气泡是李四、标题是张三" 的闪一帧。
  // 这里在 conversation.id 变更时，按 conversationId 过滤 prop messages,
  // 不匹配的会话内容被立即丢弃,会显示 empty/loading 占位直到新数据到达。
  const [lastSyncedMessages, setLastSyncedMessages] = useState(messages);
  const [syncedConversationId, setSyncedConversationId] = useState(conversation.id);
  if (syncedConversationId !== conversation.id) {
    setSyncedConversationId(conversation.id);
    setLastSyncedMessages(messages);
    setLocalMessages(messages.filter((m) => m.conversationId === conversation.id));
  } else if (lastSyncedMessages !== messages) {
    setLastSyncedMessages(messages);
    setLocalMessages(messages);
  }

  // 打开会话(conversation.id 变化)时快照一次 unread。标已读会把 live conversation.unread 归零,
  // 分隔条改用快照值渲染 —— 坐席阅读期间分隔条不随红标被清而消失。点击触发的 markRead 是异步的,
  // 首帧渲染仍是 live unread,快照能捕获到打开时的真实值(无竞态)。
  const unreadSnapshotRef = useRef<{ id: string; unread: number }>({ id: "", unread: 0 });
  if (unreadSnapshotRef.current.id !== conversation.id) {
    unreadSnapshotRef.current = { id: conversation.id, unread: conversation.unread ?? 0 };
  }
  const unreadSnapshot = unreadSnapshotRef.current.unread;

  // 把未读「边界」钉死:进入会话那一刻第一条未读消息的 id + 条数。一旦定下,会话内
  // 不再随尾部漂移 —— 活跃期间实时到达的消息一律追加在分隔条下方,不移动分隔条、不计
  // 未读(主流 IM:分隔条标记「上次读到哪」,而非一个跟着尾巴滑的窗口)。
  //
  // 后端 records 无逐条 read 状态(historyToMessage 不填 isUnread),边界只能由打开时的
  // unread 快照推得:从消息尾部反数 N 条 in 方向消息,取最早那条作锚点。与 unreadSnapshotRef
  // 同样按 conversation.id 在渲染期冻结;消息异步到达,故只在本会话消息首次非空时定锚一次,
  // 在那之前保持「未定」(不渲染分隔条)。
  const unreadAnchorRef = useRef<{ id: string; anchorId: string | null; count: number }>({
    id: "",
    anchorId: null,
    count: 0,
  });
  if (unreadAnchorRef.current.id !== conversation.id && localMessages.length > 0) {
    let anchorId: string | null = null;
    let count = 0;
    for (let i = localMessages.length - 1; i >= 0 && count < unreadSnapshot; i--) {
      if (localMessages[i].direction === "in") {
        anchorId = localMessages[i].id;
        count++;
      }
    }
    unreadAnchorRef.current = { id: conversation.id, anchorId, count };
  }
  const anchored = unreadAnchorRef.current.id === conversation.id;
  const unreadAnchorId = anchored ? unreadAnchorRef.current.anchorId : null;
  const unreadDividerCount = anchored ? unreadAnchorRef.current.count : 0;

  const timelineItems = useMemo(
    () => buildTimelineItems(localMessages, conversation, unreadAnchorId, unreadDividerCount),
    [localMessages, conversation, unreadAnchorId, unreadDividerCount],
  );

  const handleScrollMetrics = useCallback((m: ScrollMetrics) => {
    const fromUserScroll = metricsFromUserScrollRef.current;
    metricsFromUserScrollRef.current = false;

    if (!fromUserScroll && !m.atBottom && wasAtBottomRef.current) {
      const node = scrollRef.current;
      if (node) {
        node.scrollTop = node.scrollHeight;
        wasAtBottomRef.current = true;
        setAtBottom((prev) => (prev ? prev : true));
        setUnreadBelow((prev) => (prev === 0 ? prev : 0));
        return;
      }
    }

    wasAtBottomRef.current = m.atBottom;
    setAtBottom((prev) => (prev === m.atBottom ? prev : m.atBottom));
    if (m.atBottom) setUnreadBelow(0);
  }, []);

  // localMessages.length 用 ref 读,而非作为 callback dep —— 写出去的快照不影响
  // callback 行为本身,放进 deps 会让 callback 每条消息都重建,间接 invalidate
  // handleUserScroll → 不稳定的 scroll listener。
  const localMessagesLengthRef = useRef(messages.length);
  useEffect(() => {
    localMessagesLengthRef.current = localMessages.length;
  }, [localMessages.length]);

  const maybeLoadOlderHistory = useCallback(
    (m: ScrollMetrics) => {
      if (m.scrollTop > HISTORY_TOP_LOAD_THRESHOLD) return;
      if (!hasMoreHistory || loading || !onLoadMoreHistory) return;
      if (historyLoadInFlightRef.current) return;
      if (pendingInitialScrollToLatestRef.current) return;
      const node = scrollRef.current;
      if (!node) return;

      prependAnchorRef.current = {
        conversationId: conversation.id,
        messageCount: localMessagesLengthRef.current,
        scrollHeight: node.scrollHeight,
        scrollTop: node.scrollTop,
      };
      historyLoadInFlightRef.current = true;

      Promise.resolve(onLoadMoreHistory())
        .catch(() => {
          if (prependAnchorRef.current?.conversationId === conversation.id) {
            prependAnchorRef.current = null;
          }
          // A13: 失败时给出 toast 反馈,之前是静默清 ref。
          showToast(STRINGS.errors.loadFailed, { type: "error" });
        })
        .finally(() => {
          historyLoadInFlightRef.current = false;
        });
    },
    [conversation.id, hasMoreHistory, loading, onLoadMoreHistory],
  );

  // 仅由 user-initiated scroll event 触发(WorkbenchScrollArea 内部把 native
  // scroll 与 mount/resize/RO 分开)。在这里把 pill 出现/消失的逻辑全部解决:
  //
  //   - divider 已可见 / 在视口下方 → 用户已经看到 → 清 pill + 标 seen
  //   - divider 在视口上方 + 未看过 + 不在底 + 有未读 → 显示 pill
  //   - 其他情况(在底 / 已看过 / 无未读) → 不动 pill
  //
  // 抛弃了 IntersectionObserver,所有判定基于一次 getBoundingClientRect 对比,
  // 没有异步 reporting 时序边界,行为可预测。
  const handleUserScroll = useCallback(
    (m: ScrollMetrics) => {
      metricsFromUserScrollRef.current = true;
      const divider = unreadDividerRef.current;
      const viewport = scrollRef.current;
      if (!viewport) return;
      maybeLoadOlderHistory(m);
      if (!divider) {
        if (unreadAbove > 0) {
          setUnreadAboveState({ conversationId: conversation.id, count: 0 });
        }
        return;
      }
      const dRect = divider.getBoundingClientRect();
      const vRect = viewport.getBoundingClientRect();
      // divider.bottom > viewport.top 即:divider 至少有一部分在视口内,
      // 或者整个在视口下方 = 用户已经能看到。
      if (dRect.bottom > vRect.top) {
        hasSeenDividerRef.current = true;
        if (unreadAbove > 0) {
          setUnreadAboveState({ conversationId: conversation.id, count: 0 });
        }
        return;
      }
      // divider 在视口上方(用户还没看到)
      if (hasSeenDividerRef.current) return;
      if (m.atBottom) return;
      const unread = conversation.unread ?? 0;
      if (unread <= 0) return;
      if (unreadAbove === unread) return;
      setUnreadAboveState({ conversationId: conversation.id, count: unread });
    },
    [conversation.id, conversation.unread, maybeLoadOlderHistory, unreadAbove],
  );

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior });
    wasAtBottomRef.current = true;
    setUnreadBelow(0);
  }, []);

  // 切走/卸载该会话时补一次 markRead:打开期间客户消息已读靠列表红标抑制(view-only),
  // 服务端只在离开时同步一次。用 ref 读实时 unread,不入 deps,避免每来一条消息就重跑 cleanup。
  const leaveUnreadRef = useRef(0);
  useEffect(() => {
    leaveUnreadRef.current = conversation.unread ?? 0;
  }, [conversation.unread]);
  useEffect(() => {
    const leavingId = conversation.id;
    return () => {
      if (leavingId && leaveUnreadRef.current > 0) void onLeaveMarkRead?.(leavingId);
    };
    // 仅在会话切换/卸载触发;实时 unread 走 ref,故意不入 deps。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.id]);

  // Switching conversations should eventually land on the latest message, but
  // real history arrives asynchronously. Mark the intent here and let the
  // message/layout effect below perform the actual snap once the viewport and
  // first page are both mounted.
  useLayoutEffect(() => {
    activeConversationIdRef.current = conversation.id;
    pendingInitialScrollToLatestRef.current = true;
    prependAnchorRef.current = null;
    historyLoadInFlightRef.current = false;
    historyPrependAppliedMessageCountRef.current = null;
    wasAtBottomRef.current = true;
    // 切会话**不**点亮顶部 pill。pill 只有当用户从底部主动向上滚动且
    // divider 仍在视口上方时由 handleUserScroll 触发。
    hasSeenDividerRef.current = false;
    previousMessageCountRef.current = localMessages.length;
    // localMessages dep is intentionally omitted — we only want to snap on
    // conversation change, not every message append.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.id]);

  useLayoutEffect(() => {
    if (!pendingInitialScrollToLatestRef.current) return;
    if (localMessages.length === 0) return;
    const node = scrollRef.current;
    if (!node) return;

    const snap = () => {
      const current = scrollRef.current;
      if (!current || activeConversationIdRef.current !== conversation.id) return false;
      current.scrollTop = current.scrollHeight;
      wasAtBottomRef.current = true;
      setAtBottom((prev) => (prev ? prev : true));
      setUnreadBelow((prev) => (prev === 0 ? prev : 0));
      return true;
    };

    snap();
    const rafId = requestAnimationFrame(() => {
      if (!snap()) return;
      pendingInitialScrollToLatestRef.current = false;
    });
    return () => cancelAnimationFrame(rafId);
  }, [conversation.id, error, loading, localMessages.length]);

  useLayoutEffect(() => {
    const anchor = prependAnchorRef.current;
    if (!anchor || anchor.conversationId !== conversation.id) return;

    if (localMessages.length <= anchor.messageCount) {
      if (!loading && !historyLoadInFlightRef.current) {
        prependAnchorRef.current = null;
      }
      return;
    }

    const node = scrollRef.current;
    if (!node) return;
    const nextScrollTop = node.scrollHeight - anchor.scrollHeight + anchor.scrollTop;
    node.scrollTop = Math.max(0, nextScrollTop);
    prependAnchorRef.current = null;
    historyLoadInFlightRef.current = false;
    historyPrependAppliedMessageCountRef.current = localMessages.length;

    const nextAtBottom =
      node.scrollHeight - node.scrollTop - node.clientHeight < AT_BOTTOM_THRESHOLD;
    wasAtBottomRef.current = nextAtBottom;
    setAtBottom((prev) => (prev === nextAtBottom ? prev : nextAtBottom));
  }, [conversation.id, loading, localMessages.length]);

  // pill 的"消失"现在由 handleUserScroll 内 getBoundingClientRect 判定
  // (divider 进入视口 / 在视口下方 = 用户已看到),不再用 IntersectionObserver。

  const scrollToUnread = useCallback(() => {
    const node = unreadDividerRef.current;
    if (!node) return;
    node.scrollIntoView({ block: "center", behavior: "smooth" });
  }, []);

  // Stale drafts from a prior conversation are ignored at render time rather
  // than cleared via effect — keeps state mutations off the conversation-switch
  // path and out of React's "setState in effect" lint surface.
  const activeReplyDraft = replyDraft?.conversationId === conversation.id ? replyDraft : null;

  // New messages: auto-follow if at bottom, else bump the unread counter.
  useEffect(() => {
    const previousCount = previousMessageCountRef.current;
    previousMessageCountRef.current = localMessages.length;
    if (historyPrependAppliedMessageCountRef.current === localMessages.length) {
      historyPrependAppliedMessageCountRef.current = null;
      return;
    }
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

  // 真发送一条出站消息:把发送时所属会话 id 闭包进来,settle 时与 ref 中的
  // "当前活跃会话"比对。成功路径不在这里改 localMessages —— 后端落库 + 发
  // conversation-messages ChangeNotice,整窗 REPLACE 把权威气泡收敛进来。失败时
  // 若用户仍在该会话,把这条乐观气泡标 failed(供 context menu resend)。
  const deliverMessage = useCallback(
    async (messageId: string, text: string) => {
      const owningConversationId = conversation.id;
      try {
        await onSendMessage?.(text);
      } catch {
        if (owningConversationId !== activeConversationIdRef.current) return;
        setLocalMessages((current) =>
          current.map((m) => (m.id === messageId ? { ...m, status: "failed" } : m)),
        );
      }
    },
    [conversation.id, onSendMessage],
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
      void deliverMessage(id, text);
    },
    [conversation.id, deliverMessage],
  );

  const handleAction = useCallback(
    (action: MessageActionType, message: Message) => {
      switch (action) {
        case "resend":
          setLocalMessages((current) =>
            current.map((m) => (m.id === message.id ? { ...m, status: "sending" } : m)),
          );
          void deliverMessage(message.id, message.text);
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
            text: messageReplyPreview(message),
          });
          break;
        case "scroll-to":
          // 由 ChatHeader 的内部跳转处理，此处不需要额外动作。
          break;
      }
    },
    [deliverMessage, conversation.id, conversation.name],
  );

  // 会话切换时 ChatHeader 和消息区必须同步 crossfade,不然标题(头像/名字/账号)
  // 瞬间硬切而消息区淡入淡出,视觉上"出一下出两下"。两块都用 conversation.id 作
  // AnimatePresence key + 同样的 duration/ease,触发与时长完全一致 → 像一个动作。
  // RangePill 显示的是 selectedAccount(跨会话不变),保持流式硬切即可,不加 motion。
  const headerHeight = 76;
  const motionAttrs = {
    initial: { opacity: 0, pointerEvents: "none" as const },
    animate: { opacity: 1, pointerEvents: "auto" as const },
    exit: { opacity: 0, pointerEvents: "none" as const },
    transition: {
      duration: TRANSITION_DURATIONS.quick / 1000,
      ease: TRANSITION_EASE,
    },
  };

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-workbench-surface">
      <div className="relative" style={{ height: headerHeight }}>
        <AnimatePresence initial={false}>
          <motion.div key={conversation.id} className="absolute inset-0" {...motionAttrs}>
            <ChatHeader conversation={conversation} />
          </motion.div>
        </AnimatePresence>
      </div>
      <RangePill
        accounts={accounts}
        selectedAccount={selectedAccount}
        onAccountChange={onAccountChange}
      />
      {/* 会话切换:消息区 crossfade(非 mode="wait")—— 两条会话同时 absolute 叠加,
          旧的 opacity:1→0、新的 opacity:0→1 同时跑,中间没有空白瞬间。key 只取
          conversation.id —— 不复合 loading/error/empty/data,避免同一会话内
          loading→data 的状态变化也跑动画(那才是之前"3 段闪"的根因)。
          exit 时把 pointerEvents 切成 'none' —— 旧 motion.div 还在 fade-out 时
          仍占满 inset-0、默认拦截 wheel/pointer 事件,导致用户切完会话立刻滚动
          滑轮没反应(事件落到正在消失的旧层而非新 ScrollArea)。framer-motion 把
          pointerEvents 当作非补间属性,在 exit 触发瞬间直接 snap 到 'none'。 */}
      <div className="relative flex min-h-0 flex-1">
        <AnimatePresence initial={false}>
          <motion.div
            key={conversation.id}
            className="absolute inset-0 flex min-h-0 flex-col overflow-hidden"
            {...motionAttrs}
          >
            {loading && localMessages.length === 0 ? (
              <ChatLoadingState />
            ) : error ? (
              <ChatErrorState error={error} onRetry={onRetry ?? (() => undefined)} />
            ) : localMessages.length === 0 ? (
              <ChatEmptyState />
            ) : (
              <WorkbenchScrollArea
                scrollRef={setScrollNode}
                onScrollMetrics={handleScrollMetrics}
                onUserScroll={handleUserScroll}
                className="flex-1 bg-workbench-surface"
                viewportClassName="overscroll-contain bg-workbench-surface px-4 pt-5 pb-10 pr-6"
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
                        <div
                          key={item.id}
                          ref={setUnreadDividerNode}
                          className={idx === 0 ? "" : "mt-7"}
                        >
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
          </motion.div>
        </AnimatePresence>
      </div>
      {/* 翻历史 spinner:length>0 时的 loading 必是翻页加载(初次加载 length===0 走
          ChatLoadingState 分支)。绝对定位顶部居中,不挤压消息流、不引发回弹位移。 */}
      {!error && localMessages.length > 0 && loading && hasMoreHistory && <HistoryLoadingPill />}
      {!loading && !error && localMessages.length > 0 && !atBottom && (
        <ScrollToBottomButton
          count={unreadBelow}
          bottomOffset={composerHeight + 12}
          onClick={() => scrollToBottom("smooth")}
        />
      )}
      {!loading && !error && localMessages.length > 0 && unreadAbove > 0 && (
        <UnreadAbovePill count={unreadAbove} onClick={scrollToUnread} />
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

const ScrollToBottomButton = memo(function ScrollToBottomButton({
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
});

// ─── Floating unread-above pill ─────────────────────────────────────────────
// 视觉镜像 ScrollToBottomButton:位置在消息区域右上角(top-3),箭头朝上,文案
// "↑ N 条未读"。点击 → scrollIntoView UnreadDivider。IntersectionObserver
// 检测到分隔条进入视口后由父组件清零 count,本 pill 跟着卸载。
const UnreadAbovePill = memo(function UnreadAbovePill({
  count,
  onClick,
}: {
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={STRINGS.status.unreadAbove(count)}
      className={cn(
        "focus-ring absolute right-4 top-3 z-20 inline-flex items-center gap-1.5 rounded-full border border-workbench-line bg-workbench-surface px-2.5 py-1 text-wb-2xs font-medium text-workbench-text-secondary shadow-wb-popover transition-all hover:bg-workbench-surface-subtle hover:text-workbench-accent",
        "animate-in fade-in slide-in-from-top-2",
      )}
    >
      <ArrowUp size={14} className="shrink-0" aria-hidden />
      <span className="wb-num font-medium text-workbench-accent">{count > 99 ? "99+" : count}</span>
      <span>{STRINGS.status.unreadAbove(count).replace(/^↑\s*\d+\+?\s*/, "")}</span>
    </button>
  );
});

// ─── Floating history-loading pill ──────────────────────────────────────────
// 顶部居中的"加载更早消息"指示。非交互(role=status),只在向上翻页拉取时出现。
// 绝对定位 + translate 居中,不参与消息流布局,避免 prepend 时与内容互相挤压。
const HistoryLoadingPill = memo(function HistoryLoadingPill() {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "pointer-events-none absolute left-1/2 top-3 z-20 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-workbench-line bg-workbench-surface px-2.5 py-1 text-wb-2xs font-medium text-workbench-text-secondary shadow-wb-popover",
        "animate-in fade-in slide-in-from-top-2",
      )}
    >
      <Loader2 size={13} className="shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />
      <span>{STRINGS.status.loadingHistory}</span>
    </div>
  );
});
