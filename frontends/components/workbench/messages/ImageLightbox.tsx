import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Download, Loader2, X } from "lucide-react";

import { getMeasuredDims } from "./imageDimsCache";
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
 * 单图灯箱预览组件(基于 @radix-ui/react-dialog)。
 * - 全屏黑色遮罩,居中展示原图(object-contain,不裁切)。
 * - 由 Radix Dialog 提供:焦点陷阱(Tab 不逃出对话框)、Esc 关闭、关闭后焦点还原到
 *   触发它的缩略图按钮、role="dialog" aria-modal 与可访问性。
 * - 点暗区关闭(Content 背景 onClick),点图片本身不关闭(stopPropagation)。
 * - 右上角:下载按钮 + 关闭按钮。
 * - 大图加载期间显示 spinner;若 imageDimsCache 命中先撑出比例盒,避免加载完成时弹跳。
 *
 * 仅在父组件 open 时挂载,故 Dialog open 恒为 true,关闭通过 onOpenChange→onClose。
 */
export function ImageLightbox({ src, alt, onClose }: ImageLightboxProps) {
  // 灯箱仅在父组件 open 时挂载(每张图各自的 ImageAttachment 条件渲染),故每次打开都是
  // 全新实例、loaded 初始为 false,无需在 src 变化时手动复位。
  const [loaded, setLoaded] = useState(false);
  const dims = getMeasuredDims(src);

  return (
    <Dialog.Root
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 motion-reduce:animate-none" />
        <Dialog.Content
          // Radix 默认靠焦点陷阱 + 兄弟 aria-hidden 实现模态、不输出 aria-modal;
          // 这里显式补上,符合 WAI-ARIA Dialog 模式。
          aria-modal="true"
          aria-describedby={undefined}
          onClick={onClose}
          className="fixed inset-0 z-50 outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 motion-reduce:animate-none"
        >
          <Dialog.Title className="sr-only">{alt || STRINGS.attachment.video}</Dialog.Title>
          <div className="grid h-full w-full place-items-center p-6">
            <div
              className="relative grid max-h-full max-w-full place-items-center"
              onClick={(e) => e.stopPropagation()}
              style={dims ? { aspectRatio: `${dims.w} / ${dims.h}` } : undefined}
            >
              {!loaded && (
                <span className="pointer-events-none absolute inset-0 grid place-items-center">
                  <Loader2 size={28} className="animate-spin text-white/70" aria-hidden />
                </span>
              )}
              <img
                src={src}
                alt={alt}
                onLoad={() => setLoaded(true)}
                onError={() => setLoaded(true)}
                className="max-h-full max-w-full rounded-lg object-contain"
              />
            </div>
          </div>
          {/* 右上角操作区:相对 fixed inset-0 的 Content 定位在视口右上角,焦点受 Dialog 陷阱保护 */}
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
            <Dialog.Close
              type="button"
              aria-label="关闭"
              className="focus-ring grid size-9 place-items-center rounded-full bg-white/15 text-white hover:bg-white/25"
            >
              <X size={18} aria-hidden />
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
