// useFileDragDrop — 聊天区拖拽文件 hook。
// Tauri 路径:订阅 getCurrentWebview().onDragDropEvent(OS 拖拽被 Tauri 拦截,HTML5 drop
// 在 Tauri 内拿不到文件,这是唯一可靠通道;Windows/macOS 由 Tauri 统一抽象)。事件坐标为
// 物理像素,÷devicePixelRatio 换算成与 getBoundingClientRect 同一 CSS 坐标系后求交,
// 决定遮罩显隐与落点有效性。drop 的路径经 read_local_file 读回字节组装 File(与
// pickNativeFiles 同一座桥)。
// web 预览(非 Tauri):返回 webHandlers 挂到容器上,DataTransfer.files 直取;Tauri 下返回
// 空对象避免双触发。enabled=false(设置页开关关)= 不订阅、不响应。

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import { invoke, isTauri } from "@tauri-apps/api/core";

import { showToast } from "@/components/ui/toast";

import { extOf, MIME_BY_EXT } from "./data";
import { physicalToLogical, pointInRect, type Point } from "./dropFiles";
import { STRINGS } from "./strings";

interface UseFileDragDropOptions {
  /** 设置页「拖拽文件发送」开关。false = 不订阅、不响应。 */
  enabled: boolean;
  /** 聊天区根容器:落点判定与 web 事件挂载目标。 */
  containerRef: RefObject<HTMLElement | null>;
  /** 落点有效的拖入文件(已组装 File,未分类)。 */
  onFiles: (files: File[]) => void;
}

interface WebDragHandlers {
  onDragOver?: (event: React.DragEvent<HTMLElement>) => void;
  onDragLeave?: (event: React.DragEvent<HTMLElement>) => void;
  onDrop?: (event: React.DragEvent<HTMLElement>) => void;
}

/** 路径 → File:read_local_file 逐条读回,单条失败(文件夹/无权限)跳过。 */
async function readDroppedPaths(paths: string[]): Promise<File[]> {
  const settled = await Promise.allSettled(
    paths.map(async (path) => {
      const buf = await invoke<ArrayBuffer>("read_local_file", { path });
      // 兼容 Unix(/分隔)与 Windows(\分隔)路径取文件名
      const name = path.split(/[/\\]/).pop() || path;
      return new File([buf], name, {
        type: MIME_BY_EXT[extOf(name)] ?? "application/octet-stream",
      });
    }),
  );
  return settled
    .filter((s): s is PromiseFulfilledResult<File> => s.status === "fulfilled")
    .map((s) => s.value);
}

export function useFileDragDrop({ enabled, containerRef, onFiles }: UseFileDragDropOptions): {
  dragActive: boolean;
  webHandlers: WebDragHandlers;
} {
  const [dragActive, setDragActive] = useState(false);
  // onFiles 走 ref 透传:避免调用方每渲染新建闭包导致订阅 effect 反复退订/重订。
  // 注意:组件卸载后 onFilesRef 仍持有旧闭包引用,当前安全性另有一层来自
  // ChatArea 侧 composerDropRef 卸载置 null 的 `?.` 短路;下方 drop 分支
  // 的 disposed 守卫则是第一道防线,阻止 read_local_file 在途 Promise 回调回执。
  const onFilesRef = useRef(onFiles);
  useEffect(() => {
    onFilesRef.current = onFiles;
  }, [onFiles]);

  // ── Tauri 路径 ──
  useEffect(() => {
    if (!enabled || !isTauri()) {
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | null = null;

    // 判断逻辑坐标点是否在容器矩形内
    const inContainer = (position: Point): boolean => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return false;
      const logical = physicalToLogical(position, window.devicePixelRatio || 1);
      return pointInRect(logical, rect);
    };

    void (async () => {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      // DragDropEvent 的 position 是 PhysicalPosition 类({x, y}),与 Point 结构兼容
      const un = await getCurrentWebview().onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "leave") {
          setDragActive(false);
          return;
        }
        if (payload.type === "enter" || payload.type === "over") {
          setDragActive(inContainer(payload.position));
          return;
        }
        // drop:界外松手直接丢弃;界内读回文件交给 onFiles。
        setDragActive(false);
        if (payload.type !== "drop") return;
        if (!inContainer(payload.position) || payload.paths.length === 0) return;
        void readDroppedPaths(payload.paths).then((files) => {
          // drop 在途期间组件已卸载或开关已关:守卫阻断幽灵回调与幽灵 toast。
          if (disposed) return;
          if (files.length === 0) {
            showToast(STRINGS.toast.dropReadFailed, { type: "error" });
          } else {
            onFilesRef.current(files);
          }
        });
      });
      // 订阅落定前组件已卸载/开关已关:立即退订,不留悬挂监听。
      if (disposed) un();
      else unlisten = un;
    })();

    return () => {
      disposed = true;
      unlisten?.();
      setDragActive(false);
    };
  }, [enabled, containerRef]);

  // ── web 兜底路径(非 Tauri)──
  const onDragOver = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (!enabled) return;
      if (!Array.from(event.dataTransfer.types).includes("Files")) return;
      event.preventDefault();
      setDragActive(true);
    },
    [enabled],
  );
  const onDragLeave = useCallback((event: React.DragEvent<HTMLElement>) => {
    // 只在真正离开容器(而非进入子元素)时复位,避免遮罩闪烁。
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setDragActive(false);
    }
  }, []);
  const onDrop = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (!enabled) return;
      event.preventDefault();
      setDragActive(false);
      const files = Array.from(event.dataTransfer.files);
      if (files.length > 0) onFilesRef.current(files);
    },
    [enabled],
  );

  const webHandlers: WebDragHandlers = isTauri() ? {} : { onDragOver, onDragLeave, onDrop };

  return { dragActive, webHandlers };
}
