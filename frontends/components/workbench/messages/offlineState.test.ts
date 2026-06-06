import { describe, expect, it } from "vitest";

import type { HubConnectionState } from "@/lib/data/useResource";

import { nextOfflineSticky } from "./offlineState";

const connecting: HubConnectionState = { state: "connecting" };
const subscribed: HubConnectionState = { state: "subscribed" };
const disconnected: HubConnectionState = { state: "disconnected" };
const rejected: HubConnectionState = { state: "rejected", code: "x", message: "y" };

// 把一段连接态序列从初始 false 折叠成最终/逐步的 offline 值。
function fold(seq: Array<HubConnectionState | null>, init = false): boolean[] {
  const out: boolean[] = [];
  let cur = init;
  for (const s of seq) {
    cur = nextOfflineSticky(cur, s);
    out.push(cur);
  }
  return out;
}

describe("nextOfflineSticky", () => {
  it("disconnected / rejected 置离线,subscribed 置在线", () => {
    expect(nextOfflineSticky(false, disconnected)).toBe(true);
    expect(nextOfflineSticky(false, rejected)).toBe(true);
    expect(nextOfflineSticky(true, subscribed)).toBe(false);
  });

  it("connecting / null 维持上一态(不翻转)", () => {
    expect(nextOfflineSticky(true, connecting)).toBe(true);
    expect(nextOfflineSticky(false, connecting)).toBe(false);
    expect(nextOfflineSticky(true, null)).toBe(true);
    expect(nextOfflineSticky(false, null)).toBe(false);
  });

  it("首次连接 connecting → subscribed 全程不误显离线", () => {
    expect(fold([connecting, subscribed])).toEqual([false, false]);
  });

  it("重连序列 disconnected↔connecting 反复跳变期间 offline 恒为 true(不闪)", () => {
    const seq = [
      disconnected, // 断线
      connecting, // 重连尝试
      disconnected, // 失败,退避
      connecting, // 再试
      disconnected,
      connecting,
    ];
    // 关键:首项后即 true,此后整段保持 true —— 没有任何一步回落 false。
    expect(fold(seq)).toEqual([true, true, true, true, true, true]);
  });

  it("重连最终成功:仅在 subscribed 这一步转回在线", () => {
    const seq = [disconnected, connecting, disconnected, connecting, subscribed];
    expect(fold(seq)).toEqual([true, true, true, true, false]);
  });
});
