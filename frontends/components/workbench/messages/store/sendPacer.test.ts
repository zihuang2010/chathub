import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AIMD_FACTOR,
  AIMD_FIRST_BUMP_MS,
  AIMD_MAX_MS,
  AIMD_RECOVER_MS,
  getEffectiveMinIntervalMs,
  getLaneIntervalMs,
  isRetryableSendError,
  noteSendOutcome,
  resetSendPacing,
  runSerialSend,
  sendRetryBackoffMs,
  setSendPacingConfig,
} from "./sendPacer";

const OVERRIDE_KEY = "chathub:send-min-interval-ms";

afterEach(() => {
  resetSendPacing();
  globalThis.localStorage?.removeItem(OVERRIDE_KEY);
  vi.useRealTimers();
});

describe("runSerialSend 同车道一条在途", () => {
  it("B 等 A 完成才开始,严格 FIFO", async () => {
    const events: string[] = [];
    let releaseA!: () => void;
    const aGate = new Promise<void>((r) => {
      releaseA = r;
    });
    const pA = runSerialSend("acc", async () => {
      events.push("A:start");
      await aGate;
      events.push("A:end");
    });
    const pB = runSerialSend("acc", async () => {
      events.push("B:start");
      events.push("B:end");
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["A:start"]); // B 被挡住,A 未完成前不开始

    releaseA();
    await Promise.all([pA, pB]);
    expect(events).toEqual(["A:start", "A:end", "B:start", "B:end"]);
  });

  it("任务抛错不打断队列,下一条照常进行", async () => {
    const events: string[] = [];
    const pA = runSerialSend("acc", async () => {
      events.push("A");
      throw new Error("boom");
    }).catch(() => events.push("A:caught"));
    const pB = runSerialSend("acc", async () => {
      events.push("B");
    });

    await Promise.all([pA, pB]);
    expect(events).toContain("B");
    expect(events.indexOf("A")).toBeLessThan(events.indexOf("B"));
  });

  it("不同车道并发互不阻塞", async () => {
    const events: string[] = [];
    let rel!: () => void;
    const gate = new Promise<void>((r) => {
      rel = r;
    });
    const pA = runSerialSend("acc-1", async () => {
      events.push("A:start");
      await gate; // acc-1 长时间在途
    });
    const pB = runSerialSend("acc-2", async () => {
      events.push("B");
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(events).toContain("B"); // acc-2 不被 acc-1 在途任务挡住

    rel();
    await Promise.all([pA, pB]);
  });

  it("返回任务结果(透传)", async () => {
    await expect(runSerialSend("acc", async () => 42)).resolves.toBe(42);
  });

  it("撞限流后 AIMD gap 拉大,下一条被延迟到 gap 之后", async () => {
    vi.useFakeTimers();
    noteSendOutcome("acc", "rateLimited"); // interval → AIMD_FIRST_BUMP_MS
    const events: string[] = [];
    const pA = runSerialSend("acc", async () => {
      events.push("A");
    });
    const pB = runSerialSend("acc", async () => {
      events.push("B");
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual(["A"]); // A 完成,但 gap 未到,B 还没开始
    await vi.advanceTimersByTimeAsync(AIMD_FIRST_BUMP_MS - 1);
    expect(events).toEqual(["A"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(events).toEqual(["A", "B"]);

    await Promise.all([pA, pB]);
  });
});

describe("noteSendOutcome AIMD 调速", () => {
  it("撞限流乘性增:首次跳 FIRST_BUMP、再乘 FACTOR、封顶 MAX", () => {
    expect(getLaneIntervalMs("acc")).toBe(0);
    noteSendOutcome("acc", "rateLimited");
    expect(getLaneIntervalMs("acc")).toBe(AIMD_FIRST_BUMP_MS); // 0 → 200
    noteSendOutcome("acc", "rateLimited");
    expect(getLaneIntervalMs("acc")).toBe(AIMD_FIRST_BUMP_MS * AIMD_FACTOR); // 200 → 400
    for (let i = 0; i < 20; i += 1) noteSendOutcome("acc", "rateLimited");
    expect(getLaneIntervalMs("acc")).toBe(AIMD_MAX_MS); // 封顶
  });

  it("顺畅加性减,不为负", () => {
    noteSendOutcome("acc", "rateLimited"); // 200
    noteSendOutcome("acc", "ok"); // 200 - 100 = 100
    expect(getLaneIntervalMs("acc")).toBe(AIMD_FIRST_BUMP_MS - AIMD_RECOVER_MS);
    for (let i = 0; i < 20; i += 1) noteSendOutcome("acc", "ok");
    expect(getLaneIntervalMs("acc")).toBe(0);
  });

  it("不同车道 AIMD 状态互相独立", () => {
    noteSendOutcome("a", "rateLimited");
    expect(getLaneIntervalMs("a")).toBe(AIMD_FIRST_BUMP_MS);
    expect(getLaneIntervalMs("b")).toBe(0);
  });
});

describe("getEffectiveMinIntervalMs localStorage 实时覆盖(手动 gap 下限)", () => {
  it("无 override → 用 config 默认(0)", () => {
    expect(getEffectiveMinIntervalMs()).toBe(0);
  });

  it("设合法 override → 覆盖 config(真机调参免重建)", () => {
    globalThis.localStorage.setItem(OVERRIDE_KEY, "800");
    expect(getEffectiveMinIntervalMs()).toBe(800);
  });

  it("非法/空/负 override → 回落 config", () => {
    setSendPacingConfig({ minIntervalMs: 0 });
    globalThis.localStorage.setItem(OVERRIDE_KEY, "abc");
    expect(getEffectiveMinIntervalMs()).toBe(0);
    globalThis.localStorage.setItem(OVERRIDE_KEY, "");
    expect(getEffectiveMinIntervalMs()).toBe(0);
    globalThis.localStorage.setItem(OVERRIDE_KEY, "-5");
    expect(getEffectiveMinIntervalMs()).toBe(0);
  });
});

describe("sendRetryBackoffMs 指数退避", () => {
  it("400/800/1600… 封顶 3000", () => {
    expect(sendRetryBackoffMs(0)).toBe(400);
    expect(sendRetryBackoffMs(1)).toBe(800);
    expect(sendRetryBackoffMs(2)).toBe(1600);
    expect(sendRetryBackoffMs(10)).toBe(3000);
  });
});

describe("isRetryableSendError 限流错误判定", () => {
  it("命中限流类错误 → 可重试", () => {
    expect(isRetryableSendError({ message: "send_message returned http 403" })).toBe(true);
    expect(isRetryableSendError({ msg: "send too fast" })).toBe(true);
    expect(isRetryableSendError({ message: "RATE_LIMITED" })).toBe(true);
    expect(isRetryableSendError("发送过快")).toBe(true);
  });

  it("非限流错误 → 不重试", () => {
    expect(isRetryableSendError({ message: "network timeout" })).toBe(false);
    expect(isRetryableSendError({ message: "send_message returned http 500" })).toBe(false);
    expect(isRetryableSendError({ msg: "同会话已有发送进行中" })).toBe(false); // 会话锁不在限流重试范围
    expect(isRetryableSendError(new Error("boom"))).toBe(false);
    expect(isRetryableSendError({ message: "order 14030 failed" })).toBe(false); // 不误伤含 403 的更长数字
    expect(isRetryableSendError(undefined)).toBe(false);
    expect(isRetryableSendError(null)).toBe(false);
  });
});
