import { useEffect } from "react";
import { currentMonitor, getCurrentWindow, PhysicalSize } from "@tauri-apps/api/window";

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * 防止用户把窗口调整 / 拖拽到超出当前显示器工作区 —— 否则相对主窗口定位的
 * 客户详情子窗口会被甩到可视区域之外。
 *
 * 实现刻意用「事件后回弹」而非 `setMaxSize`:在 Windows 无边框窗口(decorations:false)
 * 上,`setMaxSize` 会把系统最大化的目标尺寸一并卡死,使最大化后的窗口被往左上挤、
 * 右下够不到屏幕边缘(表现为"有点偏、不满屏")。改为监听 resize/move,仅在窗口
 * **非最大化**且尺寸超出工作区时把它回弹到工作区大小 —— 既保留越界保护,又完全
 * 不干扰系统最大化。回弹用整数物理像素 + `>` 比较,落点等于工作区时不再触发,无回环。
 */
export function useWindowMaxSize() {
  useEffect(() => {
    if (!isTauriRuntime()) return;

    let disposed = false;
    const unlisteners: Array<() => void> = [];

    const clampToWorkArea = async () => {
      try {
        const win = getCurrentWindow();
        // 最大化态下尺寸由系统接管,回弹会把最大化"撤销"成工作区方框,故直接跳过。
        if (await win.isMaximized()) return;
        const monitor = await currentMonitor();
        if (disposed || !monitor) return;
        const { size } = monitor.workArea;
        const current = await win.outerSize();
        if (disposed) return;
        if (current.width > size.width || current.height > size.height) {
          await win.setSize(
            new PhysicalSize(
              Math.min(current.width, size.width),
              Math.min(current.height, size.height),
            ),
          );
        }
      } catch {
        // Browser preview or transient Tauri error — best-effort.
      }
    };

    void clampToWorkArea();

    const win = getCurrentWindow();
    const register = (fn: Promise<() => void>) =>
      void fn
        .then((un) => {
          if (disposed) un();
          else unlisteners.push(un);
        })
        .catch(() => {});

    // resize:抓住"拖边把窗口拉得比工作区还大"。move:跨到工作区不同的显示器时重判。
    register(win.onResized(() => void clampToWorkArea()));
    register(win.onMoved(() => void clampToWorkArea()));

    return () => {
      disposed = true;
      unlisteners.forEach((un) => un());
    };
  }, []);
}
