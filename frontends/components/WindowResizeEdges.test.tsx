import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("@/lib/platform", () => ({ isMac: true }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    startResizeDragging: vi.fn(),
    scaleFactor: vi.fn(),
    outerSize: vi.fn(),
    outerPosition: vi.fn(),
    setSize: vi.fn(),
    setPosition: vi.fn(),
  }),
  LogicalPosition: class LogicalPosition {
    constructor(
      public x: number,
      public y: number,
    ) {}
  },
  LogicalSize: class LogicalSize {
    constructor(
      public width: number,
      public height: number,
    ) {}
  },
}));

import { WindowResizeEdges } from "./WindowResizeEdges";

afterEach(() => {
  cleanup();
});

describe("WindowResizeEdges", () => {
  it("forwards wheel events on the resize hit zones to the scrollable element underneath", () => {
    const scroller = document.createElement("div");
    const content = document.createElement("div");
    scroller.style.overflowY = "auto";
    scroller.appendChild(content);
    document.body.appendChild(scroller);
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 100 });
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 500 });
    Object.defineProperty(scroller, "scrollTop", { configurable: true, writable: true, value: 0 });
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => content),
    });

    const { container } = render(<WindowResizeEdges />);
    const root = container.firstElementChild;
    expect(root).not.toBeNull();

    const eastHandle = root!.children.item(3);
    expect(eastHandle).not.toBeNull();

    const wheelEvent = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      clientX: 800,
      clientY: 300,
      deltaY: 120,
    });
    const dispatchResult = eastHandle!.dispatchEvent(wheelEvent);

    expect(dispatchResult).toBe(false);
    expect(wheelEvent.defaultPrevented).toBe(true);
    expect(scroller.scrollTop).toBe(120);
  });

  it("still captures pointer down for resize dragging", () => {
    const { container } = render(<WindowResizeEdges />);
    const root = container.firstElementChild;
    const eastHandle = root!.children.item(3);
    expect(eastHandle).not.toBeNull();

    const pointerDownEvent = new MouseEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    const dispatchResult = eastHandle!.dispatchEvent(pointerDownEvent);

    expect(dispatchResult).toBe(false);
    expect(pointerDownEvent.defaultPrevented).toBe(true);
  });
});
