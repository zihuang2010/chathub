// assetImageSrc 单元测试
// 核心逻辑：本地路径 → Tauri asset 协议 URL；非 Tauri 或空路径 → undefined

import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  convertFileSrc: (p: string) => `asset://localhost/${encodeURIComponent(p)}`,
}));

import { assetImageSrc } from "./assetImageSrc";

describe("assetImageSrc", () => {
  it("本地路径 → asset URL（包含 asset://localhost/）", () => {
    expect(assetImageSrc("/cache/a.img")).toContain("asset://localhost/");
  });

  it("空值 undefined → undefined", () => {
    expect(assetImageSrc(undefined)).toBeUndefined();
  });

  it("空字符串 → undefined", () => {
    expect(assetImageSrc("")).toBeUndefined();
  });

  it("null → undefined", () => {
    expect(assetImageSrc(null)).toBeUndefined();
  });

  it("路径被 encodeURIComponent 编码后出现在 URL 中", () => {
    const result = assetImageSrc("/path/to/图片.jpg");
    expect(result).toBeDefined();
    expect(result).toContain("asset://localhost/");
  });
});
