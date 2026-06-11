import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

import type { ChangeKind, ChangeNotice, ChangeSource } from "./types";

// 被 hook 调用的窗口 API / invoke / 当前员工 / 未读列表,用 vi.hoisted 提到 vi.mock 工厂之前。
const h = vi.hoisted(() => ({
  isFocused: vi.fn<() => Promise<boolean>>(() => Promise.resolve(false)),
  isVisible: vi.fn<() => Promise<boolean>>(() => Promise.resolve(true)),
  requestUserAttention: vi.fn<(t: unknown) => Promise<void>>(() => Promise.resolve()),
  onFocusChanged: vi.fn<(cb: (e: { payload: boolean }) => void) => Promise<() => void>>(() =>
    Promise.resolve(() => {}),
  ),
  invoke: vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>(() => Promise.resolve()),
  employeeId: "emp-1" as string | null,
  items: [] as { unreadCount: number }[],
  playSound: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFocused: h.isFocused,
    isVisible: h.isVisible,
    requestUserAttention: h.requestUserAttention,
    onFocusChanged: h.onFocusChanged,
  }),
  // 对齐 Tauri v2:Critical=1、Informational=2。
  UserAttentionType: { Critical: 1, Informational: 2 },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));

vi.mock("@/lib/api/useRecentFriends", () => ({
  useRecentFriends: () => ({ items: h.items }),
}));

vi.mock("./notificationSound", () => ({
  playNotificationSound: h.playSound,
}));

import { changeBus } from "./changeBus";
import { DEFAULT_SETTINGS, useSettingsStore, type UserSettings } from "./settingsStore";
import {
  shouldFlashTaskbar,
  shouldPlaySound,
  trayUnreadCount,
  useNewMessageFlash,
} from "./useNewMessageFlash";

/** 局部覆盖通知设置(其余默认)。 */
function setNotify(over: Partial<UserSettings["notify"]>) {
  const settings = structuredClone(DEFAULT_SETTINGS);
  Object.assign(settings.notify, over);
  useSettingsStore.setState({ settings, loaded: true });
}

const EMP = "emp-1";
const CRITICAL = 1;

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

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

// dispatch 后 cb 内部是 async IIFE(await isFocused → await isVisible → await requestUserAttention),
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
  h.items = [];
  h.isFocused.mockResolvedValue(false);
  h.isVisible.mockResolvedValue(true);
  useSettingsStore.setState({ settings: structuredClone(DEFAULT_SETTINGS), loaded: true });
});

afterEach(() => {
  // 卸载已挂载的 hook:它们订阅了 settingsStore,后续测试 setState 会把它们唤醒并
  // 重新订阅 changeBus,造成跨用例的幽灵通知(声音/闪烁多次触发)。
  cleanup();
  changeBus._resetForTest();
  vi.clearAllMocks();
});

// ─── 纯逻辑 ──────────────────────────────────────────────────────────────────

describe("trayUnreadCount", () => {
  it("获焦时一律 0(收敛红点),不管多少未读", () => {
    expect(trayUnreadCount(true, 0)).toBe(0);
    expect(trayUnreadCount(true, 5)).toBe(0);
  });
  it("失焦时透传总未读", () => {
    expect(trayUnreadCount(false, 3)).toBe(3);
  });
  it("失焦但无未读 / 负数 → 0", () => {
    expect(trayUnreadCount(false, 0)).toBe(0);
    expect(trayUnreadCount(false, -2)).toBe(0);
  });
});

describe("shouldFlashTaskbar", () => {
  const inbound = { kind: "upsert", source: "server-event" } as const;
  it("服务端新增 + 可见失焦 → 闪", () => {
    expect(shouldFlashTaskbar(inbound, { focused: false, visible: true })).toBe(true);
  });
  it("已获焦 → 不闪", () => {
    expect(shouldFlashTaskbar(inbound, { focused: true, visible: true })).toBe(false);
  });
  it("已隐藏(关到托盘)→ 不闪", () => {
    expect(shouldFlashTaskbar(inbound, { focused: false, visible: false })).toBe(false);
  });
  it("自己发(local-command)→ 不闪", () => {
    expect(
      shouldFlashTaskbar(
        { kind: "upsert", source: "local-command" },
        { focused: false, visible: true },
      ),
    ).toBe(false);
  });
  it("整表重拉(bulk-invalidate)→ 不闪", () => {
    expect(
      shouldFlashTaskbar(
        { kind: "bulk-invalidate", source: "server-event" },
        { focused: false, visible: true },
      ),
    ).toBe(false);
  });
});

// ─── 任务栏轻提示(Informational)─────────────────────────────────────────────

describe("useNewMessageFlash —— 任务栏闪烁", () => {
  it("服务端新消息 + 窗口未获焦(最小化/可见失焦)→ 持续闪烁(Critical)", async () => {
    renderHook(() => useNewMessageFlash(h.employeeId));
    await dispatchAndFlush(notice());
    expect(h.requestUserAttention).toHaveBeenCalledTimes(1);
    expect(h.requestUserAttention).toHaveBeenCalledWith(CRITICAL);
  });

  it("接待列表新消息 + 未获焦 → 闪烁", async () => {
    renderHook(() => useNewMessageFlash(h.employeeId));
    await dispatchAndFlush(notice({ topic: "recent-sessions" }));
    expect(h.requestUserAttention).toHaveBeenCalledTimes(1);
  });

  it("窗口已隐藏(关到托盘)→ 不闪任务栏(只靠托盘红点)", async () => {
    h.isVisible.mockResolvedValue(false);
    renderHook(() => useNewMessageFlash(h.employeeId));
    await dispatchAndFlush(notice());
    expect(h.requestUserAttention).not.toHaveBeenCalled();
  });

  it("窗口已获焦 → 不闪", async () => {
    h.isFocused.mockResolvedValue(true);
    renderHook(() => useNewMessageFlash(h.employeeId));
    await dispatchAndFlush(notice());
    expect(h.requestUserAttention).not.toHaveBeenCalled();
  });

  it("短时间重复通知 → 冷却内只闪一次", async () => {
    renderHook(() => useNewMessageFlash(h.employeeId));
    await dispatchAndFlush(notice());
    await dispatchAndFlush(notice({ occurredAtMs: 1 }));
    expect(h.requestUserAttention).toHaveBeenCalledTimes(1);
  });

  it("自己发(local-command)→ 不闪", async () => {
    renderHook(() => useNewMessageFlash(h.employeeId));
    await dispatchAndFlush(notice({ source: "local-command" as ChangeSource }));
    expect(h.requestUserAttention).not.toHaveBeenCalled();
  });

  it("整表重拉(bulk-invalidate / resync)→ 不闪", async () => {
    renderHook(() => useNewMessageFlash(h.employeeId));
    await dispatchAndFlush(
      notice({ kind: "bulk-invalidate" as ChangeKind, source: "resync" as ChangeSource }),
    );
    expect(h.requestUserAttention).not.toHaveBeenCalled();
  });

  it("未登录(employeeId 空)→ 不订阅、不闪", async () => {
    h.employeeId = null;
    renderHook(() => useNewMessageFlash(h.employeeId));
    await dispatchAndFlush(notice());
    expect(h.requestUserAttention).not.toHaveBeenCalled();
  });
});

// ─── 设置开关(settingsStore.notify)──────────────────────────────────────────

describe("shouldPlaySound", () => {
  it("服务端新增 + 未获焦 → 响(窗口隐藏在托盘也响)", () => {
    expect(shouldPlaySound({ kind: "upsert", source: "server-event" }, { focused: false })).toBe(
      true,
    );
  });
  it("已获焦 → 不响", () => {
    expect(shouldPlaySound({ kind: "upsert", source: "server-event" }, { focused: true })).toBe(
      false,
    );
  });
  it("自己发 / 整表重拉 → 不响", () => {
    expect(shouldPlaySound({ kind: "upsert", source: "local-command" }, { focused: false })).toBe(
      false,
    );
    expect(
      shouldPlaySound({ kind: "bulk-invalidate", source: "server-event" }, { focused: false }),
    ).toBe(false);
  });
});

describe("useNewMessageFlash —— 设置开关", () => {
  it("声音开(默认):服务端新消息 + 未获焦 → 播放提示音(隐藏在托盘也响)", async () => {
    h.isVisible.mockResolvedValue(false); // 关到托盘
    renderHook(() => useNewMessageFlash(h.employeeId));
    await dispatchAndFlush(notice());
    expect(h.playSound).toHaveBeenCalledTimes(1);
  });

  it("声音关 → 不播放", async () => {
    setNotify({ sound: false });
    renderHook(() => useNewMessageFlash(h.employeeId));
    await dispatchAndFlush(notice());
    expect(h.playSound).not.toHaveBeenCalled();
  });

  it("任务栏闪烁关 → 不 requestUserAttention(声音照常)", async () => {
    setNotify({ taskbarFlash: false });
    renderHook(() => useNewMessageFlash(h.employeeId));
    await dispatchAndFlush(notice());
    expect(h.requestUserAttention).not.toHaveBeenCalled();
    expect(h.playSound).toHaveBeenCalledTimes(1);
  });

  it("托盘红点关 → 有未读也 set_tray_unread(0)", async () => {
    setNotify({ trayFlash: false });
    h.items = [{ unreadCount: 3 }];
    h.isFocused.mockResolvedValue(false);
    renderHook(() => useNewMessageFlash(h.employeeId));
    await flush();
    expect(h.invoke).toHaveBeenCalledWith("set_tray_unread", { count: 0 });
    expect(h.invoke).not.toHaveBeenCalledWith("set_tray_unread", { count: 3 });
  });
});

// ─── 托盘红点(set_tray_unread)──────────────────────────────────────────────

describe("useNewMessageFlash —— 托盘红点", () => {
  it("有未读 + 窗口失焦 → set_tray_unread(总未读)", async () => {
    h.items = [{ unreadCount: 2 }, { unreadCount: 1 }];
    h.isFocused.mockResolvedValue(false);
    renderHook(() => useNewMessageFlash(h.employeeId));
    await flush();
    expect(h.invoke).toHaveBeenCalledWith("set_tray_unread", { count: 3 });
  });

  it("窗口获焦 → set_tray_unread(0),不亮红点", async () => {
    h.items = [{ unreadCount: 3 }];
    h.isFocused.mockResolvedValue(true);
    renderHook(() => useNewMessageFlash(h.employeeId));
    await flush();
    expect(h.invoke).toHaveBeenCalledWith("set_tray_unread", { count: 0 });
    expect(h.invoke).not.toHaveBeenCalledWith("set_tray_unread", { count: 3 });
  });
});
