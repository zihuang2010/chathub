import { useCallback, useRef, useState } from "react";
import type { RefObject } from "react";
import {
  currentMonitor,
  getCurrentWindow,
  PhysicalPosition,
  PhysicalSize,
} from "@tauri-apps/api/window";

import {
  CHAT_AREA_MIN_WIDTH,
  CONVERSATION_LIST_MIN_WIDTH,
  CUSTOMER_DETAILS_WIDTH,
  DETAILS_RESIZE_TOLERANCE,
  RESIZE_HANDLE_WIDTH,
} from "./constants";
import { computeExpandTarget, computeRestoreTarget } from "./detailsWindowGeometry";

/** Narrowest usable inner width WITHOUT the details panel (logical px) — used as
 *  the close-restore floor so a window dragged narrow while open can't shrink
 *  into a sliver. Scaled to physical px at open time. */
const APP_MIN_INNER_WIDTH_LOGICAL =
  CONVERSATION_LIST_MIN_WIDTH + RESIZE_HANDLE_WIDTH + CHAT_AREA_MIN_WIDTH;

/** What an open actually did to the window, so close can undo exactly that. */
interface DetailsGrow {
  /** Physical px the window inner width actually grew by (may be < requested if OS-clamped). */
  achievedDeltaWidth: number;
  /** Restore floor in physical px (APP_MIN_INNER_WIDTH_LOGICAL × scaleFactor at open). */
  minRestoreWidth: number;
  /** Window position before growing, restored on close. */
  position: PhysicalPosition;
  wasMaximized: boolean;
}

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

interface UseDetailsWindowOptions {
  /** Reference to the chat area, used to lock its current pixel width during a transition. */
  chatAreaRef: RefObject<HTMLDivElement | null>;
}

interface UseDetailsWindowResult {
  detailsOpen: boolean;
  /** Pixel width to pin the chat area at while details panel is opening/closing; null otherwise. */
  chatWidthLock: number | null;
  toggleDetails: () => void;
}

/**
 * Owns the open/close state of the customer details panel and the choreography
 * that grows / shrinks the surrounding Tauri window in lockstep.
 *
 * Single source of truth: the React `detailsOpen` state, guarded by one
 * in-flight ref. A successful grow records exactly what it changed in `growRef`;
 * close undoes that delta from the CURRENT window size (delta-undo), so a window
 * the user manually resized while the panel was open keeps that change. When the
 * work area can't fit a wider window — or the OS clamps the grow — the panel
 * opens anyway and the chat area's min-width guard absorbs the squeeze; no grow
 * is recorded, so close is a no-op. Plain browser preview (no Tauri) is a
 * degraded path that just toggles React state.
 */
export function useDetailsWindow({ chatAreaRef }: UseDetailsWindowOptions): UseDetailsWindowResult {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [chatWidthLock, setChatWidthLock] = useState<number | null>(null);

  const inFlightRef = useRef(false);
  const growRef = useRef<DetailsGrow | null>(null);

  const openDetailsWithWindowResize = useCallback(async (): Promise<boolean> => {
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
      const workArea = monitor
        ? { x: monitor.workArea.position.x, width: monitor.workArea.size.width }
        : null;

      const { canGrow, targetInnerWidth, nextX } = computeExpandTarget({
        innerWidth: contentSize.width,
        outerWidth: windowSize.width,
        outerX: position.x,
        detailsWidth,
        workArea,
      });

      // Work area can't fit a wider window → open the panel anyway and let the
      // chat min-width guard squeeze the chat column. No window mutation, so no
      // grow recorded and close stays a no-op.
      if (!canGrow) {
        if (wasMaximized) await win.maximize();
        return true;
      }

      if (nextX !== position.x) {
        await win.setPosition(new PhysicalPosition(nextX, position.y));
      }
      await win.setSize(new PhysicalSize(targetInnerWidth, contentSize.height));
      await waitForWindowMutation();

      const achievedDeltaWidth = (await win.innerSize()).width - contentSize.width;

      // OS clamped the grow away (e.g. useWindowMaxSize.setMaxSize). Revert the
      // position nudge and fall back to squeeze — don't record a grow we didn't get.
      if (achievedDeltaWidth <= DETAILS_RESIZE_TOLERANCE) {
        if (nextX !== position.x) await win.setPosition(position);
        return true;
      }

      growRef.current = {
        achievedDeltaWidth,
        minRestoreWidth: Math.round(APP_MIN_INNER_WIDTH_LOGICAL * scaleFactor),
        position,
        wasMaximized,
      };
      return true;
    } catch {
      // Plain browser preview: render the panel even without window resize.
      return !isTauriRuntime();
    }
  }, []);

  const closeDetailsWithWindowResize = useCallback(async () => {
    const grow = growRef.current;
    if (!grow) return;
    try {
      const win = getCurrentWindow();
      const current = await win.innerSize();
      const targetWidth = computeRestoreTarget(
        current.width,
        grow.achievedDeltaWidth,
        grow.minRestoreWidth,
      );
      await win.setSize(new PhysicalSize(targetWidth, current.height));
      await win.setPosition(grow.position);
      if (grow.wasMaximized) await win.maximize();
    } catch {
      // Browser preview: nothing to restore.
    } finally {
      growRef.current = null;
    }
  }, []);

  const lockCurrentChatWidth = useCallback(() => {
    const width = chatAreaRef.current?.getBoundingClientRect().width ?? 0;
    if (width <= 0) return false;
    setChatWidthLock(Math.ceil(width));
    return true;
  }, [chatAreaRef]);

  const toggleDetails = useCallback(() => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const opening = !detailsOpen;

    void (async () => {
      try {
        const locked = lockCurrentChatWidth();
        if (locked) await waitForLayoutFrame();

        if (opening) {
          const resized = await openDetailsWithWindowResize();
          if (resized) {
            setDetailsOpen(true);
            await waitForLayoutFrame();
          }
        } else {
          setDetailsOpen(false);
          await closeDetailsWithWindowResize();
          await waitForLayoutFrame();
        }
      } finally {
        setChatWidthLock(null);
        inFlightRef.current = false;
      }
    })();
  }, [
    closeDetailsWithWindowResize,
    detailsOpen,
    lockCurrentChatWidth,
    openDetailsWithWindowResize,
  ]);

  return {
    detailsOpen,
    chatWidthLock,
    toggleDetails,
  };
}
