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
  /**
   * Stage C 数据窗口化(对称 hasMoreHistory/onLoadMoreHistory):
   *   - `hasMoreNewer`:窗口底之下缓存里是否仍有更新行(= !slice.atCacheBottom)。
   *   - `onLoadNewer`:近底(≤一屏)预取把曾 drop 的较新行重新拉回。尾部 append 不改视口上方内容、
   *     scrollTop 自然不动,故无需 prepend 锚点(比 loadOlder 简单的本质区别)。
   */
  hasMoreNewer?: boolean;
  onLoadNewer?: () => Promise<void> | void;
  /**
   * Stage C:贴底实时 ref(MessagesPage 持有,useMessageHistory 读它判塌缩/缝合)。本控制器在
   * 维护 wasAtBottomRef 的各处(handleScrollMetrics/snap/锚点 effect)镜像写入,作为单一真相。
   */
  atBottomRef?: MutableRefObject<boolean>;
  onLeaveMarkRead?: (conversationId: string) => void | Promise<void>;
  /**
   * Stage B 渲染虚拟化:未读分隔条 / 锚点行可能被虚拟化卸载,DOM 不再常驻。
   *   - `unreadDividerIndex`:未读分隔条在 timelineItems 里的下标(无未读为 -1)。
   *   - `scrollToIndex`:虚拟器 `scrollToIndex(index, {align})` 的回调。
   *   - `getOffsetForIndex`:虚拟器据估高算出某行相对内容顶的 offset(无则 null);分隔条被虚拟
   *     卸载、DOM 不可用时,handleUserScroll 的 pill 判定回退到它。
   * 三者由 ChatArea 注入;若未注入(无虚拟器)则 scrollToUnread 回退到 DOM scrollIntoView、
   * pill 判定回退到原"无 divider"语义。
   */
  unreadDividerIndex?: number;
  scrollToIndex?: (index: number, options?: { align?: "start" | "center" | "end" }) => void;
  getOffsetForIndex?: (index: number) => number | null;
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
  /**
   * Stage B 渲染虚拟化:把控制器内部持有的 viewport node 暴露给 ChatArea,
   * 供 useVirtualizer 的 getScrollElement 复用同一个原生滚动 viewport
   * (不另建容器,保留 WorkbenchScrollArea 的 ScrollMetrics/ResizeObserver/overscroll 通道)。
   */
  scrollElementRef: MutableRefObject<HTMLDivElement | null>;
}

export function useScrollController({
  conversation,
  localMessages,
  loading,
  error,
  hasMoreHistory = false,
  onLoadMoreHistory,
  hasMoreNewer = false,
  onLoadNewer,
  atBottomRef,
  onLeaveMarkRead,
  unreadDividerIndex = -1,
  scrollToIndex,
  getOffsetForIndex,
}: UseScrollControllerParams): UseScrollControllerResult {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // 旧 viewport unmount 时 React 会把 ref 写成 null;用 callback ref 拒绝 null,
  // 让 scrollRef.current 始终指向当前 viewport(新的写入会覆盖旧的)。
  const setScrollNode = useCallback((node: HTMLDivElement | null) => {
    if (node) scrollRef.current = node;
  }, []);
  const wasAtBottomRef = useRef(true);
  // Stage C:把贴底真相镜像写到外部 atBottomRef(MessagesPage 持有,useMessageHistory 读它判
  // 塌缩/缝合)。所有维护 wasAtBottomRef 的写点都过此 helper,保证两 ref 同步、单一真相。
  const atBottomExternalRef = atBottomRef;
  const setWasAtBottom = useCallback(
    (v: boolean) => {
      wasAtBottomRef.current = v;
      if (atBottomExternalRef) atBottomExternalRef.current = v;
    },
    [atBottomExternalRef],
  );
  const metricsFromUserScrollRef = useRef(false);
  const previousMessageCountRef = useRef(localMessages.length);
  const pendingInitialScrollToLatestRef = useRef(true);
  const prependAnchorRef = useRef<PrependAnchor | null>(null);
  const historyLoadInFlightRef = useRef(false);
  // Stage C:loadNewer 近底预取的 in-flight 守卫(对称 historyLoadInFlightRef)。
  const newerLoadInFlightRef = useRef(false);
  // hasMoreNewer/onLoadNewer 用 ref 镜像,让稳定 useCallback(maybeLoadNewerHistory)读最新值而不入 deps。
  const hasMoreNewerRef = useRef(hasMoreNewer);
  const onLoadNewerRef = useRef(onLoadNewer);
  const historyPrependAppliedMessageCountRef = useRef<number | null>(null);
  // 首屏 snap-to-latest 的有界重断言 rAF 句柄(虚拟化下 measureElement 实测会在随后若干帧改变
  // getTotalSize → scrollHeight,单次 snap 会停在"估高底",故逐帧重钉到底直到测量稳定)。与 prepend
  // 重断言互斥(首屏 pendingInitialScrollToLatest 期间 loadOlder 被守卫挡住),用独立句柄避免互相取消。
  const snapReassertRafRef = useRef<number | null>(null);
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
  // Stage B 虚拟化:分隔条行滚出 overscan 即被卸载,React 以 null 调本 ref。必须**接受 null 写回**
  // (卸载即清 ref),否则 ref 滞留 detach 旧节点 → handleUserScroll 对其 getBoundingClientRect()
  // 得全 0 矩形 → "divider 已进入视口"分支永不触发,pill 判定失真。清空后 handleUserScroll 改走
  // 虚拟器 offset 兜底(见下),DOM 不可用时仍能判定 divider 相对视口位置。
  const setUnreadDividerNode = useCallback((node: HTMLDivElement | null) => {
    unreadDividerRef.current = node;
  }, []);
  // 本会话内 divider 是否已被用户"看到过"(进入视口或滚到下方)。切会话清回 false。
  const hasSeenDividerRef = useRef(false);

  // Stage B 渲染虚拟化:未读分隔条 index + 虚拟器 scrollToIndex 用 ref 镜像,
  // 让稳定 useCallback(scrollToUnread)读到最新值而不必把它们放进 deps、避免重建。
  const unreadDividerIndexRef = useRef(unreadDividerIndex);
  useEffect(() => {
    unreadDividerIndexRef.current = unreadDividerIndex;
  }, [unreadDividerIndex]);
  const scrollToIndexRef = useRef(scrollToIndex);
  useEffect(() => {
    scrollToIndexRef.current = scrollToIndex;
  }, [scrollToIndex]);
  const getOffsetForIndexRef = useRef(getOffsetForIndex);
  useEffect(() => {
    getOffsetForIndexRef.current = getOffsetForIndex;
  }, [getOffsetForIndex]);
  useEffect(() => {
    hasMoreNewerRef.current = hasMoreNewer;
  }, [hasMoreNewer]);
  useEffect(() => {
    onLoadNewerRef.current = onLoadNewer;
  }, [onLoadNewer]);

  const handleScrollMetrics = useCallback(
    (m: ScrollMetrics) => {
      const fromUserScroll = metricsFromUserScrollRef.current;
      metricsFromUserScrollRef.current = false;

      if (!fromUserScroll && !m.atBottom && wasAtBottomRef.current) {
        const node = scrollRef.current;
        if (node) {
          node.scrollTop = node.scrollHeight;
          setWasAtBottom(true);
          setAtBottom((prev) => (prev ? prev : true));
          setUnreadBelow((prev) => (prev === 0 ? prev : 0));
          return;
        }
      }

      setWasAtBottom(m.atBottom);
      setAtBottom((prev) => (prev === m.atBottom ? prev : m.atBottom));
      if (m.atBottom) setUnreadBelow(0);
    },
    [setWasAtBottom],
  );

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

  // Stage C 近底预取 loadNewer:对称 loadOlderHistoryAtBoundary,但**无需 prepend 锚点** —— 尾部
  // append 不改变视口上方内容,scrollTop 自然不动(append 比 prepend 简单的本质区别)。仅 in-flight
  // 守卫 + hasMoreNewer/!loading/有回调/不在首屏 snap。dropFromTop 删的是远离视口的顶部行(用户视线
  // 在底部),参照行天然在视口、保位不漂。hasMoreNewer/onLoadNewer 走 ref 读最新值,保 callback 稳定。
  const loadNewerAtBoundary = useCallback(() => {
    if (newerLoadInFlightRef.current) return;
    if (!hasMoreNewerRef.current || loading || !onLoadNewerRef.current) return;
    if (pendingInitialScrollToLatestRef.current) return;
    newerLoadInFlightRef.current = true;
    Promise.resolve(onLoadNewerRef.current()).finally(() => {
      newerLoadInFlightRef.current = false;
    });
  }, [loading]);

  // 进入近底预取区(距底 ≤ 一屏)即拉更新页。重入由 loadNewerAtBoundary 内部守卫吸收。
  const maybeLoadNewerHistory = useCallback(
    (m: ScrollMetrics) => {
      const distToBottom = m.scrollHeight - m.scrollTop - m.clientHeight;
      if (distToBottom > prefetchThreshold(m.clientHeight)) return;
      loadNewerAtBoundary();
    },
    [loadNewerAtBoundary],
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
  // 「divider 相对视口位置」的来源做成"DOM 优先 + 虚拟器 offset 兜底"(Stage B 虚拟化感知):
  //   - 节点存在且 isConnected → 用 getBoundingClientRect 精确判定(主路径,jsdom 走这条);
  //   - 否则(被虚拟卸载)若有 unreadDividerIndex 且 getOffsetForIndex 可用 → 用估算行 offset 与
  //     scrollTop 比较;
  //   - 两者皆无 → 按原"无 divider"语义(有 pill 则清)。
  // 守卫(hasSeenDividerRef / m.atBottom / conversation.unread / unreadAbove)与 setUnreadAboveState
  // 行为完全不变,只换"在视口上方"的判定来源。
  const handleUserScroll = useCallback(
    (m: ScrollMetrics) => {
      metricsFromUserScrollRef.current = true;
      const divider = unreadDividerRef.current;
      const viewport = scrollRef.current;
      if (!viewport) return;
      maybeLoadOlderHistory(m);
      maybeLoadNewerHistory(m);

      // 三态:true=在视口上方(用户还没看到),false=已可见/在下方,null=无从判定(等同无 divider)。
      let dividerAbove: boolean | null;
      if (divider && divider.isConnected) {
        const dRect = divider.getBoundingClientRect();
        const vRect = viewport.getBoundingClientRect();
        // dRect.bottom <= vRect.top 即整条 divider 都在视口上方;反之至少一部分在视口内或下方。
        dividerAbove = dRect.bottom <= vRect.top;
      } else {
        const index = unreadDividerIndexRef.current;
        const dividerOffset = index >= 0 ? (getOffsetForIndexRef.current?.(index) ?? null) : null;
        // 行 offset(相对内容顶)< scrollTop 即该行已滚到视口上方;同坐标系直接比较。
        dividerAbove = dividerOffset != null ? dividerOffset < viewport.scrollTop : null;
      }

      if (dividerAbove === null || dividerAbove === false) {
        // 无从判定(无 divider) / divider 已可见或在下方 → 用户已看到 → 清 pill。
        // (已可见分支额外标 seen,与原逻辑一致;无从判定分支不标 seen。)
        if (dividerAbove === false) hasSeenDividerRef.current = true;
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
    [
      conversation.id,
      conversation.unread,
      maybeLoadOlderHistory,
      maybeLoadNewerHistory,
      unreadAbove,
    ],
  );

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      const node = scrollRef.current;
      if (!node) return;
      node.scrollTo({ top: node.scrollHeight, behavior });
      setWasAtBottom(true);
      setUnreadBelow(0);
    },
    [setWasAtBottom],
  );

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
    // 取消上个会话悬挂的首屏 snap 重断言 rAF,防跨会话野回调改新会话 scrollTop。
    if (snapReassertRafRef.current != null) cancelAnimationFrame(snapReassertRafRef.current);
    snapReassertRafRef.current = null;
    // 切会话也镜像写外部 atBottomRef:新会话首屏走 snap 到底,贴底真相重置为 true,
    // 使 useMessageHistory 首屏 readCache 走整窗塌缩(collapseToLatest=true)。
    newerLoadInFlightRef.current = false;
    setWasAtBottom(true);
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
      setWasAtBottom(true);
      setAtBottom((prev) => (prev ? prev : true));
      setUnreadBelow((prev) => (prev === 0 ? prev : 0));
      return true;
    };

    // paint 前先到位一次。
    snap();

    // 有界重断言贴底:虚拟化下首屏按估高渲染,measureElement 实测会在随后若干帧把 getTotalSize
    // (= spacer 高 = scrollHeight)改大/改小,单次 snap 会停在"估高底"而非"实测底"(表现为首开不在
    // 最底)。故逐帧把 scrollTop 重钉到 scrollHeight,直到连续 REASSERT_STABLE_FRAMES 帧 scrollHeight
    // 不再变(测量稳定)或达 REASSERT_MAX_FRAMES 硬停 —— 与 prepend 锚点重断言同款双上限,仅首开 ~100ms
    // 窗口生效、窗口外静默。会话切换/卸载取消本 rAF(见上下 cleanup)。
    if (snapReassertRafRef.current != null) cancelAnimationFrame(snapReassertRafRef.current);
    let frames = 0;
    let stable = 0;
    let lastHeight = node.scrollHeight;
    const reassertBottom = () => {
      const current = scrollRef.current;
      if (!current || activeConversationIdRef.current !== conversation.id) {
        snapReassertRafRef.current = null;
        pendingInitialScrollToLatestRef.current = false;
        return;
      }
      frames += 1;
      const h = current.scrollHeight;
      stable = Math.abs(h - lastHeight) <= SETTLE_SCROLLTOP_EPSILON ? stable + 1 : 0;
      lastHeight = h;
      current.scrollTop = h; // 始终重钉到底,吸收 measureElement 晚到的高度变化
      if (stable >= REASSERT_STABLE_FRAMES || frames >= REASSERT_MAX_FRAMES) {
        snapReassertRafRef.current = null;
        pendingInitialScrollToLatestRef.current = false;
        return;
      }
      snapReassertRafRef.current = requestAnimationFrame(reassertBottom);
    };
    snapReassertRafRef.current = requestAnimationFrame(reassertBottom);
    return () => {
      if (snapReassertRafRef.current != null) cancelAnimationFrame(snapReassertRafRef.current);
      snapReassertRafRef.current = null;
    };
  }, [conversation.id, error, loading, localMessages.length, setWasAtBottom]);

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

    // paint 前**一次性**对齐参照行:这一帧只补偿「prepend 使 count 变化、上方新增行的估高把锚点行
    // 整体下推」的基础位移(react-virtual 不锚定 count 变化,只锚定 item resize),故这次手动写不可省。
    // 随后那批新行被 measureElement 实测时的「估高→实测」差,交给 react-virtual 原生 scrollAdjustment
    // 自动补偿(见 ChatArea 注释)——单一 scrollTop 写者,不再用逐帧重断言与库对打(那正是上滑闪 + 翻页
    // 跳的根源)。jsdom/无虚拟器路径走 targetFor 闭式回退,prepend 单测断言 scrollTop 不变。
    node.scrollTop = targetFor(node);

    // 锚点清理 / prepend 标记 / atBottom 同步(不碰 scrollTop;"新消息贴底跟随"effect 仍靠
    // historyPrependAppliedMessageCountRef 跳过本次增长,行为不变)。
    prependAnchorRef.current = null;
    historyLoadInFlightRef.current = false;
    historyPrependAppliedMessageCountRef.current = localMessages.length;
    const nextAtBottom =
      node.scrollHeight - node.scrollTop - node.clientHeight < AT_BOTTOM_THRESHOLD;
    setWasAtBottom(nextAtBottom);
    setAtBottom((prev) => (prev === nextAtBottom ? prev : nextAtBottom));
  }, [conversation.id, loading, localMessages.length, setWasAtBottom]);

  const scrollToUnread = useCallback(() => {
    // Stage B:虚拟化后分隔条 DOM 可能被卸载,scrollIntoView 失效。优先用虚拟器
    // scrollToIndex(index, {align:'center'}) —— 它据估高把该行滚进视口并挂载,
    // 不依赖 DOM 常驻。未注入虚拟器(或无未读)时回退到原 DOM scrollIntoView(单测走这条)。
    const index = unreadDividerIndexRef.current;
    const scrollTo = scrollToIndexRef.current;
    if (scrollTo && index >= 0) {
      scrollTo(index, { align: "center" });
      return;
    }
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
      // 贴底跟随(含 useChatActions 发送后直接置 wasAtBottomRef=true 的路径)→ 镜像外部 atBottomRef,
      // 使下次 readCache 走整窗塌缩(乐观气泡随塌缩进入尾窗、正常收敛)。
      setWasAtBottom(true);
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
  }, [localMessages, setWasAtBottom]);

  // 卸载时取消悬挂的首屏 snap 重断言 rAF,防野回调。
  useEffect(
    () => () => {
      if (snapReassertRafRef.current != null) cancelAnimationFrame(snapReassertRafRef.current);
      snapReassertRafRef.current = null;
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
    scrollElementRef: scrollRef,
  };
}
