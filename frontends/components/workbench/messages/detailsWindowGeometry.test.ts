import { describe, expect, it } from "vitest";

import { computeExpandTarget, computeRestoreTarget } from "./detailsWindowGeometry";

describe("computeExpandTarget", () => {
  it("grows by detailsWidth and keeps position when it fits with room to spare", () => {
    const result = computeExpandTarget({
      innerWidth: 1000,
      outerWidth: 1016,
      outerX: 100,
      detailsWidth: 324,
      workArea: { x: 0, width: 1920 },
    });
    expect(result).toEqual({ canGrow: true, targetInnerWidth: 1324, nextX: 100 });
  });

  it("flags canGrow=false when the work area can't fit the wider window", () => {
    const result = computeExpandTarget({
      innerWidth: 1800,
      outerWidth: 1816,
      outerX: 0,
      detailsWidth: 324,
      workArea: { x: 0, width: 1920 },
    });
    expect(result.canGrow).toBe(false);
    // targetInnerWidth still reported, but caller squeezes instead of growing.
    expect(result.targetInnerWidth).toBe(2124);
    expect(result.nextX).toBe(0);
  });

  it("shifts the window left when growing would push the right edge off the work area", () => {
    // Right edge 304+1396=1700; +324 → outer 1720 (≤1920 so canGrow), targetRight
    // 2024 overflows workRight 1920 by 104 → shift left 104.
    const result = computeExpandTarget({
      innerWidth: 1380,
      outerWidth: 1396,
      outerX: 304,
      detailsWidth: 324,
      workArea: { x: 0, width: 1920 },
    });
    expect(result.canGrow).toBe(true);
    expect(result.nextX).toBe(200); // 304 - 104
    expect(result.targetInnerWidth).toBe(1704);
  });

  it("shifts left relative to a non-zero work-area origin", () => {
    // workRight = 100 + 1800 = 1900; targetOuter 1600 (≤1800), targetRight
    // 400+1600=2000 overflows by 100 → shift to 300 (still ≥ workArea.x 100).
    const result = computeExpandTarget({
      innerWidth: 1290,
      outerWidth: 1300,
      outerX: 400,
      detailsWidth: 300,
      workArea: { x: 100, width: 1800 },
    });
    expect(result.canGrow).toBe(true);
    expect(result.nextX).toBe(300);
  });

  it("keeps position unchanged when work area is unknown (browser preview)", () => {
    const result = computeExpandTarget({
      innerWidth: 1000,
      outerWidth: 1016,
      outerX: 100,
      detailsWidth: 324,
      workArea: null,
    });
    expect(result).toEqual({ canGrow: true, targetInnerWidth: 1324, nextX: 100 });
  });
});

describe("computeRestoreTarget", () => {
  it("subtracts only the achieved delta (delta-undo), preserving manual resizes", () => {
    // Opened +324, user then dragged the window +200 wider → current 1524.
    // Close should land at 1524-324 = 1200, keeping the user's +200.
    expect(computeRestoreTarget(1524, 324, 628)).toBe(1200);
  });

  it("returns the exact pre-grow width when the user did not resize", () => {
    expect(computeRestoreTarget(1324, 324, 628)).toBe(1000);
  });

  it("floors at minWidth when delta-undo would shrink below the usable minimum", () => {
    // User dragged the window very narrow while open; subtracting the panel
    // would go below the app's usable min → clamp to the floor.
    expect(computeRestoreTarget(700, 324, 628)).toBe(628);
  });

  it("handles a partial (OS-clamped) achieved delta", () => {
    // Growth was clamped to +100 instead of +324; close undoes exactly +100.
    expect(computeRestoreTarget(1100, 100, 628)).toBe(1000);
  });
});
