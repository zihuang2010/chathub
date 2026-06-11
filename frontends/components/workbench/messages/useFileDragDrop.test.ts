import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Tauri mock:isTauri 可切换;onDragDropEvent 捕获回调供测试驱动。
const tauriMock = { isTauri: true };
type DragPayload =
  | { type: "enter" | "over"; position: { x: number; y: number } }
  | { type: "drop"; position: { x: number; y: number }; paths: string[] }
  | { type: "leave" };
let dragCallback: ((event: { payload: DragPayload }) => void) | null = null;
const unlistenMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(new ArrayBuffer(1))),
  isTauri: () => tauriMock.isTauri,
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: vi.fn((cb: (event: { payload: DragPayload }) => void) => {
      dragCallback = cb;
      return Promise.resolve(unlistenMock);
    }),
  }),
}));
vi.mock("@/components/ui/toast", () => ({ showToast: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";

import { useFileDragDrop } from "./useFileDragDrop";

const invokeMock = vi.mocked(invoke);

// 聊天区矩形:逻辑像素 (10,20)-(110,220)。
function makeContainer(): { current: HTMLElement } {
  const el = document.createElement("div");
  el.getBoundingClientRect = () =>
    ({
      left: 10,
      top: 20,
      right: 110,
      bottom: 220,
      width: 100,
      height: 200,
      x: 10,
      y: 20,
      toJSON: () => ({}),
    }) as DOMRect;
  return { current: el };
}

beforeEach(() => {
  tauriMock.isTauri = true;
  dragCallback = null;
  unlistenMock.mockClear();
  invokeMock.mockClear();
  invokeMock.mockImplementation(() => Promise.resolve(new ArrayBuffer(1)));
  vi.stubGlobal("devicePixelRatio", 2);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useFileDragDrop / Tauri 路径", () => {
  it("enabled=false 不订阅;true 订阅;卸载退订", async () => {
    const onFiles = vi.fn();
    const containerRef = makeContainer();
    const { rerender, unmount } = renderHook(
      ({ enabled }) => useFileDragDrop({ enabled, containerRef, onFiles }),
      { initialProps: { enabled: false } },
    );
    await act(async () => {});
    expect(dragCallback).toBeNull();

    rerender({ enabled: true });
    await waitFor(() => expect(dragCallback).not.toBeNull());

    unmount();
    await waitFor(() => expect(unlistenMock).toHaveBeenCalled());
  });

  it("over 在界内(物理坐标÷dpr)→ dragActive;界外/leave → 复位", async () => {
    const onFiles = vi.fn();
    const containerRef = makeContainer();
    const { result } = renderHook(() => useFileDragDrop({ enabled: true, containerRef, onFiles }));
    await waitFor(() => expect(dragCallback).not.toBeNull());

    // 物理 (120, 240) ÷ dpr2 = 逻辑 (60, 120) → 界内
    act(() => dragCallback!({ payload: { type: "over", position: { x: 120, y: 240 } } }));
    expect(result.current.dragActive).toBe(true);

    // 物理 (4, 4) → 逻辑 (2, 2) → 界外
    act(() => dragCallback!({ payload: { type: "over", position: { x: 4, y: 4 } } }));
    expect(result.current.dragActive).toBe(false);

    act(() => dragCallback!({ payload: { type: "over", position: { x: 120, y: 240 } } }));
    act(() => dragCallback!({ payload: { type: "leave" } }));
    expect(result.current.dragActive).toBe(false);
  });

  it("drop 界内:read_local_file 逐路径读回组装 File 调 onFiles;界外丢弃", async () => {
    const onFiles = vi.fn();
    const containerRef = makeContainer();
    renderHook(() => useFileDragDrop({ enabled: true, containerRef, onFiles }));
    await waitFor(() => expect(dragCallback).not.toBeNull());

    act(() =>
      dragCallback!({
        payload: {
          type: "drop",
          position: { x: 120, y: 240 },
          paths: ["/tmp/a.pdf", "C:\\x\\b.png"],
        },
      }),
    );
    await waitFor(() => expect(onFiles).toHaveBeenCalledTimes(1));
    const files = onFiles.mock.calls[0][0] as File[];
    expect(files.map((f) => f.name)).toEqual(["a.pdf", "b.png"]);
    expect(invokeMock).toHaveBeenCalledWith("read_local_file", { path: "/tmp/a.pdf" });

    onFiles.mockClear();
    act(() =>
      dragCallback!({ payload: { type: "drop", position: { x: 4, y: 4 }, paths: ["/tmp/c.pdf"] } }),
    );
    await act(async () => {});
    expect(onFiles).not.toHaveBeenCalled();
  });

  it("单条读取失败跳过,其余照常", async () => {
    const onFiles = vi.fn();
    const containerRef = makeContainer();
    invokeMock.mockImplementation((_cmd, args) => {
      const { path } = args as { path: string };
      return path.endsWith("bad.pdf")
        ? Promise.reject(new Error("dir"))
        : Promise.resolve(new ArrayBuffer(1));
    });
    renderHook(() => useFileDragDrop({ enabled: true, containerRef, onFiles }));
    await waitFor(() => expect(dragCallback).not.toBeNull());

    act(() =>
      dragCallback!({
        payload: {
          type: "drop",
          position: { x: 120, y: 240 },
          paths: ["/tmp/bad.pdf", "/tmp/ok.pdf"],
        },
      }),
    );
    await waitFor(() => expect(onFiles).toHaveBeenCalled());
    expect((onFiles.mock.calls[0][0] as File[]).map((f) => f.name)).toEqual(["ok.pdf"]);
  });

  it("enabled true→false→true 快速切换:unlistenMock 恰被调一次,dragCallback 重新挂上", async () => {
    // 防双订阅回归:false 切回 true 应先退订旧监听再建新监听,unlisten 恰好一次。
    const onFiles = vi.fn();
    const containerRef = makeContainer();
    const { rerender } = renderHook(
      ({ enabled }) => useFileDragDrop({ enabled, containerRef, onFiles }),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(dragCallback).not.toBeNull());
    const firstCallback = dragCallback;

    rerender({ enabled: false });
    // false 时旧订阅应被退订
    await waitFor(() => expect(unlistenMock).toHaveBeenCalledTimes(1));

    rerender({ enabled: true });
    // 重新订阅后 dragCallback 应被替换为新回调
    await waitFor(() => expect(dragCallback).not.toBeNull());
    // unlistenMock 不再多次调用(新订阅未被误退订)
    expect(unlistenMock).toHaveBeenCalledTimes(1);
    // dragCallback 已被替换(新回调被挂上)
    expect(dragCallback).not.toBe(firstCallback);
  });

  it("drop 在途卸载:onFiles 与 toast 均不触发", async () => {
    // read_local_file 在途期间组件卸载,disposed 守卫应阻断回调。
    const onFiles = vi.fn();
    const containerRef = makeContainer();
    const { showToast } = await import("@/components/ui/toast");
    const showToastMock = vi.mocked(showToast);
    showToastMock.mockClear();

    // invoke 返回挂起的 Promise,手动控制 resolve 时机
    let resolveInvoke!: (v: ArrayBuffer) => void;
    invokeMock.mockImplementation(
      () =>
        new Promise<ArrayBuffer>((resolve) => {
          resolveInvoke = resolve;
        }),
    );

    const { unmount } = renderHook(() => useFileDragDrop({ enabled: true, containerRef, onFiles }));
    await waitFor(() => expect(dragCallback).not.toBeNull());

    // 触发 drop(在途:invoke 尚未 resolve)
    act(() =>
      dragCallback!({
        payload: { type: "drop", position: { x: 120, y: 240 }, paths: ["/tmp/x.pdf"] },
      }),
    );

    // 组件卸载(disposed = true)
    unmount();

    // 之后 resolve invoke,驱动 .then 回调
    await act(async () => {
      resolveInvoke(new ArrayBuffer(1));
    });

    // disposed 守卫应阻断:onFiles 和 toast 均不触发
    expect(onFiles).not.toHaveBeenCalled();
    expect(showToastMock).not.toHaveBeenCalled();
  });
});

describe("useFileDragDrop / web 兜底路径", () => {
  it("非 Tauri:webHandlers.onDrop 直接把 DataTransfer.files 交给 onFiles", async () => {
    tauriMock.isTauri = false;
    const onFiles = vi.fn();
    const containerRef = makeContainer();
    const { result } = renderHook(() => useFileDragDrop({ enabled: true, containerRef, onFiles }));
    expect(dragCallback).toBeNull(); // 未走 Tauri 订阅

    const file = new File(["x"], "w.pdf");
    const dropEvent = {
      preventDefault: vi.fn(),
      dataTransfer: { files: [file], types: ["Files"] },
    } as unknown as React.DragEvent<HTMLElement>;
    act(() => result.current.webHandlers.onDrop?.(dropEvent));
    expect(onFiles).toHaveBeenCalledWith([file]);
    expect(result.current.dragActive).toBe(false);
  });

  it("Tauri 下 webHandlers 为空对象(不挂、避免双触发)", () => {
    tauriMock.isTauri = true;
    const containerRef = makeContainer();
    const { result } = renderHook(() =>
      useFileDragDrop({ enabled: true, containerRef, onFiles: vi.fn() }),
    );
    expect(result.current.webHandlers.onDrop).toBeUndefined();
  });
});
