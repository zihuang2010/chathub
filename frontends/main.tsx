import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ImagePreviewWindow } from "@/components/workbench/messages/ImagePreviewWindow";
import { VideoPreviewWindow } from "@/components/workbench/messages/VideoPreviewWindow";
import { isMac, isWindows } from "./lib/platform";
import "./index.css";

// Tag the document so CSS can branch on platform without JS roundtrips.
document.documentElement.dataset.os = isMac ? "mac" : isWindows ? "windows" : "linux";

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

// 独立图片/视频预览窗分流:Tauri 以 ?view=image-preview / ?view=video-preview 打开的独立窗口
// 只渲染对应预览组件;该独立窗口不包 StrictMode(避免开发期副作用双跑),其余场景维持原
// App + StrictMode。
const view = new URLSearchParams(window.location.search).get("view");
if (view === "image-preview") {
  root.render(<ImagePreviewWindow />);
} else if (view === "video-preview") {
  root.render(<VideoPreviewWindow />);
} else {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
