import { Fragment, useState } from "react";
import { Download, FileText, ImageOff, Play } from "lucide-react";

import { cn } from "@/lib/utils";

import type { MessagePart } from "./data";
import { STRINGS } from "./strings";
import { formatFileSize, formatRichText, isSafeUrl } from "./utils";

type ImagePart = Extract<MessagePart, { kind: "image" }>;
type FilePart = Extract<MessagePart, { kind: "file" }>;
type VoicePart = Extract<MessagePart, { kind: "voice" }>;
type VideoPart = Extract<MessagePart, { kind: "video" }>;

interface MessageContentProps {
  parts: MessagePart[];
}

// 内联部分:文本 + 标记为内联的图片(composer 富文本)。其余(附件图片/文件/语音/
// 视频)走下方卡片堆叠。
function isInlinePart(p: MessagePart): boolean {
  return p.kind === "text" || (p.kind === "image" && p.inline === true);
}

/**
 * 按 parts 顺序渲染消息内容。单张图片独占 → 大卡(与服务端图片气泡视觉一致);否则
 * 内联流(文本 + 内联图片)在前、媒体卡片堆叠在后。输出 Fragment,不引入额外块级包裹。
 */
export function MessageContent({ parts }: MessageContentProps) {
  if (parts.length === 1 && parts[0].kind === "image") {
    return <ImageStandalone part={parts[0]} />;
  }

  const inlineParts = parts.filter(isInlinePart);
  const cardParts = parts.filter((p) => !isInlinePart(p));
  const hasInline = inlineParts.length > 0;

  return (
    <>
      {inlineParts.map((p, i) => {
        const key = `${p.kind}-${i}`;
        if (p.kind === "text") return <TextRun key={key} value={p.text} />;
        if (p.kind === "image") return <InlineImage key={key} part={p} />;
        return null;
      })}
      {cardParts.length > 0 && (
        <div className={hasInline ? "mt-2 flex flex-col gap-2" : "flex flex-col gap-2"}>
          {cardParts.map((p, i) => (
            <PartCard key={`${p.kind}-${i}`} part={p} />
          ))}
        </div>
      )}
    </>
  );
}

// ─── Attachment cards ───────────────────────────────────────────────────────

function PartCard({ part }: { part: MessagePart }) {
  switch (part.kind) {
    case "image":
      return <ImageAttachment part={part} />;
    case "voice":
      return <VoiceAttachment part={part} />;
    case "video":
      return <VideoAttachment part={part} />;
    case "file":
      return <FileAttachment part={part} />;
    case "text":
      return null; // text 走内联流,不会落到卡片
  }
}

function ImageAttachment({ part }: { part: ImagePart }) {
  // 不安全 URL 时去掉 href,链接不可点击;MessageImage 内部同样会落 error 态。
  const href = isSafeUrl(part.url, "image") ? part.url : undefined;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={STRINGS.attachment.openImage}
      className="focus-ring inline-block max-w-full overflow-hidden rounded-xl border border-workbench-line bg-workbench-surface p-1 shadow-wb-bubble transition-colors hover:bg-workbench-surface-subtle"
    >
      <MessageImage
        src={part.url}
        alt={STRINGS.attachment.imageAlt(part.name)}
        imgClassName="block max-h-72 max-w-full rounded-lg object-contain"
      />
    </a>
  );
}

function FileAttachment({ part }: { part: FilePart }) {
  const name = part.name ?? STRINGS.attachment.file;
  const size = formatFileSize(part.sizeBytes);
  const href = isSafeUrl(part.url, "link") ? part.url : undefined;
  return (
    <a
      href={href}
      download={part.name}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${STRINGS.attachment.download} ${name}`}
      className="focus-ring flex w-64 max-w-full items-center gap-2.5 rounded-xl border border-workbench-line bg-workbench-surface p-2.5 shadow-wb-bubble transition-colors hover:bg-workbench-surface-subtle"
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-workbench-surface-soft text-workbench-accent">
        <FileText size={19} strokeWidth={1.55} aria-hidden />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-wb-2xs font-medium text-workbench-text">{name}</span>
        <span className="wb-num text-wb-3xs text-workbench-text-muted">{size}</span>
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

function VoiceAttachment({ part }: { part: VoicePart }) {
  const seconds = part.durationSec ?? 0;
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
      <span className="wb-num text-wb-3xs text-workbench-text-muted">
        {STRINGS.attachment.voiceDuration(seconds)}
      </span>
    </button>
  );
}

function VideoAttachment({ part }: { part: VideoPart }) {
  // 视频 URL 既作链接 href 又作缩略图 CSS background。不安全时一并去掉,
  // 同时避免 url() 内的 ")" / 引号破坏 CSS 表达式。
  const safe = isSafeUrl(part.url, "link");
  return (
    <a
      href={safe ? part.url : undefined}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={STRINGS.attachment.video}
      className="focus-ring relative inline-block max-w-full overflow-hidden rounded-lg"
    >
      <span
        aria-hidden
        className="block aspect-video w-64 max-w-full bg-workbench-surface-active"
        style={
          safe
            ? {
                backgroundImage: `url(${part.url})`,
                backgroundSize: "cover",
                backgroundPosition: "center",
              }
            : undefined
        }
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

// ─── Inline content ──────────────────────────────────────────────────────────

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

function InlineImage({ part }: { part: ImagePart }) {
  // 不安全 URL 不进 <img src>,渲染占位;安全图加 lazy 减少长消息一次性全量请求。
  if (!isSafeUrl(part.url, "image")) {
    return (
      <span
        role="img"
        aria-label={STRINGS.attachment.imageLoadFailed}
        className="mx-1 inline-grid size-16 place-items-center rounded-lg bg-workbench-surface-soft align-middle text-workbench-text-muted"
      >
        <ImageOff size={18} strokeWidth={1.5} aria-hidden />
      </span>
    );
  }
  return (
    <a
      href={part.url}
      target="_blank"
      rel="noopener noreferrer"
      className="focus-ring mx-1 inline-block overflow-hidden rounded-lg align-middle ring-1 ring-workbench-line transition-shadow hover:ring-workbench-accent"
    >
      <img
        src={part.url}
        alt={part.name ?? STRINGS.attachment.image}
        loading="lazy"
        className="block max-h-[200px] max-w-[260px] object-contain"
      />
    </a>
  );
}

function ImageStandalone({ part }: { part: ImagePart }) {
  const href = isSafeUrl(part.url, "image") ? part.url : undefined;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={STRINGS.attachment.openImage}
      className="focus-ring inline-block max-w-full overflow-hidden rounded-xl border border-workbench-line bg-workbench-surface p-1 shadow-wb-bubble transition-colors hover:bg-workbench-surface-subtle"
    >
      <MessageImage
        src={part.url}
        alt={STRINGS.attachment.imageAlt(part.name)}
        imgClassName="block max-h-72 max-w-full rounded-lg object-contain"
      />
    </a>
  );
}

// ─── 异步图片加载封装 ─────────────────────────────────────────────────────
//
// 解决两类闪烁:
//   A. layout shift: `<img>` 在 load 前 0×0,load(成功/失败)后才撑高,导致整列气泡
//      位移。外层 span 用 `min-h/min-w` 把这帧空间提前占住,从 128 起步而非 0。
//   B. broken-icon 闪现: src 失败时浏览器自带的 broken-icon 出现时机不可控,且在
//      AnimatePresence fade-in 同一时间窗内,放大视觉跳变。改用本地 state +
//      onLoad / onError 自管显隐:加载中渲染骨架,失败用稳定的"图片加载失败"卡片
//      替代浏览器默认 UI。
//
// 渲染态:
//   loading → 128×128 骨架 + 隐形 img(还在 loading,不参与可见层)
//   loaded  → img 撑到自然尺寸(<= max-h-72),骨架移除
//   error   → 直接换 128×128 失败卡片,img 卸载,杜绝 broken-icon 偶现

interface MessageImageProps {
  src: string;
  alt: string;
  /** img 元素自身样式;容器尺寸由本组件管。 */
  imgClassName: string;
}

function MessageImage({ src, alt, imgClassName }: MessageImageProps) {
  // 不安全协议(javascript:/file:/data:text-html 等)直接进 error 态,绝不落到 <img src>。
  const initialState = isSafeUrl(src, "image") ? "loading" : "error";
  const [state, setState] = useState<"loading" | "loaded" | "error">(initialState);
  // src 变化(消息流刷新 / 媒体 URL 重签等)时回到 loading,杜绝旧 state 复用。
  // 用 React 推荐的"渲染期同步"模式而非 useEffect:effect 内 setState 会先用
  // 旧 state 渲染一帧再修正,reflow 已经看见。这里走 React 渲染中断重新生效路径。
  const [lastSrc, setLastSrc] = useState(src);
  if (lastSrc !== src) {
    setLastSrc(src);
    setState(isSafeUrl(src, "image") ? "loading" : "error");
  }

  if (state === "error") {
    return (
      <span
        role="img"
        aria-label={STRINGS.attachment.imageLoadFailed}
        className="grid h-32 w-32 place-items-center rounded-lg bg-workbench-surface-soft text-wb-3xs text-workbench-text-muted"
      >
        <span className="flex flex-col items-center gap-1.5">
          <ImageOff size={22} strokeWidth={1.5} aria-hidden />
          <span>{STRINGS.attachment.imageLoadFailed}</span>
        </span>
      </span>
    );
  }

  return (
    <span className="relative inline-block min-h-32 min-w-32">
      <img
        src={src}
        alt={alt}
        loading="lazy"
        onLoad={() => setState("loaded")}
        onError={() => setState("error")}
        className={cn(imgClassName, state !== "loaded" && "opacity-0")}
      />
      {state === "loading" && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 animate-pulse rounded-lg bg-workbench-surface-soft"
        />
      )}
    </span>
  );
}
