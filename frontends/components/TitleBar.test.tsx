import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TitleBar } from "./TitleBar";

const unlistenMock = vi.fn();
let resolveOnResized: ((unlisten: () => void) => void) | undefined;

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMaximized: vi.fn().mockResolvedValue(false),
    onResized: vi.fn(
      () =>
        new Promise<() => void>((resolve) => {
          resolveOnResized = resolve;
        }),
    ),
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
  }),
}));

vi.mock("@/lib/platform", () => ({
  detectWindows11: vi.fn().mockResolvedValue(false),
  isMac: false,
  isWindows: true,
}));

describe("TitleBar", () => {
  it("unlistens resize handler when async registration resolves after unmount", async () => {
    const view = render(<TitleBar />);

    await waitFor(() => expect(resolveOnResized).toBeTypeOf("function"));
    view.unmount();
    expect(unlistenMock).not.toHaveBeenCalled();

    await act(async () => {
      resolveOnResized?.(unlistenMock);
      await Promise.resolve();
    });

    expect(unlistenMock).toHaveBeenCalledTimes(1);
  });
});
