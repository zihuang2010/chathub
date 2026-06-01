import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { VideoPlayer } from "./VideoPlayer";

/** 当前预览视频:src 必有,name 可空(空串归一为 undefined)。 */
interface PreviewVideo {
  src: string;
  name?: string;
}

/** 换源事件载荷:预览窗已开时用户又点另一个视频,主窗 emit 此事件切换。 */
interface ShowPayload {
  src: string;
  name?: string;
}

/** 换源事件名(主窗 emit / 预览窗 listen 的固定约定)。 */
const SHOW_EVENT = "video-preview:show";

/** 从 URL 查询串读取初始视频。URLSearchParams.get 已自动解码,无需再 decodeURIComponent。 */
function initialFromUrl(): PreviewVideo {
  const params = new URLSearchParams(window.location.search);
  return {
    src: params.get("src") ?? "",
    name: params.get("name") || undefined,
  };
}

/**
 * 独立 Tauri 视频预览窗的整窗内容。
 * - 与主窗共用同一 index.html,由 main.tsx 按视图参数分流到这里。
 * - 初始视频来自 URL 参数;预览窗已开时再点视频,主窗 emit "video-preview:show" 换源。
 * - 复用 VideoPlayer(原生 <video> 播放器)铺满整窗;实心底色容器托底。
 * - key={current.src}:换源时强制重挂 VideoPlayer,复位播放进度(与图片版 key={current.src} 同理)。
 */
export function VideoPreviewWindow() {
  const [current, setCurrent] = useState<PreviewVideo>(initialFromUrl);

  // 监听换源事件:预览窗已开时切换到新视频。组件卸载时取消监听。
  useEffect(() => {
    const unlisten = listen<ShowPayload>(SHOW_EVENT, (e) => {
      setCurrent({
        src: e.payload.src,
        name: e.payload.name,
      });
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  // 同步窗口标题(best-effort,失败静默忽略)。
  useEffect(() => {
    void getCurrentWindow()
      .setTitle(current.name || "视频预览")
      .catch(() => {});
  }, [current.name]);

  return <VideoPlayer key={current.src} src={current.src} name={current.name} />;
}
