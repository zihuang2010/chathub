import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Download, FileText, ImageOff, Pause, Play } from "lucide-react";

import { assetImageSrc } from "@/lib/assetImageSrc";
import { cachedImageSrc } from "@/lib/cachedImageSrc";
import { downloadAttachment } from "@/lib/downloadAttachment";
import { openExternal } from "@/lib/openExternal";
import { openImagePreviewWindow } from "@/lib/openImagePreviewWindow";
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

// 未知图片尺寸时的中性占位比例(偏常见横图/截图):用于尚未拿到真实宽高的首帧占位盒。
// 当前挂载周期内比例不二次收敛；真实宽高会写缓存，下一次挂载再首帧使用。
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
            // 带配文(hasInline)的图片附件铺满气泡内容宽度,与文字左对齐齐平;独占附件保持本征尺寸。
            <PartCard key={`${p.kind}-${i}`} part={p} fill={hasInline} />
          ))}
        </div>
      )}
    </>
  );
}

// ─── Attachment cards ───────────────────────────────────────────────────────

function PartCard({ part, fill }: { part: MessagePart; fill?: boolean }) {
  switch (part.kind) {
    case "image":
      return <ImageAttachment part={part} fill={fill} />;
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

function ImageAttachment({ part, fill = false }: { part: ImagePart; fill?: boolean }) {
  const [open, setOpen] = useState(false);
  const safe = isSafeUrl(part.url, "image");
  return (
    <>
      <button
        type="button"
        title={STRINGS.attachment.openImage}
        onClick={() => {
          if (!safe) return;
          // 优先在独立预览窗打开;非 Tauri 环境(返回 false)回退到应用内灯箱 Dialog。
          void openImagePreviewWindow({
            src: part.url,
            alt: STRINGS.attachment.imageAlt(part.name),
            localPath: part.localPath,
          }).then((opened) => {
            if (!opened) setOpen(true);
          });
        }}
        className={cn(
          "focus-ring cursor-pointer overflow-hidden rounded-xl align-bottom leading-none shadow-wb-bubble transition-shadow hover:shadow-wb-popover",
          // 带配文时铺满气泡宽度(随配文,封顶 360);独占图保持本征宽度上限 256。
          fill ? "block w-full" : "inline-block max-w-full",
        )}
      >
        <MessageImage
          part={part}
          alt={STRINGS.attachment.imageAlt(part.name)}
          maxW={fill ? 360 : undefined}
          maxH={fill ? 460 : undefined}
        />
      </button>
      {open && safe && (
        <ImageLightbox
          src={part.url}
          alt={STRINGS.attachment.imageAlt(part.name)}
          localPath={part.localPath}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function FileAttachment({ part }: { part: FilePart }) {
  const name = part.name ?? STRINGS.attachment.file;
  const size = formatFileSize(part.sizeBytes);
  const safe = isSafeUrl(part.url, "link");
  return (
    // 整卡不再可点:仅右侧下载按钮触发保存(另存为)。卡片本体只承载文件名/大小展示。
    <div className="flex w-72 max-w-full items-center gap-3 rounded-2xl border border-workbench-line bg-workbench-surface px-3.5 py-3 shadow-wb-bubble">
      <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-workbench-surface-soft text-workbench-accent">
        <FileText size={22} strokeWidth={1.6} aria-hidden />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-wb-xs font-medium text-workbench-text">{name}</span>
        <span className="wb-num text-wb-3xs text-workbench-text-muted">{size}</span>
      </span>
      <button
        type="button"
        disabled={!safe}
        aria-label={`${STRINGS.attachment.download} ${name}`}
        title={STRINGS.attachment.download}
        onClick={() => void downloadAttachment(part.url, part.name ?? undefined)}
        className="focus-ring grid size-8 shrink-0 place-items-center rounded-lg text-workbench-text-muted transition-colors hover:bg-workbench-surface-subtle hover:text-workbench-accent disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Download size={16} strokeWidth={1.6} aria-hidden />
      </button>
    </div>
  );
}

// WebView 原生 <audio> 能解 mp3/wav/m4a 等,但解不了企微常见的 silk。amr 走 benz-amr-recorder
// 在应用内解码播放(见下),不在此集合;silk/sil 仍无解码方案 → 外部打开。其余(含无扩展名的
// OSS 链接)乐观地在应用内 <audio> 播放,play() 失败再回退。
const WEB_UNPLAYABLE_AUDIO = new Set(["silk", "sil"]);

function audioExtension(url: string): string {
  const path = url.split(/[?#]/, 1)[0] ?? url;
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
}

// benz-amr-recorder 实例类型(默认导出类),用于 useRef 持有应用内 amr 播放器。
type BenzAMRInstance = InstanceType<typeof import("benz-amr-recorder").default>;

function VoiceAttachment({ part }: { part: VoicePart }) {
  // durationSec 缺省时,amr 解码后用 getDuration() 补一个时长用于显示;有 prop 时以 prop 为准。
  const [amrDuration, setAmrDuration] = useState(0);
  const seconds = part.durationSec ?? amrDuration;
  // Wave bar count scales with duration so a 5s voice doesn't visually claim
  // the same width as a 60s one. Cap at 18 bars for layout stability.
  const barCount = Math.min(18, Math.max(6, Math.ceil(seconds / 2)));
  const safe = isSafeUrl(part.url, "link");
  const ext = audioExtension(part.url);
  const isAmr = ext === "amr";
  // amr 走 benz 应用内解码;silk/sil 仍无解码 → 外部打开;其余(mp3/wav 等)用原生 <audio>。
  const nativePlayable = safe && !WEB_UNPLAYABLE_AUDIO.has(ext) && !isAmr;
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const amrRef = useRef<BenzAMRInstance | null>(null);
  const [playing, setPlaying] = useState(false);
  // amr 首次播放需异步取字节 + 解码,loading 期间防重复点击。
  const [loading, setLoading] = useState(false);

  // 卸载时停掉 amr 播放,避免后台残留音频。
  useEffect(() => {
    return () => {
      amrRef.current?.stop();
    };
  }, []);

  const playAmr = async () => {
    // 已有实例 → 直接切换播放/停止,无需重新取字节解码。
    const existing = amrRef.current;
    if (existing) {
      if (existing.isPlaying()) existing.stop();
      else existing.play();
      return;
    }
    if (loading) return;
    setLoading(true);
    try {
      // 默认导出是 BenzAMRRecorder 类(见 node_modules 自带 .d.ts)。
      const { default: BenzAMRRecorder } = await import("benz-amr-recorder");
      // 经后端命令取字节:JS fetch/WebAudio 直读 OSS 受 CORS 限制取不到,Tauri 命令不受此限。
      const bytes = await invoke<number[]>("fetch_media_bytes", { url: part.url });
      const amr = new BenzAMRRecorder();
      await amr.initWithBlob(new Blob([new Uint8Array(bytes)]));
      amr.onPlay(() => setPlaying(true));
      amr.onStop(() => setPlaying(false));
      amr.onEnded(() => setPlaying(false));
      // durationSec 缺省时用解码后的真实时长补显示。
      if (!part.durationSec) {
        const d = Math.round(amr.getDuration());
        if (d > 0) setAmrDuration(d);
      }
      amrRef.current = amr;
      amr.play();
    } catch {
      // 取字节/解码失败 → 回退系统播放器并复位状态。
      setPlaying(false);
      void openExternal(part.url);
    } finally {
      setLoading(false);
    }
  };

  const handleClick = () => {
    if (!safe) return;
    if (isAmr) {
      void playAmr();
      return;
    }
    const el = audioRef.current;
    if (!nativePlayable || !el) {
      // 不可解码格式(silk/sil) / 无 audio 元素 → 系统默认播放器打开。
      void openExternal(part.url);
      return;
    }
    if (el.paused) {
      void el.play().catch(() => {
        // 解码/网络失败 → 回退系统播放器。
        setPlaying(false);
        void openExternal(part.url);
      });
    } else {
      el.pause();
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        aria-label={`${STRINGS.attachment.voice} ${seconds}″`}
        className="focus-ring inline-flex items-center gap-2.5 rounded-2xl border border-workbench-line bg-workbench-surface px-3 py-2 shadow-wb-bubble transition-colors hover:bg-workbench-surface-subtle"
      >
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-workbench-accent text-white">
          {playing ? (
            <Pause size={13} strokeWidth={2} fill="currentColor" aria-hidden />
          ) : (
            <Play size={13} strokeWidth={2} fill="currentColor" aria-hidden />
          )}
        </span>
        <span
          className={cn("flex h-4 items-end gap-[2px]", playing && "animate-pulse")}
          aria-hidden
        >
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
      {nativePlayable && (
        <audio
          ref={audioRef}
          src={part.url}
          preload="none"
          className="hidden"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
        />
      )}
    </>
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
        onClick={() => {
          // 优先在独立预览窗打开;非 Tauri 环境(返回 false)回退到应用内灯箱 Dialog。
          void openImagePreviewWindow({
            src: part.url,
            alt: part.name ?? STRINGS.attachment.image,
            localPath: part.localPath,
          }).then((opened) => {
            if (!opened) setOpen(true);
          });
        }}
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
          localPath={part.localPath}
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
//   - 无宽高 → 中性 4:3 稳定占位盒
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

  // 比例盒只取挂载首帧能拿到的尺寸:后端 image_meta 注入的宽高 → 模块缓存 → 中性占位。
  // 后续 <img> onLoad 或权威重读补齐 meta 都只写缓存,不改变当前已绘制行的 aspect-ratio;
  // 这样图片不会在上滑/切会话/发送后逐张推高或塌陷列表。下一次挂载再用缓存/后端宽高首帧就位。
  const [layoutDims] = useState<{ w: number; h: number } | null>(() => {
    if (part.width && part.height) return { w: part.width, h: part.height };
    return getMeasuredDims(part.url) ?? null;
  });

  const captureNaturalDims = (img: HTMLImageElement | null) => {
    if (!img || part.width || part.height) return;
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      const dims = { w: img.naturalWidth, h: img.naturalHeight };
      rememberMeasuredDims(part.url, dims);
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
    }
    if (renderState.phase === "loading") {
      rememberLoadedImageSrc(renderState.visibleSrc);
      const visibleSrc = renderState.visibleSrc;
      queueMicrotask(() => {
        setRenderState((current) =>
          current.phase === "loading" && current.visibleSrc === visibleSrc
            ? { phase: "loaded", visibleSrc }
            : current,
        );
      });
    }
  }, [renderState, part.url, part.width, part.height]);

  const dimW = layoutDims?.w;
  const dimH = layoutDims?.h;
  const hasDims = !!(dimW && dimH);
  // 未知尺寸不再用 192 正方形(与常见宽图差异大、切换时高方块塌成矮条很跳)，
  // 而是与有 dims 盒共用同一套宽度口径(width:100% + maxWidth/maxHeight)。
  const boxStyle: React.CSSProperties = {
    aspectRatio: hasDims ? `${dimW} / ${dimH}` : NEUTRAL_IMAGE_ASPECT,
    maxWidth: maxW,
    maxHeight: maxH,
    width: "100%",
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
        className={cn(
          "block h-full w-full object-contain",
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
          data-testid="image-loading-placeholder"
          className="pointer-events-none absolute inset-0 bg-workbench-surface-soft"
        />
      )}
    </span>
  );
}
