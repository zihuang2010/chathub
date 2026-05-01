import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

import { WorkbenchPanel } from "@/components/workbench/WorkbenchPanel";
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

export function MessagesPage() {
  const [selectedId, setSelectedId] = useState<string>(MOCK_CONVERSATIONS[0].id);
  const [conversationListWidth, setConversationListWidth] = useState(
    CONVERSATION_LIST_DEFAULT_WIDTH,
  );
  const [isResizing, setIsResizing] = useState(false);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const dragStartRef = useRef({ x: 0, width: CONVERSATION_LIST_DEFAULT_WIDTH });

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

  const clampConversationListWidth = useCallback((nextWidth: number) => {
    const pageWidth = pageRef.current?.clientWidth ?? 0;
    const layoutMaxWidth =
      pageWidth > 0
        ? Math.max(
            CONVERSATION_LIST_MIN_WIDTH,
            pageWidth - CUSTOMER_DETAILS_WIDTH - CHAT_AREA_MIN_WIDTH - RESIZE_HANDLE_WIDTH,
          )
        : CONVERSATION_LIST_MAX_WIDTH;
    const maxWidth = Math.min(CONVERSATION_LIST_MAX_WIDTH, layoutMaxWidth);

    return Math.min(Math.max(nextWidth, CONVERSATION_LIST_MIN_WIDTH), maxWidth);
  }, []);

  useEffect(() => {
    const handleWindowResize = () => {
      setConversationListWidth((width) => clampConversationListWidth(width));
    };

    handleWindowResize();
    window.addEventListener("resize", handleWindowResize);
    return () => window.removeEventListener("resize", handleWindowResize);
  }, [clampConversationListWidth]);

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

  return (
    <WorkbenchPanel panelRef={pageRef}>
      <ConversationList
        conversations={MOCK_CONVERSATIONS}
        selectedId={selectedId}
        onSelect={setSelectedId}
        width={conversationListWidth}
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
          "group flex h-full w-2 shrink-0 cursor-col-resize justify-center bg-white outline-none transition-colors hover:bg-[#F8FAFC] focus-visible:bg-[#F8FAFC]",
          isResizing && "bg-[#F8FAFC]",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "h-full w-px bg-[#F3F6FA] transition-colors group-hover:bg-[#93C5FD] group-focus-visible:bg-[#60A5FA]",
            isResizing && "bg-[#60A5FA]",
          )}
        />
      </div>
      <ChatArea conversation={conversation} messages={messages} />
      <CustomerDetails customer={customer} quickReplies={MOCK_QUICK_REPLIES} />
    </WorkbenchPanel>
  );
}
