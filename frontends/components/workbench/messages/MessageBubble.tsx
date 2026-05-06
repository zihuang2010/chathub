import { memo } from "react";
import { AlertCircle, Check, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

import { AgentAvatar, CustomerAvatar } from "./Avatar";
import type { Message, MessageStatus } from "./data";
import { MessageContent } from "./MessageContent";
import { MessageContextMenu, type MessageActionType } from "./MessageContextMenu";
import { STRINGS } from "./strings";
import { formatMessageDateTime } from "./utils";

export interface ReplyTarget {
  senderName: string;
  text: string;
}

interface MessageBubbleProps {
  message: Message;
  avatarName: string;
  avatarColor?: string;
  account: string;
  /** Resolved data for `message.replyTo`; pass `undefined` if no reply or unresolved. */
  replyTarget?: ReplyTarget;
  onAction?: (action: MessageActionType, message: Message) => void;
}

const COMPACT_TEXT_LIMIT = 8;

// Custom equality for memo: timeline rebuilds replyTarget objects fresh each
// pass, so a reference compare would force every bubble to re-render whenever
// any sibling changes. Compare by content for replyTarget; reference compare
// for everything else (Message/onAction are stable across normal renders).
function arePropsEqual(prev: MessageBubbleProps, next: MessageBubbleProps): boolean {
  return (
    prev.message === next.message &&
    prev.avatarName === next.avatarName &&
    prev.avatarColor === next.avatarColor &&
    prev.account === next.account &&
    prev.onAction === next.onAction &&
    prev.replyTarget?.senderName === next.replyTarget?.senderName &&
    prev.replyTarget?.text === next.replyTarget?.text
  );
}

export const MessageBubble = memo(function MessageBubble({
  message,
  avatarName,
  avatarColor,
  account,
  replyTarget,
  onAction,
}: MessageBubbleProps) {
  const handleAction = onAction ?? (() => undefined);
  const isOut = message.direction === "out";

  if (message.isRecalled) {
    return <RecalledLine isOut={isOut} />;
  }

  return isOut ? (
    <OutgoingBubble
      message={message}
      account={account}
      replyTarget={replyTarget}
      onAction={handleAction}
    />
  ) : (
    <IncomingBubble
      message={message}
      avatarName={avatarName}
      avatarColor={avatarColor}
      replyTarget={replyTarget}
      onAction={handleAction}
    />
  );
}, arePropsEqual);

// ─── Recalled system line ───────────────────────────────────────────────────

function RecalledLine({ isOut }: { isOut: boolean }) {
  const label = isOut ? STRINGS.status.recalledByMe : STRINGS.status.recalledByPeer;
  return (
    <div role="status" aria-live="polite" className="flex items-center justify-center py-1.5">
      <span className="rounded-full bg-workbench-surface-subtle px-2.5 py-0.5 text-wb-3xs text-workbench-text-muted">
        {label}
      </span>
    </div>
  );
}

interface BubbleVariantProps {
  message: Message;
  replyTarget?: ReplyTarget;
  onAction: (action: MessageActionType, message: Message) => void;
}

function IncomingBubble({
  message,
  avatarName,
  avatarColor,
  replyTarget,
  onAction,
}: BubbleVariantProps & { avatarName: string; avatarColor?: string }) {
  const fullLabel = formatMessageDateTime(message.sentAt);
  const compact = isCompactText(message.text);
  return (
    <div className="flex w-full items-start gap-2 self-start">
      <CustomerAvatar name={avatarName} color={avatarColor} size="sm" />
      <div className="flex min-w-0 max-w-[min(76%,560px)] flex-col items-start">
        <MessageContextMenu message={message} onAction={onAction}>
          <article
            tabIndex={0}
            role="article"
            aria-label={`${avatarName}: ${message.text}，发送时间 ${fullLabel}`}
            className={cn(
              "group relative flex flex-col gap-1 rounded-2xl rounded-tl-md border border-workbench-bubble-in-border bg-workbench-bubble-in text-wb-xs text-workbench-text shadow-wb-bubble focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-workbench-accent/15",
              compact ? "px-3 py-1.5" : "px-3.5 py-2",
            )}
          >
            <MessageTimeTooltip label={fullLabel} align="left" />
            {replyTarget && <ReplyBlock target={replyTarget} />}
            <span className="whitespace-pre-wrap break-words">
              <MessageContent
                text={message.text}
                blocks={message.blocks}
                attachments={message.attachments}
              />
            </span>
          </article>
        </MessageContextMenu>
      </div>
    </div>
  );
}

function OutgoingBubble({
  message,
  account,
  replyTarget,
  onAction,
}: BubbleVariantProps & { account: string }) {
  const fullLabel = formatMessageDateTime(message.sentAt);
  const compact = isCompactText(message.text);
  return (
    <div className="flex w-full flex-row-reverse items-start gap-2 self-end">
      <AgentAvatar account={account} />
      <div className="flex min-w-0 max-w-[min(76%,560px)] flex-col items-end">
        <MessageContextMenu message={message} onAction={onAction}>
          <article
            tabIndex={0}
            role="article"
            aria-label={`我：${message.text}，发送时间 ${fullLabel}`}
            className={cn(
              "group relative flex flex-col gap-1 rounded-2xl rounded-tr-md border border-workbench-bubble-out-border bg-workbench-bubble-out text-wb-xs text-workbench-text shadow-wb-bubble focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-workbench-accent/15",
              compact ? "px-3 py-1.5" : "px-3.5 py-2",
            )}
          >
            <MessageTimeTooltip label={fullLabel} align="right" />
            {replyTarget && <ReplyBlock target={replyTarget} />}
            <span className="whitespace-pre-wrap break-words">
              <MessageContent
                text={message.text}
                blocks={message.blocks}
                attachments={message.attachments}
              />
            </span>
          </article>
        </MessageContextMenu>
        <StatusLine status={message.status} onResend={() => onAction("resend", message)} />
      </div>
    </div>
  );
}

function ReplyBlock({ target }: { target: ReplyTarget }) {
  return (
    <blockquote className="mb-0.5 max-w-full overflow-hidden rounded border-l-2 border-workbench-accent-soft bg-workbench-surface-subtle px-2 py-1 text-wb-2xs text-workbench-text-secondary">
      <span className="block truncate font-medium text-workbench-text">{target.senderName}</span>
      <span className="line-clamp-2 break-words">{target.text}</span>
    </blockquote>
  );
}

function StatusLine({ status, onResend }: { status?: MessageStatus; onResend: () => void }) {
  if (!status) return null;
  return (
    <div className="wb-num mt-0.5 flex items-center gap-1.5 text-wb-3xs leading-none text-workbench-text-muted/80">
      <StatusIcon status={status} />
      {status === "failed" && (
        <>
          <span className="font-medium text-workbench-danger">{STRINGS.errors.sendFailed}</span>
          <button
            type="button"
            onClick={onResend}
            title={STRINGS.errors.resend}
            className="focus-ring inline-flex items-center gap-0.5 rounded border border-workbench-danger/40 bg-workbench-danger/5 px-1.5 py-0.5 font-medium text-workbench-danger transition-colors hover:bg-workbench-danger/10"
          >
            {STRINGS.errors.resend}
          </button>
        </>
      )}
    </div>
  );
}

function StatusIcon({ status }: { status?: MessageStatus }) {
  if (!status) return null;
  switch (status) {
    case "sending":
      return (
        <Loader2
          size={11}
          className="animate-spin text-workbench-text-muted"
          aria-label={STRINGS.status.sending}
        />
      );
    case "sent":
      return (
        <Check size={12} className="text-workbench-text-muted" aria-label={STRINGS.status.sent} />
      );
    case "failed":
      return (
        <AlertCircle
          size={12}
          className="text-workbench-danger"
          aria-label={STRINGS.status.failed}
        />
      );
  }
}

export function DateDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center py-2">
      <span className="wb-num rounded-full bg-workbench-surface-subtle px-2.5 py-0.5 text-wb-3xs text-workbench-text-muted">
        {label}
      </span>
    </div>
  );
}

export function UnreadDivider({ count }: { count: number }) {
  return (
    <div className="flex items-center justify-center py-2" role="separator">
      <span className="rounded-full bg-workbench-surface-active px-2.5 py-0.5 text-wb-3xs font-medium text-workbench-accent">
        {STRINGS.status.unreadDivider(count)}
      </span>
    </div>
  );
}

function MessageTimeTooltip({ label, align }: { label: string; align: "left" | "right" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "wb-num pointer-events-none absolute -top-6 z-10 whitespace-nowrap text-wb-3xs font-medium text-workbench-text-muted opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100",
        align === "right" ? "right-0" : "left-0",
      )}
    >
      {label}
    </span>
  );
}

function isCompactText(text: string): boolean {
  return text.trim().length <= COMPACT_TEXT_LIMIT && !/\n/.test(text);
}
