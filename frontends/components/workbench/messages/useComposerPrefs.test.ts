import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  loadComposerPrefs,
  saveComposerPrefs,
  useComposerPrefs,
  COMPOSER_PREFS_KEY,
  DEFAULT_PREFS,
} from "./useComposerPrefs";

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("composer prefs persistence", () => {
  it("默认值在没有存储时返回", () => {
    expect(loadComposerPrefs()).toEqual(DEFAULT_PREFS);
  });

  it("写入后读出", () => {
    saveComposerPrefs({ silent: true, jumpToNext: false });
    expect(loadComposerPrefs()).toEqual({ silent: true, jumpToNext: false });
  });

  it("损坏的 JSON 回退默认", () => {
    window.localStorage.setItem(COMPOSER_PREFS_KEY, "not-json");
    expect(loadComposerPrefs()).toEqual(DEFAULT_PREFS);
  });
});

describe("useComposerPrefs hook", () => {
  it("toggle 持久化到 localStorage", () => {
    const { result } = renderHook(() => useComposerPrefs());
    act(() => result.current.setSilent(true));
    expect(loadComposerPrefs().silent).toBe(true);
    expect(result.current.prefs.silent).toBe(true);
  });
});
