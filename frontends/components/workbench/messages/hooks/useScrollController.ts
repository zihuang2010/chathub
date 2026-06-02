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
  type WheelEvent,
} from "react";

import { showToast } from "@/components/ui/toast";

import {
  AT_BOTTOM_THRESHOLD,
  HISTORY_PREFETCH_MIN_PX,
  REASSERT_MAX_FRAMES,
  REASSERT_STABLE_FRAMES,
  SETTLE_SCROLLTOP_EPSILON,
} from "../constants";
import type { Conversation, Message } from "../data";
import { STRINGS } from "../strings";
import type { ScrollMetrics } from "../WorkbenchScrollArea";

// 上拉预取阈值:距顶 ≤ max(HISTORY_PREFETCH_MIN_PX, 一个视口高度) ≈ 一屏即后台加载更旧页。
// 提前预取 → 数据在用户滚到顶之前就位、prepend 在远离顶部边界处落地,锚定补偿不被 scrollTop=0
// 钳制、也不与边界惯性相争,当前内容不动;同时不必"等惯性停"再触发,灵敏度大幅提升。
const prefetchThreshold = (clientHeight: number): number =>
  Math.max(HISTORY_PREFETCH_MIN_PX, clientHeight);

interface PrependAnchor {
  conversationId: string;
  messageCount: number;
  // 闭式回退(jsdom 无布局 / 未捕获到参照行时用):prepend 前后 scrollHeight 差值。
  scrollHeight: number;
  scrollTop: number;
  // 参照行锚(真实浏览器主路径):视口顶部第一条可见消息行的 id + 其相对视口顶的偏移。
  // prepend 后把同一行恢复到同一偏移,**只看这一行的视觉位置、不依赖总高**,因此免疫:
  // 边界处 burst 间距/日期分隔增减、占位盒、以及"加载窗口内底部来新消息撑高 scrollHeight"
  // 等一切会让闭式差值偏的情况 —— 当前页面视觉真正不动。
  refId: string | null;
  refTopRel: number | null;
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
  handleWheelCapture: (event: WheelEvent<HTMLDivElement>) => void;
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  scrollToUnread: () => void;
  atBottom: boolean;
  unreadBelow: number;
  unreadAbove: number;
  /** 暴露给发送流程:发出消息后置 true 触发贴底跟随(原 ChatArea handleSend 行为)。 */
  wasAtBottomRef: MutableRefObject<boolean>;
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
  // prepend 后有限重断言锚点的 rAF 句柄(见锚点恢复 layout effect)。
  const reassertRafRef = useRef<number | null>(null);
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

  const loadOlderHistoryAtBoundary = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return false;
    if (historyLoadInFlightRef.current) return true;
    if (prependAnchorRef.current?.conversationId === conversation.id) return true;
    if (!hasMoreHistory || loading || !onLoadMoreHistory) return false;
    if (pendingInitialScrollToLatestRef.current) return false;

    // 捕获视口顶部第一条可见行作参照锚:行 key=message.id 稳定,prepend 后不 remount,可按
    // data-message-row-id 找回。比 scrollHeight 差值更稳——只盯这一行的视觉位置。
    const vTop = node.getBoundingClientRect().top;
    let refId: string | null = null;
    let refTopRel: number | null = null;
    const rows = node.querySelectorAll<HTMLElement>("[data-message-row-id]");
    for (let i = 0; i < rows.length; i++) {
      const rRect = rows[i].getBoundingClientRect();
      if (rRect.bottom > vTop + 0.5) {
        refId = rows[i].getAttribute("data-message-row-id");
        refTopRel = rRect.top - vTop;
        break;
      }
    }

    prependAnchorRef.current = {
      conversationId: conversation.id,
      messageCount: localMessagesLengthRef.current,
      scrollHeight: node.scrollHeight,
      scrollTop: node.scrollTop,
      refId,
      refTopRel,
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
    return true;
  }, [conversation.id, hasMoreHistory, loading, onLoadMoreHistory]);

  // 进入预取区(距顶 ≤ 一屏)即直接拉更旧页 —— 不再"等惯性停稳",触发即时。重入由
  // loadOlderHistoryAtBoundary 内部的 in-flight / 已有锚点 / 仍在首屏 snap 等守卫挡住,
  // 命中阈值的连续滚动事件只会触发一次加载。prepend 在远离顶部边界处落地,锚定恢复(参照行锚
  // + 有界重断言)即可让当前视口纹丝不动,无需再靠停稳门控规避边界处的惯性冲突。
  const maybeLoadOlderHistory = useCallback(
    (m: ScrollMetrics) => {
      if (m.scrollTop > prefetchThreshold(m.clientHeight)) return;
      loadOlderHistoryAtBoundary();
    },
    [loadOlderHistoryAtBoundary],
  );

  const handleWheelCapture = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      if (event.deltaY >= 0) return;
      const node = scrollRef.current;
      if (!node) return;
      if (node.scrollTop > prefetchThreshold(node.clientHeight)) return;
      // 进入预取区即后台加载,但**不** preventDefault —— 提前预取要让原生滚动顺畅继续(用户
      // 可一路上滚,数据在背后就位)。重复触发由 loadOlderHistoryAtBoundary 的守卫吸收。
      loadOlderHistoryAtBoundary();
    },
    [loadOlderHistoryAtBoundary],
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
    // 取消上个会话悬挂的重断言 rAF,防跨会话野回调改新会话 scrollTop。
    if (reassertRafRef.current != null) cancelAnimationFrame(reassertRafRef.current);
    reassertRafRef.current = null;
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

    // 目标 scrollTop:主路径=参照行锚 —— 把捕获到的那条可见行恢复到它原来的视口偏移,只依赖这
    // 一行的实测位置,免疫 prepend 前后总高的任何变化(边界 burst 间距/日期分隔增减、占位盒、以及
    // "加载窗口内底部来新消息撑高 scrollHeight"——后者正是闭式差值会偏的主因)。无布局(jsdom)或
    // 找不到参照行时回退到 scrollHeight 差值闭式(单测走这条,行为同原逻辑)。
    const targetFor = (n: HTMLDivElement): number => {
      const vRect = n.getBoundingClientRect();
      if (vRect.height > 0 && anchor.refId != null && anchor.refTopRel != null) {
        const rows = n.querySelectorAll<HTMLElement>("[data-message-row-id]");
        for (let i = 0; i < rows.length; i++) {
          if (rows[i].getAttribute("data-message-row-id") === anchor.refId) {
            const curRel = rows[i].getBoundingClientRect().top - vRect.top;
            return Math.max(0, n.scrollTop + (curRel - anchor.refTopRel));
          }
        }
      }
      return Math.max(0, n.scrollHeight - anchor.scrollHeight + anchor.scrollTop);
    };

    // 1) paint 前单次到位。
    node.scrollTop = targetFor(node);

    // 锚点清理 / prepend 标记 / atBottom 同步 —— 时机与原逻辑一致,不依赖下面的重断言结果,
    // 故"新消息贴底跟随"effect 仍靠 historyPrependAppliedMessageCountRef 跳过本次增长,行为不变。
    prependAnchorRef.current = null;
    historyLoadInFlightRef.current = false;
    historyPrependAppliedMessageCountRef.current = localMessages.length;
    const nextAtBottom =
      node.scrollHeight - node.scrollTop - node.clientHeight < AT_BOTTOM_THRESHOLD;
    wasAtBottomRef.current = nextAtBottom;
    setAtBottom((prev) => (prev === nextAtBottom ? prev : nextAtBottom));

    // 2) 有界重断言:逐帧重新对齐参照行(快滚残余惯性、边界处晚到的高度变化都扳回)。WebKit 无
    //    overflow-anchor 兜底,全靠这里。连续 REASSERT_STABLE_FRAMES 帧已对齐即停,或最多
    //    REASSERT_MAX_FRAMES 帧硬停 —— 双上限,只在 prepend 后 ~100ms 窗口生效、窗口外静默,
    //    绝不退化成此前被删掉的"持续逐帧稳定器"。会话切换/卸载取消本 rAF(见上下两处 cleanup)。
    if (reassertRafRef.current != null) cancelAnimationFrame(reassertRafRef.current);
    let frames = 0;
    let stable = 0;
    const reassert = () => {
      const n = scrollRef.current;
      if (!n || activeConversationIdRef.current !== conversation.id) {
        reassertRafRef.current = null;
        return;
      }
      frames += 1;
      const target = targetFor(n);
      if (Math.abs(n.scrollTop - target) > SETTLE_SCROLLTOP_EPSILON) {
        n.scrollTop = target;
        stable = 0;
      } else {
        stable += 1;
      }
      if (stable >= REASSERT_STABLE_FRAMES || frames >= REASSERT_MAX_FRAMES) {
        reassertRafRef.current = null;
        return;
      }
      reassertRafRef.current = requestAnimationFrame(reassert);
    };
    reassertRafRef.current = requestAnimationFrame(reassert);

    return () => {
      if (reassertRafRef.current != null) cancelAnimationFrame(reassertRafRef.current);
      reassertRafRef.current = null;
    };
  }, [conversation.id, loading, localMessages.length]);

  const scrollToUnread = useCallback(() => {
    const node = unreadDividerRef.current;
    if (!node) return;
    node.scrollIntoView({ block: "center", behavior: "smooth" });
  }, []);

  // New messages: auto-follow if at bottom, else bump the unread counter.
  // 用 useLayoutEffect 而非 useEffect:贴底跟随必须在浏览器绘制前完成。打开会话后台
  // reconcile 补齐历史、或实时新消息追加时,localMessages 增长会先撑高内容;若在绘制后
  // (useEffect)才把 scrollTop 拉到底,用户会看到新气泡先冒在视口上方、再跳到底部的
  // 一帧抖动。改 layout effect 后在同一帧绘制前贴底,新气泡直接落在底部,无跳帧。
  useLayoutEffect(() => {
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

  // 卸载时取消悬挂的重断言 rAF,防野回调。
  useEffect(
    () => () => {
      if (reassertRafRef.current != null) cancelAnimationFrame(reassertRafRef.current);
      reassertRafRef.current = null;
    },
    [],
  );

  return {
    setScrollNode,
    setUnreadDividerNode,
    handleScrollMetrics,
    handleUserScroll,
    handleWheelCapture,
    scrollToBottom,
    scrollToUnread,
    atBottom,
    unreadBelow,
    unreadAbove,
    wasAtBottomRef,
  };
}
