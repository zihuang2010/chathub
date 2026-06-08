import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { showToast, ToastViewport } from "./toast";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("toast", () => {
  it("clears the auto-dismiss timer when a toast is manually dismissed", () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");

    render(<ToastViewport />);

    act(() => {
      showToast("发送失败", { type: "error", durationMs: 1000 });
    });

    fireEvent.click(screen.getByLabelText("关闭通知"));

    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
  });
});
