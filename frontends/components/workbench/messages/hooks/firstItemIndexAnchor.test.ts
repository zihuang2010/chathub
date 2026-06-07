import { describe, it, expect } from "vitest";

import { resolvePrependShift, type FirstItemIndexAnchor } from "./firstItemIndexAnchor";

const INITIAL = 1_000_000;

describe("resolvePrependShift", () => {
  it("首次建立锚:无旧锚 + 有消息行 → 锚到最旧消息行,firstItemIndex 不变", () => {
    const prev: FirstItemIndexAnchor = {
      anchorKey: "",
      anchorIndex: -1,
      firstItemIndex: INITIAL,
    };
    expect(resolvePrependShift(prev, ["date-d1-mA", "mA", "mB"], 1)).toEqual({
      anchorKey: "mA",
      anchorIndex: 1,
      firstItemIndex: INITIAL,
      changed: true,
    });
  });

  it("同日 prepend:旧锚下移 2 → firstItemIndex 减 2,重锚到新最旧消息行", () => {
    const prev: FirstItemIndexAnchor = {
      anchorKey: "mA",
      anchorIndex: 1,
      firstItemIndex: INITIAL,
    };
    expect(resolvePrependShift(prev, ["date-d1-mX", "mX", "mY", "mA", "mB"], 1)).toEqual({
      anchorKey: "mX",
      anchorIndex: 1,
      firstItemIndex: 999_998,
      changed: true,
    });
  });

  it("跨日 prepend:旧锚下移 3(多一条日期分隔条) → firstItemIndex 减 3", () => {
    const prev: FirstItemIndexAnchor = {
      anchorKey: "mA",
      anchorIndex: 1,
      firstItemIndex: INITIAL,
    };
    expect(
      resolvePrependShift(prev, ["date-d0-mX", "mX", "mY", "date-d1-mA", "mA", "mB"], 1),
    ).toEqual({
      anchorKey: "mX",
      anchorIndex: 1,
      firstItemIndex: 999_997,
      changed: true,
    });
  });

  it("纯追加:底部新消息、旧锚位置不变 → firstItemIndex 不变、changed=false", () => {
    const prev: FirstItemIndexAnchor = {
      anchorKey: "mA",
      anchorIndex: 1,
      firstItemIndex: INITIAL,
    };
    expect(resolvePrependShift(prev, ["date-d1-mA", "mA", "mB", "mC"], 1)).toEqual({
      anchorKey: "mA",
      anchorIndex: 1,
      firstItemIndex: INITIAL,
      changed: false,
    });
  });

  it("整窗塌缩:旧锚消失(prevNow=-1)→ firstItemIndex 不调整,重锚到新最旧消息行", () => {
    const prev: FirstItemIndexAnchor = {
      anchorKey: "mA",
      anchorIndex: 1,
      firstItemIndex: 999_990,
    };
    expect(resolvePrependShift(prev, ["date-d9-mZ", "mZ", "mW"], 1)).toEqual({
      anchorKey: "mZ",
      anchorIndex: 1,
      firstItemIndex: 999_990,
      changed: true,
    });
  });

  it("未读分隔条插入:同锚 key、位置下移 1 → firstItemIndex 减 1、anchorIndex 更新", () => {
    const prev: FirstItemIndexAnchor = {
      anchorKey: "mA",
      anchorIndex: 1,
      firstItemIndex: INITIAL,
    };
    expect(resolvePrependShift(prev, ["date-d1-mA", "unread-divider", "mA", "mB"], 2)).toEqual({
      anchorKey: "mA",
      anchorIndex: 2,
      firstItemIndex: 999_999,
      changed: true,
    });
  });
});
