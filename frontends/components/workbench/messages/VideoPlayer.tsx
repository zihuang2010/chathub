import { useEffect, useRef, useState } from "react";
import { Download, VideoOff } from "lucide-react";

import { downloadAttachment } from "@/lib/downloadAttachment";
import { openExternal } from "@/lib/openExternal";
import { isWindows } from "@/lib/platform";

/**
 * 独立视频预览窗的整窗内容(原生 <video> 播放器)。
 * - 毛玻璃背景:同源视频静音循环、放大模糊作氛围铺底,再叠半透明玻璃层(与图片预览窗的毛玻璃观感一致)。
 * - 居中一个原生 <video>:自带 controls/进度条/音量,无需自造控件,浮于毛玻璃之上。
 * - src 直接用 OSS https 直链:<video> 播放不受 CORS 限制,无需走后端取字节。
 * - 尽力自动播放:WebView 自动播放策略可能拦截(.catch 静默吞掉),
 *   此时保留原生 controls 让用户手动点播。
 * - 不做缩放/平移/关闭:独立窗有系统原生关闭,播放控件原生提供。
 * - Windows 兼容:WebView2(Chromium)解不了 HEVC/H.265 等编码(Mac WKWebView 走
 *   AVFoundation 都能播),失败时 <video> 静默空白 → 整窗只剩底色像"白屏"。
 *   故 onError 转明确错误占位 + 「用系统播放器打开」兜底;同时 Windows 不渲染氛围
 *   铺底视频(同 src 第二路解码 + 全窗大模糊,弱 GPU/受限硬解机器是渲染异常源)。
 */
export function VideoPlayer({ src, name }: { src: string; name?: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  // 主视频加载/解码失败(编码不支持、链接失效等);父组件 key={src} 换源时自动复位。
  const [failed, setFailed] = useState(false);

  // 尽力自动播放;被 WebView 策略拦截时静默忽略,留原生 controls 给用户手动播放。
  useEffect(() => {
    videoRef.current?.play().catch(() => {});
  }, [src]);

  // 顶角控件统一样式:毛玻璃圆钮,描边可见,盖在背景之上(照搬 ImageLightbox 的 ctrlBtn)。
  const ctrlBtn =
    "focus-ring grid size-10 place-items-center rounded-full bg-workbench-surface/90 text-workbench-text ring-1 ring-workbench-line shadow-wb-popover transition-colors hover:bg-workbench-surface";

  return (
    <div className="fixed inset-0 overflow-hidden bg-workbench-surface">
      {/* 氛围铺底:同源视频静音循环、放大模糊作毛玻璃底图(纯装饰、不可交互、不入 Tab)。
          静音自动播放符合 WebView 策略;同源 URL 多走 HTTP 缓存,不另发请求。
          Windows 不渲染:WebView2 下这是同 src 的第二路解码 + 全窗 44px 模糊 + backdrop
          双重合成,弱 GPU/硬解会话受限的机器会整窗渲染异常(白屏),纯色托底即可。 */}
      {!isWindows && !failed && (
        <>
          <video
            src={src}
            muted
            loop
            autoPlay
            playsInline
            aria-hidden
            tabIndex={-1}
            className="pointer-events-none absolute inset-0 h-full w-full scale-110 object-cover opacity-80 blur-[44px]"
          />
          {/* 半透明玻璃层:叠在氛围底图之上,营造毛玻璃质感(底色降透 + 背景虚化)。 */}
          <div aria-hidden className="absolute inset-0 bg-workbench-surface/55 backdrop-blur-2xl" />
        </>
      )}

      {/* 视频舞台:铺满但四周留白(视频浮于毛玻璃之上),整图等比缩入、绝不裁切。
          失败时换成明确错误占位:WebView 解不了的编码(如 Windows WebView2 之于 HEVC)
          交给系统播放器兜底,不再留一片空白。 */}
      <div className="absolute inset-0 grid place-items-center overflow-hidden">
        {failed ? (
          <div className="flex flex-col items-center gap-3 text-workbench-text-muted">
            <VideoOff size={36} strokeWidth={1.5} aria-hidden />
            <span className="text-sm">此视频无法在应用内播放</span>
            <button
              type="button"
              onClick={() => void openExternal(src)}
              className="focus-ring rounded-full bg-workbench-surface/90 px-4 py-2 text-sm text-workbench-text shadow-wb-popover ring-1 ring-workbench-line transition-colors hover:bg-workbench-surface"
            >
              用系统播放器打开
            </button>
          </div>
        ) : (
          <video
            ref={videoRef}
            src={src}
            controls
            playsInline
            preload="metadata"
            onError={() => setFailed(true)}
            className="block max-h-[95vh] max-w-[97vw] rounded-xl"
          />
        )}
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
