import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // silk-wasm 用 `new URL("silk.wasm", import.meta.url)` 定位 wasm。排除其 esbuild 预打包,
  // 否则 dep optimize 会改写 import.meta.url 导致 wasm 取址跑偏(vite 才能把 silk.wasm 当
  // 静态资源产出并重写 URL)。仅 silk 语音点击播放时懒加载,不影响首屏。
  optimizeDeps: {
    exclude: ["silk-wasm"],
  },

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./frontends"),
    },
  },

  // 手动分包:把重依赖拆成稳定的 vendor 分组,避免它们和业务代码、彼此混在同一 chunk
  // 里——任意业务改动都会让整块 hash 变化、缓存失效。函数式 manualChunks 按模块 id 归组,
  // 命中顺序从具体到一般(prosemirror/@tiptap/pm 先于 @tiptap),未命中的依赖走默认拆分。
  // 注意:silk-wasm 已在 optimizeDeps.exclude,其 wasm 取址依赖 vite 的静态资源重写,
  // 这里不要把它归进手写 chunk,保持默认懒加载行为。
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          // editor:tiptap 全家桶 + 底层 prosemirror(@tiptap/pm 是 prosemirror 的封装)
          if (id.includes("node_modules/@tiptap/") || id.includes("node_modules/prosemirror-")) {
            return "editor";
          }
          // motion:framer-motion 动画库
          if (id.includes("node_modules/framer-motion/")) {
            return "motion";
          }
          // crypto:crypto-js
          if (id.includes("node_modules/crypto-js/")) {
            return "crypto";
          }
          // react vendor:react / react-dom 运行时(放在最后,避免误吞上面更具体的包)
          if (id.includes("node_modules/react/") || id.includes("node_modules/react-dom/")) {
            return "react";
          }
          return undefined;
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/backends/**"],
    },
  },
}));
