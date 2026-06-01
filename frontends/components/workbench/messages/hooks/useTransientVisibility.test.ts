import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useTransientVisibility } from "./useTransientVisibility";

describe("useTransientVisibility", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders immediately when active", () => {
    const { result } = renderHook(
      ({ active }) => useTransientVisibility(active, { minVisibleMs: 400, fadeMs: 180 }),
      { initialProps: { active: true } },
    );
    expect(result.current.rendered).toBe(true);
    expect(result.current.leaving).toBe(false);
  });

  it("holds for minVisibleMs after going inactive, then fades out", () => {
    const { result, rerender } = renderHook(
      ({ active }) => useTransientVisibility(active, { minVisibleMs: 400, fadeMs: 180 }),
      { initialProps: { active: true } },
    );

    act(() => {
      rerender({ active: false });
    });
    expect(result.current.rendered).toBe(true);
    expect(result.current.leaving).toBe(false);

    act(() => {
      vi.advanceTimersByTime(399);
    });
    expect(result.current.rendered).toBe(true);
    expect(result.current.leaving).toBe(false);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.leaving).toBe(true);
    expect(result.current.rendered).toBe(true);

    act(() => {
      vi.advanceTimersByTime(180);
    });
    expect(result.current.rendered).toBe(false);
    expect(result.current.leaving).toBe(false);
  });

  it("cancels a pending leave when reactivated", () => {
    const { result, rerender } = renderHook(
      ({ active }) => useTransientVisibility(active, { minVisibleMs: 400, fadeMs: 180 }),
      { initialProps: { active: true } },
    );

    act(() => {
      rerender({ active: false });
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    act(() => {
      rerender({ active: true });
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.rendered).toBe(true);
    expect(result.current.leaving).toBe(false);
  });
});
