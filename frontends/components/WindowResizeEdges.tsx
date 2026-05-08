import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { getCurrentWindow, LogicalPosition, LogicalSize } from "@tauri-apps/api/window";

import { isMac } from "@/lib/platform";

// macOS 用 `transparent: true` + 8px body padding 制造圆角窗口的视觉效果，
// 但 OS 层面的窗口边界仍是矩形（位于可见圆角外 8px）—— macOS 对无装饰透明
// 窗口的原生 resize 命中区落在 OS 边上，所以鼠标移到"看上去的边框"上时
// 光标不变，要再往外探 8px 才触发。这里在视口边补一圈不可见命中区，覆盖
// 整个 padding 环并向 app-shell 内多探几像素，让光标在视觉边框上就能改。
//
// macOS 上 `startResizeDragging` 在 tao 实现里只对四角稳定 —— 上下左右四条
// 边在我们这版 Tauri 上调用后没反应（实测：四角能拖，四边纹丝不动）。所以
// 边用纯 JS 的 pointermove → setSize/setPosition 循环手动驱动；角继续走
// 原生 API，丝滑度更好。
//
// 仅 macOS 启用：Windows/Linux 上 body 没有那 8px padding，可见边框就是 OS
// 边界，原生 resize 已经够用；硬塞自定义命中区反而会和右上角的最小化/关闭
// 按钮抢点击事件。

type ResizeDirection =
  | "North"
  | "South"
  | "East"
  | "West"
  | "NorthEast"
  | "NorthWest"
  | "SouthEast"
  | "SouthWest";

const CORNER_DIRECTIONS = new Set<ResizeDirection>([
  "NorthEast",
  "NorthWest",
  "SouthEast",
  "SouthWest",
]);

// 8px (body padding) + 4px (探入可见边框) — 让 hover 在视觉边框上就能命中。
const EDGE_THICKNESS = 12;
// 角部正方形稍大，既好抓又能盖住对应的两个边带交界处。
const CORNER_SIZE = 16;

// tauri.conf.json 里写死的最小尺寸；自定义 resize 时要在前端先 clamp 一遍，
// 否则 setSize 之后位置算在原大小上、再被 OS 推回 min，会跳。
const MIN_LOGICAL_WIDTH = 860;
const MIN_LOGICAL_HEIGHT = 600;

interface HandleSpec {
  dir: ResizeDirection;
  cursor: CSSProperties["cursor"];
  style: CSSProperties;
}

// 边带留出 CORNER_SIZE 的间距给四角；否则角落落在边带上时方向是不对的（角是
// 双轴 resize，边只是单轴）。
const HANDLES: HandleSpec[] = [
  {
    dir: "North",
    cursor: "ns-resize",
    style: { top: 0, left: CORNER_SIZE, right: CORNER_SIZE, height: EDGE_THICKNESS },
  },
  {
    dir: "South",
    cursor: "ns-resize",
    style: { bottom: 0, left: CORNER_SIZE, right: CORNER_SIZE, height: EDGE_THICKNESS },
  },
  {
    dir: "West",
    cursor: "ew-resize",
    style: { left: 0, top: CORNER_SIZE, bottom: CORNER_SIZE, width: EDGE_THICKNESS },
  },
  {
    dir: "East",
    cursor: "ew-resize",
    style: { right: 0, top: CORNER_SIZE, bottom: CORNER_SIZE, width: EDGE_THICKNESS },
  },
  {
    dir: "NorthWest",
    cursor: "nwse-resize",
    style: { top: 0, left: 0, width: CORNER_SIZE, height: CORNER_SIZE },
  },
  {
    dir: "NorthEast",
    cursor: "nesw-resize",
    style: { top: 0, right: 0, width: CORNER_SIZE, height: CORNER_SIZE },
  },
  {
    dir: "SouthWest",
    cursor: "nesw-resize",
    style: { bottom: 0, left: 0, width: CORNER_SIZE, height: CORNER_SIZE },
  },
  {
    dir: "SouthEast",
    cursor: "nwse-resize",
    style: { bottom: 0, right: 0, width: CORNER_SIZE, height: CORNER_SIZE },
  },
];

async function startManualResize(
  direction: ResizeDirection,
  startEvent: ReactPointerEvent<HTMLDivElement>,
) {
  // 一进来就把鼠标坐标抠出来 —— React 18 的 SyntheticEvent 跨 await 后某些
  // WebView（特别是 macOS WKWebView）会把 screenX/Y 重置为 0，那样 dx 就
  // 直接等于"鼠标的屏幕绝对 X"，几百到几千像素，看起来就像窗口被推到一个
  // 固定大小不动了。这是 Tauri webview 长期存在的一个坑。
  const startScreenX = startEvent.screenX;
  const startScreenY = startEvent.screenY;

  const win = getCurrentWindow();
  // 全程用 logical (CSS) 像素：screenX/Y 本来就是 CSS 像素，setSize/setPosition
  // 接受 LogicalSize 时 Tauri 内部会自己乘 scaleFactor 转物理像素，省掉一次
  // 手算单位的机会，也避开"WKWebView 的 screenX 到底是 CSS px 还是物理 px"
  // 这个长尾问题。
  let scaleFactor: number;
  try {
    scaleFactor = await win.scaleFactor();
  } catch {
    return;
  }

  let initialLogicalWidth: number;
  let initialLogicalHeight: number;
  let initialLogicalX: number;
  let initialLogicalY: number;
  try {
    const [physSize, physPos] = await Promise.all([win.outerSize(), win.outerPosition()]);
    initialLogicalWidth = physSize.width / scaleFactor;
    initialLogicalHeight = physSize.height / scaleFactor;
    initialLogicalX = physPos.x / scaleFactor;
    initialLogicalY = physPos.y / scaleFactor;
  } catch {
    return;
  }

  const movesEast = direction === "East";
  const movesWest = direction === "West";
  const movesSouth = direction === "South";
  const movesNorth = direction === "North";

  const onMove = (e: PointerEvent) => {
    const dx = e.screenX - startScreenX;
    const dy = e.screenY - startScreenY;

    let width = initialLogicalWidth;
    let height = initialLogicalHeight;
    let x = initialLogicalX;
    let y = initialLogicalY;

    if (movesEast) {
      width = Math.max(MIN_LOGICAL_WIDTH, initialLogicalWidth + dx);
    } else if (movesWest) {
      width = Math.max(MIN_LOGICAL_WIDTH, initialLogicalWidth - dx);
      // West 边外移 → 窗口左边界跟着移；受 minWidth clamp 时位置也要一起
      // clamp，否则窗口越过最小宽度后会继续往左飘。
      x = initialLogicalX + (initialLogicalWidth - width);
    }

    if (movesSouth) {
      height = Math.max(MIN_LOGICAL_HEIGHT, initialLogicalHeight + dy);
    } else if (movesNorth) {
      height = Math.max(MIN_LOGICAL_HEIGHT, initialLogicalHeight - dy);
      y = initialLogicalY + (initialLogicalHeight - height);
    }

    void win.setSize(new LogicalSize(width, height)).catch(() => {});
    if (movesWest || movesNorth) {
      void win.setPosition(new LogicalPosition(x, y)).catch(() => {});
    }
  };

  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}

export function WindowResizeEdges() {
  if (!isMac) return null;

  const handlePointerDown =
    (dir: ResizeDirection) => async (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();

      if (CORNER_DIRECTIONS.has(dir)) {
        // 角部走原生 — Tauri/tao 在 macOS 上对角部 resize 是稳的。
        try {
          await getCurrentWindow().startResizeDragging(dir);
        } catch {
          // 非 Tauri 运行时；忽略。
        }
        return;
      }

      // 上下左右四条边在 macOS 上的 startResizeDragging 实测无效，改走 pointer
      // loop 自己驱动 setSize/setPosition。
      await startManualResize(dir, event);
    };

  return (
    <div aria-hidden style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 200 }}>
      {HANDLES.map(({ dir, cursor, style }) => (
        <div
          key={dir}
          style={{ position: "absolute", pointerEvents: "auto", cursor, ...style }}
          onPointerDown={handlePointerDown(dir)}
        />
      ))}
    </div>
  );
}
