import { memo } from "react";

import { cn } from "@/lib/utils";

import { AgentAvatar, CustomerAvatar } from "./Avatar";
import type { Message } from "./data";
import { formatMessageDateTime } from "./utils";

export const MessageBubble = memo(function MessageBubble({
  message,
  avatarName,
  avatarColor,
  account,
}: {
  message: Message;
  avatarName: string;
  avatarColor: string;
  account: string;
}) {
  return message.direction === "out" ? (
    <OutgoingBubble message={message} account={account} />
  ) : (
    <IncomingBubble message={message} avatarName={avatarName} avatarColor={avatarColor} />
  );
});

function IncomingBubble({
  message,
  avatarName,
  avatarColor,
}: {
  message: Message;
  avatarName: string;
  avatarColor: string;
}) {
  const fullLabel = formatMessageDateTime(message.sentAt);
  return (
    <div className="flex w-full items-start gap-2 self-start">
      <CustomerAvatar name={avatarName} color={avatarColor} size="sm" />
      <div className="flex min-w-0 max-w-[76%] flex-col">
        <div
          tabIndex={0}
          aria-label={`${message.text}，发送时间 ${fullLabel}`}
          className="group relative flex min-h-11 items-center rounded-md border border-workbench-line-subtle bg-white px-3.5 py-2 text-[13px] leading-[1.65] text-workbench-text shadow-[0_1px_1px_rgba(15,23,42,0.025),0_4px_12px_rgba(15,23,42,0.018)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-workbench-blue-strong/15"
        >
          <MessageTimeTooltip label={fullLabel} align="left" />
          {message.text}
        </div>
      </div>
    </div>
  );
}

function OutgoingBubble({ message, account }: { message: Message; account: string }) {
  const fullLabel = formatMessageDateTime(message.sentAt);
  return (
    <div className="flex w-full flex-row-reverse items-start gap-2 self-end">
      <AgentAvatar account={account} />
      <div className="flex min-w-0 max-w-[76%] flex-col items-end">
        <div
          tabIndex={0}
          aria-label={`${message.text}，发送时间 ${fullLabel}`}
          className="group relative flex min-h-11 items-center rounded-md border border-workbench-out-bubble-border bg-workbench-out-bubble px-3.5 py-2 text-[13px] leading-[1.65] text-workbench-text shadow-[0_1px_1px_rgba(37,99,235,0.026),0_4px_12px_rgba(37,99,235,0.018)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-workbench-blue-strong/15"
        >
          <MessageTimeTooltip label={fullLabel} align="right" />
          {message.text}
        </div>
      </div>
    </div>
  );
}

export function DateDivider({ label }: { label: string }) {
  return (
    <div className="flex justify-center py-2.5">
      <span className="font-numeric text-[12px] font-medium tabular-nums text-workbench-text-muted">
        {label}
      </span>
    </div>
  );
}

function MessageTimeTooltip({ label, align }: { label: string; align: "left" | "right" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute -top-6 z-10 whitespace-nowrap font-numeric text-[11px] font-medium tabular-nums text-workbench-text-muted opacity-0 transition-opacity duration-100 group-hover:opacity-100 group-focus-visible:opacity-100",
        align === "right" ? "right-0" : "left-0",
      )}
    >
      {label}
    </span>
  );
}
