// 消息区滚动控制器(Stage 4d:从 ChatArea 抽出)。
//
// 内聚一簇相互依赖的滚动状态:置底跟随、翻历史的 prepend 锚点恢复、未读「上方/下方」
// 浮动 pill 的出现/消失、切会话 snap-to-latest、离开会话补 markRead。逻辑与原 ChatArea
// 内联实现完全一致,仅做结构搬移。
//
// ⚠️ 滚动位置/锚点行为依赖真实布局(scrollHeight / getBoundingClientRect),jsdom 无法
// 复现,故本 hook 的滚动正确性需在运行的应用里手测;单测仅覆盖纯状态逻辑。

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";

import { showToast } from "@/components/ui/toast";

import { AT_BOTTOM_THRESHOLD } from "../constants";
import type { Conversation, Message } from "../data";
import { STRINGS } from "../strings";
import type { ScrollMetrics } from "../WorkbenchScrollArea";

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

export interface UseScrollControllerParams {
  conversation: Conversation;
  localMessages: Message[];
  loading?: boolean;
  error?: Error | null;
  hasMoreHistory?: boolean;
  onLoadMoreHistory?: () => Promise<void> | void;
  onLeaveMarkRead?: (conversationId: string) => void | Promise<void>;
}

export interface UseScrollControllerResult {
  setScrollNode: (node: HTMLDivElement | null) => void;
  setUnreadDividerNode: (node: HTMLDivElement | null) => void;
  handleScrollMetrics: (m: ScrollMetrics) => void;
  handleUserScroll: (m: ScrollMetrics) => void;
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  scrollToUnread: () => void;
  atBottom: boolean;
  unreadBelow: number;
  unreadAbove: number;
  /** 暴露给发送流程:发出消息后置 true 触发贴底跟随(原 ChatArea handleSend 行为)。 */
  wasAtBottomRef: MutableRefObject<boolean>;
  /** 滚动 viewport 节点 ref,供虚拟器 getScrollElement 使用。 */
  scrollElementRef: MutableRefObject<HTMLDivElement | null>;
}

export function useScrollController({
  conversation,
  localMessages,
  loading,
  error,
  hasMoreHistory = false,
  onLoadMoreHistory,
  onLeaveMarkRead,
}: UseScrollControllerParams): UseScrollControllerResult {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // 旧 viewport unmount 时 React 会把 ref 写成 null;用 callback ref 拒绝 null,
  // 让 scrollRef.current 始终指向当前 viewport(新的写入会覆盖旧的)。
  const setScrollNode = useCallback((node: HTMLDivElement | null) => {
    if (node) scrollRef.current = node;
  }, []);
  const wasAtBottomRef = useRef(true);
  const metricsFromUserScrollRef = useRef(false);
  const previousMessageCountRef = useRef(localMessages.length);
  const pendingInitialScrollToLatestRef = useRef(true);
  const prependAnchorRef = useRef<PrependAnchor | null>(null);
  const historyLoadInFlightRef = useRef(false);
  const historyPrependAppliedMessageCountRef = useRef<number | null>(null);
  // 记录当前活动会话,给定时器/异步回调判断"我所属的会话是否还活着"。
  const activeConversationIdRef = useRef(conversation.id);

  const [atBottom, setAtBottom] = useState(true);
  // Counts incoming messages that arrived while the user is scrolled up.
  const [unreadBelow, setUnreadBelow] = useState(0);
  const [unreadAboveState, setUnreadAboveState] = useState<ConversationCount>({
    conversationId: conversation.id,
    count: 0,
  });
  const unreadAbove =
    unreadAboveState.conversationId === conversation.id ? unreadAboveState.count : 0;

  const unreadDividerRef = useRef<HTMLDivElement | null>(null);
  const setUnreadDividerNode = useCallback((node: HTMLDivElement | null) => {
    if (node) unreadDividerRef.current = node;
  }, []);
  // 本会话内 divider 是否已被用户"看到过"(进入视口或滚到下方)。切会话清回 false。
  const hasSeenDividerRef = useRef(false);

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
  const localMessagesLengthRef = useRef(localMessages.length);
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

  // 仅由 user-initiated scroll event 触发。在这里把 pill 出现/消失的逻辑全部解决:
  //   - divider 已可见 / 在视口下方 → 用户已经看到 → 清 pill + 标 seen
  //   - divider 在视口上方 + 未看过 + 不在底 + 有未读 → 显示 pill
  //   - 其他情况(在底 / 已看过 / 无未读) → 不动 pill
  // 所有判定基于一次 getBoundingClientRect 对比,没有异步 reporting 时序边界,行为可预测。
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
      // divider.bottom > viewport.top 即:divider 至少有一部分在视口内,或整个在视口下方。
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

  // 切会话:标记需要 snap-to-latest,实际滚动由下面的 layout effect 在视口与首页都挂载后执行。
  useLayoutEffect(() => {
    activeConversationIdRef.current = conversation.id;
    pendingInitialScrollToLatestRef.current = true;
    prependAnchorRef.current = null;
    historyLoadInFlightRef.current = false;
    historyPrependAppliedMessageCountRef.current = null;
    wasAtBottomRef.current = true;
    // 切会话**不**点亮顶部 pill。pill 只有当用户从底部主动向上滚动且 divider 仍在视口上方时触发。
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

  const scrollToUnread = useCallback(() => {
    const node = unreadDividerRef.current;
    if (!node) return;
    node.scrollIntoView({ block: "center", behavior: "smooth" });
  }, []);

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

  return {
    setScrollNode,
    setUnreadDividerNode,
    handleScrollMetrics,
    handleUserScroll,
    scrollToBottom,
    scrollToUnread,
    atBottom,
    unreadBelow,
    unreadAbove,
    wasAtBottomRef,
    scrollElementRef: scrollRef,
  };
}
