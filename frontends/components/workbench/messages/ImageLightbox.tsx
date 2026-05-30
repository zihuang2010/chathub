import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Download, X } from "lucide-react";

import { STRINGS } from "./strings";

interface ImageLightboxProps {
  /** 原图 URL（https 直连）。 */
  src: string;
  /** 图片 alt 描述文字。 */
  alt: string;
  /** 关闭灯箱的回调（Esc / 点遮罩 / 关闭按钮）。 */
  onClose: () => void;
}

/**
 * 单图灯箱预览组件。
 * - 全屏黑色遮罩，居中展示原图（object-contain，不裁切）。
 * - Esc 键 / 点击遮罩关闭。
 * - 右上角：下载按钮 + 关闭按钮。
 * - role="dialog" aria-modal="true" 满足无障碍要求。
 * - 用 createPortal 挂到 document.body，不受父级 overflow:hidden 裁切。
 */
export function ImageLightbox({ src, alt, onClose }: ImageLightboxProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-6"
    >
      {/* 图片本身点击不穿透到遮罩（stopPropagation） */}
      <img
        src={src}
        alt={alt}
        onClick={(e) => e.stopPropagation()}
        className="max-h-full max-w-full rounded-lg object-contain"
      />
      {/* 右上角操作区 */}
      <div className="absolute right-4 top-4 flex gap-2" onClick={(e) => e.stopPropagation()}>
        <a
          href={src}
          download
          target="_blank"
          rel="noopener noreferrer"
          aria-label={STRINGS.attachment.download}
          className="focus-ring grid size-9 place-items-center rounded-full bg-white/15 text-white hover:bg-white/25"
        >
          <Download size={18} aria-hidden />
        </a>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭"
          className="focus-ring grid size-9 place-items-center rounded-full bg-white/15 text-white hover:bg-white/25"
        >
          <X size={18} aria-hidden />
        </button>
      </div>
    </div>,
    document.body,
  );
}
