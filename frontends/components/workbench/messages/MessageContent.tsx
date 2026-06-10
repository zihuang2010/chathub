import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Download,
  Eye,
  File as FileIcon,
  Image as ImageIcon,
  ImageOff,
  Loader2,
  MicOff,
  Pause,
  Play,
  Video,
  VideoOff,
} from "lucide-react";

import { assetImageSrc } from "@/lib/assetImageSrc";
import { cachedImageSrc } from "@/lib/cachedImageSrc";
import { downloadAttachment } from "@/lib/downloadAttachment";
import { openExternal } from "@/lib/openExternal";
import { openImagePreviewWindow } from "@/lib/openImagePreviewWindow";
import { openVideoPreviewWindow } from "@/lib/openVideoPreviewWindow";
import { cn } from "@/lib/utils";

import type { MessagePart } from "./data";
import { getMeasuredDims, rememberMeasuredDims } from "./imageDimsCache";
import { ImageLightbox } from "./ImageLightbox";
import { hasLoadedImageSrc, rememberLoadedImageSrc } from "./loadedImageSrcs";
import { STRINGS } from "./strings";
import { formatFileSize, formatRichText, isSafeUrl, thumbWidth } from "./utils";

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

// 内联部分:文本 + 标记为内联的图片(composer 富文本) + 未知消息占位(类文本提示)。
// 其余(附件图片/文件/语音/视频)走下方卡片堆叠。
function isInlinePart(p: MessagePart): boolean {
  return p.kind === "text" || p.kind === "unknown" || (p.kind === "image" && p.inline === true);
}

// 附件转存态:1=待转存(loading 占位),3=转存失败(占位),0/2/缺省=就绪正常渲染。
type TransferState = "ready" | "pending" | "failed";
function transferState(s?: number): TransferState {
  if (s === 1) return "pending";
  if (s === 3) return "failed";
  return "ready";
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
        if (p.kind === "unknown") return <UnknownRun key={key} />;
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
    case "unknown":
      return null; // text / unknown 走内联流,不会落到卡片
  }
}

function ImageAttachment({ part, fill = false }: { part: ImagePart; fill?: boolean }) {
  const [open, setOpen] = useState(false);
  const state = transferState(part.transferStatus);
  if (state === "pending") {
    // 转存中:媒体骨架——与就绪图卡同尺寸的柔色块缓慢呼吸(animate-pulse)+ 居中暗淡图片
    // 图标,不用 spinner/文字(读作"图片在来",而非"空框/出错")。盒子尺寸不变,避免布局跳动;
    // reduced-motion 下停掉呼吸退化为静态柔色块;文案降级为 aria-label 供读屏。
    return (
      <span
        role="img"
        aria-label={STRINGS.attachment.processing}
        className="grid aspect-[4/3] w-40 max-w-full animate-pulse place-items-center rounded-lg bg-workbench-surface-soft text-workbench-text-muted ring-1 ring-workbench-line motion-reduce:animate-none"
      >
        <ImageIcon size={28} strokeWidth={1.5} aria-hidden />
      </span>
    );
  }
  if (state === "failed") {
    // 转存失败:占位盒 + 失败图标/文案(真错误态,保留明确语义,不做骨架)。
    return (
      <span
        role="img"
        aria-label={STRINGS.attachment.unavailable}
        className="text-wb-3xs grid aspect-[4/3] w-40 max-w-full place-items-center rounded-lg bg-workbench-surface-soft text-workbench-text-muted ring-1 ring-workbench-line"
      >
        <span className="flex flex-col items-center gap-2">
          <ImageOff size={22} strokeWidth={1.5} aria-hidden />
          <span>{STRINGS.attachment.unavailable}</span>
        </span>
      </span>
    );
  }
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
          "focus-ring cursor-pointer overflow-hidden rounded-lg align-bottom leading-none shadow-wb-bubble transition-shadow hover:shadow-wb-popover",
          // 带配文时铺满气泡宽度(随配文,封顶 360);独占图保持本征宽度上限 256。
          fill ? "block w-full" : "inline-block max-w-full",
        )}
      >
        <MessageImage
          part={part}
          alt={STRINGS.attachment.imageAlt(part.name)}
          fill={fill}
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

// 文件扩展名 → 类型徽标渐变底色。参考 Telegram/飞书:文档蓝、表格绿、演示橙、PDF 红、
// 压缩包紫,未识别扩展名回退中性灰 + 通用文件图标。
const FILE_BADGE_GRADIENTS: Record<string, string> = {
  pdf: "from-rose-500 to-red-500",
  doc: "from-sky-500 to-blue-600",
  docx: "from-sky-500 to-blue-600",
  xls: "from-emerald-500 to-green-600",
  xlsx: "from-emerald-500 to-green-600",
  csv: "from-emerald-500 to-green-600",
  ppt: "from-amber-500 to-orange-500",
  pptx: "from-amber-500 to-orange-500",
  zip: "from-violet-500 to-purple-600",
  rar: "from-violet-500 to-purple-600",
  "7z": "from-violet-500 to-purple-600",
  txt: "from-slate-400 to-slate-500",
  md: "from-indigo-400 to-indigo-600",
  markdown: "from-indigo-400 to-indigo-600",
};

// 长扩展名 → 徽标短标签(超 4 字符放不进 40px 方块,归一为通用缩写)。
const FILE_BADGE_LABELS: Record<string, string> = {
  markdown: "MD",
};

function fileExtension(name?: string): string {
  if (!name) return "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

// 文件类型徽标:彩色渐变方块直出扩展名大写标签,作为卡片左侧的视觉锚点;
// 无扩展名/标签过长时回退通用文件图标。
function FileTypeBadge({ ext }: { ext: string }) {
  const gradient = FILE_BADGE_GRADIENTS[ext];
  const label =
    FILE_BADGE_LABELS[ext] ?? (ext.length > 0 && ext.length <= 4 ? ext.toUpperCase() : "");
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-10 shrink-0 place-items-center rounded-xl bg-gradient-to-b text-white shadow-sm",
        gradient ?? "from-slate-400 to-slate-500",
      )}
    >
      {label ? (
        <span className="text-[9.5px] font-bold leading-none tracking-wide">{label}</span>
      ) : (
        <FileIcon size={18} strokeWidth={1.8} />
      )}
    </span>
  );
}

// 文件卡外壳:18px 圆角 + 半透明毛玻璃底 + 轻阴影,hover 阴影加深(去描边的卡片感)。
const FILE_CARD_SHELL =
  "flex w-72 max-w-full items-center gap-3 rounded-[18px] bg-workbench-surface-elevated/75 px-3.5 py-3 shadow-wb-card-soft ring-1 ring-workbench-line-subtle/50 backdrop-blur-md";

function FileAttachment({ part }: { part: FilePart }) {
  const state = transferState(part.transferStatus);
  if (state !== "ready") {
    // 转存中/失败:复用文件卡外壳,左侧徽标位换 loading/失败,文案右移,保持卡片尺寸不跳。
    return (
      <div className={FILE_CARD_SHELL}>
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-workbench-surface-soft text-workbench-text-muted">
          {state === "pending" ? (
            <Loader2
              size={18}
              strokeWidth={1.6}
              className="animate-spin text-workbench-text-secondary"
              aria-hidden
            />
          ) : (
            <FileIcon size={18} strokeWidth={1.6} aria-hidden />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-wb-xs text-workbench-text-muted">
          {state === "pending" ? STRINGS.attachment.processing : STRINGS.attachment.unavailable}
        </span>
      </div>
    );
  }
  const name = part.name ?? STRINGS.attachment.file;
  const ext = fileExtension(part.name);
  const size = formatFileSize(part.sizeBytes);
  const safe = isSafeUrl(part.url, "link");
  return (
    // 整卡不可点:右侧预览/下载按钮 hover 浮现(focus-within 同步浮现保证键盘可达)。
    // 文件名是主视觉焦点,大小弱化为 10px 淡灰。
    <div className={cn(FILE_CARD_SHELL, "group transition-shadow hover:shadow-wb-card")}>
      <FileTypeBadge ext={ext} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-wb-xs font-semibold text-workbench-text">{name}</span>
        <span className="wb-num text-wb-4xs text-workbench-text-muted/80">{size}</span>
      </span>
      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100">
        <button
          type="button"
          disabled={!safe}
          aria-label={`${STRINGS.attachment.preview} ${name}`}
          title={STRINGS.attachment.preview}
          onClick={() => {
            if (safe) void openExternal(part.url);
          }}
          className="focus-ring grid size-8 place-items-center rounded-lg text-workbench-text-muted transition-colors hover:bg-workbench-surface-subtle hover:text-workbench-accent disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Eye size={16} strokeWidth={1.6} aria-hidden />
        </button>
        <button
          type="button"
          disabled={!safe}
          aria-label={`${STRINGS.attachment.download} ${name}`}
          title={STRINGS.attachment.download}
          onClick={() => void downloadAttachment(part.url, part.name ?? undefined)}
          className="focus-ring grid size-8 place-items-center rounded-lg text-workbench-text-muted transition-colors hover:bg-workbench-surface-subtle hover:text-workbench-accent disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Download size={16} strokeWidth={1.6} aria-hidden />
        </button>
      </span>
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
  const state = transferState(part.transferStatus);
  // durationSec 缺省时,amr 解码后用 getDuration() 补一个时长用于显示;有 prop 时以 prop 为准。
  const [amrDuration, setAmrDuration] = useState(0);
  const seconds = part.durationSec ?? amrDuration;
  // Wave bar count scales with duration so a 5s voice doesn't visually claim
  // the same width as a 60s one. Cap at 18 bars for layout stability.
  const barCount = Math.min(18, Math.max(6, Math.ceil(seconds / 2)));
  // 本地乐观预览(blob:/data:):刚发送、未落库前气泡用本地预览 URL(原始文件,可能是 amr,
  // webview <audio> 解不了),且 isSafeUrl(...,"link") 不放行 blob/data。此处视为可播,并统一
  // 走 benz 应用内解码(其 initWithBlob 兼解 amr 与 mp3/wav)。
  const isLocal = /^(?:blob:|data:)/i.test(part.url);
  const safe = isLocal || isSafeUrl(part.url, "link");
  const ext = audioExtension(part.url);
  const isAmr = ext === "amr";
  // silk/sil:WebView 原生 <audio> 解不了,改走 silk-wasm 应用内解码(见 playSilkInApp)。
  const isSilk = WEB_UNPLAYABLE_AUDIO.has(ext);
  // amr / 本地预览走 benz;silk 走 silk-wasm 解码;其余 http(mp3/wav 等)用原生 <audio>。
  const nativePlayable = safe && !isLocal && !WEB_UNPLAYABLE_AUDIO.has(ext) && !isAmr;
  // 下载仅对远程附件开放:本地乐观预览(blob:/data:)的原始字节后端 download_attachment 取不到,
  // 且未落库前不该让用户另存。VoicePart 无独立文件名,从 URL 末段取;无扩展名兜底 语音.<ext|amr>。
  const downloadable = !isLocal && safe;
  const voiceFileName = (() => {
    const base = decodeURIComponent(part.url.split(/[?#]/, 1)[0]?.split("/").pop() ?? "");
    return base.includes(".") ? base : `语音.${ext || "amr"}`;
  })();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const amrRef = useRef<BenzAMRInstance | null>(null);
  // silk 解码后的 WAV blob: URL,缓存避免二次点击重复取字节+解码;卸载时 revoke。
  const silkUrlRef = useRef<string | null>(null);
  const [playing, setPlaying] = useState(false);
  // amr 首次播放需异步取字节 + 解码,loading 期间防重复点击。
  const [loading, setLoading] = useState(false);
  // 未播放标记:点过播放即消失(仅本挂载周期内的视觉提示,不持久化)。
  const [hasPlayed, setHasPlayed] = useState(false);

  // 卸载时停掉 amr 播放,避免后台残留音频。
  useEffect(() => {
    return () => {
      amrRef.current?.stop();
      if (silkUrlRef.current) URL.revokeObjectURL(silkUrlRef.current);
    };
  }, []);

  // 应用内解码播放:amr / 本地预览统一走 benz(initWithBlob 兼解 amr 与 mp3/wav)。
  const playInApp = async () => {
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
      // 本地预览(blob:/data:)直接在 webview 取 Blob;远程 OSS 经后端命令取字节绕 CORS。
      const blob = isLocal
        ? await (await fetch(part.url)).blob()
        : new Blob([
            new Uint8Array(await invoke<number[]>("fetch_media_bytes", { url: part.url })),
          ]);
      const amr = new BenzAMRRecorder();
      await amr.initWithBlob(blob);
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

  // silk 应用内解码播放:取字节 → silk-wasm 解成 WAV → 复用隐藏 <audio> 播放。
  const playSilkInApp = async () => {
    const el = audioRef.current;
    if (!el) {
      void openExternal(part.url);
      return;
    }
    // 已解码过 → 直接 play/pause 切换,不重复取字节解码。
    if (silkUrlRef.current) {
      if (el.paused) void el.play().catch(() => void openExternal(part.url));
      else el.pause();
      return;
    }
    if (loading) return;
    setLoading(true);
    try {
      // 本地预览(blob:/data:)直接取 Blob;远程 OSS 经后端命令取字节绕 CORS(与 amr 同口径)。
      const bytes = isLocal
        ? new Uint8Array(await (await fetch(part.url)).arrayBuffer())
        : new Uint8Array(await invoke<number[]>("fetch_media_bytes", { url: part.url }));
      const { decodeSilkToWav } = await import("./silk");
      const { wav, durationSec } = await decodeSilkToWav(bytes);
      const url = URL.createObjectURL(wav);
      silkUrlRef.current = url;
      el.src = url;
      // durationSec 缺省时用解码时长补显示。
      if (!part.durationSec && durationSec > 0) setAmrDuration(durationSec);
      await el.play();
    } catch {
      // 取字节/解码失败(含 wasm 被 CSP 拦)→ 回退系统播放器并复位状态。
      setPlaying(false);
      void openExternal(part.url);
    } finally {
      setLoading(false);
    }
  };

  const handleClick = () => {
    if (!safe) return;
    setHasPlayed(true);
    // silk/sil:走 silk-wasm 应用内解码(自带本地/远程取字节)。放在 isLocal 前,避免极少数
    // blob: silk 误入 benz。
    if (isSilk) {
      void playSilkInApp();
      return;
    }
    // amr / 本地预览(blob/data,可能是 amr,原生 <audio> 解不了)统一走 benz 应用内解码。
    if (isAmr || isLocal) {
      void playInApp();
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

  if (state !== "ready") {
    // 转存中/失败:保持语音胶囊外形,内容换 loading/失败,避免布局跳动。
    // 注:早返回须在全部 hooks 之后,遵守 hooks 规则。
    return (
      <span
        role="img"
        aria-label={
          state === "pending" ? STRINGS.attachment.processing : STRINGS.attachment.unavailable
        }
        className="text-wb-3xs inline-flex items-center gap-2 rounded-[20px] bg-workbench-surface-soft/80 px-3 py-2 text-workbench-text-muted"
      >
        {state === "pending" ? (
          <Loader2
            size={14}
            strokeWidth={1.6}
            className="animate-spin text-workbench-text-secondary"
            aria-hidden
          />
        ) : (
          <MicOff size={14} strokeWidth={1.6} aria-hidden />
        )}
        <span>
          {state === "pending" ? STRINGS.attachment.processing : STRINGS.attachment.unavailable}
        </span>
      </span>
    );
  }

  return (
    <span className={cn("group inline-flex items-center gap-1.5", playing && "wb-voice-playing")}>
      {/* 整个胶囊即播放按钮:20px 圆角、无描边、浅蓝(accent)渐变底。整体高度对齐
          文字气泡(约 36px)。须保持为组件内第一个 button(测试以首个 button 作为播放入口)。 */}
      <button
        type="button"
        onClick={handleClick}
        aria-label={`${STRINGS.attachment.voice} ${seconds}″`}
        className="focus-ring inline-flex items-center gap-2 rounded-[20px] bg-[linear-gradient(135deg,hsl(var(--wb-accent)/0.08)_0%,hsl(var(--wb-accent)/0.18)_100%)] py-1 pl-1 pr-3 transition-shadow hover:shadow-wb-bubble active:scale-[0.99]"
      >
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-workbench-accent text-white shadow-[0_2px_8px_hsl(var(--wb-accent)/0.35)] transition-colors hover:bg-workbench-accent-hover">
          {loading ? (
            <Loader2 size={13} strokeWidth={2.2} className="animate-spin" aria-hidden />
          ) : playing ? (
            <Pause size={12} strokeWidth={2} fill="currentColor" aria-hidden />
          ) : (
            <Play
              size={12}
              strokeWidth={2}
              fill="currentColor"
              className="translate-x-px"
              aria-hidden
            />
          )}
        </span>
        {/* 波形:静止时为固有高度的蓝条;播放中由 .wb-voice-playing 驱动错峰 scaleY
            呼吸(相位走 animation-delay,reduced-motion 自动静止,见 index.css)。 */}
        <span className="flex h-[14px] items-center gap-[2.5px]" aria-hidden>
          {Array.from({ length: barCount }).map((_, i) => (
            <span
              key={i}
              className={cn(
                "wb-voice-bar w-[2.5px] rounded-full transition-colors",
                playing ? "bg-workbench-accent/80" : "bg-workbench-accent/50",
              )}
              style={{
                height: `${36 + ((i * 23 + 11) % 53)}%`,
                animationDelay: `${(i % 5) * 0.12}s`,
              }}
            />
          ))}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="wb-num text-wb-3xs text-workbench-text-muted/75">
            {STRINGS.attachment.voiceDuration(seconds)}
          </span>
          {/* 未播放提示:蓝色圆点,点过播放即消失(Telegram 习惯)。 */}
          {!hasPlayed && <span aria-hidden className="size-1.5 rounded-full bg-workbench-accent" />}
        </span>
      </button>
      {downloadable && (
        <button
          type="button"
          aria-label={`${STRINGS.attachment.download} ${STRINGS.attachment.voice}`}
          title={STRINGS.attachment.download}
          onClick={() => void downloadAttachment(part.url, voiceFileName)}
          className="focus-ring grid size-8 shrink-0 place-items-center rounded-full text-workbench-text-muted opacity-0 transition-[color,background-color,opacity] hover:bg-workbench-surface-subtle hover:text-workbench-accent focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Download size={15} strokeWidth={1.6} aria-hidden />
        </button>
      )}
      {(nativePlayable || isSilk) && (
        <audio
          ref={audioRef}
          src={nativePlayable ? part.url : undefined}
          preload="none"
          className="hidden"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
        />
      )}
    </span>
  );
}

function VideoAttachment({ part }: { part: VideoPart }) {
  // 封面截帧加载失败(非 OSS 视频 / 不支持截帧 / 解码失败)时回退灰底盒;hook 须在早返回前
  // 声明(遵守 hooks 规则)。
  const [posterFailed, setPosterFailed] = useState(false);
  const state = transferState(part.transferStatus);
  if (state === "pending") {
    // 转存中:媒体骨架——与就绪封面同尺寸(aspect-video w-64)的柔色块缓慢呼吸 + 居中暗淡视频
    // 图标,不用 spinner/文字。盒子尺寸不变,避免布局跳动;reduced-motion 下停呼吸;文案降为 aria-label。
    return (
      <span
        role="img"
        aria-label={STRINGS.attachment.processing}
        className="grid aspect-video w-64 max-w-full animate-pulse place-items-center rounded-lg bg-workbench-surface-soft text-workbench-text-muted ring-1 ring-workbench-line motion-reduce:animate-none"
      >
        <Video size={28} strokeWidth={1.5} aria-hidden />
      </span>
    );
  }
  if (state === "failed") {
    // 转存失败:占位盒 + 失败图标/文案(真错误态,保留明确语义,不做骨架)。
    return (
      <span
        role="img"
        aria-label={STRINGS.attachment.unavailable}
        className="text-wb-3xs grid aspect-video w-64 max-w-full place-items-center rounded-lg bg-workbench-surface-soft text-workbench-text-muted ring-1 ring-workbench-line"
      >
        <span className="flex flex-col items-center gap-2">
          <VideoOff size={22} strokeWidth={1.5} aria-hidden />
          <span>{STRINGS.attachment.unavailable}</span>
        </span>
      </span>
    );
  }
  // href 用 isSafeUrl(协议安全即可,括号等在 href 上下文合法)。
  const safe = isSafeUrl(part.url, "link");
  // 封面:对直链 OSS 视频用 `?x-oss-process=video/snapshot,t_1000,f_jpg` 截第 1 秒一帧 JPG 作
  // 封面渲染成真实 <img>(此前把 mp4 URL 直接当 CSS background,浏览器无法解码 → 只剩灰底)。
  // 截帧 URL 再经 cachedImageSrc 走磁盘缓存 + 本地降采样(与消息图一致,控 webview 解码内存;
  // 后端 cachedimg 是原样下载、本地缩放,不与 video/snapshot 参数冲突)。query 分隔符镜像后端
  // image_cache 约定(已有 `?` 用 `&`)。加载失败 → onError 置位回退灰底盒。
  const sep = part.url.includes("?") ? "&" : "?";
  const poster =
    isSafeUrl(part.url, "image") && !posterFailed
      ? cachedImageSrc(
          `${part.url}${sep}x-oss-process=video/snapshot,t_1000,f_jpg`,
          thumbWidth(256 * 2),
        )
      : undefined;
  return (
    <button
      type="button"
      onClick={() => {
        if (!safe) return;
        // 优先在独立预览窗打开;非 Tauri 环境(返回 false)回退到系统默认应用打开外链。
        void openVideoPreviewWindow({ src: part.url, name: part.name }).then((opened) => {
          if (!opened) void openExternal(part.url);
        });
      }}
      aria-label={STRINGS.attachment.video}
      title={STRINGS.attachment.openVideo}
      className="focus-ring relative inline-block max-w-full cursor-pointer overflow-hidden rounded-lg"
    >
      <span aria-hidden className="block aspect-video w-64 max-w-full bg-workbench-surface-active">
        {poster && (
          <img
            src={poster}
            alt=""
            aria-hidden
            loading="lazy"
            decoding="async"
            onError={() => setPosterFailed(true)}
            className="h-full w-full object-cover"
          />
        )}
      </span>
      <span
        aria-hidden
        className="absolute inset-0 grid place-items-center bg-black/15 transition-colors hover:bg-black/25"
      >
        <span className="grid size-10 place-items-center rounded-full bg-black/55 text-white">
          <Play size={20} strokeWidth={1.6} fill="currentColor" />
        </span>
      </span>
      {part.durationSec !== undefined && (
        // 视频时长徽标:右下角黑色半透明小圆角,仅在后端下发时长时显示。
        <span className="wb-num text-wb-3xs absolute bottom-1.5 right-1.5 rounded bg-black/55 px-1.5 py-0.5 text-white">
          {STRINGS.attachment.voiceDuration(part.durationSec)}
        </span>
      )}
    </button>
  );
}

// ─── Inline content ──────────────────────────────────────────────────────────

// 微信表情(收到的 [微笑] 等)内联渲染为本地打包 PNG。尺寸跟随字号、与文字基线对齐;
// alt 用原文 "[微笑]" 以便复制/读屏退化为文本。加载失败 → 回退显示原文,杜绝裂图。
function WechatEmoji({ value, src }: { value: string; src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <>{value}</>;
  return (
    <img
      src={src}
      alt={value}
      draggable={false}
      loading="lazy"
      onError={() => setFailed(true)}
      className="mx-px inline-block h-[1.25em] w-[1.25em] align-text-bottom"
    />
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
          case "emoji-image":
            return <WechatEmoji key={key} value={seg.value} src={seg.src} />;
          case "emoji":
          case "text":
            return <Fragment key={key}>{seg.value}</Fragment>;
        }
      })}
    </>
  );
}

// 未知消息占位:前端不识别的消息类型(如 messageType=99)既无文本也无可渲染附件。
// 渲染为气泡内的淡色提示行(实心信息图标 + 文案),引导用户在手机端查看原消息;沿用
// 所在气泡的 in/out 底色与排版,读作"这是一条消息,但本端暂不支持展示",而非空白/出错。
// 图标用实心圆(填充当前 muted 灰)+ 镂空白色 i,白色取面板底色随主题自适应,避免描边
// 空心图标在浅底气泡上发虚。
function UnknownRun() {
  return (
    <span className="inline-flex items-center gap-1.5 align-middle font-medium text-workbench-text-muted">
      <svg width={16} height={16} viewBox="0 0 24 24" className="shrink-0" aria-hidden>
        <circle cx="12" cy="12" r="10" fill="currentColor" />
        <circle cx="12" cy="7.8" r="1.45" fill="hsl(var(--wb-surface))" />
        <rect x="10.8" y="10.6" width="2.4" height="5.8" rx="1.2" fill="hsl(var(--wb-surface))" />
      </svg>
      {STRINGS.unknown.bubble}
    </span>
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
        className="focus-ring mx-1 inline-block cursor-pointer overflow-hidden rounded-lg align-bottom leading-none"
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
  /** 配文图:外层 block w-full、宽度确定,盒子 width:100% 铺满即可。
   *  非配文(默认):外层是 shrink-to-fit 的 inline-block,盒子须用确定 px 宽,否则解码前
   *  宽度塌成 0 → aspectRatio 算出 0 高 → 解码后弹满,造成发图首帧整列位移(文本+图+文本)。 */
  fill?: boolean;
}

type ImageRenderState =
  | { phase: "loading"; visibleSrc: string; pendingSrc?: undefined }
  | { phase: "loaded"; visibleSrc: string; pendingSrc?: undefined }
  | { phase: "transition"; visibleSrc: string; pendingSrc: string }
  | { phase: "error"; visibleSrc: string; pendingSrc?: undefined };

// data:/blob: 是已在内存、用户刚在 composer 看过的本地源(内联图 data:、托盘图 blob:):
// 字节已就绪、无网络等待 → 首帧直接判 loaded,消除「发送瞬间先闪一帧骨架」。
function isInstantSrc(src: string): boolean {
  return src.startsWith("data:") || src.startsWith("blob:");
}

function initialImageState(src: string, safe: boolean, isLocal: boolean): ImageRenderState {
  if (!safe) return { phase: "error", visibleSrc: src };
  if (isLocal || isInstantSrc(src) || hasLoadedImageSrc(src)) {
    return { phase: "loaded", visibleSrc: src };
  }
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

function MessageImage({ part, alt, maxW = 256, maxH = 320, fill = false }: MessageImageProps) {
  // 本地 asset 源（优先）
  const local = assetImageSrc(part.localPath);
  // 回退源（cachedImageSrc / 原 URL）
  const fallback = cachedImageSrc(part.url, thumbWidth(maxW * 2));
  const [useFallback, setUseFallback] = useState(false);
  const src = !useFallback && local ? local : fallback;

  // 有 localPath 且未进回退 → asset 源已同步缓存，直接 loaded；否则走 loading
  const isLocal = !useFallback && !!local;
  // 「即时源」:asset 本地缩略 + data:/blob: 内存源。都已落盘/在内存,可 eager+sync 同帧出
  // 像素;远程源(cachedimg://)才需 lazy+async 省屏外解码内存。
  const instant = isLocal || isInstantSrc(src);
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
  // 非配文图(inline-block 父级,shrink-to-fit):给盒子确定 px 宽,aspectRatio 首帧即算出
  // 高度,不依赖父级宽度/图片解码 → 消除「解码前塌成 0、解码后弹满」的发图首帧位移。
  // 宽度 = 在 maxW×maxH 内等比缩放后的真实显示宽(scale 与 virtualListSizing.estimateImageBoxHeight
  // 同式),使盒子比例严格等于图片比例。否则竖图被 maxHeight 夹住高度、盒宽仍是 maxW → 盒比图宽,
  // object-contain 透出气泡底色形成左右白边。横图本就高度受限,该式仍得 min(maxW,真实宽),宽度不变。
  // 配文图(fill)外层 block w-full 宽度本就确定,保留 width:100% 铺满气泡。
  const boxStyle: React.CSSProperties = {
    aspectRatio: hasDims ? `${dimW} / ${dimH}` : NEUTRAL_IMAGE_ASPECT,
    maxWidth: maxW,
    maxHeight: maxH,
    width:
      !fill && dimW && dimH ? Math.round(dimW * Math.min(maxW / dimW, maxH / dimH, 1)) : "100%",
  };

  if (renderState.phase === "error") {
    return (
      <span
        role="img"
        aria-label={STRINGS.attachment.imageLoadFailed}
        className="text-wb-3xs grid place-items-center rounded-lg bg-workbench-surface-soft text-workbench-text-muted ring-1 ring-workbench-line"
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
      className="relative inline-block overflow-hidden rounded-lg align-bottom ring-1 ring-workbench-line"
      style={boxStyle}
    >
      <img
        // key 锚定到 src:收敛切源(data:→cachedimg://→asset://)时,过渡态预载的隐藏 <img>
        // 已把新源解码完毕。用 src 作 key 让 React 在塌缩成单图时「复用那个已解码的元素」、
        // 卸掉旧元素,而不是原地改写可见 <img> 的 src 逼其重新解码——后者正是 WKWebView 上
        // 发图后那一下「闪」的来源(自定义协议跨元素不共享解码位图 + async 解码露白帧)。
        key={renderState.visibleSrc}
        ref={imgRef}
        src={renderState.visibleSrc}
        alt={alt}
        // 固有宽高属性:在 <img> 解码完成前就给浏览器内在尺寸,打破「inline-block 父级
        // shrink-to-fit ↔ 盒子 width:100% ↔ 等 img 解码」的循环 —— 否则解码前盒子宽塌成 0、
        // aspectRatio 算出 0 高,解码后再弹到满高,造成发图首帧整列位移(尤其文本+图+文本)。
        // 实际显示尺寸仍由下方 h-full/w-full + object-contain 决定,属性仅用于首帧占位。
        // 无尺寸时为 undefined,React 自动省略,行为不变。
        width={dimW}
        height={dimH}
        // 即时源(本地 asset 磁盘命中 / data:|blob: 内存源)→ eager + 同步解码:插入 DOM 同帧
        // 就解码出像素,消除"元素已挂载但像素未解码"的空白闪;远程回退源(cachedimg://,首次
        // 预取未完成的过渡态)仍 lazy + 异步,省屏外解码内存。
        loading={instant ? "eager" : "lazy"}
        decoding={instant ? "sync" : "async"}
        onLoad={handleVisibleLoad}
        onError={() => handleImageError(renderState.visibleSrc, "visible")}
        className={cn(
          "block h-full w-full object-contain",
          renderState.phase === "loading" && "opacity-0",
        )}
      />
      {renderState.phase === "transition" && (
        <img
          key={renderState.pendingSrc}
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
