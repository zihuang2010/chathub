import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Download, Loader2, Minus, Plus, X } from "lucide-react";

import { assetImageSrc } from "@/lib/assetImageSrc";
import { cachedImageSrc } from "@/lib/cachedImageSrc";
import { downloadAttachment } from "@/lib/downloadAttachment";
import { cn } from "@/lib/utils";

import { STRINGS } from "./strings";

/** 高清显示宽度(px):cachedimg 上限 2560、只缩不放,取近原图清晰度。 */
const LIGHTBOX_W = 2048;
/** 占位图宽度(px):与气泡缩略图同一档,通常已落盘 → 瞬显,先糊后清(blur-up)。 */
const PLACEHOLDER_W = 512;
/** 最大放大倍数。 */
const MAX_SCALE = 5;

/** 从 alt(优先,非空)或 src 的 path basename(去 query/hash)推导下载文件名。 */
function deriveFileName(alt: string, src: string): string | undefined {
  if (alt.trim()) return alt;
  try {
    const base = new URL(src).pathname.split("/").pop();
    return base ? decodeURIComponent(base) : undefined;
  } catch {
    const base = src.split(/[?#]/)[0]?.split("/").pop();
    return base || undefined;
  }
}

interface ImageLightboxProps {
  /** 原图 URL(https 直连):高清源与下载源。 */
  src: string;
  /** 图片 alt 描述文字。 */
  alt: string;
  /** 已缓存缩略图本地绝对路径(asset:// 瞬显占位),由后端 image_meta 注入,可缺省。 */
  localPath?: string;
  /** 关闭灯箱的回调(Esc / 点遮罩 / 关闭按钮)。 */
  onClose: () => void;
  /** 是否显示右上角关闭按钮。缺省 true;独立预览窗有系统原生关闭(标题栏),传 false 去重。 */
  showClose?: boolean;
  /** 独立预览窗(整窗看图)传 true,图片近铺满窗口、减少四周留白;缺省 false 保持应用内灯箱浮于暗区的留白。 */
  fill?: boolean;
}

/**
 * 单图灯箱预览(基于 @radix-ui/react-dialog)。专业看图器交互:
 * - 层级 z-[1000]:盖过 TitleBar(z-[100]) 等应用层,否则顶部控件会被标题栏/拖拽区吞掉点击。
 * - 居中浮层:图片四周留足暗区(模糊背景上的一张"浮起照片"),点暗区任意处即可关闭。
 * - 渐进加载:先用已缓存缩略图瞬显(blur-up),后台拉高清,就绪后无闪切换 —— 消除等整图下载的卡顿。
 * - 缩放/平移:滚轮(向光标)、双击、底部 ±/百分比、键盘 +/-/0;放大后可拖拽平移。
 * - 关闭:右上角关闭按钮(showClose=true 时;独立预览窗用系统原生关闭故隐藏) / Esc / 点图片以外的暗区。点图片本身不关闭(stopPropagation)。
 *
 * 仅在父组件 open 时挂载,每次打开都是全新实例、状态从初值开始,无需手动复位。
 */
export function ImageLightbox({
  src,
  alt,
  localPath,
  onClose,
  showClose = true,
  fill = false,
}: ImageLightboxProps) {
  // 渐进加载:displaySrc 在高清就绪前显示占位(本地 asset 或 512 缓存,几乎瞬时)。
  const placeholderSrc = assetImageSrc(localPath) ?? cachedImageSrc(src, PLACEHOLDER_W);
  const [hiSrc, setHiSrc] = useState(() => cachedImageSrc(src, LIGHTBOX_W));
  const [hiResReady, setHiResReady] = useState(false);
  const [baseLoaded, setBaseLoaded] = useState(false);
  const displaySrc = hiResReady ? hiSrc : placeholderSrc;

  // 缩放/平移视图状态:scale 倍数 + (tx,ty) 平移(px,相对舞台中心)。
  const [view, setView] = useState({ scale: 1, tx: 0, ty: 0 });
  const [dragging, setDragging] = useState(false);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  const clamp = (s: number) => Math.min(MAX_SCALE, Math.max(1, s));
  const reset = () => setView({ scale: 1, tx: 0, ty: 0 });

  // 以视口某点(光标/舞台中心)为锚缩放:缩放后保持该点在图上的位置不动。
  const zoomAt = (clientX: number, clientY: number, factor: number) => {
    const stage = stageRef.current;
    if (!stage) return;
    const r = stage.getBoundingClientRect();
    const cx = clientX - r.left - r.width / 2;
    const cy = clientY - r.top - r.height / 2;
    setView((v) => {
      const next = clamp(v.scale * factor);
      if (next <= 1) return { scale: 1, tx: 0, ty: 0 };
      const ratio = next / v.scale;
      return { scale: next, tx: cx - (cx - v.tx) * ratio, ty: cy - (cy - v.ty) * ratio };
    });
  };
  const zoomCenter = (factor: number) => {
    const stage = stageRef.current;
    if (!stage) return;
    const r = stage.getBoundingClientRect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
  };

  // 滚轮缩放:React onWheel 默认 passive,无法 preventDefault;用原生 non-passive 监听。
  // zoomAt 只依赖 ref + 函数式 setView,不闭包过期状态,故一次性挂载即可。
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    if (view.scale <= 1) return; // 仅放大后允许拖拽平移
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setView((v) => ({ ...v, tx: d.tx + (e.clientX - d.x), ty: d.ty + (e.clientY - d.y) }));
  };
  const endDrag = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      zoomCenter(1.4);
    } else if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      zoomCenter(1 / 1.4);
    } else if (e.key === "0") {
      e.preventDefault();
      reset();
    }
    // Esc 交给 Radix Dialog 处理
  };

  const zoomed = view.scale > 1;
  const title = alt || STRINGS.attachment.image;
  // 顶角控件统一样式:毛玻璃圆钮,描边可见,盖在背景之上。
  const ctrlBtn =
    "focus-ring grid size-10 place-items-center rounded-full bg-workbench-surface/90 text-workbench-text ring-1 ring-workbench-line shadow-wb-popover transition-colors hover:bg-workbench-surface";

  return (
    <Dialog.Root
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <Dialog.Portal>
        {/* z-[1000] 与应用 Modal 一致,盖过 TitleBar(z-[100]);毛玻璃暗化但非纯黑、亮暗自适应。 */}
        <Dialog.Overlay className="fixed inset-0 z-[1000] bg-workbench-surface/70 backdrop-blur-xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 motion-reduce:animate-none" />
        <Dialog.Content
          // Radix 默认靠焦点陷阱 + 兄弟 aria-hidden 实现模态、不输出 aria-modal;显式补上。
          aria-modal="true"
          aria-describedby={undefined}
          onClick={onClose}
          onKeyDown={onKeyDown}
          className="fixed inset-0 z-[1000] outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 motion-reduce:animate-none"
        >
          <Dialog.Title className="sr-only">{title}</Dialog.Title>

          {/* 高清预加载:就绪后把可见图切到高清(已在缓存,切换无闪);失败回退原始直连源。 */}
          <img
            src={hiSrc}
            alt=""
            aria-hidden
            className="hidden"
            onLoad={() => setHiResReady(true)}
            onError={() => {
              if (hiSrc !== src) setHiSrc(src);
            }}
          />

          {/* 图片舞台:铺满但四周留白(图片浮于暗区);点图片以外的暗区冒泡到 Content → 关闭。 */}
          <div ref={stageRef} className="absolute inset-0 grid place-items-center overflow-hidden">
            {!baseLoaded && (
              <span className="pointer-events-none absolute inset-0 grid place-items-center">
                <Loader2 size={30} className="animate-spin text-workbench-text-muted" aria-hidden />
              </span>
            )}
            <div
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => (zoomed ? reset() : zoomAt(e.clientX, e.clientY, 2))}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              style={{
                transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`,
                transition: dragging ? "none" : "transform 0.16s ease-out",
                cursor: zoomed ? (dragging ? "grabbing" : "grab") : "zoom-in",
              }}
              className="touch-none"
            >
              <img
                src={displaySrc}
                alt={alt}
                draggable={false}
                onLoad={() => setBaseLoaded(true)}
                onError={() => setBaseLoaded(true)}
                // 视口单位封顶:相对舞台/包裹层是 auto,百分比 max 会失效;用 vh/vw 才是确定参照 → 整图等比缩入、绝不裁切。放大时 transform 溢出再由舞台 overflow-hidden 裁。
                className={cn(
                  "block select-none rounded-xl object-contain",
                  // 独立预览窗近铺满(95vh/97vw);应用内灯箱保持浮于暗区的留白(88vh/90vw)。
                  fill ? "max-h-[95vh] max-w-[97vw]" : "max-h-[88vh] max-w-[90vw]",
                  // blur-up:高清就绪前对占位图轻微模糊,切到高清时移除。
                  !hiResReady && "blur-[1.5px]",
                )}
              />
            </div>
          </div>

          {/* 关闭按钮固定右上(showClose):避开 mac 左上系统关闭;独立预览窗有原生关闭故隐藏去重。stopPropagation 防误关。 */}
          {showClose && (
            <div onClick={(e) => e.stopPropagation()} className="absolute right-4 top-4 z-10">
              <Dialog.Close type="button" aria-label="关闭" className={ctrlBtn}>
                <X size={18} aria-hidden />
              </Dialog.Close>
            </div>
          )}

          {/* 下载按钮放左上,与关闭分居两侧,互不挤压。 */}
          <div onClick={(e) => e.stopPropagation()} className="absolute left-4 top-4 z-10">
            <button
              type="button"
              aria-label={STRINGS.attachment.download}
              title={STRINGS.attachment.download}
              onClick={() => void downloadAttachment(src, deriveFileName(alt, src))}
              className={ctrlBtn}
            >
              <Download size={18} aria-hidden />
            </button>
          </div>

          {/* 底部居中缩放控制条 */}
          <div
            onClick={(e) => e.stopPropagation()}
            className="absolute bottom-5 left-1/2 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-full bg-workbench-surface/90 px-1.5 py-1 shadow-wb-popover ring-1 ring-workbench-line"
          >
            <button
              type="button"
              aria-label="缩小"
              onClick={() => zoomCenter(1 / 1.4)}
              disabled={!zoomed}
              className="focus-ring grid size-8 place-items-center rounded-full text-workbench-text transition-colors hover:bg-workbench-surface-subtle disabled:opacity-40"
            >
              <Minus size={16} aria-hidden />
            </button>
            <button
              type="button"
              onClick={reset}
              title="重置缩放"
              className="focus-ring wb-num min-w-[3.5rem] rounded-full px-2 py-1 text-center text-wb-2xs font-medium text-workbench-text-secondary transition-colors hover:bg-workbench-surface-subtle"
            >
              {Math.round(view.scale * 100)}%
            </button>
            <button
              type="button"
              aria-label="放大"
              onClick={() => zoomCenter(1.4)}
              disabled={view.scale >= MAX_SCALE}
              className="focus-ring grid size-8 place-items-center rounded-full text-workbench-text transition-colors hover:bg-workbench-surface-subtle disabled:opacity-40"
            >
              <Plus size={16} aria-hidden />
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
