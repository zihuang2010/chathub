import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ToastViewport } from "@/components/ui/toast";
import { WorkbenchPanel } from "@/components/workbench/WorkbenchPanel";
import { cn } from "@/lib/utils";

import { ChatArea } from "./ChatArea";
import { STRINGS } from "./strings";
import {
  CHAT_AREA_MIN_WIDTH,
  CONVERSATION_LIST_DEFAULT_WIDTH,
  CONVERSATION_LIST_MAX_WIDTH,
  CONVERSATION_LIST_MIN_WIDTH,
  CUSTOMER_DETAILS_WIDTH,
  RESIZE_HANDLE_WIDTH,
  RESIZE_KEYBOARD_STEP,
} from "./constants";
import { ConversationList } from "./ConversationList";
import { CustomerDetails } from "./CustomerDetails";
import {
  MOCK_CONVERSATIONS,
  MOCK_CUSTOMERS_BY_CONVERSATION,
  MOCK_MESSAGES_BY_CONVERSATION,
  MOCK_QUICK_REPLIES,
} from "./data";
import { useChatMessages } from "./useChatMessages";
import { useDetailsWindow } from "./useDetailsWindow";

export function MessagesPage() {
  const [selectedId, setSelectedId] = useState<string>(MOCK_CONVERSATIONS[0].id);
  const [selectedAccount, setSelectedAccount] = useState<string | null>(null);
  const [conversationListWidth, setConversationListWidth] = useState(
    CONVERSATION_LIST_DEFAULT_WIDTH,
  );
  const [isResizing, setIsResizing] = useState(false);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const chatAreaRef = useRef<HTMLDivElement | null>(null);
  const dragStartRef = useRef({ x: 0, width: CONVERSATION_LIST_DEFAULT_WIDTH });

  const { detailsOpen, chatWidthLock, toggleDetails, markManualResizeIfNeeded } = useDetailsWindow({
    chatAreaRef,
  });

  const accountOptions = useMemo(
    () => Array.from(new Set(MOCK_CONVERSATIONS.map((c) => c.account))),
    [],
  );
  const conversation = useMemo(
    () => MOCK_CONVERSATIONS.find((c) => c.id === selectedId) ?? MOCK_CONVERSATIONS[0],
    [selectedId],
  );
  const {
    messages,
    loading: messagesLoading,
    error: messagesError,
    retry: retryMessages,
  } = useChatMessages({
    source: MOCK_MESSAGES_BY_CONVERSATION,
    conversationId: conversation.id,
  });
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

  // Window resize + detailsOpen toggles both invalidate the previously clamped
  // width. Re-running this effect when `clampConversationListWidth` identity
  // changes (i.e. detailsOpen flipped) covers the toggle case via the initial
  // `handleWindowResize()` call below.
  useEffect(() => {
    const handleWindowResize = () => {
      if (detailsOpen) markManualResizeIfNeeded();
      setConversationListWidth((width) => clampConversationListWidth(width));
    };

    handleWindowResize();
    window.addEventListener("resize", handleWindowResize);
    return () => window.removeEventListener("resize", handleWindowResize);
  }, [clampConversationListWidth, detailsOpen, markManualResizeIfNeeded]);

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
    dragStartRef.current = { x: event.clientX, width: conversationListWidth };
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
      return clampConversationListWidth(width + direction * RESIZE_KEYBOARD_STEP);
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

  const errorBoundaryProps = {
    title: STRINGS.errors.pageUnavailable,
    retryLabel: STRINGS.errors.retry,
  };

  return (
    <WorkbenchPanel panelRef={pageRef} className="relative">
      <ErrorBoundary {...errorBoundaryProps}>
        <ConversationList
          conversations={MOCK_CONVERSATIONS}
          selectedId={selectedId}
          onSelect={setSelectedId}
          width={conversationListWidth}
          accountOptions={accountOptions}
          selectedAccount={selectedAccount}
          onAccountChange={handleAccountChange}
        />
      </ErrorBoundary>
      <div
        role="separator"
        aria-label={STRINGS.resize.listHandle}
        aria-orientation="vertical"
        aria-valuemin={CONVERSATION_LIST_MIN_WIDTH}
        aria-valuemax={CONVERSATION_LIST_MAX_WIDTH}
        aria-valuenow={Math.round(conversationListWidth)}
        tabIndex={0}
        onPointerDown={handleResizePointerDown}
        onKeyDown={handleResizeKeyDown}
        className={cn(
          "group flex h-full w-2 shrink-0 cursor-col-resize justify-center bg-workbench-surface outline-none transition-colors",
          isResizing
            ? "bg-workbench-surface-subtle"
            : "hover:bg-workbench-surface-subtle focus-visible:bg-workbench-surface-subtle",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "h-full w-px transition-colors",
            isResizing
              ? "bg-workbench-accent-soft"
              : "bg-workbench-line group-hover:bg-workbench-accent-soft group-focus-visible:bg-workbench-accent-soft",
          )}
        />
      </div>
      <div
        ref={chatAreaRef}
        className="flex h-full min-w-0 flex-1"
        style={chatWidthLock ? { flex: `0 0 ${chatWidthLock}px`, width: chatWidthLock } : undefined}
      >
        <ErrorBoundary {...errorBoundaryProps}>
          <ChatArea
            conversation={conversation}
            messages={messages}
            accountOptions={accountOptions}
            selectedAccount={selectedAccount}
            onAccountChange={handleAccountChange}
            detailsOpen={detailsOpen}
            onToggleDetails={toggleDetails}
            loading={messagesLoading}
            error={messagesError}
            onRetry={retryMessages}
            quickReplies={MOCK_QUICK_REPLIES}
            mentionCandidates={MOCK_CONVERSATIONS}
          />
        </ErrorBoundary>
      </div>
      {detailsOpen && (
        <ErrorBoundary {...errorBoundaryProps}>
          <CustomerDetails customer={customer} quickReplies={MOCK_QUICK_REPLIES} />
        </ErrorBoundary>
      )}
      <ToastViewport />
    </WorkbenchPanel>
  );
}
