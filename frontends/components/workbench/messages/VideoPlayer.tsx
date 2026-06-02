import { useEffect, useRef } from "react";
import { Download } from "lucide-react";

import { downloadAttachment } from "@/lib/downloadAttachment";

/**
 * 独立视频预览窗的整窗内容(原生 <video> 播放器)。
 * - 实心底色容器铺满整窗,与图片预览窗底色一致(bg-workbench-surface)。
 * - 居中一个原生 <video>:自带 controls/进度条/音量,无需自造控件。
 * - src 直接用 OSS https 直链:<video> 播放不受 CORS 限制,无需走后端取字节。
 * - 尽力自动播放:WebView 自动播放策略可能拦截(.catch 静默吞掉),
 *   此时保留原生 controls 让用户手动点播。
 * - 不做缩放/平移/关闭:独立窗有系统原生关闭,播放控件原生提供。
 */
export function VideoPlayer({ src, name }: { src: string; name?: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  // 尽力自动播放;被 WebView 策略拦截时静默忽略,留原生 controls 给用户手动播放。
  useEffect(() => {
    videoRef.current?.play().catch(() => {});
  }, [src]);

  // 顶角控件统一样式:毛玻璃圆钮,描边可见,盖在背景之上(照搬 ImageLightbox 的 ctrlBtn)。
  const ctrlBtn =
    "focus-ring grid size-10 place-items-center rounded-full bg-workbench-surface/90 text-workbench-text ring-1 ring-workbench-line shadow-wb-popover transition-colors hover:bg-workbench-surface";

  return (
    <div className="fixed inset-0 bg-workbench-surface">
      {/* 视频舞台:铺满但四周留白(视频浮于底色之上),整图等比缩入、绝不裁切。 */}
      <div className="absolute inset-0 grid place-items-center overflow-hidden">
        <video
          ref={videoRef}
          src={src}
          controls
          playsInline
          preload="metadata"
          className="block max-h-[95vh] max-w-[97vw] rounded-xl"
        />
      </div>

      {/* 下载按钮固定左上:与图片预览窗布局一致。 */}
      <div className="absolute left-4 top-4 z-10">
        <button
          type="button"
          aria-label="下载"
          title="下载"
          onClick={() => void downloadAttachment(src, name)}
          className={ctrlBtn}
        >
          <Download size={18} aria-hidden />
        </button>
      </div>
    </div>
  );
}
