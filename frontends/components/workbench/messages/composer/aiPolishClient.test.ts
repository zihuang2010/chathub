// 非 Tauri 环境(isTauri 返回 false)下,streamPolish 走本地 mock 逐字回放:
// 断言 onDelta 多次累加 = 预期前缀文本、最终 onDone;cancel() 后不再触发 onDone。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Tauri 边界 mock:isTauri 假 → 走 mock 分支;invoke/Channel 不应被调用,占位即可。
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: vi.fn(),
  Channel: class {
    onmessage: ((ev: unknown) => void) | null = null;
  },
}));

import { streamPolish } from "./aiPolishClient";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("streamPolish 非 Tauri mock 回放", () => {
  it("逐字 onDelta 累加为「[正式] 原文」并最终 onDone", () => {
    const deltas: string[] = [];
    const onDone = vi.fn();
    const onError = vi.fn();

    streamPolish("你好", "formal", "", {
      onDelta: (t) => deltas.push(t),
      onDone,
      onError,
    });

    // 推进所有定时器,跑完整条流。
    vi.runAllTimers();

    expect(deltas.join("")).toBe("[正式] 你好");
    // 每个字符一次 onDelta(逐字)。
    expect(deltas.length).toBe(Array.from("[正式] 你好").length);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("不同语气使用对应 label 前缀", () => {
    const deltas: string[] = [];
    streamPolish("hi", "concise", "", {
      onDelta: (t) => deltas.push(t),
      onDone: vi.fn(),
      onError: vi.fn(),
    });
    vi.runAllTimers();
    expect(deltas.join("")).toBe("[简洁] hi");
  });

  it("cancel() 后停止回放且不再触发 onDone", () => {
    const deltas: string[] = [];
    const onDone = vi.fn();

    const handle = streamPolish("你好世界", "formal", "", {
      onDelta: (t) => deltas.push(t),
      onDone,
      onError: vi.fn(),
    });

    // 只推进一步,拿到第一个字符后立刻取消。
    vi.advanceTimersByTime(16);
    expect(deltas.length).toBe(1);

    handle.cancel();
    // 取消后即便耗尽所有定时器,也不应再有 delta / done。
    const countAfterCancel = deltas.length;
    vi.runAllTimers();

    expect(deltas.length).toBe(countAfterCancel);
    expect(onDone).not.toHaveBeenCalled();
  });
});
