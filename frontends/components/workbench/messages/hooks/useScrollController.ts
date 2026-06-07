// 消息区滚动控制器。
//
// 内聚一簇相互依赖的滚动状态:未读「上方/下方」浮动 pill 的出现/消失、切会话/首屏「滚到底」、
// 翻页/近底预取触发(数据层职责)、离开会话补 markRead。
//
// ⚠️ 锚定与贴底跟随已交给 virtual-core 3.17.0 原生原语(ChatArea 的 useVirtualizer 配 anchorTo:
// 'end' / followOnAppend:'auto' / scrollEndThreshold):
//   - prepend 时可见内容稳定 = anchorTo(库按 [可见项 key, scrollOffset−item.start] 捕获并恢复)。
//   - 新消息贴底跟随 = followOnAppend(贴底时尾部新增项自动 scrollToEnd)。
//   - 首开/新增内容估高→实测漂移 = resizeItem 的 wasAtEnd 补偿。
// 本控制器不再手写 scrollTop 做锚点/跟随/逐帧重断言(那会与库双写打架,正是上滑闪 + 翻页跳的
// 根源)。仅保留库不覆盖的两件正交事:① 首挂/切会话「一次性滚到底」(库首挂 prevOptions undefined
// 不触发 anchorTo/follow),② 预取触发 + 未读 pill/计数(数据层与 UI 职责,库不管)。
//
// ⚠️ 滚动位置依赖真实布局(scrollHeight / getBoundingClientRect),jsdom 无法复现,故本 hook 的
// 滚动正确性需在运行的应用里手测;单测仅覆盖纯状态逻辑(预取触发/未读计数/收敛零 remount)。

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

import { HISTORY_PREFETCH_MIN_PX } from "../constants";
import type { Conversation, Message } from "../data";
import { STRINGS } from "../strings";
import type { ScrollMetrics } from "../WorkbenchScrollArea";

// 上拉预取阈值:距顶 ≤ max(HISTORY_PREFETCH_MIN_PX, 一个视口高度) ≈ 一屏即后台加载更旧页。
// 提前预取 → 数据在用户滚到顶之前就位、prepend 在远离顶部边界处落地,锚定补偿不被 scrollTop=0
// 钳制、也不与边界惯性相争,当前内容不动;同时不必"等惯性停"再触发,灵敏度大幅提升。
const prefetchThreshold = (clientHeight: number): number =>
  Math.max(HISTORY_PREFETCH_MIN_PX, clientHeight);

// prepend「in-flight 标记」:仅用于预取重入守卫 + 让「新消息贴底跟随」effect 跳过本次因 prepend
// 引起的 count 增长(否则会把翻历史误当新消息)。锚点恢复本身已交 anchorTo,故不再记 scrollHeight/
// scrollTop/参照行 —— 这里只保留判定「本次增长来自 prepend」所需的最小信息。
interface PrependMarker {
  conversationId: string;
  messageCount: number;
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
  const previousMessageCountRef = useRef(localMessages.length);
  const pendingInitialScrollToLatestRef = useRef(true);
  const prependMarkerRef = useRef<PrependMarker | null>(null);
  const historyLoadInFlightRef = useRef(false);
  // Stage C:loadNewer 近底预取的 in-flight 守卫(对称 historyLoadInFlightRef)。
  const newerLoadInFlightRef = useRef(false);
  // hasMoreNewer/onLoadNewer 用 ref 镜像,让稳定 useCallback(maybeLoadNewerHistory)读最新值而不入 deps。
  const hasMoreNewerRef = useRef(hasMoreNewer);
  const onLoadNewerRef = useRef(onLoadNewer);
  const historyPrependAppliedMessageCountRef = useRef<number | null>(null);
  // 上滑预取「边沿触发 + 消费门」:一次进入预取区只加载一页,直到 scrollTop 离开预取区(>阈值)再进入
  // 才放下一页(微信式「滑到顶加载一页,需往回看再上滑才加载下一页」)。防 Stage C 本地瞬时读导致的
  // 「一次上滑狂加载多页」。离开预取区 → 重新武装。切会话重置为 true。
  // 注:删手搓 prepend/snap 的 scrollTop 写后,主要自激源(写→scroll→预取→再写)已消失;library 的
  // anchorTo 恢复保持可见内容稳定(scrollTop 不会因 prepend 跳回顶部),故此边沿门已足以将翻页限为
  // 「一次进区一页」,不再需要原 SUPPRESS_PREFETCH_MS 自激抑制窗。
  const olderPrefetchArmedRef = useRef(true);
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
      // 旧实现里「曾贴底但 metrics 报非贴底(内容增高/resize 撑出)」会手写 scrollTop=scrollHeight
      // 强行拉回底。现交给 virtual-core:followOnAppend 接管尾部新增的贴底跟随、resizeItem 的
      // wasAtEnd 接管「贴底时估高→实测漂移」的补偿,故此处不再手写 scrollTop,只同步状态。
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
    if (prependMarkerRef.current?.conversationId === conversation.id) return true;
    if (!hasMoreHistory || loading || !onLoadMoreHistory) return false;
    if (pendingInitialScrollToLatestRef.current) return false;

    // 不再捕获参照行/总高锚点:prepend 后可见内容稳定由 virtual-core anchorTo:'end' 自动处理
    // (库按 [可见项 key, scrollOffset−item.start] 捕获并恢复)。这里只记 in-flight 标记(重入守卫
    // + 让「新消息贴底跟随」effect 跳过本次 prepend 增长)。
    prependMarkerRef.current = {
      conversationId: conversation.id,
      messageCount: localMessagesLengthRef.current,
    };
    historyLoadInFlightRef.current = true;

    Promise.resolve(onLoadMoreHistory())
      .catch(() => {
        if (prependMarkerRef.current?.conversationId === conversation.id) {
          prependMarkerRef.current = null;
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
      // 边沿触发 + 消费门:离开预取区即重新武装;进区且已武装才加载一页并消耗武装;进区但未武装(本次进区
      // 已加载过)→ 不再发。须先滚出预取区(>阈值)再滚回,才放下一页。
      if (m.scrollTop > prefetchThreshold(m.clientHeight)) {
        olderPrefetchArmedRef.current = true;
        return;
      }
      if (!olderPrefetchArmedRef.current) return;
      olderPrefetchArmedRef.current = false;
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
      // 同 maybeLoadOlderHistory 的边沿门(共用 olderPrefetchArmedRef):离开预取区重新武装,进区且已武装
      // 才加载一页并消耗武装。防一次上滑(连续 wheel)在预取区内狂发多页。
      if (node.scrollTop > prefetchThreshold(node.clientHeight)) {
        olderPrefetchArmedRef.current = true;
        return;
      }
      if (!olderPrefetchArmedRef.current) return;
      olderPrefetchArmedRef.current = false;
      // 进入预取区即后台加载,但**不** preventDefault —— 提前预取要让原生滚动顺畅继续(用户
      // 可一路上滚,数据在背后就位)。
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
      const divider = unreadDividerRef.current;
      const viewport = scrollRef.current;
      if (!viewport) return;
      // 预取触发:进区即拉一页,重入由边沿门 olderPrefetchArmedRef + in-flight 守卫吸收。删手搓
      // prepend/snap scrollTop 写后,程序化写已无(锚定/跟随归 virtual-core),不再需要自激抑制窗。
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

  // 切会话:标记需要「滚到底一次」,实际滚动由下面的 layout effect 在视口与首页都挂载后执行。
  useLayoutEffect(() => {
    activeConversationIdRef.current = conversation.id;
    pendingInitialScrollToLatestRef.current = true;
    // 切会话:预取边沿门重新武装(新会话首次进预取区可加载一页)。
    olderPrefetchArmedRef.current = true;
    prependMarkerRef.current = null;
    historyLoadInFlightRef.current = false;
    historyPrependAppliedMessageCountRef.current = null;
    // 切会话也镜像写外部 atBottomRef:新会话首屏滚到底,贴底真相重置为 true,
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

  // 首挂 / 切会话「滚到底一次」:virtual-core 首挂(prevOptions undefined)不触发 anchorTo/follow,
  // 切会话是数据替换(整窗 REPLACE,非 prepend/append,边缘 key 全变但属「换内容」而非「续上下文」),
  // 故首屏到底仍须我们显式做一次。只写一次 scrollTop=scrollHeight;随后 measureElement 实测带来的
  // 估高→实测漂移由 virtual-core resizeItem 的 wasAtEnd 补偿自动 settle(不再逐帧重断言、不与库对打)。
  useLayoutEffect(() => {
    if (!pendingInitialScrollToLatestRef.current) return;
    if (localMessages.length === 0) return;
    const node = scrollRef.current;
    if (!node || activeConversationIdRef.current !== conversation.id) return;

    node.scrollTop = node.scrollHeight;
    setWasAtBottom(true);
    setAtBottom((prev) => (prev ? prev : true));
    setUnreadBelow((prev) => (prev === 0 ? prev : 0));
    pendingInitialScrollToLatestRef.current = false;
  }, [conversation.id, error, loading, localMessages.length, setWasAtBottom]);

  // prepend 落地:不再手写 scrollTop 锚定(anchorTo:'end' 已把可见内容稳住)。本 effect 只做收尾簿记:
  // 清 in-flight 标记 + 记 historyPrependAppliedMessageCountRef(让「新消息贴底跟随」effect 跳过这次因
  // prepend 引起的 count 增长,不误判为新消息)。不碰 scrollTop、不读 scrollHeight 差值。
  useLayoutEffect(() => {
    const marker = prependMarkerRef.current;
    if (!marker || marker.conversationId !== conversation.id) return;

    if (localMessages.length <= marker.messageCount) {
      if (!loading && !historyLoadInFlightRef.current) {
        prependMarkerRef.current = null;
      }
      return;
    }

    prependMarkerRef.current = null;
    historyLoadInFlightRef.current = false;
    historyPrependAppliedMessageCountRef.current = localMessages.length;
  }, [conversation.id, loading, localMessages.length]);

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
  // 新消息到达:贴底时的「滚到底跟随」交给 virtual-core followOnAppend:'auto'(贴底 + 尾部 last key
  // 变化 → 自动 scrollToEnd),本 effect 不再手写 scrollTop。仅保留库不管的两件事:
  //   ① 贴底时镜像 setWasAtBottom(true) 维持状态真相(外部 atBottomRef → 下次 readCache 整窗塌缩);
  //   ② 非贴底时累计 INCOMING 未读 below 计数(给 scroll-to-bottom pill 用)。
  // prepend 引起的 count 增长经 historyPrependAppliedMessageCountRef 跳过(不误判为新消息)。
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
      // 贴底跟随(含 useChatActions 发送后直接置 wasAtBottomRef=true 的路径)的实际滚动归 followOnAppend;
      // 这里只镜像外部 atBottomRef,使下次 readCache 走整窗塌缩(乐观气泡随塌缩进入尾窗、正常收敛)。
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
