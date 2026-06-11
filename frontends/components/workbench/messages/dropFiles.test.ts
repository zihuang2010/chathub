import { describe, expect, it } from "vitest";

import { classifyDroppedFiles, physicalToLogical, pointInRect } from "./dropFiles";

const f = (name: string) => new File(["x"], name);

describe("classifyDroppedFiles 按扩展名分流", () => {
  it("四组各归其位,大小写不敏感", () => {
    const groups = classifyDroppedFiles([
      f("a.PNG"),
      f("b.pdf"),
      f("c.amr"),
      f("d.exe"),
      f("e.jpeg"),
      f("f.zip"),
    ]);
    expect(groups.images.map((x) => x.name)).toEqual(["a.PNG", "e.jpeg"]);
    expect(groups.docs.map((x) => x.name)).toEqual(["b.pdf", "f.zip"]);
    expect(groups.voices.map((x) => x.name)).toEqual(["c.amr"]);
    expect(groups.unsupported.map((x) => x.name)).toEqual(["d.exe"]);
  });

  it("空数组与无扩展名", () => {
    expect(classifyDroppedFiles([])).toEqual({
      images: [],
      docs: [],
      voices: [],
      unsupported: [],
    });
    expect(classifyDroppedFiles([f("README")]).unsupported).toHaveLength(1);
  });
});

describe("physicalToLogical 物理→逻辑像素", () => {
  it("除以 scale;scale<=0 时原样返回兜底", () => {
    expect(physicalToLogical({ x: 200, y: 100 }, 2)).toEqual({ x: 100, y: 50 });
    expect(physicalToLogical({ x: 200, y: 100 }, 0)).toEqual({ x: 200, y: 100 });
  });
});

describe("pointInRect 含边界", () => {
  const rect = { left: 10, top: 20, right: 110, bottom: 220 };
  it("界内/边界 true,界外 false", () => {
    expect(pointInRect({ x: 60, y: 120 }, rect)).toBe(true);
    expect(pointInRect({ x: 10, y: 20 }, rect)).toBe(true);
    expect(pointInRect({ x: 110, y: 220 }, rect)).toBe(true);
    expect(pointInRect({ x: 9, y: 120 }, rect)).toBe(false);
    expect(pointInRect({ x: 60, y: 221 }, rect)).toBe(false);
  });
});
