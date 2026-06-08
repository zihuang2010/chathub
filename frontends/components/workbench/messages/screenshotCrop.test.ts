import { describe, expect, it } from "vitest";

import { computeCropRect, normalizeDisplayRect } from "./screenshotCrop";
import type { ImageBox } from "./screenshotCrop";

describe("normalizeDisplayRect", () => {
  const box: ImageBox = { left: 0, top: 0, width: 1000, height: 500 };

  it("把 client 坐标换算成相对图片左上角的正向矩形", () => {
    expect(normalizeDisplayRect({ x: 100, y: 100 }, { x: 300, y: 200 }, box)).toEqual({
      left: 100,
      top: 100,
      width: 200,
      height: 100,
    });
  });

  it("反向拖拽(终点在起点左上)也归一为正尺寸", () => {
    expect(normalizeDisplayRect({ x: 300, y: 200 }, { x: 100, y: 100 }, box)).toEqual({
      left: 100,
      top: 100,
      width: 200,
      height: 100,
    });
  });

  it("减去图片在视口中的偏移", () => {
    const offset: ImageBox = { left: 50, top: 20, width: 1000, height: 500 };
    expect(normalizeDisplayRect({ x: 150, y: 120 }, { x: 350, y: 220 }, offset)).toEqual({
      left: 100,
      top: 100,
      width: 200,
      height: 100,
    });
  });

  it("超出图片范围的端点夹取到图片边界内", () => {
    expect(normalizeDisplayRect({ x: -50, y: -50 }, { x: 1200, y: 800 }, box)).toEqual({
      left: 0,
      top: 0,
      width: 1000,
      height: 500,
    });
  });
});

describe("computeCropRect", () => {
  it("按缩放系数把渲染像素映射回自然像素(2x)", () => {
    const box: ImageBox = { left: 0, top: 0, width: 1000, height: 500 };
    expect(computeCropRect({ x: 100, y: 100 }, { x: 300, y: 200 }, box, 2000, 1000)).toEqual({
      sx: 200,
      sy: 200,
      sw: 400,
      sh: 200,
    });
  });

  it("叠加图片偏移 + 缩放", () => {
    const box: ImageBox = { left: 50, top: 20, width: 1000, height: 500 };
    expect(computeCropRect({ x: 150, y: 120 }, { x: 350, y: 220 }, box, 2000, 1000)).toEqual({
      sx: 200,
      sy: 200,
      sw: 400,
      sh: 200,
    });
  });

  it("框满整图时输出等于整幅自然尺寸", () => {
    const box: ImageBox = { left: 0, top: 0, width: 1000, height: 500 };
    expect(computeCropRect({ x: -10, y: -10 }, { x: 9999, y: 9999 }, box, 1000, 500)).toEqual({
      sx: 0,
      sy: 0,
      sw: 1000,
      sh: 500,
    });
  });

  it("靠右下边缘时宽高夹取,不越出自然尺寸", () => {
    const box: ImageBox = { left: 0, top: 0, width: 1000, height: 500 };
    const crop = computeCropRect({ x: 900, y: 450 }, { x: 9999, y: 9999 }, box, 1000, 500);
    expect(crop.sx + crop.sw).toBeLessThanOrEqual(1000);
    expect(crop.sy + crop.sh).toBeLessThanOrEqual(500);
    expect(crop).toEqual({ sx: 900, sy: 450, sw: 100, sh: 50 });
  });

  it("图片尺寸为 0(未加载完)时返回零矩形,避免除零", () => {
    const box: ImageBox = { left: 0, top: 0, width: 0, height: 0 };
    expect(computeCropRect({ x: 10, y: 10 }, { x: 50, y: 50 }, box, 1000, 500)).toEqual({
      sx: 0,
      sy: 0,
      sw: 0,
      sh: 0,
    });
  });
});
