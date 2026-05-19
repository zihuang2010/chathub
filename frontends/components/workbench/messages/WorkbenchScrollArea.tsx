import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { cn } from "@/lib/utils";

import {
  AT_BOTTOM_THRESHOLD,
  SCROLLBAR_IDLE_HIDE_MS,
  SCROLLBAR_MAX_THUMB_HEIGHT,
  SCROLLBAR_MIN_THUMB_HEIGHT,
  SCROLLBAR_OVERFLOW_THRESHOLD,
} from "./constants";

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
  scrollRef?: RefObject<HTMLDivElement | null>;
  onScrollMetrics?: (metrics: ScrollMetrics) => void;
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function WorkbenchScrollArea({
  children,
  className,
  viewportClassName,
  contentClassName,
  scrollRef,
  onScrollMetrics,
}: WorkbenchScrollAreaProps) {
  const internalScrollRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = scrollRef ?? internalScrollRef;
  // Hover lives at the area level (not inside the scrollbar) so the thumb
  // stays visible when the cursor is over the content, not just the 6px-wide
  // track. Matches macOS overlay-scrollbar feel.
  const [isHovering, setIsHovering] = useState(false);

  return (
    <div
      className={cn("relative min-h-0", className)}
      onPointerEnter={() => setIsHovering(true)}
      onPointerLeave={() => setIsHovering(false)}
    >
      <div
        ref={viewportRef}
        className={cn(
          "h-full overflow-y-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          viewportClassName,
        )}
      >
        <div className={contentClassName}>{children}</div>
      </div>
      <WorkbenchScrollbar
        scrollRef={viewportRef}
        onScrollMetrics={onScrollMetrics}
        isHovering={isHovering}
      />
    </div>
  );
}

interface ScrollbarMetricsRef {
  visible: boolean;
  thumbHeight: number;
  trackHeight: number;
  maxThumbTop: number;
  maxScrollTop: number;
}

interface DragStateRef {
  active: boolean;
  startY: number;
  startScrollTop: number;
  maxScrollTop: number;
  maxThumbTop: number;
  targetScrollTop: number;
}

function WorkbenchScrollbar({
  scrollRef,
  onScrollMetrics,
  isHovering,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  onScrollMetrics?: (metrics: ScrollMetrics) => void;
  isHovering: boolean;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const thumbRef = useRef<HTMLDivElement | null>(null);
  const dragRafRef = useRef<number | null>(null);
  const dragRef = useRef<DragStateRef>({
    active: false,
    startY: 0,
    startScrollTop: 0,
    maxScrollTop: 0,
    maxThumbTop: 0,
    targetScrollTop: 0,
  });
  const metricsRef = useRef<ScrollbarMetricsRef>({
    visible: false,
    thumbHeight: SCROLLBAR_MIN_THUMB_HEIGHT,
    trackHeight: 0,
    maxThumbTop: 0,
    maxScrollTop: 0,
  });
  // Stash the latest callback in a ref so the listener-installing effect
  // doesn't need to re-run every time the parent re-renders.
  const onScrollMetricsRef = useRef(onScrollMetrics);
  useEffect(() => {
    onScrollMetricsRef.current = onScrollMetrics;
  }, [onScrollMetrics]);

  const [isDragging, setIsDragging] = useState(false);
  // `recentlyScrolled` flips true on each scroll event and back to false
  // SCROLLBAR_IDLE_HIDE_MS after the last one. Combined with isHovering /
  // isDragging this drives the auto-hide opacity.
  const [recentlyScrolled, setRecentlyScrolled] = useState(false);
  const idleTimerRef = useRef<number | null>(null);
  // Only re-render when these visual props change. Thumb position is updated
  // imperatively via `transform` to keep scroll-driven updates off the React tree.
  const [visualState, setVisualState] = useState<{ visible: boolean; thumbHeight: number }>({
    visible: false,
    thumbHeight: SCROLLBAR_MIN_THUMB_HEIGHT,
  });

  const markActive = useCallback(() => {
    setRecentlyScrolled((prev) => (prev ? prev : true));
    if (idleTimerRef.current !== null) window.clearTimeout(idleTimerRef.current);
    idleTimerRef.current = window.setTimeout(() => {
      setRecentlyScrolled(false);
      idleTimerRef.current = null;
    }, SCROLLBAR_IDLE_HIDE_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (idleTimerRef.current !== null) {
        window.clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
    };
  }, []);

  const writeThumbTransform = useCallback((thumbTop: number) => {
    const thumb = thumbRef.current;
    if (!thumb) return;
    thumb.style.transform = `translate3d(0, ${thumbTop}px, 0)`;
  }, []);

  const emitMetrics = useCallback(
    (scrollTop: number, scrollHeight: number, clientHeight: number) => {
      const cb = onScrollMetricsRef.current;
      if (!cb) return;
      cb({
        scrollTop,
        scrollHeight,
        clientHeight,
        atBottom: scrollHeight - scrollTop - clientHeight < AT_BOTTOM_THRESHOLD,
      });
    },
    [],
  );

  const recomputeAll = useCallback(() => {
    const node = scrollRef.current;
    const track = trackRef.current;
    const m = metricsRef.current;

    if (!node || !track) {
      if (m.visible) {
        m.visible = false;
        setVisualState((s) => (s.visible ? { ...s, visible: false } : s));
      }
      return;
    }

    const scrollHeight = node.scrollHeight;
    const clientHeight = node.clientHeight;
    const trackHeight = Math.max(track.clientHeight, 0);
    const maxScrollTop = Math.max(scrollHeight - clientHeight, 0);

    if (trackHeight <= 0 || maxScrollTop < SCROLLBAR_OVERFLOW_THRESHOLD) {
      m.visible = false;
      m.maxScrollTop = 0;
      m.maxThumbTop = 0;
      setVisualState((s) => (s.visible ? { ...s, visible: false } : s));
      emitMetrics(node.scrollTop, scrollHeight, clientHeight);
      return;
    }

    const rawThumbHeight = (clientHeight / scrollHeight) * trackHeight;
    const thumbHeight = clampNumber(
      Math.round(rawThumbHeight),
      Math.min(SCROLLBAR_MIN_THUMB_HEIGHT, trackHeight),
      Math.min(SCROLLBAR_MAX_THUMB_HEIGHT, trackHeight),
    );
    const maxThumbTop = Math.max(trackHeight - thumbHeight, 0);
    const scrollTop = clampNumber(node.scrollTop, 0, maxScrollTop);
    const thumbTop = maxThumbTop > 0 ? (scrollTop / maxScrollTop) * maxThumbTop : 0;

    m.visible = true;
    m.thumbHeight = thumbHeight;
    m.trackHeight = trackHeight;
    m.maxThumbTop = maxThumbTop;
    m.maxScrollTop = maxScrollTop;

    writeThumbTransform(thumbTop);
    emitMetrics(scrollTop, scrollHeight, clientHeight);

    setVisualState((s) =>
      s.visible && s.thumbHeight === thumbHeight ? s : { visible: true, thumbHeight },
    );
  }, [emitMetrics, scrollRef, writeThumbTransform]);

  // Fast path on scroll: only update thumb transform via ref. If content size
  // changed (e.g. new messages appended), fall back to a full recompute.
  const syncOnScroll = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    const m = metricsRef.current;
    const scrollHeight = node.scrollHeight;
    const clientHeight = node.clientHeight;
    const maxScrollTop = Math.max(scrollHeight - clientHeight, 0);

    markActive();

    if (Math.abs(maxScrollTop - m.maxScrollTop) > 0.5) {
      recomputeAll();
      return;
    }

    if (m.maxThumbTop <= 0 || maxScrollTop <= 0) {
      emitMetrics(node.scrollTop, scrollHeight, clientHeight);
      return;
    }

    const scrollTop = clampNumber(node.scrollTop, 0, maxScrollTop);
    const thumbTop = (scrollTop / maxScrollTop) * m.maxThumbTop;
    writeThumbTransform(thumbTop);
    emitMetrics(scrollTop, scrollHeight, clientHeight);
  }, [emitMetrics, markActive, recomputeAll, scrollRef, writeThumbTransform]);

  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;

    recomputeAll();
    node.addEventListener("scroll", syncOnScroll, { passive: true });
    window.addEventListener("resize", recomputeAll);

    // ResizeObserver 监听 viewport + 当前 firstElementChild。后者会在 ChatArea
    // 的 loading/empty/log 状态切换时被替换，原版只在 effect 挂载时绑一次，
    // 之后切到不同 child 就停止追踪内容高度，scrollbar thumb 大小停止更新。
    // 用 MutationObserver 监听 viewport 子节点变化，重新绑定到新的 firstChild。
    const resizeObserver = new ResizeObserver(recomputeAll);
    resizeObserver.observe(node);
    let observedChild: Element | null = node.firstElementChild;
    if (observedChild) resizeObserver.observe(observedChild);

    const childObserver = new MutationObserver(() => {
      const next = node.firstElementChild;
      if (next === observedChild) return;
      if (observedChild) resizeObserver.unobserve(observedChild);
      if (next) resizeObserver.observe(next);
      observedChild = next;
      recomputeAll();
    });
    childObserver.observe(node, { childList: true });

    return () => {
      node.removeEventListener("scroll", syncOnScroll);
      window.removeEventListener("resize", recomputeAll);
      resizeObserver.disconnect();
      childObserver.disconnect();
    };
  }, [recomputeAll, scrollRef, syncOnScroll]);

  useEffect(() => {
    if (!isDragging) return;

    const flush = () => {
      dragRafRef.current = null;
      const node = scrollRef.current;
      const drag = dragRef.current;
      if (!node || !drag.active) return;
      node.scrollTop = drag.targetScrollTop;
    };
    const requestFlush = () => {
      if (dragRafRef.current !== null) return;
      dragRafRef.current = window.requestAnimationFrame(flush);
    };

    const handlePointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag.active || drag.maxThumbTop <= 0) return;
      const deltaY = event.clientY - drag.startY;
      const ratio = drag.maxScrollTop / drag.maxThumbTop;
      drag.targetScrollTop = clampNumber(
        drag.startScrollTop + deltaY * ratio,
        0,
        drag.maxScrollTop,
      );
      requestFlush();
    };
    const stopDragging = () => {
      dragRef.current.active = false;
      setIsDragging(false);
    };
    const previousUserSelect = document.body.style.userSelect;

    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopDragging);
    window.addEventListener("pointercancel", stopDragging);

    return () => {
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopDragging);
      window.removeEventListener("pointercancel", stopDragging);
      if (dragRafRef.current !== null) {
        window.cancelAnimationFrame(dragRafRef.current);
        dragRafRef.current = null;
      }
    };
  }, [isDragging, scrollRef]);

  const handleTrackPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const node = scrollRef.current;
    const track = trackRef.current;
    if (!node || !track || event.target !== event.currentTarget) return;
    const m = metricsRef.current;
    if (m.maxThumbTop <= 0) return;
    const rect = track.getBoundingClientRect();
    const targetThumbTop = clampNumber(
      event.clientY - rect.top - m.thumbHeight / 2,
      0,
      m.maxThumbTop,
    );
    node.scrollTop = (targetThumbTop / m.maxThumbTop) * m.maxScrollTop;
  };

  // Scrollbar track/thumb 与 viewport 是兄弟节点（同一父级下并排,非 DOM 嵌套）,
  // 浏览器原生 wheel 处理沿 DOM 树寻找 overflow:auto 的祖先 → 找不到 viewport →
  // 滚轮在 scrollbar 6px 宽度内直接空转。手工把 wheel delta 写回 viewport.scrollTop
  // 修正:用 native addEventListener 而非 React onWheel，因为 React 在 root 委派
  // wheel 时 passive:true,且在某些 webkit 版本下 e.preventDefault 不起作用会让浏览器
  // 先执行默认行为(找祖先 overflow → 找不到 → 无效)再触发 React 同步,顺序错位。
  // native 注册到 trackRef 上,passive:false 让我们能 preventDefault,确保浏览器
  // 不会再额外尝试找祖先滚动。deltaMode=DOM_DELTA_LINE/PAGE 时换算成像素后再滚。
  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const onWheel = (event: WheelEvent) => {
      const node = scrollRef.current;
      if (!node) return;
      const lineHeight = 16;
      const pageHeight = node.clientHeight || 600;
      let dy = event.deltaY;
      let dx = event.deltaX;
      if (event.deltaMode === 1) {
        dy *= lineHeight;
        dx *= lineHeight;
      } else if (event.deltaMode === 2) {
        dy *= pageHeight;
        dx *= pageHeight;
      }
      node.scrollTop += dy;
      if (dx !== 0) node.scrollLeft += dx;
      event.preventDefault();
    };
    track.addEventListener("wheel", onWheel, { passive: false });
    return () => track.removeEventListener("wheel", onWheel);
  }, [scrollRef]);

  const handleThumbPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const node = scrollRef.current;
    if (!node) return;
    event.preventDefault();
    event.stopPropagation();
    const m = metricsRef.current;
    const startScrollTop = clampNumber(node.scrollTop, 0, m.maxScrollTop);
    dragRef.current = {
      active: true,
      startY: event.clientY,
      startScrollTop,
      maxScrollTop: m.maxScrollTop,
      maxThumbTop: m.maxThumbTop,
      targetScrollTop: startScrollTop,
    };
    setIsDragging(true);
  };

  // Effective visibility: there must be overflow AND either the user is
  // currently interacting (hover/drag) or just finished scrolling.
  const shouldShow = visualState.visible && (isHovering || isDragging || recentlyScrolled);

  return (
    <div
      ref={trackRef}
      aria-hidden
      onPointerDown={handleTrackPointerDown}
      className={cn(
        "absolute bottom-3 right-2 top-3 z-10 w-1.5 rounded-full transition-opacity duration-200",
        shouldShow ? "opacity-100" : "pointer-events-none opacity-0",
      )}
    >
      <div
        ref={thumbRef}
        onPointerDown={handleThumbPointerDown}
        className={cn(
          "absolute left-0 top-0 w-full rounded-full bg-workbench-thumb transition-colors will-change-transform hover:bg-workbench-thumb-hover",
          isDragging ? "cursor-grabbing bg-workbench-thumb-hover" : "cursor-grab",
          !shouldShow && "pointer-events-none",
        )}
        style={{ height: visualState.thumbHeight }}
      />
    </div>
  );
}
