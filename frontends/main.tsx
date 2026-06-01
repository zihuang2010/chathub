import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ImagePreviewWindow } from "@/components/workbench/messages/ImagePreviewWindow";
import { isMac, isWindows } from "./lib/platform";
import "./index.css";

// Tag the document so CSS can branch on platform without JS roundtrips.
document.documentElement.dataset.os = isMac ? "mac" : isWindows ? "windows" : "linux";

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

// 独立图片预览窗分流:Tauri 以 ?view=image-preview 打开的独立窗口只渲染预览组件;
// 该独立窗口不包 StrictMode(避免开发期副作用双跑),其余场景维持原 App + StrictMode。
if (new URLSearchParams(window.location.search).get("view") === "image-preview") {
  root.render(<ImagePreviewWindow />);
} else {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
