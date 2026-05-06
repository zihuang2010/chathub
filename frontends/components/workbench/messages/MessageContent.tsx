import { Fragment } from "react";
import { Download, FileText, Play } from "lucide-react";

import type { MessageAttachment, MessageBlock } from "./data";
import { STRINGS } from "./strings";
import { formatFileSize, formatRichText } from "./utils";

interface MessageContentProps {
  text: string;
  blocks?: MessageBlock[];
  attachments?: MessageAttachment[];
}

/**
 * Render plain message text with inline link / mention / emoji decorations,
 * followed by any attachment cards (image / file / voice / video). Output is
 * a Fragment so it composes inside any bubble layout without introducing
 * extra block-level wrappers around the text portion.
 */
export function MessageContent({ text, blocks, attachments }: MessageContentProps) {
  if (blocks && blocks.length > 0) {
    return <BlocksContent blocks={blocks} attachments={attachments} />;
  }

  const segments = formatRichText(text);
  const hasText = text.length > 0;
  const hasAttachments = attachments && attachments.length > 0;

  return (
    <>
      {hasText &&
        segments.map((seg, i) => {
          const key = `${seg.type}-${i}`;
          switch (seg.type) {
            case "link":
              return (
                <a
                  key={key}
                  href={seg.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-workbench-accent underline-offset-2 hover:underline"
                >
                  {seg.value}
                </a>
              );
            case "mention":
              return (
                <span key={key} className="font-medium text-workbench-accent">
                  {seg.value}
                </span>
              );
            case "emoji":
              return <span key={key}>{seg.value}</span>;
            case "text":
              return <Fragment key={key}>{seg.value}</Fragment>;
          }
        })}
      {hasAttachments && (
        <div className={hasText ? "mt-2 flex flex-col gap-2" : "flex flex-col gap-2"}>
          {attachments!.map((att, i) => (
            <AttachmentCard key={`${att.type}-${i}`} attachment={att} />
          ))}
        </div>
      )}
    </>
  );
}

// ─── Attachment cards ───────────────────────────────────────────────────────

function AttachmentCard({ attachment }: { attachment: MessageAttachment }) {
  switch (attachment.type) {
    case "image":
      return <ImageAttachment attachment={attachment} />;
    case "voice":
      return <VoiceAttachment attachment={attachment} />;
    case "video":
      return <VideoAttachment attachment={attachment} />;
    case "file":
    default:
      return <FileAttachment attachment={attachment} />;
  }
}

function ImageAttachment({ attachment }: { attachment: MessageAttachment }) {
  return (
    <a
      href={attachment.url}
      target="_blank"
      rel="noopener noreferrer"
      title={STRINGS.attachment.openImage}
      className="focus-ring inline-block max-w-full overflow-hidden rounded-xl border border-workbench-line bg-workbench-surface p-1 shadow-wb-bubble transition-colors hover:bg-workbench-surface-subtle"
    >
      <img
        src={attachment.url}
        alt={STRINGS.attachment.imageAlt(attachment.name)}
        loading="lazy"
        className="block max-h-72 max-w-full rounded-lg object-contain"
      />
    </a>
  );
}

function FileAttachment({ attachment }: { attachment: MessageAttachment }) {
  const name = attachment.name ?? STRINGS.attachment.file;
  const size = formatFileSize(attachment.sizeBytes);
  return (
    <a
      href={attachment.url}
      download={attachment.name}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${STRINGS.attachment.download} ${name}`}
      className="focus-ring flex w-64 max-w-full items-center gap-2.5 rounded-xl border border-workbench-line bg-workbench-surface p-2.5 shadow-wb-bubble transition-colors hover:bg-workbench-surface-subtle"
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-workbench-surface-soft text-workbench-accent">
        <FileText size={19} strokeWidth={1.55} aria-hidden />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[12.5px] font-medium leading-[18px] text-workbench-text">
          {name}
        </span>
        <span className="font-numeric text-[11px] tabular-nums text-workbench-text-muted">
          {size}
        </span>
      </span>
      <Download
        size={14}
        strokeWidth={1.6}
        className="shrink-0 text-workbench-text-muted"
        aria-hidden
      />
    </a>
  );
}

function VoiceAttachment({ attachment }: { attachment: MessageAttachment }) {
  const seconds = attachment.durationSec ?? 0;
  // Wave bar count scales with duration so a 5s voice doesn't visually claim
  // the same width as a 60s one. Cap at 18 bars for layout stability.
  const barCount = Math.min(18, Math.max(6, Math.ceil(seconds / 2)));
  return (
    <button
      type="button"
      aria-label={`${STRINGS.attachment.voice} ${seconds}″`}
      className="focus-ring inline-flex items-center gap-2 rounded-full bg-workbench-surface-subtle px-3 py-1.5 transition-colors hover:bg-workbench-surface-active"
    >
      <Play size={14} strokeWidth={2} className="shrink-0 text-workbench-accent" aria-hidden />
      <span className="flex h-4 items-end gap-[2px]" aria-hidden>
        {Array.from({ length: barCount }).map((_, i) => (
          <span
            key={i}
            className="w-[2px] rounded-full bg-workbench-accent/60"
            style={{ height: `${30 + ((i * 17) % 70)}%` }}
          />
        ))}
      </span>
      <span className="font-numeric text-[11px] tabular-nums text-workbench-text-muted">
        {STRINGS.attachment.voiceDuration(seconds)}
      </span>
    </button>
  );
}

function VideoAttachment({ attachment }: { attachment: MessageAttachment }) {
  return (
    <a
      href={attachment.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={STRINGS.attachment.video}
      className="focus-ring relative inline-block max-w-full overflow-hidden rounded-lg"
    >
      <span
        aria-hidden
        className="block aspect-video w-64 max-w-full bg-workbench-surface-active"
        style={{
          backgroundImage: `url(${attachment.url})`,
          backgroundSize: "cover",
          backgroundPosition: "center",
        }}
      />
      <span
        aria-hidden
        className="absolute inset-0 grid place-items-center bg-black/15 transition-colors hover:bg-black/25"
      >
        <span className="grid size-10 place-items-center rounded-full bg-black/55 text-white">
          <Play size={20} strokeWidth={1.6} fill="currentColor" />
        </span>
      </span>
    </a>
  );
}

// ─── Blocks-path helpers ─────────────────────────────────────────────────────

function BlocksContent({
  blocks,
  attachments,
}: {
  blocks: MessageBlock[];
  attachments?: MessageAttachment[];
}) {
  // 「图片独占消息」判定：blocks 长度 = 1 且唯一一项为 image。命中走旧大卡样式。
  if (blocks.length === 1 && blocks[0].type === "image") {
    const only = blocks[0];
    return <ImageStandalone block={only} />;
  }

  // 否则 inline 混排；非图片附件仍走下方堆叠
  const nonImageAttachments = (attachments ?? []).filter((a) => a.type !== "image");
  return (
    <>
      {blocks.map((b, i) => {
        if (b.type === "text") return <TextRun key={i} value={b.value} />;
        return <InlineImage key={i} block={b} />;
      })}
      {nonImageAttachments.length > 0 && (
        <div className="mt-2 flex flex-col gap-2">
          {nonImageAttachments.map((att, i) => (
            <AttachmentCard key={`${att.type}-${i}`} attachment={att} />
          ))}
        </div>
      )}
    </>
  );
}

function TextRun({ value }: { value: string }) {
  const segs = formatRichText(value);
  return (
    <>
      {segs.map((seg, i) => {
        const key = `${seg.type}-${i}`;
        switch (seg.type) {
          case "link":
            return (
              <a
                key={key}
                href={seg.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-workbench-accent underline-offset-2 hover:underline"
              >
                {seg.value}
              </a>
            );
          case "mention":
            return (
              <span key={key} className="font-medium text-workbench-accent">
                {seg.value}
              </span>
            );
          case "emoji":
          case "text":
            return <Fragment key={key}>{seg.value}</Fragment>;
        }
      })}
    </>
  );
}

function InlineImage({ block }: { block: Extract<MessageBlock, { type: "image" }> }) {
  return (
    <a
      href={block.url}
      target="_blank"
      rel="noopener noreferrer"
      className="focus-ring mx-1 inline-block overflow-hidden rounded-lg align-middle ring-1 ring-workbench-line transition-shadow hover:ring-workbench-accent"
    >
      <img
        src={block.url}
        alt={block.name ?? STRINGS.attachment.image}
        className="block max-h-[200px] max-w-[260px] object-contain"
      />
    </a>
  );
}

function ImageStandalone({ block }: { block: Extract<MessageBlock, { type: "image" }> }) {
  return (
    <a
      href={block.url}
      target="_blank"
      rel="noopener noreferrer"
      title={STRINGS.attachment.openImage}
      className="focus-ring inline-block max-w-full overflow-hidden rounded-xl border border-workbench-line bg-workbench-surface p-1 shadow-wb-bubble transition-colors hover:bg-workbench-surface-subtle"
    >
      <img
        src={block.url}
        alt={STRINGS.attachment.imageAlt(block.name)}
        loading="lazy"
        className="block max-h-72 max-w-full rounded-lg object-contain"
      />
    </a>
  );
}
