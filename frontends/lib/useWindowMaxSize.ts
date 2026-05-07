import { useEffect } from "react";
import { currentMonitor, getCurrentWindow, PhysicalSize } from "@tauri-apps/api/window";

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Caps the Tauri window's max width/height to the current monitor's work area
 * so the user can't drag any edge off-screen — which previously left the
 * customer-details panel stranded outside the visible region. Re-applied on
 * `moved` events to handle the window crossing into a monitor with a
 * different work area.
 */
export function useWindowMaxSize() {
  useEffect(() => {
    if (!isTauriRuntime()) return;

    let disposed = false;
    let unlisten: (() => void) | null = null;

    const applyMaxSize = async () => {
      try {
        const monitor = await currentMonitor();
        if (disposed || !monitor) return;
        const { size } = monitor.workArea;
        const win = getCurrentWindow();
        await win.setMaxSize(new PhysicalSize(size.width, size.height));

        const currentSize = await win.outerSize();
        if (disposed) return;
        if (currentSize.width > size.width || currentSize.height > size.height) {
          await win.setSize(
            new PhysicalSize(
              Math.min(currentSize.width, size.width),
              Math.min(currentSize.height, size.height),
            ),
          );
        }
      } catch {
        // Browser preview or transient Tauri error — best-effort.
      }
    };

    void applyMaxSize();

    void getCurrentWindow()
      .onMoved(() => {
        void applyMaxSize();
      })
      .then((un) => {
        if (disposed) un();
        else unlisten = un;
      })
      .catch(() => {});

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
