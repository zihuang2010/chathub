import { describe, it, expect } from "vitest";

import {
  initialRevealGateState,
  stepRevealGate,
  REVEAL_MAX_FRAMES,
  REVEAL_HARD_MAX_FRAMES,
  type RevealGateInput,
  type RevealGateState,
} from "./scrollRevealGate";

// 逐帧驱动 gate,返回首次揭开的帧下标(-1=给定帧内未揭开)与终态。
function drive(inputs: RevealGateInput[]): { revealFrame: number; state: RevealGateState } {
  let state = initialRevealGateState();
  for (let i = 0; i < inputs.length; i++) {
    const r = stepRevealGate(state, inputs[i]);
    state = r.state;
    if (r.reveal) return { revealFrame: i, state };
  }
  return { revealFrame: -1, state };
}

const frame = (over: Partial<RevealGateInput>): RevealGateInput => ({
  heightVersion: 1,
  measured: true,
  atBottom: false,
  fitsNoScroll: false,
  ...over,
});

describe("stepRevealGate", () => {
  it("测量收敛(版本连续不变)且真实贴底 → 揭开;在收敛前不揭开", () => {
    // frame0 估高版本=1(首测);frame1 版本=2(估高→真实高度修正);frame2/3 版本=2 稳定。
    const { revealFrame } = drive([
      frame({ heightVersion: 1, atBottom: true }),
      frame({ heightVersion: 2, atBottom: true }),
      frame({ heightVersion: 2, atBottom: true }),
      frame({ heightVersion: 2, atBottom: true }),
    ]);
    // 收敛(版本连续 2 帧不变)需到 frame3 才满足 → 此前修正期间不揭开。
    expect(revealFrame).toBe(3);
  });

  it("关键回归:估高首帧已『贴底』但高度仍在逐帧修正(版本一直变)→ 绝不在修正前揭开", () => {
    // 模拟扁平 84px 估高造成的持续修正:每帧 atBottom 都为 true,但 totalListHeightChanged 版本每帧递增。
    const { revealFrame } = drive(
      Array.from({ length: 6 }, (_, i) => frame({ heightVersion: i + 1, atBottom: true })),
    );
    expect(revealFrame).toBe(-1);
  });

  it("内容不足一屏(fitsNoScroll)收敛后揭开,无需贴底", () => {
    const { revealFrame } = drive([
      frame({ heightVersion: 1, fitsNoScroll: true }),
      frame({ heightVersion: 1, fitsNoScroll: true }),
      frame({ heightVersion: 1, fitsNoScroll: true }),
    ]);
    expect(revealFrame).toBe(2);
  });

  it("Scroller 未挂载(measured=false):不推进帧、不消耗兜底额度、不揭开", () => {
    let state = initialRevealGateState();
    for (let i = 0; i < 5; i++) {
      const r = stepRevealGate(state, frame({ measured: false, atBottom: true }));
      state = r.state;
      expect(r.reveal).toBe(false);
    }
    expect(state.frames).toBe(0);
    expect(state.stableFrames).toBe(0);
    expect(state.lastHeightVersion).toBe(-1);
  });

  it("关键回归:高度持续抖动(图片陆续加载)永远 settle 不了、但已真实贴底 → 到 MAX_FRAMES 放宽稳定要求后揭开", () => {
    // 模拟图片陆续加载:totalListHeightChanged 版本每帧递增(永不收敛),但 scrollTop 已贴底。
    const inputs = Array.from({ length: REVEAL_MAX_FRAMES + 2 }, (_, i) =>
      frame({ heightVersion: i + 1, atBottom: true }),
    );
    const { revealFrame } = drive(inputs);
    // frames 在第 i 帧推进到 i+1;i+1 >= REVEAL_MAX_FRAMES 且已贴底 → i = REVEAL_MAX_FRAMES - 1。
    expect(revealFrame).toBe(REVEAL_MAX_FRAMES - 1);
  });

  it("关键回归:从未贴底(react-virtuoso 仍停在 scrollTop:0 渲染周期)→ MAX_FRAMES 兜底绝不揭开,避免露出空白滚动区", () => {
    // scrollTop:0 那一帧 atBottom/fitsNoScroll 恒 false;旧实现会在第 40 帧无视贴底强行揭开 → 空白+滚动条。
    const inputs = Array.from({ length: REVEAL_MAX_FRAMES + 20 }, (_, i) =>
      frame({ heightVersion: i + 1, atBottom: false, fitsNoScroll: false }),
    );
    const { revealFrame } = drive(inputs);
    expect(revealFrame).toBe(-1);
  });

  it("绝对保险:极端卡死(测量永不收敛且从不贴底)达 HARD_MAX 才强制揭开,防永久隐藏", () => {
    const inputs = Array.from({ length: REVEAL_HARD_MAX_FRAMES + 2 }, (_, i) =>
      frame({ heightVersion: i + 1, atBottom: false, fitsNoScroll: false }),
    );
    const { revealFrame } = drive(inputs);
    // frames 在第 i 帧推进到 i+1;i+1 >= REVEAL_HARD_MAX_FRAMES 时揭开 → i = REVEAL_HARD_MAX_FRAMES - 1。
    expect(revealFrame).toBe(REVEAL_HARD_MAX_FRAMES - 1);
  });

  it("已收敛但既不贴底也不满屏 → 不揭开(等真实贴底或兜底)", () => {
    const { revealFrame } = drive(
      Array.from({ length: 5 }, () =>
        frame({ heightVersion: 7, atBottom: false, fitsNoScroll: false }),
      ),
    );
    expect(revealFrame).toBe(-1);
  });
});
