import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

// hub:connection 事件回调捕获。
let connectionCb: ((e: { payload: unknown }) => void) | undefined;

vi.mock("@tauri-apps/api/core", () => ({
  // hub_state 初值返回 subscribed,避免初始 null。
  invoke: vi.fn().mockResolvedValue({ state: "subscribed" }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, cb: (e: { payload: unknown }) => void) => {
    if (name === "hub:connection") connectionCb = cb;
    return Promise.resolve(() => {});
  }),
}));

import { useHubSyncStatus } from "./useHubSyncStatus";

beforeEach(() => {
  connectionCb = undefined;
  // 只 fake setTimeout/clearTimeout;setInterval 不 fake,避免 jsdom/testing-library 内部轮询死锁。
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("useHubSyncStatus hub:connection 去抖", () => {
  it("瞬时 disconnected→subscribed(<300ms)不暴露 disconnected", async () => {
    const { result } = renderHook(() => useHubSyncStatus());

    // flush:让 IIFE 里的 await invoke() + await listen() 都完成,connectionCb 被赋值。
    // 因为 setTimeout 被 fake,flushPromises 里用 real setTimeout 不会触发;
    // 改用 vi.runAllTicks() + queueMicrotask 链推进。
    await act(async () => {
      // 推进微任务让 invoke 的 Promise.resolve 回调完成。
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(connectionCb).toBeTypeOf("function");

    act(() => {
      // login stop→start 抖动:先 disconnected。
      connectionCb!({ payload: { state: "disconnected" } });
    });

    // 关键红态断言:去抖实现后 disconnected 不会被立即 set(应仍是 subscribed 初值);
    // 当前无去抖时这里 connectionState 已经是 disconnected → 用例失败(红)。
    expect(result.current.connectionState).toEqual({ state: "subscribed" });

    // 50ms 内来 subscribed,取消挂起的 disconnected。
    act(() => {
      vi.advanceTimersByTime(50);
    });
    act(() => {
      connectionCb!({ payload: { state: "subscribed" } });
    });

    // 等 250ms 窗口过去,确认 disconnected 从未被 set。
    act(() => {
      vi.advanceTimersByTime(300);
    });

    // disconnected 被去抖吃掉,最终态是 subscribed。
    expect(result.current.connectionState).toEqual({ state: "subscribed" });
  });

  it("持续 disconnected 超过去抖窗口后暴露 disconnected", async () => {
    const { result } = renderHook(() => useHubSyncStatus());

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(connectionCb).toBeTypeOf("function");

    act(() => {
      connectionCb!({ payload: { state: "disconnected" } });
    });

    // 超过 250ms 去抖窗口。
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(result.current.connectionState).toEqual({ state: "disconnected" });
  });

  it("subscribed/connecting 立即生效,不被延迟", async () => {
    const { result } = renderHook(() => useHubSyncStatus());

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(connectionCb).toBeTypeOf("function");

    act(() => {
      connectionCb!({ payload: { state: "connecting" } });
    });

    expect(result.current.connectionState).toEqual({ state: "connecting" });
  });
});
