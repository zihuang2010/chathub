import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import {
  currentMonitor,
  getCurrentWindow,
  PhysicalPosition,
  PhysicalSize,
} from "@tauri-apps/api/window";

import { WorkbenchPanel } from "@/components/workbench/WorkbenchPanel";
import { WORKBENCH_LINE, WORKBENCH_SURFACE_SUBTLE } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { ChatArea } from "./ChatArea";
import { ConversationList } from "./ConversationList";
import { CustomerDetails } from "./CustomerDetails";
import {
  MOCK_CONVERSATIONS,
  MOCK_CUSTOMERS_BY_CONVERSATION,
  MOCK_MESSAGES_BY_CONVERSATION,
  MOCK_QUICK_REPLIES,
} from "./data";

const CONVERSATION_LIST_DEFAULT_WIDTH = 316;
const CONVERSATION_LIST_MIN_WIDTH = 260;
const CONVERSATION_LIST_MAX_WIDTH = 460;
const CUSTOMER_DETAILS_WIDTH = 324;
const CHAT_AREA_MIN_WIDTH = 360;
const RESIZE_HANDLE_WIDTH = 8;
const KEYBOARD_RESIZE_STEP = 16;
const DETAILS_RESIZE_TOLERANCE = 12;
const DETAILS_AUTO_CLOSE_MIN_WIDTH =
  CONVERSATION_LIST_MIN_WIDTH + RESIZE_HANDLE_WIDTH + CHAT_AREA_MIN_WIDTH + CUSTOMER_DETAILS_WIDTH;

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

export function MessagesPage() {
  const [selectedId, setSelectedId] = useState<string>(MOCK_CONVERSATIONS[0].id);
  const [selectedAccount, setSelectedAccount] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [chatWidthLock, setChatWidthLock] = useState<number | null>(null);
  const [conversationListWidth, setConversationListWidth] = useState(
    CONVERSATION_LIST_DEFAULT_WIDTH,
  );
  const [isResizing, setIsResizing] = useState(false);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const chatAreaRef = useRef<HTMLDivElement | null>(null);
  const dragStartRef = useRef({ x: 0, width: CONVERSATION_LIST_DEFAULT_WIDTH });
  const detailsResizeInFlightRef = useRef(false);
  const detailsOpenRef = useRef(false);
  const detailsResizePhaseRef = useRef<DetailsResizePhase>("closed");
  const manualResizeCheckInFlightRef = useRef(false);
  const detailsWindowStateRef = useRef<DetailsWindowState | null>(null);

  const accountOptions = useMemo(
    () => Array.from(new Set(MOCK_CONVERSATIONS.map((conversation) => conversation.account))),
    [],
  );
  const conversation = useMemo(
    () => MOCK_CONVERSATIONS.find((c) => c.id === selectedId) ?? MOCK_CONVERSATIONS[0],
    [selectedId],
  );
  const messages = useMemo(
    () => MOCK_MESSAGES_BY_CONVERSATION[conversation.id] ?? [],
    [conversation.id],
  );
  const customer = useMemo(
    () => MOCK_CUSTOMERS_BY_CONVERSATION[conversation.id] ?? MOCK_CUSTOMERS_BY_CONVERSATION.c1,
    [conversation.id],
  );

  const clampConversationListWidth = useCallback(
    (nextWidth: number) => {
      const pageWidth = pageRef.current?.clientWidth ?? 0;
      const detailsWidth = detailsOpen ? CUSTOMER_DETAILS_WIDTH : 0;
      const layoutMaxWidth =
        pageWidth > 0
          ? Math.max(
              CONVERSATION_LIST_MIN_WIDTH,
              pageWidth - detailsWidth - CHAT_AREA_MIN_WIDTH - RESIZE_HANDLE_WIDTH,
            )
          : CONVERSATION_LIST_MAX_WIDTH;
      const maxWidth = Math.min(CONVERSATION_LIST_MAX_WIDTH, layoutMaxWidth);

      return Math.min(Math.max(nextWidth, CONVERSATION_LIST_MIN_WIDTH), maxWidth);
    },
    [detailsOpen],
  );

  const setDetailsOpenState = useCallback((open: boolean) => {
    detailsOpenRef.current = open;
    detailsResizePhaseRef.current = open ? "open" : "closed";
    setDetailsOpen(open);
  }, []);

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

  useEffect(() => {
    const handleWindowResize = () => {
      const pageWidth = pageRef.current?.clientWidth ?? 0;

      if (detailsOpenRef.current && detailsResizePhaseRef.current === "open") {
        if (pageWidth > 0 && pageWidth < DETAILS_AUTO_CLOSE_MIN_WIDTH) {
          setDetailsOpenState(false);
          setChatWidthLock(null);
          detailsWindowStateRef.current = null;
          return;
        }

        markManualResizeIfNeeded();
      }

      setConversationListWidth((width) => clampConversationListWidth(width));
    };

    handleWindowResize();
    window.addEventListener("resize", handleWindowResize);
    return () => window.removeEventListener("resize", handleWindowResize);
  }, [clampConversationListWidth, markManualResizeIfNeeded, setDetailsOpenState]);

  useEffect(() => {
    if (!isResizing) return;

    const handlePointerMove = (event: PointerEvent) => {
      const deltaX = event.clientX - dragStartRef.current.x;
      setConversationListWidth(clampConversationListWidth(dragStartRef.current.width + deltaX));
    };
    const stopResizing = () => setIsResizing(false);
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResizing);
    window.addEventListener("pointercancel", stopResizing);

    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResizing);
      window.removeEventListener("pointercancel", stopResizing);
    };
  }, [clampConversationListWidth, isResizing]);

  const handleResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;

    event.preventDefault();
    dragStartRef.current = {
      x: event.clientX,
      width: conversationListWidth,
    };
    setIsResizing(true);
  };

  const handleResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      event.key !== "ArrowLeft" &&
      event.key !== "ArrowRight" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }

    event.preventDefault();
    setConversationListWidth((width) => {
      if (event.key === "Home") return CONVERSATION_LIST_MIN_WIDTH;
      if (event.key === "End") return clampConversationListWidth(CONVERSATION_LIST_MAX_WIDTH);

      const direction = event.key === "ArrowLeft" ? -1 : 1;
      return clampConversationListWidth(width + direction * KEYBOARD_RESIZE_STEP);
    });
  };

  const handleAccountChange = useCallback(
    (account: string | null) => {
      setSelectedAccount(account);

      if (!account || conversation.account === account) return;

      const nextConversation = MOCK_CONVERSATIONS.find((item) => item.account === account);
      if (nextConversation) setSelectedId(nextConversation.id);
    },
    [conversation.account],
  );

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
      // Plain browser preview has no Tauri window to resize, but should still render the panel.
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
      // Plain browser preview has no Tauri window to restore.
    } finally {
      detailsWindowStateRef.current = null;
    }
  }, []);

  const lockCurrentChatWidth = useCallback(() => {
    const width = chatAreaRef.current?.getBoundingClientRect().width ?? 0;
    if (width <= 0) return false;

    setChatWidthLock(Math.ceil(width));
    return true;
  }, []);

  const handleToggleDetails = useCallback(() => {
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

        setConversationListWidth((width) => clampConversationListWidth(width));
      } finally {
        if (detailsResizePhaseRef.current === "opening") {
          detailsOpenRef.current = false;
          detailsResizePhaseRef.current = "closed";
        } else if (detailsResizePhaseRef.current === "closing") {
          detailsOpenRef.current = false;
          detailsResizePhaseRef.current = "closed";
        }
        setChatWidthLock(null);
        detailsResizeInFlightRef.current = false;
      }
    })();
  }, [
    closeDetailsWithWindowResize,
    clampConversationListWidth,
    lockCurrentChatWidth,
    openDetailsWithWindowResize,
  ]);

  return (
    <WorkbenchPanel panelRef={pageRef} className="relative">
      <ConversationList
        conversations={MOCK_CONVERSATIONS}
        selectedId={selectedId}
        onSelect={setSelectedId}
        width={conversationListWidth}
        accountOptions={accountOptions}
        selectedAccount={selectedAccount}
        onAccountChange={handleAccountChange}
      />
      <div
        role="separator"
        aria-label="调整会话列表宽度"
        aria-orientation="vertical"
        aria-valuemin={CONVERSATION_LIST_MIN_WIDTH}
        aria-valuemax={CONVERSATION_LIST_MAX_WIDTH}
        aria-valuenow={Math.round(conversationListWidth)}
        tabIndex={0}
        onPointerDown={handleResizePointerDown}
        onKeyDown={handleResizeKeyDown}
        className={cn(
          "group flex h-full w-2 shrink-0 cursor-col-resize justify-center bg-white outline-none transition-colors hover:bg-[#F7FAFD] focus-visible:bg-[#F7FAFD]",
        )}
        style={{ background: isResizing ? WORKBENCH_SURFACE_SUBTLE : undefined }}
      >
        <span
          aria-hidden
          className={cn(
            "h-full w-px transition-colors group-hover:bg-[#93C5FD] group-focus-visible:bg-[#60A5FA]",
            isResizing && "bg-[#60A5FA]",
          )}
          style={!isResizing ? { background: WORKBENCH_LINE } : undefined}
        />
      </div>
      <div
        ref={chatAreaRef}
        className="flex h-full min-w-0 flex-1"
        style={
          chatWidthLock
            ? {
                flex: `0 0 ${chatWidthLock}px`,
                width: chatWidthLock,
              }
            : undefined
        }
      >
        <ChatArea
          conversation={conversation}
          messages={messages}
          accountOptions={accountOptions}
          selectedAccount={selectedAccount}
          onAccountChange={handleAccountChange}
          detailsOpen={detailsOpen}
          onToggleDetails={handleToggleDetails}
        />
      </div>
      {detailsOpen && <CustomerDetails customer={customer} quickReplies={MOCK_QUICK_REPLIES} />}
    </WorkbenchPanel>
  );
}
