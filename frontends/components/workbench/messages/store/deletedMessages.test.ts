import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 每个用例重载模块,重置模块级单例(与 useDraftStore.test 同款隔离)。
async function loadStore() {
  vi.resetModules();
  return await import("./deletedMessages");
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("deletedMessages 本地删除墓碑", () => {
  it("markMessageDeleted 后 isMessageDeleted 按 id 命中", async () => {
    const { markMessageDeleted, isMessageDeleted } = await loadStore();
    markMessageDeleted("conv-A", ["msg-1"]);
    expect(isMessageDeleted("conv-A", ["msg-1"])).toBe(true);
    expect(isMessageDeleted("conv-A", ["msg-2"])).toBe(false);
  });

  it("按会话隔离:A 会话的删除不影响 B 会话(防切账号串台)", async () => {
    const { markMessageDeleted, isMessageDeleted } = await loadStore();
    markMessageDeleted("conv-A", ["msg-1"]);
    expect(isMessageDeleted("conv-B", ["msg-1"])).toBe(false);
  });

  it("filterDeletedMessages 过滤掉墓碑消息(按 m.id)", async () => {
    const { markMessageDeleted, filterDeletedMessages } = await loadStore();
    markMessageDeleted("conv-A", ["m2"]);
    const out = filterDeletedMessages("conv-A", [{ id: "m1" }, { id: "m2" }, { id: "m3" }]);
    expect(out.map((m) => m.id)).toEqual(["m1", "m3"]);
  });

  it("filterDeletedMessages 按 requestMessageId 过滤(删在途乐观气泡,权威回显仍拦)", async () => {
    const { markMessageDeleted, filterDeletedMessages } = await loadStore();
    // 删除时这条还是乐观气泡:id=local-x;权威回显 id=server-9, requestMessageId=local-x。
    markMessageDeleted("conv-A", ["local-x"]);
    const out = filterDeletedMessages("conv-A", [
      { id: "server-9", requestMessageId: "local-x" },
      { id: "server-8" },
    ]);
    expect(out.map((m) => m.id)).toEqual(["server-8"]);
  });

  it("undefined 键被忽略,不误标/误匹配", async () => {
    const { markMessageDeleted, isMessageDeleted } = await loadStore();
    markMessageDeleted("conv-A", [undefined, "msg-1", undefined]);
    expect(isMessageDeleted("conv-A", [undefined])).toBe(false);
    expect(isMessageDeleted("conv-A", ["msg-1"])).toBe(true);
  });

  it("持久化:重载模块(模拟重启)后墓碑仍命中", async () => {
    const first = await loadStore();
    first.markMessageDeleted("conv-A", ["msg-1"]);
    // 不清 localStorage:重载模块 → 新内存应从 localStorage 恢复墓碑。
    const second = await loadStore();
    expect(second.isMessageDeleted("conv-A", ["msg-1"])).toBe(true);
  });

  it("localStorage.setItem 抛错时降级为内存,不崩且当次仍生效", async () => {
    const { markMessageDeleted, isMessageDeleted } = await loadStore();
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    expect(() => markMessageDeleted("conv-A", ["msg-1"])).not.toThrow();
    expect(isMessageDeleted("conv-A", ["msg-1"])).toBe(true);
    spy.mockRestore();
  });

  it("每会话 FIFO 上限:超限后最旧墓碑被淘汰", async () => {
    const { markMessageDeleted, isMessageDeleted, MAX_PER_CONVERSATION } = await loadStore();
    // 填满到上限。
    for (let i = 0; i < MAX_PER_CONVERSATION; i++) markMessageDeleted("conv-A", [`m${i}`]);
    expect(isMessageDeleted("conv-A", ["m0"])).toBe(true);
    // 再加一个 → 最旧(m0)被淘汰,新的(overflow)在。
    markMessageDeleted("conv-A", ["overflow"]);
    expect(isMessageDeleted("conv-A", ["m0"])).toBe(false);
    expect(isMessageDeleted("conv-A", ["overflow"])).toBe(true);
  });
});
