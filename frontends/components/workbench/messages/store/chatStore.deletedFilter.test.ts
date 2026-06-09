import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Message } from "../data";

// store 与墓碑都是模块级单例;每用例 resetModules 重建整个模块图,保证 chatStore 内部 import 的
// deletedMessages 与本测试 import 的是同一新单例。beforeEach 清 localStorage 隔离持久态。
async function loadStores() {
  vi.resetModules();
  const store = await import("./chatStore");
  const tombstones = await import("./deletedMessages");
  return { store, tombstones };
}

function msg(id: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    conversationId: "c1",
    direction: "in",
    text: id,
    sentAt: "2026-05-19T00:00:00.000Z",
    sortKey: id,
    parts: [{ kind: "text", text: id }],
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("chatStore 数据入口:本地删除墓碑过滤(权威补回以本地为主)", () => {
  it("replaceAuthoritative(塌缩补回路径)过滤掉已本地删除的条目,删了不复活", async () => {
    const { store, tombstones } = await loadStores();
    tombstones.markMessageDeleted("k1", ["m2"]);
    store.useChatStore.getState().replaceAuthoritative("k1", [msg("m1"), msg("m2"), msg("m3")]);
    const order = store
      .selectTimeline(store.useChatStore.getState().conversations["k1"])
      .map((e) => e.id);
    expect(order).toEqual(["m1", "m3"]);
  });

  it("未删除时 replaceAuthoritative 全量进入(不误伤正常消息)", async () => {
    const { store } = await loadStores();
    store.useChatStore.getState().replaceAuthoritative("k1", [msg("m1"), msg("m2")]);
    const order = store
      .selectTimeline(store.useChatStore.getState().conversations["k1"])
      .map((e) => e.id);
    expect(order).toEqual(["m1", "m2"]);
  });

  it("按 requestMessageId 过滤:删在途乐观气泡后,其权威回显补回仍被拦", async () => {
    const { store, tombstones } = await loadStores();
    tombstones.markMessageDeleted("k1", ["local-x"]);
    store.useChatStore
      .getState()
      .replaceAuthoritative("k1", [
        msg("server-9", { direction: "out", requestMessageId: "local-x" }),
        msg("m2"),
      ]);
    const order = store
      .selectTimeline(store.useChatStore.getState().conversations["k1"])
      .map((e) => e.id);
    expect(order).toEqual(["m2"]);
  });

  it("appendNewerWindow(新窗追加路径)过滤掉已删条", async () => {
    const { store, tombstones } = await loadStores();
    store.useChatStore.getState().replaceAuthoritative("k1", [msg("m1")]);
    tombstones.markMessageDeleted("k1", ["m3"]);
    store.useChatStore
      .getState()
      .appendNewerWindow("k1", [msg("m2"), msg("m3")], { atCacheBottom: true });
    const order = store
      .selectTimeline(store.useChatStore.getState().conversations["k1"])
      .map((e) => e.id);
    expect(order).toEqual(["m1", "m2"]);
  });

  it("prependOlder(上翻历史路径)过滤掉已删条", async () => {
    const { store, tombstones } = await loadStores();
    store.useChatStore.getState().replaceAuthoritative("k1", [msg("m5")]);
    tombstones.markMessageDeleted("k1", ["m2"]);
    store.useChatStore.getState().prependOlder("k1", [msg("m1"), msg("m2")], false);
    const order = store
      .selectTimeline(store.useChatStore.getState().conversations["k1"])
      .map((e) => e.id);
    expect(order).toEqual(["m1", "m5"]);
  });

  it("prependOlderWindow(上翻窗口路径)过滤掉已删条", async () => {
    const { store, tombstones } = await loadStores();
    store.useChatStore.getState().replaceAuthoritative("k1", [msg("m5")]);
    tombstones.markMessageDeleted("k1", ["m2"]);
    store.useChatStore
      .getState()
      .prependOlderWindow("k1", [msg("m1"), msg("m2")], { atCacheTop: false });
    const order = store
      .selectTimeline(store.useChatStore.getState().conversations["k1"])
      .map((e) => e.id);
    expect(order).toEqual(["m1", "m5"]);
  });
});
