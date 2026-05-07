import { memo } from "react";
import { Loader2 } from "lucide-react";

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

function messageAriaText(message: Message): string {
  const blockImageCount = message.blocks?.filter((b) => b.type === "image").length ?? 0;
  const attachmentImageCount = message.attachments?.filter((a) => a.type === "image").length ?? 0;
  const imageCount = blockImageCount + attachmentImageCount;
  const trimmed = message.text.trim();
  if (imageCount === 0) return message.text;
  return trimmed ? `${trimmed}（含 ${imageCount} 张图片）` : `（含 ${imageCount} 张图片）`;
}

// Custom equality for memo: timeline rebuilds replyTarget objects fresh each
// pass, so a reference compare would force every bubble to re-render whenever
// any sibling changes. Compare by content for replyTarget; reference compare
// for everything else (Message/onAction are stable across normal renders).
//
// ⚠️ 这里依赖**消息以 immutable update 的方式更新**——`current.map(m =>
// m.id === id ? {...m, status: "sent"} : m)` 会产生新引用，prev.message ===
// next.message 才能正确判断变化。如果未来贡献者用 in-place mutation
// （如 `message.status = "sent"`），这里会静默漏更新，气泡 UI 不会刷新。
// 维护规约：messages 数组中的 Message 对象一旦发出，不允许直接 mutate；
// 必须用对象展开重建。
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
            aria-label={`${avatarName}: ${messageAriaText(message)}，发送时间 ${fullLabel}`}
            className={cn(
              "group relative flex flex-col gap-1 rounded-2xl rounded-tl-md bg-workbench-bubble-in text-[13.5px] font-[450] leading-[1.65] text-workbench-text shadow-wb-bubble ring-1 ring-workbench-bubble-in-border/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-workbench-accent/40",
              compact ? "px-3.5 py-2" : "px-4 py-2.5",
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
      <div className="relative flex min-w-0 max-w-[min(76%,560px)] flex-col items-end">
        <MessageContextMenu message={message} onAction={onAction}>
          <article
            tabIndex={0}
            role="article"
            aria-label={`我：${messageAriaText(message)}，发送时间 ${fullLabel}`}
            className={cn(
              "group relative flex flex-col gap-1 rounded-2xl rounded-tr-md bg-workbench-bubble-out text-[13.5px] font-[450] leading-[1.65] text-workbench-text shadow-wb-bubble ring-1 ring-workbench-bubble-out-border/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-workbench-accent/40",
              compact ? "px-3.5 py-2" : "px-4 py-2.5",
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
    <blockquote className="mb-1 flex max-w-full gap-2 text-wb-2xs leading-relaxed text-workbench-text-secondary">
      <span
        aria-hidden
        className="w-[2px] shrink-0 self-stretch rounded-full bg-workbench-accent/40"
      />
      <div className="min-w-0 flex-1">
        <div className="truncate">{target.senderName}：</div>
        <div className="line-clamp-2 break-words">{target.text}</div>
      </div>
    </blockquote>
  );
}

function StatusLine({ status, onResend }: { status?: MessageStatus; onResend: () => void }) {
  // "sent" used to render a tick — product wants no read-receipt UI, so the
  // status line is only meaningful while in-flight or after a failure.
  if (!status || status === "sent") return null;
  // Sending is transient (~800ms) and used to push the bubble's column up by
  // ~16px when the status flipped to "sent" — visible as a screen jump. Float
  // the spinner out of layout so the column height never changes.
  if (status === "sending") {
    return (
      <div
        aria-live="polite"
        className="pointer-events-none absolute right-0 top-full mt-1 flex items-center text-wb-3xs leading-none text-workbench-text-muted/80"
      >
        <StatusIcon status={status} />
      </div>
    );
  }
  return (
    <div className="wb-num mt-1 flex items-center gap-1.5 text-wb-3xs leading-none text-workbench-text-muted/80">
      <StatusIcon status={status} />
      <span className="font-medium text-workbench-text-muted">{STRINGS.errors.sendFailed}</span>
      <button
        type="button"
        onClick={onResend}
        title={STRINGS.errors.resend}
        className="focus-ring rounded font-medium text-workbench-accent transition-colors hover:text-workbench-accent-hover"
      >
        {STRINGS.errors.resend}
      </button>
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
    case "failed":
      return <FailedBadge />;
    default:
      return null;
  }
}

// Inline filled-circle "!" badge — designed at 12px so the mark reads crisply
// without the optical mush of lucide's AlertCircle outline at small sizes.
// Uses the softer coral red (workbench-unread) instead of saturated danger red
// to fit the pastel surface palette without losing the warning semantic.
function FailedBadge() {
  return (
    <svg
      role="img"
      aria-label={STRINGS.status.failed}
      viewBox="0 0 12 12"
      className="size-3 shrink-0 text-workbench-unread"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="6" cy="6" r="6" fill="currentColor" />
      <rect x="5.4" y="2.9" width="1.2" height="3.7" rx="0.6" fill="white" />
      <circle cx="6" cy="8.7" r="0.85" fill="white" />
    </svg>
  );
}

export function DateDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center py-2">
      <span className="wb-num rounded-full bg-workbench-surface-subtle px-2.5 py-0.5 text-wb-3xs font-medium text-workbench-text-muted">
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
        "wb-num pointer-events-none absolute -top-5 z-10 whitespace-nowrap text-wb-3xs font-medium leading-none text-workbench-text-muted opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100",
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
