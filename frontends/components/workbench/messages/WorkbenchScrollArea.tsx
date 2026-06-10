import { type ReactNode, type WheelEventHandler, useCallback, useEffect, useRef } from "react";

import { isMac } from "@/lib/platform";
import { cn } from "@/lib/utils";

import { AT_BOTTOM_THRESHOLD } from "./constants";

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  atBottom: boolean;
}

interface WorkbenchScrollAreaProps {
  children: ReactNode;
  className?: string;
  viewportClassName?: string;
  contentClassName?: string;
  /** 接受 RefCallback。父组件用 callback ref 可以选择忽略 null 调用,
   *  避免 motion.div crossfade 期间旧实例 unmount 把共享 ref 清空。 */
  scrollRef?: (node: HTMLDivElement | null) => void;
  onScrollMetrics?: (metrics: ScrollMetrics) => void;
  /** 仅由 viewport 上的 native scroll event 触发 —— 用于区分"用户主动滚动"
   *  与"系统重排"(mount、window resize、ResizeObserver、MutationObserver)。
   *  ChatArea 用它来决定是否点亮顶部"↑ N 条未读" pill: 切会话/resize 引起的
   *  emit 不能触发 pill,只有用户主动滚动才可以。 */
  onUserScroll?: (metrics: ScrollMetrics) => void;
  onWheelCapture?: WheelEventHandler<HTMLDivElement>;
  /** 到顶继续上推时给一个极轻的 transform 回弹(不碰 scrollTop)。默认关,仅消息区开。 */
  overscrollBounce?: boolean;
  /** 仅消息区:接近顶部时钳制单次 wheel 步长,削快滚冲顶尖峰、让到顶更跟手(配合翻页停稳门控,
   *  减小惯性下的锚点跳动)。默认关。WKWebView 上"接管平滑滚动"会与原生惯性双写打架,故只做近顶
   *  钳制、不接管滚动。可独立摘除(见 ChatArea)。 */
  smoothWheel?: boolean;
}

// 早先版本把 scrollbar 当作 viewport 的"兄弟节点"(custom WorkbenchScrollbar 渲染
// 在 viewport 之外的 absolute 层),wheel 落在兄弟上时浏览器沿 DOM 树找不到
// overflow:auto 祖先 → 滚轮直接空转。前后修了三次都没根治,因此整体推倒重做:
//   - viewport 直接 overflow-y:auto,wheel/touch/keyboard/drag 全交给 native;
//   - scrollbar 视觉用 index.css 里全局 *::-webkit-scrollbar 的 6px wb-thumb 样式;
//   - 仅保留 ScrollMetrics 上报通道,让 ChatArea 的 atBottom / unread pill 继续工作。
// 不再有 custom scrollbar 组件,事件路径回归浏览器默认,不存在"hover scrollbar
// wheel 失效"这类副作用。需要 thumb 拖动时由 native 提供,与 macOS 一致。
export function WorkbenchScrollArea({
  children,
  className,
  viewportClassName,
  contentClassName,
  scrollRef,
  onScrollMetrics,
  onUserScroll,
  onWheelCapture,
  overscrollBounce,
  smoothWheel,
}: WorkbenchScrollAreaProps) {
  // 内部 ref 始终持有真实 DOM,所有 effect/listener 都通过 internalRef.current 读取,
  // 不依赖父传 ref 的引用一致性。父传的 scrollRef 由 setViewportRef 桥接转发。
  const internalRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  const setViewportRef = useCallback(
    (node: HTMLDivElement | null) => {
      internalRef.current = node;
      scrollRef?.(node);
    },
    [scrollRef],
  );

  // 用 ref 镜像最新的 onScrollMetrics 回调,避免每次父组件 re-render 都重绑 listener。
  const onScrollMetricsRef = useRef(onScrollMetrics);
  useEffect(() => {
    onScrollMetricsRef.current = onScrollMetrics;
  }, [onScrollMetrics]);
  const onUserScrollRef = useRef(onUserScroll);
  useEffect(() => {
    onUserScrollRef.current = onUserScroll;
  }, [onUserScroll]);

  useEffect(() => {
    const node = internalRef.current;
    if (!node) return;

    const computeMetrics = (): ScrollMetrics => {
      const { scrollTop, scrollHeight, clientHeight } = node;
      return {
        scrollTop,
        scrollHeight,
        clientHeight,
        atBottom: scrollHeight - scrollTop - clientHeight < AT_BOTTOM_THRESHOLD,
      };
    };
    let frameId: number | null = null;
    let pendingMetrics: ScrollMetrics | null = null;
    let pendingUserScroll = false;

    const flushMetrics = () => {
      frameId = null;
      const metrics = pendingMetrics;
      if (!metrics) return;
      const shouldNotifyUserScroll = pendingUserScroll;
      pendingMetrics = null;
      pendingUserScroll = false;

      // user-scroll callback 先于 metrics callback —— ChatArea 的 handleUserScroll
      // 读到的 ref 状态(wasAtBottomRef 等)还是 handleScrollMetrics 更新之前的旧值,
      // 避免顺序耦合(尽管当前 handleUserScroll 不依赖那个 ref,但保留这个保险)。
      if (shouldNotifyUserScroll) onUserScrollRef.current?.(metrics);
      onScrollMetricsRef.current?.(metrics);
    };

    const scheduleMetrics = (fromUserScroll: boolean) => {
      pendingMetrics = computeMetrics();
      pendingUserScroll = pendingUserScroll || fromUserScroll;
      if (frameId !== null) return;
      frameId = requestAnimationFrame(flushMetrics);
    };
    const emit = () => scheduleMetrics(false);
    const onScrollEvent = () => scheduleMetrics(true);

    // 首次挂载先 emit 一次,让父组件拿到初始 atBottom 状态。
    emit();

    node.addEventListener("scroll", onScrollEvent, { passive: true });
    window.addEventListener("resize", emit);

    // viewport 自身尺寸 + 内容尺寸都可能变(loading→data 状态切换、新消息追加、
    // 窗口拖宽收窄)。ResizeObserver 同时观察 viewport 和当前 firstElementChild,
    // MutationObserver 检测 ChatArea 的 state 切换替换了 firstElementChild 时重绑。
    const ro = new ResizeObserver(emit);
    ro.observe(node);
    let observedChild: Element | null = node.firstElementChild;
    if (observedChild) ro.observe(observedChild);
    const mo = new MutationObserver(() => {
      const next = node.firstElementChild;
      if (next === observedChild) return;
      if (observedChild) ro.unobserve(observedChild);
      if (next) ro.observe(next);
      observedChild = next;
      emit();
    });
    mo.observe(node, { childList: true });

    return () => {
      node.removeEventListener("scroll", onScrollEvent);
      window.removeEventListener("resize", emit);
      if (frameId !== null) cancelAnimationFrame(frameId);
      ro.disconnect();
      mo.disconnect();
    };
  }, []);

  // A2:到顶继续上推时给一个极轻的 overscroll 回弹(纯 transform,不碰 scrollTop/不破锚定)。
  // 默认关,仅消息区开;reduce-motion 下整段禁用、不挂监听。
  useEffect(() => {
    if (!overscrollBounce) return;
    const viewport = internalRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const reduceMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) return;

    const MAX_PULL = 8; // 最大回弹位移(px;从 14 调小,快滚到顶时回弹更克制、过冲近半)
    const DAMP = 0.28; // 阻尼:越界滚动量 → 位移
    const RELEASE_MS = 90; // 停止上推后多久开始回弹
    let offset = 0;
    let releaseTimer: ReturnType<typeof setTimeout> | null = null;

    const settle = () => {
      offset = 0;
      content.style.transition = "transform 220ms cubic-bezier(0.22, 1, 0.36, 1)";
      content.style.transform = "translateY(0px)";
    };

    const onWheel = (e: WheelEvent) => {
      // 仅"贴顶 + 继续上推"才回弹;其余交回原生滚动。
      if (e.deltaY >= 0 || viewport.scrollTop > 0) {
        if (offset !== 0) settle();
        return;
      }
      offset = Math.min(MAX_PULL, offset + -e.deltaY * DAMP);
      content.style.transition = "transform 0ms";
      content.style.transform = `translateY(${offset}px)`;
      if (releaseTimer) clearTimeout(releaseTimer);
      releaseTimer = setTimeout(settle, RELEASE_MS);
    };

    viewport.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      viewport.removeEventListener("wheel", onWheel);
      if (releaseTimer) clearTimeout(releaseTimer);
      content.style.transition = "";
      content.style.transform = "";
    };
  }, [overscrollBounce]);

  // 近顶区 wheel 步长钳制(opt-in,仅消息区)。只在"最后一屏、向上滚、单次 deltaY 超 MAX_STEP"时
  // 钳制并手动滚一小步,削掉快滚冲顶的尖峰、降低到顶速度 → 让翻页停稳门控更快触发、惯性更小。
  // 远离顶部 / 向下 / 未超限一律放行原生,不接管滚动(避免 WKWebView 上与惯性双写打架)。
  // 与 onWheelCapture(scrollTop<=1 才介入)区间不重叠;reduce-motion 下禁用。
  useEffect(() => {
    // 仅 macOS:该钳制为 WKWebView 触摸板惯性(连续小 deltaY)设计;Windows 鼠标滚轮一格
    // deltaY≈100-120,远超 MAX_STEP=60,启用会让近顶一屏内每格都被钳、滚动发粘。
    if (!smoothWheel || !isMac) return;
    const viewport = internalRef.current;
    if (!viewport) return;
    const reduceMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) return;

    const MAX_STEP = 60; // 近顶区单次向上滚最大步长(px)

    const onWheel = (e: WheelEvent) => {
      if (e.deltaY >= 0) return; // 只管向上
      const top = viewport.scrollTop;
      if (top <= 0) return; // 已到顶 → 交给 onWheelCapture / overscrollBounce
      if (top > viewport.clientHeight) return; // 远离顶部(超过一屏)→ 全交原生,零干预
      if (-e.deltaY <= MAX_STEP) return; // 未超限 → 原生处理
      e.preventDefault();
      viewport.scrollTop = Math.max(0, top - MAX_STEP);
    };

    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [smoothWheel]);

  return (
    <div className={cn("min-h-0", className)}>
      <div
        ref={setViewportRef}
        onWheelCapture={onWheelCapture}
        className={cn("h-full overflow-y-auto overflow-x-hidden", viewportClassName)}
      >
        <div ref={contentRef} className={contentClassName}>
          {children}
        </div>
      </div>
    </div>
  );
}
