// IME 回车守卫:候选词上屏的"提交回车"必须被吞掉,真正的发送回车必须放行。
// 时间窗用事件自带 timeStamp 判定(不依赖 setTimeout 调度),Windows/macOS 时序一致。

import { describe, expect, it } from "vitest";

import { COMPOSITION_COMMIT_WINDOW_MS, isImeCommitEnter } from "./imeEnterGuard";

function enterEvent(
  overrides: Partial<{ isComposing: boolean; keyCode: number; timeStamp: number }> = {},
) {
  return { isComposing: false, keyCode: 13, timeStamp: 10_000, ...overrides };
}

describe("isImeCommitEnter", () => {
  it("合成中(isComposing)的回车一律判为提交回车", () => {
    expect(isImeCommitEnter(enterEvent({ isComposing: true }), Number.NEGATIVE_INFINITY)).toBe(
      true,
    );
  });

  it("keyCode 229(WebKit 合成期特殊值)一律判为提交回车", () => {
    expect(isImeCommitEnter(enterEvent({ keyCode: 229 }), Number.NEGATIVE_INFINITY)).toBe(true);
  });

  it("compositionend 后时间窗内的回车判为提交回车(搜狗等上屏瞬间 isComposing 已转 false)", () => {
    const compositionEndAt = 10_000;
    const event = enterEvent({ timeStamp: compositionEndAt + COMPOSITION_COMMIT_WINDOW_MS - 1 });
    expect(isImeCommitEnter(event, compositionEndAt)).toBe(true);
  });

  it("时间窗之外的回车放行(用户随后真正按下的发送回车)", () => {
    const compositionEndAt = 10_000;
    const event = enterEvent({ timeStamp: compositionEndAt + COMPOSITION_COMMIT_WINDOW_MS });
    expect(isImeCommitEnter(event, compositionEndAt)).toBe(false);
  });

  it("从未发生过 composition(初始 -Infinity)时回车直接放行", () => {
    expect(isImeCommitEnter(enterEvent({ timeStamp: 1 }), Number.NEGATIVE_INFINITY)).toBe(false);
  });
});
