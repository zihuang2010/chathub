import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { ImageLightbox } from "./ImageLightbox";

/** 当前预览图：src 必有,alt 可空串,localPath 空串归一为 undefined(交给 ImageLightbox 走原图)。 */
interface PreviewImage {
  src: string;
  alt: string;
  localPath?: string;
}

/** 换图事件载荷:预览窗已开时用户又点另一张图,主窗 emit 此事件切换。 */
interface ShowPayload {
  src: string;
  alt?: string;
  localPath?: string;
}

/** 换图事件名(主窗 emit / 预览窗 listen 的固定约定)。 */
const SHOW_EVENT = "image-preview:show";

/** 从 URL 查询串读取初始图片。URLSearchParams.get 已自动解码,无需再 decodeURIComponent。 */
function initialFromUrl(): PreviewImage {
  const params = new URLSearchParams(window.location.search);
  const localPath = params.get("localPath") || undefined;
  return {
    src: params.get("src") ?? "",
    alt: params.get("alt") ?? "",
    localPath,
  };
}

/**
 * 独立 Tauri 图片预览窗的整窗内容。
 * - 与主窗共用同一 index.html,由 main.tsx 按 ?view=image-preview 分流到这里。
 * - 初始图来自 URL 参数;预览窗已开时再点图,主窗 emit "image-preview:show" 换图。
 * - 复用 ImageLightbox(全屏 Radix Dialog 看图器:缩放/平移/下载/blur-up)铺满整窗;
 *   实心底色容器托底,避免 ImageLightbox 半透明遮罩背后空白发灰。
 * - key={current.src}:ImageLightbox 内部状态由 props 初始化、不随 src 自动复位,
 *   换图时靠 key 强制重挂,彻底复位缩放/加载态。
 */
export function ImagePreviewWindow() {
  const [current, setCurrent] = useState<PreviewImage>(initialFromUrl);

  // 监听换图事件:预览窗已开时切换到新图。组件卸载时取消监听。
  useEffect(() => {
    const unlisten = listen<ShowPayload>(SHOW_EVENT, (e) => {
      setCurrent({
        src: e.payload.src,
        alt: e.payload.alt ?? "",
        localPath: e.payload.localPath || undefined,
      });
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  // 同步窗口标题(best-effort,失败静默忽略)。
  useEffect(() => {
    void getCurrentWindow()
      .setTitle(current.alt || "图片预览")
      .catch(() => {});
  }, [current.alt]);

  return (
    <div className="fixed inset-0 bg-workbench-surface">
      <ImageLightbox
        key={current.src}
        src={current.src}
        alt={current.alt}
        localPath={current.localPath}
        // 独立窗有系统原生关闭(标题栏红绿灯/窗口控件),隐藏灯箱内的 ✕ 去重。
        showClose={false}
        // 整窗看图:图片近铺满窗口,减少四周留白(应用内灯箱默认保留留白)。
        fill
        onClose={() => {
          void getCurrentWindow().close();
        }}
      />
    </div>
  );
}
