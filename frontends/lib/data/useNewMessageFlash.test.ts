import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import type { ChangeKind, ChangeNotice, ChangeSource } from "./types";

// 被 hook 调用的窗口 API + 当前员工 ID,用 vi.hoisted 提到 vi.mock 工厂之前(否则 TDZ)。
const h = vi.hoisted(() => ({
  isFocused: vi.fn<() => Promise<boolean>>(() => Promise.resolve(false)),
  requestUserAttention: vi.fn<(t: unknown) => Promise<void>>(() => Promise.resolve()),
  employeeId: "emp-1" as string | null,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFocused: h.isFocused,
    requestUserAttention: h.requestUserAttention,
  }),
  // 对齐 Tauri v2:Critical=1、Informational=2。
  UserAttentionType: { Critical: 1, Informational: 2 },
}));

vi.mock("./useCurrentEmployeeId", () => ({
  useCurrentEmployeeId: () => h.employeeId,
}));

import { changeBus } from "./changeBus";
import { useNewMessageFlash } from "./useNewMessageFlash";

const EMP = "emp-1";

function notice(over: Partial<ChangeNotice> = {}): ChangeNotice {
  return {
    topic: "conversation-messages",
    scope: { employeeId: EMP },
    kind: "upsert",
    source: "server-event",
    occurredAtMs: 0,
    ...over,
  };
}

// dispatch 后 cb 内部是 async IIFE(await isFocused → await requestUserAttention),
// 多推几轮微任务让其跑完。
async function dispatchAndFlush(n: ChangeNotice): Promise<void> {
  await act(async () => {
    changeBus._dispatchForTest(n);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  h.employeeId = EMP;
  h.isFocused.mockResolvedValue(false);
});

afterEach(() => {
  changeBus._resetForTest();
  vi.clearAllMocks();
});

describe("useNewMessageFlash", () => {
  it("服务端推送的新消息 + 窗口失焦 → 闪烁(Critical)", async () => {
    renderHook(() => useNewMessageFlash());
    await dispatchAndFlush(notice());
    expect(h.requestUserAttention).toHaveBeenCalledTimes(1);
    expect(h.requestUserAttention).toHaveBeenCalledWith(1); // UserAttentionType.Critical
  });

  it("窗口已聚焦 → 不闪", async () => {
    h.isFocused.mockResolvedValue(true);
    renderHook(() => useNewMessageFlash());
    await dispatchAndFlush(notice());
    expect(h.requestUserAttention).not.toHaveBeenCalled();
  });

  it("自己发的消息(local-command) → 不闪", async () => {
    renderHook(() => useNewMessageFlash());
    await dispatchAndFlush(notice({ source: "local-command" as ChangeSource }));
    expect(h.requestUserAttention).not.toHaveBeenCalled();
  });

  it("整表重拉(bulk-invalidate / resync) → 不闪", async () => {
    renderHook(() => useNewMessageFlash());
    await dispatchAndFlush(
      notice({ kind: "bulk-invalidate" as ChangeKind, source: "resync" as ChangeSource }),
    );
    expect(h.requestUserAttention).not.toHaveBeenCalled();
  });

  it("未登录(employeeId 为空) → 不订阅、不闪", async () => {
    h.employeeId = null;
    renderHook(() => useNewMessageFlash());
    await dispatchAndFlush(notice());
    expect(h.requestUserAttention).not.toHaveBeenCalled();
  });
});
