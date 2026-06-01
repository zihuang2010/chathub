import { describe, expect, it } from "vitest";

import type { Message } from "../data";
import {
  type ChatMessageEntity,
  type ConversationSlice,
  emptySlice,
  enqueueOptimistic,
  MAX_HOT_CONVERSATIONS,
  markFailed,
  markSent,
  prependOlder,
  removeEntity,
  replaceAuthoritative,
  selectTimeline,
  useChatStore,
} from "./chatStore";

function msg(id: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    conversationId: "c1",
    direction: "in",
    text: id,
    sentAt: "2026-05-19T00:00:00.000Z",
    parts: [{ kind: "text", text: id }],
    ...overrides,
  };
}

function optimistic(
  clientMsgId: string,
  overrides: Partial<ChatMessageEntity> = {},
): ChatMessageEntity {
  return {
    ...msg(clientMsgId, { direction: "out", status: "sending" }),
    clientMsgId,
    ...overrides,
  };
}

function sliceWith(entities: ChatMessageEntity[]): ConversationSlice {
  const byId: Record<string, ChatMessageEntity> = {};
  for (const e of entities) byId[e.id] = e;
  return { ...emptySlice(), order: entities.map((e) => e.id), byId };
}

describe("chatStore reducers", () => {
  it("replaceAuthoritative on empty slice yields just the authoritative list in order", () => {
    const next = replaceAuthoritative(emptySlice(), [msg("m1"), msg("m2"), msg("m3")]);
    expect(selectTimeline(next).map((e) => e.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("enqueueOptimistic appends a sending bubble at the end", () => {
    const next = enqueueOptimistic(sliceWith([optimistic("c-1")]), optimistic("c-2"));
    expect(selectTimeline(next).map((e) => e.id)).toEqual(["c-1", "c-2"]);
    expect(next.byId["c-2"].status).toBe("sending");
    expect(next.byId["c-2"].clientMsgId).toBe("c-2");
  });

  it("markSent attaches serverId and flips status to sent", () => {
    const next = markSent(sliceWith([optimistic("c-1")]), "c-1", "server-99", {
      sentAt: "2026-05-19T01:00:00.000Z",
    });
    expect(next.byId["c-1"].status).toBe("sent");
    expect(next.byId["c-1"].serverId).toBe("server-99");
    expect(next.byId["c-1"].sentAt).toBe("2026-05-19T01:00:00.000Z");
  });

  it("markSent is a no-op when clientMsgId is unknown", () => {
    const slice = sliceWith([optimistic("c-1")]);
    expect(markSent(slice, "missing", "x")).toBe(slice);
  });

  it("markSent 竞态:权威回显已先于 markSent 落地时就地塌缩成一行(不留瞬时双行)", () => {
    // 后端重读抢在发送 resp 之前 → replaceAuthoritative 把权威回显(id=server-1)放进切片,
    // 乐观气泡(c-1,serverId 未知)被当作 in-flight 追加在末尾 → 双行(发图抖动根因)。
    // markSent 拿到 server-1 应按 id===serverId 对上权威回显:删乐观、保权威、带 clientMsgId。
    const echo = msg("server-1", { direction: "out", status: "sent" });
    const slice = sliceWith([echo, optimistic("c-1")]);
    const next = markSent(slice, "c-1", "server-1");
    expect(selectTimeline(next).map((e) => e.id)).toEqual(["server-1"]);
    expect(next.byId["c-1"]).toBeUndefined();
    // 行 key 稳定:clientMsgId 带到权威条目;状态收敛为 sent。
    expect(next.byId["server-1"].clientMsgId).toBe("c-1");
    expect(next.byId["server-1"].status).toBe("sent");
  });

  it("markSent 竞态:塌缩含图片的权威回显时保留乐观本地宽高(防尺寸回跳)", () => {
    const echo = msg("server-1", {
      direction: "out",
      status: "sent",
      parts: [{ kind: "image", url: "https://filet.jdd51.com/a.png", width: 901, height: 1599 }],
    });
    const opt = optimistic("c-1", {
      parts: [{ kind: "image", url: "data:image/png;base64,abc", width: 900, height: 1600 }],
    });
    const next = markSent(sliceWith([echo, opt]), "c-1", "server-1");
    expect(next.byId["server-1"].parts).toEqual([
      expect.objectContaining({ kind: "image", width: 900, height: 1600 }),
    ]);
  });

  it("markFailed flips status to failed (keeps bubble for resend)", () => {
    const next = markFailed(sliceWith([optimistic("c-1")]), "c-1");
    expect(next.byId["c-1"].status).toBe("failed");
  });

  it("replaceAuthoritative preserves an in-flight optimistic bubble not yet echoed by server", () => {
    // 本地刚发了 c-1(sending),服务端权威窗口还没包含它 → 必须保留,不能被整窗 REPLACE 抹掉。
    const slice = sliceWith([optimistic("c-1")]);
    const next = replaceAuthoritative(slice, [msg("m1"), msg("m2")]);
    expect(selectTimeline(next).map((e) => e.id)).toEqual(["m1", "m2", "c-1"]);
    expect(next.byId["c-1"].status).toBe("sending");
  });

  it("replaceAuthoritative dedups: optimistic whose serverId is in authoritative is replaced (no double bubble)", () => {
    // markSent 已把 serverId 钉成 server-1;权威列表包含 server-1 → 用权威版本,丢弃乐观副本。
    const sent = optimistic("c-1", { status: "sent", serverId: "server-1" });
    const slice = sliceWith([sent]);
    const next = replaceAuthoritative(slice, [
      msg("server-1", { direction: "out", status: "sent" }),
    ]);
    expect(selectTimeline(next).map((e) => e.id)).toEqual(["server-1"]);
    expect(next.byId["c-1"]).toBeUndefined();
  });

  it("replaceAuthoritative 收敛时把乐观气泡的 clientMsgId 带到权威条目(供稳定 React key,消发图闪)", () => {
    // 发图闪根因:乐观气泡 id=clientMsgId,权威条目 id=serverId;若行 key 跟着 id 由
    // clientMsgId 变 serverId,React 会 remount 整行 → MessageImage 重建走骨架态闪一下。
    // 修法:收敛时把 clientMsgId 带到权威条目,上层据此给一个跨「乐观→权威」稳定的 key。
    const sent = optimistic("c-1", { status: "sent", serverId: "server-1" });
    const next = replaceAuthoritative(sliceWith([sent]), [
      msg("server-1", { direction: "out", status: "sent" }),
    ]);
    expect(next.byId["server-1"].clientMsgId).toBe("c-1");
  });

  it("replaceAuthoritative 对没有乐观来源的历史消息不附加 clientMsgId(key 回退到 id)", () => {
    const next = replaceAuthoritative(emptySlice(), [msg("h1"), msg("h2")]);
    expect(next.byId["h1"].clientMsgId).toBeUndefined();
    expect(next.byId["h2"].clientMsgId).toBeUndefined();
  });

  it("replaceAuthoritative 收敛已发送图片时保留本地已知宽高，防止权威回读缺 meta 后尺寸回跳", () => {
    const sent = optimistic("c-1", {
      status: "sent",
      serverId: "server-1",
      parts: [{ kind: "image", url: "data:image/png;base64,abc", width: 900, height: 1600 }],
    });
    const slice = sliceWith([sent]);

    const next = replaceAuthoritative(slice, [
      msg("server-1", {
        direction: "out",
        status: "sent",
        parts: [{ kind: "image", url: "https://filet.jdd51.com/a.png", width: 901, height: 1599 }],
      }),
    ]);

    expect(next.byId["server-1"].parts).toEqual([
      expect.objectContaining({ kind: "image", width: 900, height: 1600 }),
    ]);
  });

  it("replaceAuthoritative 收敛已发送图片时不让权威宽高覆盖本地稳定占位，避免读尺寸失败后突然变大", () => {
    const sent = optimistic("c-1", {
      status: "sent",
      serverId: "server-1",
      parts: [{ kind: "image", url: "data:image/png;base64,abc" }],
    });
    const slice = sliceWith([sent]);

    const next = replaceAuthoritative(slice, [
      msg("server-1", {
        direction: "out",
        status: "sent",
        parts: [{ kind: "image", url: "https://filet.jdd51.com/a.png", width: 400, height: 1200 }],
      }),
    ]);

    expect(next.byId["server-1"].parts).toEqual([
      expect.objectContaining({ kind: "image", width: undefined, height: undefined }),
    ]);
  });

  it("replaceAuthoritative keeps a sent-but-not-yet-echoed bubble to avoid flicker", () => {
    // markSent 后 serverId=server-1,但权威窗口尚未刷新出 server-1 → 保留乐观副本,避免气泡先消失。
    const sent = optimistic("c-1", { status: "sent", serverId: "server-1" });
    const next = replaceAuthoritative(sliceWith([sent]), [msg("m1")]);
    expect(selectTimeline(next).map((e) => e.id)).toEqual(["m1", "c-1"]);
  });

  it("prependOlder prepends and dedups by id", () => {
    const slice = replaceAuthoritative(emptySlice(), [msg("m3"), msg("m4")]);
    const next = prependOlder(slice, [msg("m1"), msg("m2"), msg("m3")]);
    // m3 已存在,只 prepend m1/m2。
    expect(selectTimeline(next).map((e) => e.id)).toEqual(["m1", "m2", "m3", "m4"]);
  });

  it("prependOlder returns same slice reference when nothing new", () => {
    const slice = replaceAuthoritative(emptySlice(), [msg("m1")]);
    expect(prependOlder(slice, [])).toBe(slice);
    expect(prependOlder(slice, [msg("m1")])).toBe(slice);
  });

  it("removeEntity drops from byId and order", () => {
    const slice = replaceAuthoritative(emptySlice(), [msg("m1"), msg("m2")]);
    const next = removeEntity(slice, "m1");
    expect(selectTimeline(next).map((e) => e.id)).toEqual(["m2"]);
    expect(next.byId["m1"]).toBeUndefined();
  });

  it("selectTimeline returns [] for undefined slice", () => {
    expect(selectTimeline(undefined)).toEqual([]);
  });
});

describe("useChatStore actions", () => {
  it("reset clears all conversations (登出/切员工防串台)", () => {
    useChatStore.getState().reset();
    useChatStore.getState().enqueueOptimistic("c1", optimistic("a"));
    useChatStore.getState().enqueueOptimistic("c2", optimistic("b"));
    expect(Object.keys(useChatStore.getState().conversations)).toHaveLength(2);
    useChatStore.getState().reset();
    expect(useChatStore.getState().conversations).toEqual({});
  });

  it("clearConversation drops only the named slice", () => {
    useChatStore.getState().reset();
    useChatStore.getState().enqueueOptimistic("c1", optimistic("a"));
    useChatStore.getState().enqueueOptimistic("c2", optimistic("b"));
    useChatStore.getState().clearConversation("c1");
    const convs = useChatStore.getState().conversations;
    expect(convs.c1).toBeUndefined();
    expect(convs.c2).toBeDefined();
    useChatStore.getState().reset();
  });

  it("LRU 淘汰:超过上限丢最久未访问的非活跃切片,活跃会话保留", () => {
    useChatStore.getState().reset();
    const total = MAX_HOT_CONVERSATIONS + 5;
    for (let i = 0; i < total; i++) {
      useChatStore.getState().replaceAuthoritative(`conv-${i}`, [msg(`m-${i}`)]);
    }
    const convs = useChatStore.getState().conversations;
    expect(Object.keys(convs)).toHaveLength(MAX_HOT_CONVERSATIONS);
    // 最早的 5 个被淘汰,最近的保留。
    expect(convs["conv-0"]).toBeUndefined();
    expect(convs["conv-4"]).toBeUndefined();
    expect(convs[`conv-${total - 1}`]).toBeDefined();

    // 再次访问最旧仍存活的会话 → 刷新为 MRU,后续淘汰轮不到它。
    const oldestAlive = `conv-5`;
    useChatStore.getState().setLoading(oldestAlive, true);
    useChatStore.getState().replaceAuthoritative("conv-NEW", [msg("m-new")]);
    expect(useChatStore.getState().conversations[oldestAlive]).toBeDefined();
    useChatStore.getState().reset();
  });
});
