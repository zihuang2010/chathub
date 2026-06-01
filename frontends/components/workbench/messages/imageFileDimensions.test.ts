import { afterEach, describe, expect, it, vi } from "vitest";

import { readImageFileDimensions } from "./imageFileDimensions";

describe("readImageFileDimensions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, "createImageBitmap");
  });

  it("uses browser bitmap dimensions for local image files before optimistic send", async () => {
    const close = vi.fn();
    Object.defineProperty(globalThis, "createImageBitmap", {
      value: vi.fn().mockResolvedValue({ width: 640, height: 360, close }),
      configurable: true,
    });
    const file = new File([new Uint8Array([1])], "photo.png", { type: "image/png" });

    await expect(readImageFileDimensions(file)).resolves.toEqual({ width: 640, height: 360 });
    expect(close).toHaveBeenCalled();
  });

  it("returns null for non-image files", async () => {
    const file = new File(["x"], "note.txt", { type: "text/plain" });

    await expect(readImageFileDimensions(file)).resolves.toBeNull();
  });
});
