import { type ReactNode, type WheelEventHandler, useCallback, useEffect, useRef } from "react";

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
}: WorkbenchScrollAreaProps) {
  // 内部 ref 始终持有真实 DOM,所有 effect/listener 都通过 internalRef.current 读取,
  // 不依赖父传 ref 的引用一致性。父传的 scrollRef 由 setViewportRef 桥接转发。
  const internalRef = useRef<HTMLDivElement | null>(null);

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

  return (
    <div className={cn("min-h-0", className)}>
      <div
        ref={setViewportRef}
        onWheelCapture={onWheelCapture}
        className={cn("h-full overflow-y-auto overflow-x-hidden", viewportClassName)}
      >
        <div className={contentClassName}>{children}</div>
      </div>
    </div>
  );
}
