import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ImagePreviewWindow } from "@/components/workbench/messages/ImagePreviewWindow";
import { VideoPreviewWindow } from "@/components/workbench/messages/VideoPreviewWindow";
import { isMac, isWindows } from "./lib/platform";
import "./fonts.css";
import "./index.css";

// Tag the document so CSS can branch on platform without JS roundtrips.
document.documentElement.dataset.os = isMac ? "mac" : isWindows ? "windows" : "linux";

// 生产包禁用 webview 原生右键菜单:WebView2 / WKWebView 默认的右键菜单带「重新加载 /
// 检查元素」,正式发布时不希望用户右键 reload 刷掉应用状态,故在 production 构建里全局
// 拦截 contextmenu。App 自己的 Radix 右键菜单(消息行/会话行)走 React 合成事件,在 #root
// 上、本监听器(window 冒泡阶段)之前触发并各自 preventDefault,不受影响;dev 仍保留原生
// 菜单方便调试(reload / devtools)。本文件同时被独立图片/视频预览窗加载,故这些窗口一并生效。
if (import.meta.env.PROD) {
  window.addEventListener("contextmenu", (e) => e.preventDefault());
}

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
