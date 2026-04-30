import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { isMac, isWindows } from "./lib/platform";
import "./index.css";

// Tag the document so CSS can branch on platform without JS roundtrips.
document.documentElement.dataset.os = isMac ? "mac" : isWindows ? "windows" : "linux";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
