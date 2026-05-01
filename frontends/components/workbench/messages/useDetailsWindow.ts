import { useCallback, useRef, useState } from "react";
import type { RefObject } from "react";
import {
  currentMonitor,
  getCurrentWindow,
  PhysicalPosition,
  PhysicalSize,
} from "@tauri-apps/api/window";

import { CUSTOMER_DETAILS_WIDTH, DETAILS_RESIZE_TOLERANCE } from "./constants";

interface DetailsWindowState {
  baseContentSize: PhysicalSize;
  expandedContentSize: PhysicalSize;
  position: PhysicalPosition;
  wasMaximized: boolean;
  manuallyResized: boolean;
}

type DetailsResizePhase = "closed" | "opening" | "open" | "closing";

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function waitForWindowMutation() {
  return new Promise((resolve) => window.setTimeout(resolve, 50));
}

function waitForLayoutFrame() {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(resolve);
    });
  });
}

function sizeDeltaExceeds(a: PhysicalSize, b: PhysicalSize, tolerance: number) {
  return Math.abs(a.width - b.width) > tolerance || Math.abs(a.height - b.height) > tolerance;
}

interface UseDetailsWindowOptions {
  /** Reference to the chat area, used to lock its current pixel width during a transition. */
  chatAreaRef: RefObject<HTMLDivElement | null>;
}

interface UseDetailsWindowResult {
  detailsOpen: boolean;
  /** Pixel width to pin the chat area at while details panel is opening/closing; null otherwise. */
  chatWidthLock: number | null;
  toggleDetails: () => void;
  /** Imperatively close when an external listener (e.g. window resize) decides we no longer fit. */
  closeDueToResize: () => void;
  /** Tell the hook the user might have manually resized the Tauri window so we shouldn't auto-restore. */
  markManualResizeIfNeeded: () => void;
}

/**
 * Owns the open/close state of the customer details panel and the choreography
 * that grows / shrinks the surrounding Tauri window in lockstep. Pure React
 * state outside of Tauri (browser preview) is supported as a degraded path.
 */
export function useDetailsWindow({ chatAreaRef }: UseDetailsWindowOptions): UseDetailsWindowResult {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [chatWidthLock, setChatWidthLock] = useState<number | null>(null);

  const detailsOpenRef = useRef(false);
  const detailsResizePhaseRef = useRef<DetailsResizePhase>("closed");
  const detailsResizeInFlightRef = useRef(false);
  const manualResizeCheckInFlightRef = useRef(false);
  const detailsWindowStateRef = useRef<DetailsWindowState | null>(null);

  const markManualResizeIfNeeded = useCallback(() => {
    if (!isTauriRuntime()) return;
    if (manualResizeCheckInFlightRef.current) return;
    if (!detailsOpenRef.current || detailsResizePhaseRef.current !== "open") return;

    const previousState = detailsWindowStateRef.current;
    if (!previousState || previousState.manuallyResized) return;

    manualResizeCheckInFlightRef.current = true;
    void (async () => {
      try {
        const contentSize = await getCurrentWindow().innerSize();
        const currentState = detailsWindowStateRef.current;
        if (
          currentState &&
          detailsOpenRef.current &&
          detailsResizePhaseRef.current === "open" &&
          sizeDeltaExceeds(contentSize, currentState.expandedContentSize, DETAILS_RESIZE_TOLERANCE)
        ) {
          currentState.manuallyResized = true;
        }
      } catch {
        // Browser preview has no Tauri window; ignore manual resize tracking there.
      } finally {
        manualResizeCheckInFlightRef.current = false;
      }
    })();
  }, []);

  const openDetailsWithWindowResize = useCallback(async () => {
    try {
      const win = getCurrentWindow();
      const wasMaximized = await win.isMaximized();
      if (wasMaximized) {
        await win.unmaximize();
        await waitForWindowMutation();
      }

      const [contentSize, windowSize, position, scaleFactor, monitor] = await Promise.all([
        win.innerSize(),
        win.outerSize(),
        win.outerPosition(),
        win.scaleFactor(),
        currentMonitor(),
      ]);
      const detailsWidth = Math.round(CUSTOMER_DETAILS_WIDTH * scaleFactor);
      const targetContentWidth = contentSize.width + detailsWidth;
      const targetWindowWidth = windowSize.width + detailsWidth;
      const workArea = monitor?.workArea;

      if (workArea) {
        const workRight = workArea.position.x + workArea.size.width;
        const targetRight = position.x + targetWindowWidth;
        const overflow = Math.max(0, targetRight - workRight);
        if (overflow > 0) {
          await win.setPosition(
            new PhysicalPosition(Math.max(workArea.position.x, position.x - overflow), position.y),
          );
        }
      }

      await win.setSize(new PhysicalSize(targetContentWidth, contentSize.height));
      await waitForWindowMutation();

      const nextContentSize = await win.innerSize();
      if (nextContentSize.width < contentSize.width + detailsWidth - DETAILS_RESIZE_TOLERANCE) {
        await win.setSize(contentSize);
        await win.setPosition(position);
        if (wasMaximized) await win.maximize();
        detailsWindowStateRef.current = null;
        return false;
      }

      detailsWindowStateRef.current = {
        baseContentSize: contentSize,
        expandedContentSize: nextContentSize,
        position,
        wasMaximized,
        manuallyResized: false,
      };
      return true;
    } catch {
      // Plain browser preview: render the panel even without window resize.
      return !isTauriRuntime();
    }
  }, []);

  const closeDetailsWithWindowResize = useCallback(async () => {
    const previousState = detailsWindowStateRef.current;
    if (!previousState) return;
    if (previousState.manuallyResized) {
      detailsWindowStateRef.current = null;
      return;
    }
    try {
      const win = getCurrentWindow();
      await win.setSize(previousState.baseContentSize);
      await win.setPosition(previousState.position);
      if (previousState.wasMaximized) await win.maximize();
    } catch {
      // Browser preview: nothing to restore.
    } finally {
      detailsWindowStateRef.current = null;
    }
  }, []);

  const lockCurrentChatWidth = useCallback(() => {
    const width = chatAreaRef.current?.getBoundingClientRect().width ?? 0;
    if (width <= 0) return false;
    setChatWidthLock(Math.ceil(width));
    return true;
  }, [chatAreaRef]);

  const toggleDetails = useCallback(() => {
    if (detailsResizeInFlightRef.current) return;

    const currentPhase = detailsResizePhaseRef.current;
    const opening = currentPhase === "closed" && !detailsOpenRef.current;
    const closing = currentPhase === "open" && detailsOpenRef.current;
    if (!opening && !closing) return;

    detailsResizeInFlightRef.current = true;
    detailsResizePhaseRef.current = opening ? "opening" : "closing";

    void (async () => {
      try {
        const locked = lockCurrentChatWidth();
        if (locked) await waitForLayoutFrame();

        if (opening) {
          const resized = await openDetailsWithWindowResize();
          if (resized) {
            detailsOpenRef.current = true;
            setDetailsOpen(true);
            await waitForLayoutFrame();
            detailsResizePhaseRef.current = "open";
          } else {
            detailsOpenRef.current = false;
            detailsResizePhaseRef.current = "closed";
          }
        } else {
          detailsOpenRef.current = false;
          setDetailsOpen(false);
          await closeDetailsWithWindowResize();
          await waitForLayoutFrame();
          detailsResizePhaseRef.current = "closed";
        }
      } finally {
        if (
          detailsResizePhaseRef.current === "opening" ||
          detailsResizePhaseRef.current === "closing"
        ) {
          detailsOpenRef.current = false;
          detailsResizePhaseRef.current = "closed";
        }
        setChatWidthLock(null);
        detailsResizeInFlightRef.current = false;
      }
    })();
  }, [closeDetailsWithWindowResize, lockCurrentChatWidth, openDetailsWithWindowResize]);

  const closeDueToResize = useCallback(() => {
    detailsOpenRef.current = false;
    detailsResizePhaseRef.current = "closed";
    detailsWindowStateRef.current = null;
    setDetailsOpen(false);
    setChatWidthLock(null);
  }, []);

  return {
    detailsOpen,
    chatWidthLock,
    toggleDetails,
    closeDueToResize,
    markManualResizeIfNeeded,
  };
}
