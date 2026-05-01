import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { ChatHeader } from "./ChatHeader";
import { COMPOSER_DEFAULT_HEIGHT } from "./constants";
import type { Conversation, Message } from "./data";
import { DateDivider, MessageBubble } from "./MessageBubble";
import { MessageComposer } from "./MessageComposer";
import { RangePill } from "./RangePill";
import { formatMessageDate } from "./utils";
import { type ScrollMetrics, WorkbenchScrollArea } from "./WorkbenchScrollArea";

interface ChatAreaProps {
  conversation: Conversation;
  messages: Message[];
  accountOptions: string[];
  selectedAccount: string | null;
  onAccountChange: (account: string | null) => void;
  detailsOpen: boolean;
  onToggleDetails: () => void;
}

type TimelineItem =
  | { type: "date-divider"; id: string; label: string }
  | { type: "message"; id: string; message: Message };

function buildTimelineItems(messages: Message[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  let previousDate: string | null = null;

  for (const message of messages) {
    const dateLabel = formatMessageDate(message.sentAt);
    if (dateLabel !== previousDate) {
      items.push({ type: "date-divider", id: `date-${dateLabel}-${message.id}`, label: dateLabel });
      previousDate = dateLabel;
    }
    items.push({ type: "message", id: message.id, message });
  }

  return items;
}

export const ChatArea = memo(function ChatArea({
  conversation,
  messages,
  accountOptions,
  selectedAccount,
  onAccountChange,
  detailsOpen,
  onToggleDetails,
}: ChatAreaProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const wasAtBottomRef = useRef(true);
  const [composerHeight, setComposerHeight] = useState(COMPOSER_DEFAULT_HEIGHT);
  const timelineItems = useMemo(() => buildTimelineItems(messages), [messages]);

  // Track whether the user is parked at the bottom; we piggyback on the metrics
  // the scrollbar already computes — no separate scroll listener / layout read.
  const handleScrollMetrics = useCallback((m: ScrollMetrics) => {
    wasAtBottomRef.current = m.atBottom;
  }, []);

  // Switching conversations always jumps to the latest message.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
    wasAtBottomRef.current = true;
  }, [conversation.id]);

  // New messages only pull the view down when the user was already at bottom.
  useEffect(() => {
    if (!wasAtBottomRef.current) return;
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [messages.length]);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-white">
      <ChatHeader conversation={conversation} />
      <RangePill
        accountOptions={accountOptions}
        selectedAccount={selectedAccount}
        onAccountChange={onAccountChange}
      />
      <WorkbenchScrollArea
        scrollRef={scrollRef}
        onScrollMetrics={handleScrollMetrics}
        className="flex-1 bg-white"
        viewportClassName="bg-white px-4 py-5 pr-6"
        contentClassName="flex w-full flex-col gap-4"
      >
        {timelineItems.map((item) =>
          item.type === "date-divider" ? (
            <DateDivider key={item.id} label={item.label} />
          ) : (
            <MessageBubble
              key={item.id}
              message={item.message}
              avatarName={conversation.name}
              avatarColor={conversation.avatarColor}
              account={conversation.account}
            />
          ),
        )}
      </WorkbenchScrollArea>
      {/* `key` resets the Composer's local draft when the conversation changes. */}
      <MessageComposer
        key={conversation.id}
        height={composerHeight}
        onHeightChange={setComposerHeight}
        detailsOpen={detailsOpen}
        onToggleDetails={onToggleDetails}
      />
    </div>
  );
});
