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

const SCROLLBAR_MIN_THUMB_HEIGHT = 44;
const SCROLLBAR_MAX_THUMB_HEIGHT = 160;

interface WorkbenchScrollAreaProps {
  children: ReactNode;
  className?: string;
  viewportClassName?: string;
  contentClassName?: string;
  scrollRef?: RefObject<HTMLDivElement | null>;
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
}: WorkbenchScrollAreaProps) {
  const internalScrollRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = scrollRef ?? internalScrollRef;

  return (
    <div className={cn("relative min-h-0", className)}>
      <div
        ref={viewportRef}
        className={cn(
          "h-full overflow-y-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          viewportClassName,
        )}
      >
        <div className={contentClassName}>{children}</div>
      </div>
      <WorkbenchScrollbar scrollRef={viewportRef} />
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

function WorkbenchScrollbar({ scrollRef }: { scrollRef: RefObject<HTMLDivElement | null> }) {
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
  const [isDragging, setIsDragging] = useState(false);
  // Only re-render when these visual props change. Thumb position is updated
  // imperatively via `transform` to keep scroll-driven updates off the React tree.
  const [visualState, setVisualState] = useState<{ visible: boolean; thumbHeight: number }>({
    visible: false,
    thumbHeight: SCROLLBAR_MIN_THUMB_HEIGHT,
  });

  const writeThumbTransform = useCallback((thumbTop: number) => {
    const thumb = thumbRef.current;
    if (!thumb) return;
    thumb.style.transform = `translate3d(0, ${thumbTop}px, 0)`;
  }, []);

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

    const trackHeight = Math.max(track.clientHeight, 0);
    const maxScrollTop = Math.max(node.scrollHeight - node.clientHeight, 0);

    if (trackHeight <= 0 || maxScrollTop <= 1) {
      m.visible = false;
      m.maxScrollTop = 0;
      m.maxThumbTop = 0;
      setVisualState((s) => (s.visible ? { ...s, visible: false } : s));
      return;
    }

    const rawThumbHeight = (node.clientHeight / node.scrollHeight) * trackHeight;
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

    setVisualState((s) =>
      s.visible && s.thumbHeight === thumbHeight ? s : { visible: true, thumbHeight },
    );
  }, [scrollRef, writeThumbTransform]);

  // Fast path on scroll: only update thumb transform via ref. If content size
  // changed (e.g. new messages appended), fall back to a full recompute.
  const syncOnScroll = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    const m = metricsRef.current;
    const maxScrollTop = Math.max(node.scrollHeight - node.clientHeight, 0);
    if (Math.abs(maxScrollTop - m.maxScrollTop) > 0.5) {
      recomputeAll();
      return;
    }
    if (m.maxThumbTop <= 0 || maxScrollTop <= 0) return;
    const scrollTop = clampNumber(node.scrollTop, 0, maxScrollTop);
    const thumbTop = (scrollTop / maxScrollTop) * m.maxThumbTop;
    writeThumbTransform(thumbTop);
  }, [recomputeAll, scrollRef, writeThumbTransform]);

  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;

    recomputeAll();
    node.addEventListener("scroll", syncOnScroll, { passive: true });
    window.addEventListener("resize", recomputeAll);

    const observer = new ResizeObserver(recomputeAll);
    observer.observe(node);
    if (node.firstElementChild) observer.observe(node.firstElementChild);

    return () => {
      node.removeEventListener("scroll", syncOnScroll);
      window.removeEventListener("resize", recomputeAll);
      observer.disconnect();
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

  return (
    <div
      ref={trackRef}
      aria-hidden
      onPointerDown={handleTrackPointerDown}
      className={cn(
        "absolute bottom-3 right-2 top-3 z-10 w-1.5 rounded-full transition-opacity",
        visualState.visible ? "opacity-100" : "pointer-events-none opacity-0",
      )}
    >
      <div
        ref={thumbRef}
        onPointerDown={handleThumbPointerDown}
        className={cn(
          "absolute left-0 top-0 w-full rounded-full bg-[#C4CEDB] transition-colors will-change-transform hover:bg-[#A9B6C6]",
          isDragging ? "cursor-grabbing bg-[#A9B6C6]" : "cursor-grab",
          !visualState.visible && "pointer-events-none opacity-0",
        )}
        style={{ height: visualState.thumbHeight }}
      />
    </div>
  );
}
