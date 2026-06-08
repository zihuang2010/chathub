import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

import { computeCropRect, normalizeDisplayRect } from "./screenshotCrop";
import type { ImageBox, Point } from "./screenshotCrop";
import { STRINGS } from "./strings";

interface Props {
  /** 整屏截图的 data URL(后端 read_screenshot_file 返回的 base64 拼成)。 */
  src: string;
  /** 框选确认后回传裁剪好的 PNG 文件。 */
  onConfirm: (file: File) => void;
  /** 取消(点取消 / Esc / 无选区点确认时不触发)。 */
  onCancel: () => void;
}

// 选区小于该渲染像素阈值视为「没框」,确认按钮禁用——避免误点产生 1px 截图。
const MIN_SELECTION_PX = 4;

/**
 * 区域截图框选遮罩:全窗显示整屏截图,拖框选区后用 canvas 裁出局部 PNG。
 * 仅用于 Windows/Linux —— 原生插件只能抓整屏,框选裁剪在这里补齐(macOS 仍用系统 screencapture 框选)。
 * 图片走 data URL(同源),canvas 不会被跨域污染,toBlob 可正常导出。
 */
export function ScreenshotCropOverlay({ src, onConfirm, onCancel }: Props) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [imgBox, setImgBox] = useState<ImageBox | null>(null);
  const [drag, setDrag] = useState<{ start: Point; cur: Point } | null>(null);

  const display = drag && imgBox ? normalizeDisplayRect(drag.start, drag.cur, imgBox) : null;
  // 读数显示实际输出像素(自然尺寸),比渲染像素更贴近用户最终拿到的图。
  const crop =
    drag && imgBox && natural
      ? computeCropRect(drag.start, drag.cur, imgBox, natural.w, natural.h)
      : null;
  const hasSelection =
    !!display && display.width >= MIN_SELECTION_PX && display.height >= MIN_SELECTION_PX;

  const confirm = useCallback(() => {
    const img = imgRef.current;
    if (!img || !drag || !imgBox || !natural) return;
    const crop = computeCropRect(drag.start, drag.cur, imgBox, natural.w, natural.h);
    if (crop.sw < 1 || crop.sh < 1) return;
    const canvas = document.createElement("canvas");
    canvas.width = crop.sw;
    canvas.height = crop.sh;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(img, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.sw, crop.sh);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      onConfirm(new File([blob], `screenshot-${stamp}.png`, { type: "image/png" }));
    }, "image/png");
  }, [drag, imgBox, natural, onConfirm]);

  // Esc 取消 / Enter 确认。挂 window 级监听,遮罩期间独占这两个键。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        confirm();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, confirm]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const img = imgRef.current;
    if (!img) return;
    const rect = img.getBoundingClientRect();
    // 拖拽期间图片不动,按下时锁定一次 imgBox 即可,后续 move 不再读 DOM。
    setImgBox({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    const p = { x: e.clientX, y: e.clientY };
    setDrag({ start: p, cur: p });
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    setDrag((d) => (d ? { start: d.start, cur: { x: e.clientX, y: e.clientY } } : d));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // 指针已释放,忽略
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-black/70">
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <div
          className="relative inline-block select-none leading-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          <img
            ref={imgRef}
            src={src}
            alt=""
            draggable={false}
            onLoad={(e) =>
              setNatural({
                w: e.currentTarget.naturalWidth,
                h: e.currentTarget.naturalHeight,
              })
            }
            className="block max-h-[82vh] max-w-full cursor-crosshair rounded"
          />
          {display && (
            // boxShadow 大扩散把选区外整片压暗,选区内保持原图——单元素实现「暗化遮罩+亮选区」。
            <div
              className="pointer-events-none absolute border-2 border-sky-400"
              style={{
                left: display.left,
                top: display.top,
                width: display.width,
                height: display.height,
                boxShadow: "0 0 0 9999px rgba(0,0,0,0.5)",
              }}
            />
          )}
        </div>
      </div>
      <div className="flex items-center justify-center gap-3 pb-6">
        <div className="flex items-center gap-4 rounded-full bg-background/95 px-5 py-2 shadow-lg">
          <span className="text-sm text-muted-foreground">
            {hasSelection && crop
              ? STRINGS.composer.screenshotCropSize(crop.sw, crop.sh)
              : STRINGS.composer.screenshotCropHint}
          </span>
          <Button variant="secondary" size="sm" onClick={onCancel}>
            {STRINGS.composer.screenshotCropCancel}
          </Button>
          <Button size="sm" onClick={confirm} disabled={!hasSelection}>
            {STRINGS.composer.screenshotCropConfirm}
          </Button>
        </div>
      </div>
    </div>
  );
}
