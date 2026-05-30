import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { AT_BOTTOM_THRESHOLD } from "./constants";
import { type ScrollMetrics, WorkbenchScrollArea } from "./WorkbenchScrollArea";

let rafCallbacks: FrameRequestCallback[] = [];

beforeEach(() => {
  rafCallbacks = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafCallbacks.push(cb);
    return rafCallbacks.length;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  class ResizeObserverMock {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  }
  class MutationObserverMock {
    observe = vi.fn();
    disconnect = vi.fn();
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  vi.stubGlobal("MutationObserver", MutationObserverMock);
});

function flushRaf() {
  const callbacks = rafCallbacks;
  rafCallbacks = [];
  callbacks.forEach((cb) => cb(0));
}

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe("WorkbenchScrollArea", () => {
  function setupViewport(opts: {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
    onMetrics?: (m: ScrollMetrics) => void;
    onUserScroll?: (m: ScrollMetrics) => void;
  }) {
    const { scrollTop, scrollHeight, clientHeight, onMetrics, onUserScroll } = opts;
    const { container } = render(
      <div style={{ height: clientHeight }}>
        <WorkbenchScrollArea
          className="h-full"
          onScrollMetrics={onMetrics}
          onUserScroll={onUserScroll}
        >
          <div data-testid="content" style={{ height: scrollHeight }}>
            content
          </div>
        </WorkbenchScrollArea>
      </div>,
    );
    const viewport = container.querySelector(".overflow-y-auto") as HTMLDivElement | null;
    expect(viewport).not.toBeNull();
    Object.defineProperty(viewport!, "clientHeight", { configurable: true, value: clientHeight });
    Object.defineProperty(viewport!, "scrollHeight", { configurable: true, value: scrollHeight });
    Object.defineProperty(viewport!, "scrollTop", {
      configurable: true,
      writable: true,
      value: scrollTop,
    });
    return viewport!;
  }

  it("relies on native overflow-y:auto for scrolling (viewport is the scroll container)", () => {
    const viewport = setupViewport({ scrollTop: 0, scrollHeight: 500, clientHeight: 100 });
    // viewport 本身就是 overflow-y:auto 的滚动容器,wheel 由浏览器原生处理。
    // 单元测试只验证 viewport 存在且承载了 overflow-y-auto;wheel 行为由
    // 浏览器/Tauri WebKit 提供,不在 jsdom 单测覆盖范围。
    expect(viewport.className).toContain("overflow-y-auto");
  });

  it("emits ScrollMetrics with correct dimensions after a scroll event", async () => {
    const onMetrics = vi.fn();
    const viewport = setupViewport({
      scrollTop: 0,
      scrollHeight: 500,
      clientHeight: 100,
      onMetrics,
    });
    await Promise.resolve();
    onMetrics.mockClear();
    // 初次挂载时 useEffect 已 emit 过一轮,但当时 jsdom 默认 0 维度;手动
    // 触发一次 scroll 让 emit 读到 defineProperty 后的真实值。
    viewport.dispatchEvent(new Event("scroll"));
    flushRaf();
    expect(onMetrics).toHaveBeenCalled();
    const m = onMetrics.mock.lastCall?.[0] as ScrollMetrics;
    expect(m.scrollTop).toBe(0);
    expect(m.scrollHeight).toBe(500);
    expect(m.clientHeight).toBe(100);
    expect(m.atBottom).toBe(false);
  });

  it("emits atBottom=true when within AT_BOTTOM_THRESHOLD of bottom", async () => {
    const onMetrics = vi.fn();
    const viewport = setupViewport({
      scrollTop: 500 - 100 - (AT_BOTTOM_THRESHOLD - 1),
      scrollHeight: 500,
      clientHeight: 100,
      onMetrics,
    });
    await Promise.resolve();
    onMetrics.mockClear();
    viewport.dispatchEvent(new Event("scroll"));
    flushRaf();
    expect(onMetrics).toHaveBeenCalled();
    const m = onMetrics.mock.lastCall?.[0] as ScrollMetrics;
    expect(m.atBottom).toBe(true);
  });

  it("emits ScrollMetrics on scroll events", async () => {
    const onMetrics = vi.fn();
    const viewport = setupViewport({
      scrollTop: 0,
      scrollHeight: 500,
      clientHeight: 100,
      onMetrics,
    });
    await Promise.resolve();
    onMetrics.mockClear();

    Object.defineProperty(viewport, "scrollTop", {
      configurable: true,
      writable: true,
      value: 120,
    });
    viewport.dispatchEvent(new Event("scroll"));
    flushRaf();

    expect(onMetrics).toHaveBeenCalled();
    const m = onMetrics.mock.lastCall?.[0] as ScrollMetrics;
    expect(m.scrollTop).toBe(120);
    expect(m.atBottom).toBe(false);
  });

  it("invokes onUserScroll only on native scroll event, not on mount/resize", async () => {
    const onUserScroll = vi.fn();
    const viewport = setupViewport({
      scrollTop: 0,
      scrollHeight: 500,
      clientHeight: 100,
      onUserScroll,
    });
    // 初始 mount 触发 emit() 但不触发 onUserScroll。
    await Promise.resolve();
    expect(onUserScroll).not.toHaveBeenCalled();

    // window resize 走 emit(),不走 onUserScroll。
    window.dispatchEvent(new Event("resize"));
    flushRaf();
    expect(onUserScroll).not.toHaveBeenCalled();

    // 真正的 native scroll event 才触发 onUserScroll。
    viewport.dispatchEvent(new Event("scroll"));
    flushRaf();
    expect(onUserScroll).toHaveBeenCalledTimes(1);
    const m = onUserScroll.mock.lastCall?.[0] as ScrollMetrics;
    expect(m.scrollTop).toBe(0);
    expect(m.scrollHeight).toBe(500);
  });

  it("both onScrollMetrics and onUserScroll fire on a scroll event", async () => {
    const onMetrics = vi.fn();
    const onUserScroll = vi.fn();
    const viewport = setupViewport({
      scrollTop: 0,
      scrollHeight: 500,
      clientHeight: 100,
      onMetrics,
      onUserScroll,
    });
    await Promise.resolve();
    onMetrics.mockClear();
    onUserScroll.mockClear();

    viewport.dispatchEvent(new Event("scroll"));
    flushRaf();

    expect(onMetrics).toHaveBeenCalledTimes(1);
    expect(onUserScroll).toHaveBeenCalledTimes(1);
  });

  it("coalesces repeated scroll events into one metrics report per animation frame", async () => {
    const onMetrics = vi.fn();
    const onUserScroll = vi.fn();
    const viewport = setupViewport({
      scrollTop: 0,
      scrollHeight: 800,
      clientHeight: 200,
      onMetrics,
      onUserScroll,
    });
    await Promise.resolve();
    onMetrics.mockClear();
    onUserScroll.mockClear();

    viewport.scrollTop = 40;
    viewport.dispatchEvent(new Event("scroll"));
    viewport.scrollTop = 80;
    viewport.dispatchEvent(new Event("scroll"));
    viewport.scrollTop = 120;
    viewport.dispatchEvent(new Event("scroll"));

    expect(onMetrics).not.toHaveBeenCalled();
    expect(onUserScroll).not.toHaveBeenCalled();

    flushRaf();

    expect(onUserScroll).toHaveBeenCalledTimes(1);
    expect(onMetrics).toHaveBeenCalledTimes(1);
    expect((onMetrics.mock.lastCall?.[0] as ScrollMetrics).scrollTop).toBe(120);
  });
});
