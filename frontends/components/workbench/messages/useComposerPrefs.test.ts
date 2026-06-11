import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import { invoke } from "@tauri-apps/api/core";

import { DEFAULT_SETTINGS, mergeSettings, useSettingsStore } from "@/lib/data/settingsStore";

import { useComposerPrefs } from "./useComposerPrefs";

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS, loaded: false });
  // update_settings:回显合并结果(模拟后端 merge 行为)
  invokeMock.mockImplementation((_cmd, args) => {
    const { patch } = (args ?? {}) as { patch: Parameters<typeof mergeSettings>[1] };
    return Promise.resolve(mergeSettings(useSettingsStore.getState().settings, patch));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useComposerPrefs(settings store 适配层)", () => {
  it("默认值:silent/jumpToNext 均为 false", () => {
    const { result } = renderHook(() => useComposerPrefs());
    expect(result.current.prefs).toEqual({ silent: false, jumpToNext: false, dragDrop: true });
  });

  it("setSilent 走统一设置存储(invoke update_settings)", async () => {
    const { result } = renderHook(() => useComposerPrefs());
    await act(async () => {
      result.current.setSilent(true);
    });
    expect(invokeMock).toHaveBeenCalledWith("update_settings", {
      patch: { composer: { silent: true } },
    });
    expect(result.current.prefs.silent).toBe(true);
  });

  it("跨实例同步:A 写入后 B 自动更新(同一 store)", async () => {
    const a = renderHook(() => useComposerPrefs());
    const b = renderHook(() => useComposerPrefs());
    await act(async () => {
      a.result.current.setSilent(true);
    });
    expect(b.result.current.prefs.silent).toBe(true);
  });

  it("setJumpToNext 不影响 silent(部分更新)", async () => {
    const { result } = renderHook(() => useComposerPrefs());
    await act(async () => {
      result.current.setJumpToNext(true);
    });
    expect(result.current.prefs).toEqual({ silent: false, jumpToNext: true, dragDrop: true });
  });
});
