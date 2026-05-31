import { Fragment, useLayoutEffect, useRef, useState } from "react";
import { Download, FileText, ImageOff, Play } from "lucide-react";

import { assetImageSrc } from "@/lib/assetImageSrc";
import { cachedImageSrc } from "@/lib/cachedImageSrc";
import { cn } from "@/lib/utils";

import type { MessagePart } from "./data";
import { getMeasuredDims, rememberMeasuredDims } from "./imageDimsCache";
import { ImageLightbox } from "./ImageLightbox";
import { hasLoadedImageSrc, rememberLoadedImageSrc } from "./loadedImageSrcs";
import { STRINGS } from "./strings";
import { cssUrlSafe, formatFileSize, formatRichText, isSafeUrl, thumbWidth } from "./utils";

type ImagePart = Extract<MessagePart, { kind: "image" }>;
type FilePart = Extract<MessagePart, { kind: "file" }>;
type VoicePart = Extract<MessagePart, { kind: "voice" }>;
type VideoPart = Extract<MessagePart, { kind: "video" }>;

interface MessageContentProps {
  parts: MessagePart[];
}

// 未知图片尺寸时的中性占位比例(偏常见横图/截图):用于尚未拿到真实宽高的首帧占位盒,
// 使占位与最终真实比例盒的高度差尽量小,配合 aspect-ratio transition 软化加载时的尺寸收敛。
const NEUTRAL_IMAGE_ASPECT = "4 / 3";

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
    // 单图独占大卡与附件图卡视觉/交互一致,复用同一组件(避免重复实现)。
    return <ImageAttachment part={parts[0]} />;
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
  const [open, setOpen] = useState(false);
  const safe = isSafeUrl(part.url, "image");
  return (
    <>
      <button
        type="button"
        title={STRINGS.attachment.openImage}
        onClick={() => safe && setOpen(true)}
        className="focus-ring inline-block max-w-full cursor-pointer overflow-hidden rounded-xl align-bottom leading-none shadow-wb-bubble transition-shadow hover:shadow-wb-popover"
      >
        <MessageImage part={part} alt={STRINGS.attachment.imageAlt(part.name)} />
      </button>
      {open && safe && (
        <ImageLightbox
          src={part.url}
          alt={STRINGS.attachment.imageAlt(part.name)}
          onClose={() => setOpen(false)}
        />
      )}
    </>
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
  // 视频 URL 既作链接 href 又作缩略图 CSS background。href 用 isSafeUrl(协议安全即可,
  // 括号等在 href 上下文合法);CSS background 另用 cssUrlSafe —— 协议白名单通过后再拒绝
  // CSS 元字符,并以带引号的 url("...") 形式拼接,防止可控 URL 闭合 url() 注入 CSS。
  const safe = isSafeUrl(part.url, "link");
  const coverUrl = cssUrlSafe(part.url, "link");
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
          coverUrl
            ? {
                backgroundImage: `url("${coverUrl}")`,
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
  const [open, setOpen] = useState(false);
  // 不安全 URL 不进 <img src>,渲染占位。
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
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="focus-ring mx-1 inline-block cursor-pointer overflow-hidden rounded-xl align-bottom leading-none"
      >
        <MessageImage
          part={part}
          alt={part.name ?? STRINGS.attachment.image}
          maxW={260}
          maxH={200}
        />
      </button>
      {open && (
        <ImageLightbox
          src={part.url}
          alt={part.name ?? STRINGS.attachment.image}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

// ─── 异步图片加载封装 ─────────────────────────────────────────────────────
//
// 渲染源优先级：
//   1. assetImageSrc(part.localPath)（asset 协议，WebView 可靠缓存，命中即不画骨架）
//   2. cachedImageSrc(part.url, thumbWidth(maxW * 2))（回退，保留骨架）
//
// 比例盒策略：
//   - 有宽高 → style.aspectRatio + maxW/maxH 上限 + object-contain（不裁切）
//   - 无宽高 → 固定 192×192 方盒（向后兼容）
//
// 三态（盒子恒定尺寸，零位移）：
//   loading → 骨架 overlay + 隐形 img（opacity-0）
//   loaded  → img object-contain，骨架移除
//   error   → 失败卡片，img 卸载，杜绝 broken-icon 偶现
//
// asset onError 回退：先 setUseFallback(true) → src 切换到 cachedImageSrc 重新下载

interface MessageImageProps {
  part: ImagePart;
  alt: string;
  /** 显示上限宽度（px），默认 256。 */
  maxW?: number;
  /** 显示上限高度（px），默认 320。 */
  maxH?: number;
}

type ImageRenderState =
  | { phase: "loading"; visibleSrc: string; pendingSrc?: undefined }
  | { phase: "loaded"; visibleSrc: string; pendingSrc?: undefined }
  | { phase: "transition"; visibleSrc: string; pendingSrc: string }
  | { phase: "error"; visibleSrc: string; pendingSrc?: undefined };

function initialImageState(src: string, safe: boolean, isLocal: boolean): ImageRenderState {
  if (!safe) return { phase: "error", visibleSrc: src };
  if (isLocal || hasLoadedImageSrc(src)) return { phase: "loaded", visibleSrc: src };
  return { phase: "loading", visibleSrc: src };
}

function nextImageState(
  current: ImageRenderState,
  nextSrc: string,
  safe: boolean,
  isLocal: boolean,
): ImageRenderState {
  if (!safe) return { phase: "error", visibleSrc: nextSrc };

  if (current.visibleSrc === nextSrc) {
    if (current.phase === "transition" || current.phase === "error") {
      return { phase: "loaded", visibleSrc: nextSrc };
    }
    if (hasLoadedImageSrc(nextSrc) && current.phase !== "loaded") {
      return { phase: "loaded", visibleSrc: nextSrc };
    }
    return current;
  }

  if (hasLoadedImageSrc(nextSrc)) {
    return { phase: "loaded", visibleSrc: nextSrc };
  }

  if (current.phase === "loaded" || current.phase === "transition") {
    return { phase: "transition", visibleSrc: current.visibleSrc, pendingSrc: nextSrc };
  }

  return initialImageState(nextSrc, safe, isLocal);
}

function MessageImage({ part, alt, maxW = 256, maxH = 320 }: MessageImageProps) {
  // 本地 asset 源（优先）
  const local = assetImageSrc(part.localPath);
  // 回退源（cachedImageSrc / 原 URL）
  const fallback = cachedImageSrc(part.url, thumbWidth(maxW * 2));
  const [useFallback, setUseFallback] = useState(false);
  const src = !useFallback && local ? local : fallback;

  // 有 localPath 且未进回退 → asset 源已同步缓存，直接 loaded；否则走 loading
  const isLocal = !useFallback && !!local;
  // 安全性检查基于原始 https URL，asset URL 本身是程序化生成的不需要再检查
  const safe = isSafeUrl(part.url, "image");
  const [renderState, setRenderState] = useState<ImageRenderState>(() =>
    initialImageState(src, safe, isLocal),
  );

  const [lastSource, setLastSource] = useState({ src, safe, isLocal });
  if (lastSource.src !== src || lastSource.safe !== safe || lastSource.isLocal !== isLocal) {
    setLastSource({ src, safe, isLocal });
    setRenderState(nextImageState(renderState, src, safe, isLocal));
  }

  // 首次查看(后端预取未回、part 无宽高)时，从已加载 <img> 读其固有宽高，立刻据此切比例盒——
  // 消除"固定 192 方盒 object-contain 把非方图留白边、数秒后预取回来才变原比例"的白边二段跳。
  // 缩略图保持原图纵横比，故测得比例与后端 dims 一致：预取回来时盒比例不变、零位移。
  // 重挂时(虚拟列表滚动 / 切会话)从模块缓存恢复已测宽高 → 比例盒首帧即就位,无方盒、无抖动。
  const [measuredDims, setMeasuredDims] = useState<{ w: number; h: number } | null>(
    () => getMeasuredDims(part.url) ?? null,
  );
  const captureNaturalDims = (img: HTMLImageElement | null) => {
    if (!img || part.width || part.height) return;
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      const dims = { w: img.naturalWidth, h: img.naturalHeight };
      rememberMeasuredDims(part.url, dims);
      setMeasuredDims((prev) => prev ?? dims);
    }
  };

  // 切到"看过的会话"时图片已在缓存中：useLayoutEffect 在 paint 前同步标记 loaded，
  // 骨架那一帧不会被画出（消除切会话闪烁）。缓存命中时 onLoad 可能早于监听器挂载而丢失，
  // 这里也兜底捕获固有宽高。jsdom 中 naturalWidth 恒为 0，故测试里 loading 态/方盒保持不变。
  const imgRef = useRef<HTMLImageElement | null>(null);
  useLayoutEffect(() => {
    const img = imgRef.current;
    if (!img || !img.complete || img.naturalWidth <= 0) return;
    if (!part.width && !part.height) {
      const dims = { w: img.naturalWidth, h: img.naturalHeight };
      rememberMeasuredDims(part.url, dims);
      setMeasuredDims((prev) => prev ?? dims);
    }
    if (renderState.phase === "loading") {
      rememberLoadedImageSrc(renderState.visibleSrc);
      setRenderState({ phase: "loaded", visibleSrc: renderState.visibleSrc });
    }
  }, [renderState, part.width, part.height]);

  // 比例盒尺寸源优先级：后端 image_meta 注入的原始宽高 → <img> 固有宽高(首次加载即测得) →
  // 都没有(尚未加载完)才回退中性占位比例。任一真实宽高可用即按真实比例渲染，杜绝白边 letterbox。
  const dimW = part.width ?? measuredDims?.w;
  const dimH = part.height ?? measuredDims?.h;
  const hasDims = !!(dimW && dimH);
  // 软化「先大后正常」：未知尺寸不再用 192 正方形(与常见宽图差异大、切换时高方块塌成矮条很跳)，
  // 而是与有 dims 盒共用同一套宽度口径(width:100% + maxWidth/maxHeight)，仅 aspectRatio 不同 —
  // 占位用中性 4:3(偏常见横图/截图)。这样宽度跨态恒定，只有高度变化，且用 transition 平滑收敛，
  // 把「猛跳一下」变成「轻微 ease」。首帧已有 dims(后端注入/模块缓存命中)时无前一帧、不触发过渡。
  const boxStyle: React.CSSProperties = {
    aspectRatio: hasDims ? `${dimW} / ${dimH}` : NEUTRAL_IMAGE_ASPECT,
    maxWidth: maxW,
    maxHeight: maxH,
    width: "100%",
    transition: "aspect-ratio 200ms ease",
  };

  if (renderState.phase === "error") {
    return (
      <span
        role="img"
        aria-label={STRINGS.attachment.imageLoadFailed}
        className="text-wb-3xs grid place-items-center rounded-xl bg-workbench-surface-soft text-workbench-text-muted ring-1 ring-workbench-line"
        style={boxStyle}
      >
        <span className="flex flex-col items-center gap-1.5">
          <ImageOff size={22} strokeWidth={1.5} aria-hidden />
          <span>{STRINGS.attachment.imageLoadFailed}</span>
        </span>
      </span>
    );
  }

  const handleVisibleLoad = () => {
    captureNaturalDims(imgRef.current);
    rememberLoadedImageSrc(renderState.visibleSrc);
    setRenderState((current) =>
      current.phase === "loading" && current.visibleSrc === renderState.visibleSrc
        ? { phase: "loaded", visibleSrc: renderState.visibleSrc }
        : current,
    );
  };

  const handlePendingLoad = () => {
    if (renderState.phase !== "transition") return;
    rememberLoadedImageSrc(renderState.pendingSrc);
    setRenderState((current) =>
      current.phase === "transition" && current.pendingSrc === renderState.pendingSrc
        ? { phase: "loaded", visibleSrc: renderState.pendingSrc }
        : current,
    );
  };

  const handleImageError = (erroredSrc: string, role: "visible" | "pending") => {
    if (local && erroredSrc === local) {
      setUseFallback(true);
      if (role === "visible") setRenderState(initialImageState(fallback, safe, false));
      return;
    }
    setRenderState({ phase: "error", visibleSrc: erroredSrc });
  };

  return (
    <span
      className="relative inline-block overflow-hidden rounded-xl align-bottom ring-1 ring-workbench-line"
      style={boxStyle}
    >
      <img
        ref={imgRef}
        src={renderState.visibleSrc}
        alt={alt}
        // 本地 asset 图(磁盘命中、WebView 可靠缓存)→ eager + 同步解码:重挂/切回/上滑回看
        // 时在插入 DOM 同帧就解码出像素,消除"元素已挂载但像素未解码"的空白闪;远程回退源
        // (cachedimg://,首次预取未完成的过渡态)仍 lazy + 异步,省屏外解码内存。
        loading={isLocal ? "eager" : "lazy"}
        decoding={isLocal ? "sync" : "async"}
        onLoad={handleVisibleLoad}
        onError={() => handleImageError(renderState.visibleSrc, "visible")}
        // transition-opacity:仅"真正网络首加载"(loading→loaded)时 0→1 柔和渐显,软化那一下闪;
        // 重挂/缓存命中走 loaded 态、初始即满不透明,不触发过渡 → 即时出图、不影响丝滑。
        className={cn(
          "block h-full w-full object-contain transition-opacity duration-200",
          renderState.phase === "loading" && "opacity-0",
        )}
      />
      {renderState.phase === "transition" && (
        <img
          src={renderState.pendingSrc}
          alt=""
          aria-hidden
          loading="eager"
          onLoad={handlePendingLoad}
          onError={() => handleImageError(renderState.pendingSrc, "pending")}
          className="absolute inset-0 h-full w-full object-contain opacity-0"
        />
      )}
      {renderState.phase === "loading" && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 animate-pulse bg-workbench-surface-soft"
        />
      )}
    </span>
  );
}
