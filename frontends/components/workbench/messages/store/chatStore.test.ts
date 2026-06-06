import { describe, expect, it } from "vitest";

import { attachmentPreviewUrl } from "@/lib/api/messageHistory";

import type { Message } from "../data";
import {
  appendNewerWindow,
  type ChatMessageEntity,
  type ConversationSlice,
  dropFromBottom,
  dropFromTop,
  emptySlice,
  enqueueOptimistic,
  isUnconvergedOptimistic,
  MAX_HOT_CONVERSATIONS,
  markFailed,
  markSent,
  prependOlder,
  prependOlderWindow,
  removeEntity,
  replaceAuthoritative,
  selectTimeline,
  useChatStore,
  valueEqual,
} from "./chatStore";

function msg(id: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    conversationId: "c1",
    direction: "in",
    text: id,
    sentAt: "2026-05-19T00:00:00.000Z",
    // 权威条目都带 sortKey(窗口边界派生依赖);默认用 id 作 sortKey,顺序与 id 字典序一致。
    sortKey: id,
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
    // 乐观气泡未落库,无后端 sortKey(与生产一致:enqueueOptimistic 不带 sortKey)。
    sortKey: undefined,
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

  it("replaceAuthoritative 竞态:权威出站附件回显抢在 markSent 前落地时,按 objectName 配对收敛(消双行)", () => {
    // 发图收敛双行根因:权威重读(读本地缓存极快)抢在 markSent 钉 serverId 之前落地,权威图片
    // 回显(id=server-1,无 clientMsgId)作新行插入、乐观气泡(serverId 未钉)被当 in-flight 追加
    // → 同一条图片瞬时两行、整列上下跳。修法:用 objectName(乐观 filePath ↔ 权威 part.url)确定性
    // 配对,提前带 clientMsgId 并收敛掉乐观副本 → 行 key 不变、无双行,且与 markSent 时序无关。
    const opt = optimistic("c-1", {
      filePath: "chat/obj-1.jpg",
      parts: [{ kind: "image", url: "data:image/png;base64,abc", width: 900, height: 1600 }],
    });
    const auth = msg("server-1", {
      direction: "out",
      status: "sent",
      parts: [
        { kind: "image", url: attachmentPreviewUrl("chat/obj-1.jpg"), width: 901, height: 1599 },
      ],
    });
    const next = replaceAuthoritative(sliceWith([opt]), [auth]);
    // 收敛成一行(无瞬时双行),clientMsgId 带到权威条目稳住跨「乐观→权威」行 key。
    expect(selectTimeline(next).map((e) => e.id)).toEqual(["server-1"]);
    expect(next.byId["c-1"]).toBeUndefined();
    expect(next.byId["server-1"].clientMsgId).toBe("c-1");
    // 复用 preserveOptimisticImageDimensions:权威条目沿用乐观本地宽高,防尺寸回跳。
    expect(next.byId["server-1"].parts).toEqual([
      expect.objectContaining({ kind: "image", width: 900, height: 1600 }),
    ]);
  });

  it("replaceAuthoritative 竞态:objectName 不匹配的权威出站附件不误收敛乐观气泡(保留在飞气泡)", () => {
    // 回归保护:配对必须按 objectName 等值命中,不能把无关的权威出站消息吞掉本地在飞气泡。
    const opt = optimistic("c-1", {
      filePath: "chat/obj-1.jpg",
      parts: [{ kind: "image", url: "data:image/png;base64,abc" }],
    });
    const other = msg("server-9", {
      direction: "out",
      status: "sent",
      parts: [{ kind: "image", url: attachmentPreviewUrl("chat/other.jpg") }],
    });
    const next = replaceAuthoritative(sliceWith([opt]), [other]);
    expect(selectTimeline(next).map((e) => e.id)).toEqual(["server-9", "c-1"]);
    expect(next.byId["c-1"].status).toBe("sending");
  });

  it("replaceAuthoritative 竞态:权威出站文本回显抢在 markSent 前落地时,按内容配对收敛(消双行)", () => {
    // 图+文串行发送,文本最后才发(等图片上传完),其权威重读可能抢在 markSent 钉 serverId 之前
    // 落地。文本无 objectName 可配,旧实现把权威回显(id=server-1,无 clientMsgId)作新行插入、
    // 乐观气泡(serverId 未钉)当 in-flight 追加 → 瞬时双行,条数 N→N+1 触发贴底跟随猛挪一下。
    // 修法:对在途纯文本乐观气泡按「方向 out + 纯文本 + 内容相等」FIFO 配对,同次收敛掉、带 clientMsgId。
    const opt = optimistic("c-1", { text: "123456", parts: [{ kind: "text", text: "123456" }] });
    const auth = msg("server-1", {
      direction: "out",
      status: "sent",
      text: "123456",
      parts: [{ kind: "text", text: "123456" }],
    });
    const next = replaceAuthoritative(sliceWith([opt]), [auth]);
    // 收敛成一行(无瞬时双行),clientMsgId 带到权威条目稳住跨「乐观→权威」行 key。
    expect(selectTimeline(next).map((e) => e.id)).toEqual(["server-1"]);
    expect(next.byId["c-1"]).toBeUndefined();
    expect(next.byId["server-1"].clientMsgId).toBe("c-1");
  });

  it("replaceAuthoritative 竞态:不同文本的新权威出站消息不误收敛在途乐观文本(保留双方)", () => {
    // 回归保护:文本配对必须内容等值,不能把无关的权威出站文本吞掉本地在飞文本气泡。
    const opt = optimistic("c-1", { text: "123456", parts: [{ kind: "text", text: "123456" }] });
    const other = msg("server-9", {
      direction: "out",
      status: "sent",
      text: "你好",
      parts: [{ kind: "text", text: "你好" }],
    });
    const next = replaceAuthoritative(sliceWith([opt]), [other]);
    expect(selectTimeline(next).map((e) => e.id)).toEqual(["server-9", "c-1"]);
    expect(next.byId["c-1"].status).toBe("sending");
  });

  it("replaceAuthoritative 竞态:已失败的乐观文本不被同内容权威回显内容匹配吞掉", () => {
    // 回归保护:仅在途(status==="sending")的乐观气泡参与内容配对;失败气泡须保留供重发。
    const failed = optimistic("c-1", {
      status: "failed",
      text: "123456",
      parts: [{ kind: "text", text: "123456" }],
    });
    const auth = msg("server-1", {
      direction: "out",
      status: "sent",
      text: "123456",
      parts: [{ kind: "text", text: "123456" }],
    });
    const next = replaceAuthoritative(sliceWith([failed]), [auth]);
    expect(selectTimeline(next).map((e) => e.id)).toEqual(["server-1", "c-1"]);
    expect(next.byId["c-1"].status).toBe("failed");
  });

  it("replaceAuthoritative 确定性配对:权威出站行带 requestMessageId 命中乐观 clientMsgId → 收敛成一行(不双行)", () => {
    // send 改造后权威行经 push 稍后到达,serverId(markSent)尚未钉上时,靠服务端把发送时的
    // clientMsgId 经 request_message_id 落库带回的 requestMessageId 做确定性配对:权威条目
    // requestMessageId == 乐观气泡 clientMsgId 即唯一命中,收敛成一行、clientMsgId 带到权威条目。
    const opt = optimistic("local-uuid-1", {
      text: "你好",
      parts: [{ kind: "text", text: "你好" }],
    });
    const auth = msg("server-1", {
      direction: "out",
      status: "sent",
      text: "你好",
      parts: [{ kind: "text", text: "你好" }],
      requestMessageId: "local-uuid-1",
    });
    const next = replaceAuthoritative(sliceWith([opt]), [auth]);
    expect(selectTimeline(next).map((e) => e.id)).toEqual(["server-1"]);
    expect(next.byId["local-uuid-1"]).toBeUndefined();
    expect(next.byId["server-1"].clientMsgId).toBe("local-uuid-1");
  });

  it("replaceAuthoritative 确定性配对优先于启发式:requestMessageId 错配时不被同文本误吞,正确配对各自命中", () => {
    // 两条同文本乐观气泡在途,权威各带不同 requestMessageId → 必须按 requestMessageId 精确各归各位,
    // 不能退化为启发式 FIFO 把顺序配错。验证确定性路径先于文本启发式生效。
    const a = optimistic("local-A", { text: "同文本", parts: [{ kind: "text", text: "同文本" }] });
    const b = optimistic("local-B", { text: "同文本", parts: [{ kind: "text", text: "同文本" }] });
    const authForB = msg("server-B", {
      direction: "out",
      status: "sent",
      text: "同文本",
      parts: [{ kind: "text", text: "同文本" }],
      requestMessageId: "local-B",
    });
    // 权威列表只回来 B 的回显(A 还在途)。确定性配对必须命中 local-B 而非 FIFO 误配 local-A。
    const next = replaceAuthoritative(sliceWith([a, b]), [authForB]);
    expect(next.byId["server-B"].clientMsgId).toBe("local-B");
    // local-B 被收敛删除;local-A 仍在途保留(未被错配吞掉)。
    expect(next.byId["local-B"]).toBeUndefined();
    expect(next.byId["local-A"]?.status).toBe("sending");
    expect(selectTimeline(next).map((e) => e.id)).toEqual(["server-B", "local-A"]);
  });

  it("replaceAuthoritative:失败气泡按 sentAt 归位,晚于它发送成功的消息排在其下方(不被顶到末尾)", () => {
    // 先发 c-1(t0)失败,停一会再发的消息成功落库 → 权威重读把成功消息(server-2,t2)带进窗口,
    // 但不含从未到服务端的 c-1。旧实现把 c-1 一律追加末尾 → 失败气泡被后发的成功消息顶到下面。
    // 期望按 sentAt:c-1(t0)在 server-2(t2)之上。
    const failed = optimistic("c-1", {
      status: "failed",
      sentAt: "2026-05-19T00:00:00.000Z",
      text: "先发失败",
      parts: [{ kind: "text", text: "先发失败" }],
    });
    const next = replaceAuthoritative(sliceWith([failed]), [
      msg("m0", { sentAt: "2026-05-18T23:59:00.000Z" }),
      msg("server-2", {
        direction: "out",
        status: "sent",
        sentAt: "2026-05-19T00:00:10.000Z",
        text: "后发成功",
        parts: [{ kind: "text", text: "后发成功" }],
      }),
    ]);
    expect(selectTimeline(next).map((e) => e.id)).toEqual(["m0", "c-1", "server-2"]);
    expect(next.byId["c-1"].status).toBe("failed");
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

  it("replaceAuthoritative:已显示之后到达的迟到入站消息追加到底部,不按服务端时间插进中间(单调插入)", () => {
    // m1,m2,s-out 已显示;随后对方一条迟到入站 m-late 落库,其服务端 sort_key 排在 s-out 之前。
    // 旧实现照搬服务端数组顺序 → m-late 插到 s-out 上方,像凭空插进历史中间、易漏看。
    // 单调插入:已显示的保位,本批第一次出现的 m-late 追加到底部。
    const slice = sliceWith([msg("m1"), msg("m2"), msg("s-out", { direction: "out" })]);
    const next = replaceAuthoritative(slice, [
      msg("m1"),
      msg("m2"),
      msg("m-late", { direction: "in" }),
      msg("s-out", { direction: "out" }),
    ]);
    expect(selectTimeline(next).map((e) => e.id)).toEqual(["m1", "m2", "s-out", "m-late"]);
  });

  it("replaceAuthoritative:权威把刚发的出站消息排到已显示消息之前时,本端保位不跳(收敛仍贴底)", () => {
    // a(in) 已显示;本端发 c-1(乐观,贴底)。权威回读把出站 s-1(经 requestMessageId 收敛 c-1)
    // 按服务端时间排到 a 之前。旧实现 → [s-1, a],自己刚发的气泡跳到 a 上方;期望保位 → [a, s-1]。
    const slice = sliceWith([msg("a", { direction: "in" }), optimistic("c-1")]);
    const next = replaceAuthoritative(slice, [
      msg("s-1", { direction: "out", status: "sent", requestMessageId: "c-1" }),
      msg("a", { direction: "in" }),
    ]);
    expect(selectTimeline(next).map((e) => e.id)).toEqual(["a", "s-1"]);
    expect(next.byId["s-1"].clientMsgId).toBe("c-1");
    expect(next.byId["c-1"]).toBeUndefined();
  });

  it("replaceAuthoritative:同一时刻两条消息的相对顺序稳定,不被权威翻序重排", () => {
    // x,y 已显示(同 sentAt)。权威回读把二者翻序返回 [y,x](同毫秒 tiebreak 不稳)。
    // 旧实现照搬 → [y,x] 抖动;期望保位 → 维持 [x,y]。
    const slice = sliceWith([msg("x"), msg("y")]);
    const next = replaceAuthoritative(slice, [msg("y"), msg("x")]);
    expect(selectTimeline(next).map((e) => e.id)).toEqual(["x", "y"]);
  });

  // ── 内容等价短路:消除「重读到完全相同数据」触发的整窗 re-render ──────────────
  it("replaceAuthoritative:内容等价的重读复用原 slice 引用(无变化 → 渲染端零 re-render)", () => {
    const slice = replaceAuthoritative(emptySlice(), [msg("m1"), msg("m2")]);
    // 同样的权威输入再读一次:byId/order 一字未变 → 必须返回同一引用,Zustand selector 才跳过。
    expect(replaceAuthoritative(slice, [msg("m1"), msg("m2")])).toBe(slice);
  });

  it("replaceAuthoritative:status 变化(sending→sent)返回新引用(防过度短路)", () => {
    const slice = replaceAuthoritative(emptySlice(), [
      msg("s1", { direction: "out", status: "sending" }),
    ]);
    const next = replaceAuthoritative(slice, [msg("s1", { direction: "out", status: "sent" })]);
    expect(next).not.toBe(slice);
    expect(next.byId["s1"].status).toBe("sent");
  });

  it("replaceAuthoritative:text 变化返回新引用(防过度短路)", () => {
    const slice = replaceAuthoritative(emptySlice(), [msg("m1", { text: "旧" })]);
    expect(replaceAuthoritative(slice, [msg("m1", { text: "新" })])).not.toBe(slice);
  });

  it("replaceAuthoritative:isRecalled 变化返回新引用(防过度短路)", () => {
    const slice = replaceAuthoritative(emptySlice(), [msg("m1")]);
    expect(replaceAuthoritative(slice, [msg("m1", { isRecalled: true })])).not.toBe(slice);
  });

  it("replaceAuthoritative:order 增减一条返回新引用(防过度短路)", () => {
    const slice = replaceAuthoritative(emptySlice(), [msg("m1")]);
    expect(replaceAuthoritative(slice, [msg("m1"), msg("m2")])).not.toBe(slice);
  });

  it("失败行 leftover 时,不被已显示的后发成功行(knownAuth)顶到下方(治沉底)", () => {
    const slice = sliceWith([
      optimistic("c-1", {
        status: "failed",
        sentAt: "2026-05-19T00:00:00.000Z",
        text: "先发失败",
        parts: [{ kind: "text", text: "先发失败" }],
      }),
      optimistic("c-2", {
        status: "sent",
        serverId: "server-2",
        sentAt: "2026-05-19T00:00:10.000Z",
        text: "后发成功",
        parts: [{ kind: "text", text: "后发成功" }],
      }),
    ]);
    const next = replaceAuthoritative(slice, [
      msg("server-2", {
        direction: "out",
        status: "sent",
        sentAt: "2026-05-19T00:00:10.000Z",
        text: "后发成功",
        parts: [{ kind: "text", text: "后发成功" }],
      }),
    ]);
    expect(selectTimeline(next).map((e) => e.id)).toEqual(["c-1", "server-2"]);
    expect(next.byId["c-1"].status).toBe("failed");
  });

  it("反例护栏:失败行 sentAt 落在已显示历史中段,无关重读不顶动已显示的真实消息", () => {
    const slice = sliceWith([
      msg("h0", { sentAt: "2026-05-19T00:00:00.000Z" }),
      optimistic("c-1", {
        status: "failed",
        sentAt: "2026-05-19T00:00:05.000Z",
        text: "A",
        parts: [{ kind: "text", text: "A" }],
      }),
      msg("S", { direction: "out", status: "sent", sentAt: "2026-05-19T00:00:10.000Z" }),
    ]);
    const next = replaceAuthoritative(slice, [
      msg("h0", { sentAt: "2026-05-19T00:00:00.000Z" }),
      msg("S", { direction: "out", status: "sent", sentAt: "2026-05-19T00:00:10.000Z" }),
    ]);
    expect(selectTimeline(next).map((e) => e.id)).toEqual(["h0", "c-1", "S"]);
  });
});

// ─── Stage C 数据窗口化:窗口 reducer + 缝合 UPSERT ────────────────────────────────────
//
// 用 emptySlice 兜底所有窗口字段;sliceWith 已沿用 emptySlice 默认(atCacheBottom=true 等)。
// 窗口边界由 reducer 从 order 两端有 sortKey 实体派生,测试只需断言派生结果与 atCacheTop/Bottom。

describe("isUnconvergedOptimistic 判据", () => {
  it("乐观在途/失败(有 clientMsgId、无 serverId)= true;权威/已收敛 = false", () => {
    expect(isUnconvergedOptimistic(optimistic("c-1"))).toBe(true);
    expect(isUnconvergedOptimistic(optimistic("c-1", { status: "failed" }))).toBe(true);
    // 已 markSent 钉 serverId(待回显)→ 已收敛在即,不算未收敛乐观。
    expect(isUnconvergedOptimistic(optimistic("c-1", { status: "sent", serverId: "s-1" }))).toBe(
      false,
    );
    // 权威条目(无 clientMsgId)。
    expect(isUnconvergedOptimistic(msg("m1") as ChatMessageEntity)).toBe(false);
    expect(isUnconvergedOptimistic(undefined)).toBe(false);
  });
});

describe("appendNewerWindow(尾部追加更新页)", () => {
  it("尾部追加去重、不重排,更新 windowNewestSortKey + atCacheBottom", () => {
    const slice = sliceWith([msg("m1"), msg("m2")]);
    const next = appendNewerWindow(slice, [msg("m2"), msg("m3"), msg("m4")], {
      atCacheBottom: true,
    });
    // m2 已在窗口内 → 去重;m3/m4 升序追加,不重排。
    expect(selectTimeline(next).map((e) => e.id)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(next.windowNewestSortKey).toBe("m4");
    expect(next.atCacheBottom).toBe(true);
  });

  it("新页插在未收敛乐观尾部之前(乐观气泡永远贴最底)", () => {
    const slice = sliceWith([msg("m1"), optimistic("c-opt")]);
    const next = appendNewerWindow(slice, [msg("m2")], { atCacheBottom: false });
    // m2 插在乐观气泡 c-opt 之前。
    expect(selectTimeline(next).map((e) => e.id)).toEqual(["m1", "m2", "c-opt"]);
    expect(next.windowNewestSortKey).toBe("m2");
    expect(next.atCacheBottom).toBe(false);
  });

  it("中段失败乐观气泡:新页插在最后一个真实条目之后,中段乐观保位、较新页不错序", () => {
    // failed 乐观气泡按 sentAt 归位可落在 real 中段(m1 与 m2 之间)。append [m3] 必须插在「最后一个
    // 有 sortKey 的真实条目 m2」之后,而非「第一个乐观 c-fail」之前(后者会把 m3 排到 m2 之前 → 错序)。
    const slice = sliceWith([msg("m1"), optimistic("c-fail", { status: "failed" }), msg("m2")]);
    const next = appendNewerWindow(slice, [msg("m3")], { atCacheBottom: false });
    expect(selectTimeline(next).map((e) => e.id)).toEqual(["m1", "c-fail", "m2", "m3"]);
    expect(next.windowNewestSortKey).toBe("m3");
  });

  it("无新增且 meta 未变 → 复用原 slice 引用", () => {
    const slice = sliceWith([msg("m1"), msg("m2")]);
    // 全部已存在 + 不带 meta(视为不改边界)→ 复用引用。
    expect(appendNewerWindow(slice, [msg("m1")], {})).toBe(slice);
  });
});

describe("prependOlderWindow(头部 prepend 更旧页)", () => {
  it("复用 prependOlder 去重 + prepend,更新 windowOldestSortKey + atCacheTop", () => {
    const slice = sliceWith([msg("m3"), msg("m4")]);
    const next = prependOlderWindow(slice, [msg("m1"), msg("m2"), msg("m3")], { atCacheTop: true });
    expect(selectTimeline(next).map((e) => e.id)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(next.windowOldestSortKey).toBe("m1");
    expect(next.atCacheTop).toBe(true);
  });

  it("空(无新增)且 meta 未变 → 复用原 slice 引用", () => {
    const slice = sliceWith([msg("m1")]);
    expect(prependOlderWindow(slice, [], {})).toBe(slice);
    expect(prependOlderWindow(slice, [msg("m1")], {})).toBe(slice);
  });
});

describe("dropFromTop(裁头部最旧)", () => {
  it("删头 n 条,更新 windowOldestSortKey,atCacheTop=false", () => {
    const slice = sliceWith([msg("m1"), msg("m2"), msg("m3")]);
    const next = dropFromTop(slice, 2);
    expect(selectTimeline(next).map((e) => e.id)).toEqual(["m3"]);
    expect(next.byId["m1"]).toBeUndefined();
    expect(next.byId["m2"]).toBeUndefined();
    expect(next.windowOldestSortKey).toBe("m3");
    // 裁了头,顶部之上必有更旧。
    expect(next.atCacheTop).toBe(false);
  });

  it("n<=0 复用引用", () => {
    const slice = sliceWith([msg("m1")]);
    expect(dropFromTop(slice, 0)).toBe(slice);
  });
});

describe("dropFromBottom(裁尾部较新真实行,绝不裁未收敛乐观尾部)", () => {
  it("核心约束:order=[real, real, opt-sending],裁紧贴乐观尾部的真实行、绝不裁乐观", () => {
    // 请求裁 1:裁掉紧贴乐观尾部的较新真实行 m2(离上滚视口最远),保 m1 + 乐观气泡。
    const slice = sliceWith([msg("m1"), msg("m2"), optimistic("c-opt")]);
    const next = dropFromBottom(slice, 1);
    expect(selectTimeline(next).map((e) => e.id)).toEqual(["m1", "c-opt"]);
    expect(next.byId["m2"]).toBeUndefined();
    expect(next.byId["c-opt"]).toBeDefined();
    // 边界从裁后有 sortKey 实体派生(m1);atCacheBottom=false。
    expect(next.windowNewestSortKey).toBe("m1");
    expect(next.atCacheBottom).toBe(false);
  });

  it("核心约束:请求条数 ≥ 真实行数时,裁光真实尾部但乐观气泡仍保留(永不可裁)", () => {
    // 裁 2(= 全部真实行):m1/m2 都可裁(在 SQLite、可恢复);乐观 c-opt 不在 SQLite,绝不裁。
    const slice = sliceWith([msg("m1"), msg("m2"), optimistic("c-opt")]);
    const next = dropFromBottom(slice, 2);
    expect(selectTimeline(next).map((e) => e.id)).toEqual(["c-opt"]);
    expect(next.byId["c-opt"]).toBeDefined();
  });

  it("失败乐观气泡同样不可裁(不在 SQLite、裁了不可恢复)", () => {
    const slice = sliceWith([msg("m1"), msg("m2"), optimistic("c-fail", { status: "failed" })]);
    const next = dropFromBottom(slice, 5);
    // 只能裁乐观之前的真实尾部 m1/m2;乐观失败气泡 c-fail 保留。
    expect(selectTimeline(next).map((e) => e.id)).toEqual(["c-fail"]);
    expect(next.byId["c-fail"]).toBeDefined();
  });

  it("中段失败乐观气泡:逐条跳过任意位置乐观,裁两侧真实行而绝不裁中段乐观", () => {
    // failed 乐观 c-fail 落在 real 中段。dropFromBottom(3) 从尾逐条裁真实行(m3/m2/m1,均在 SQLite
    // 可恢复)、跳过中段乐观 c-fail。旧「遇尾部第一个乐观即停」会漏裁 m1、错留 [m1, c-fail]。
    const slice = sliceWith([
      msg("m1"),
      optimistic("c-fail", { status: "failed" }),
      msg("m2"),
      msg("m3"),
    ]);
    const next = dropFromBottom(slice, 3);
    expect(selectTimeline(next).map((e) => e.id)).toEqual(["c-fail"]);
    expect(next.byId["c-fail"]).toBeDefined();
  });

  it("纯真实尾部:dropFromBottom(2) 裁掉最新 2 条,更新 windowNewestSortKey,atCacheBottom=false", () => {
    const slice = sliceWith([msg("m1"), msg("m2"), msg("m3")]);
    const next = dropFromBottom(slice, 2);
    expect(selectTimeline(next).map((e) => e.id)).toEqual(["m1"]);
    expect(next.windowNewestSortKey).toBe("m1");
    expect(next.atCacheBottom).toBe(false);
  });

  it("全是未收敛乐观(无可裁真实尾部)→ 复用引用", () => {
    const slice = sliceWith([optimistic("c-1"), optimistic("c-2")]);
    expect(dropFromBottom(slice, 2)).toBe(slice);
  });

  it("n<=0 复用引用", () => {
    const slice = sliceWith([msg("m1")]);
    expect(dropFromBottom(slice, 0)).toBe(slice);
  });
});

describe("replaceAuthoritative collapseToLatest=false(缝合 UPSERT,不丢上滚历史)", () => {
  it("① 窗口内条目 status UPSERT 不丢上滚历史:order 长度不变、上滚旧 id 仍在、status 就地更新", () => {
    // 上滚窗口 [m1..m3](非贴底),其中 m2 是出站 sending。缝合重读带来 m2 已变 sent。
    const slice = sliceWith([
      msg("m1"),
      msg("m2", { direction: "out", status: "sending" }),
      msg("m3"),
    ]);
    const next = replaceAuthoritative(
      slice,
      [msg("m2", { direction: "out", status: "sent" })],
      false,
    );
    // order 不变(不丢上滚历史),m2 status 就地升级。
    expect(selectTimeline(next).map((e) => e.id)).toEqual(["m1", "m2", "m3"]);
    expect(next.byId["m2"].status).toBe("sent");
  });

  it("② 区间外较新权威条目不并入(它们留在 SQLite,下滚 loadNewer 再取)", () => {
    // 窗口区间 [m1, m3];权威重读带来一条 sortKey=m9 的较新入站消息 → 越界,不并入。
    const slice = sliceWith([msg("m1"), msg("m2"), msg("m3")]);
    const next = replaceAuthoritative(
      slice,
      [msg("m1"), msg("m2"), msg("m3"), msg("m9", { sortKey: "m9" })],
      false,
    );
    expect(selectTimeline(next).map((e) => e.id)).toEqual(["m1", "m2", "m3"]);
    expect(next.byId["m9"]).toBeUndefined();
  });

  it("③ 乐观气泡的权威回显 sortKey>hi 仍被 requestMessageId 配对收敛(不因区间过滤丢)", () => {
    // 上滚窗口 [m1, m2] + 尾部一条在途乐观 c-1(无 sortKey)。其权威回显 server-1 的 sortKey=z9
    // 越界(> hi=m2),但带 requestMessageId=c-1,必须配对收敛(否则双行)。
    const slice = sliceWith([msg("m1"), msg("m2"), optimistic("c-1")]);
    const auth = msg("server-1", {
      direction: "out",
      status: "sent",
      sortKey: "z9",
      requestMessageId: "c-1",
    });
    const next = replaceAuthoritative(slice, [auth], false);
    // 乐观 c-1 被 server-1 在原位收敛(保位);m1/m2 保留。
    expect(selectTimeline(next).map((e) => e.id)).toEqual(["m1", "m2", "server-1"]);
    expect(next.byId["c-1"]).toBeUndefined();
    expect(next.byId["server-1"].clientMsgId).toBe("c-1");
  });

  it("④ failed 乐观气泡在缝合下仍按 sentAt 归位(不被顶到末尾)", () => {
    // 窗口 [h0, S](h0 早、S 晚);中间一条 failed 乐观 c-1(sentAt 在两者之间)。
    const slice = sliceWith([
      msg("h0", { sortKey: "a", sentAt: "2026-05-19T00:00:00.000Z" }),
      optimistic("c-1", {
        status: "failed",
        sentAt: "2026-05-19T00:00:05.000Z",
        text: "A",
        parts: [{ kind: "text", text: "A" }],
      }),
      msg("S", {
        direction: "out",
        status: "sent",
        sortKey: "z",
        sentAt: "2026-05-19T00:00:10.000Z",
      }),
    ]);
    // 区间内重读(纯 status 等价),failed 行 sentAt 归位在 h0 与 S 之间。
    const next = replaceAuthoritative(
      slice,
      [
        msg("h0", { sortKey: "a", sentAt: "2026-05-19T00:00:00.000Z" }),
        msg("S", {
          direction: "out",
          status: "sent",
          sortKey: "z",
          sentAt: "2026-05-19T00:00:10.000Z",
        }),
      ],
      false,
    );
    expect(selectTimeline(next).map((e) => e.id)).toEqual(["h0", "c-1", "S"]);
    expect(next.byId["c-1"].status).toBe("failed");
  });

  it("⑤ 缝合内容等价(纯重读无变化)→ 复用原 slice 引用", () => {
    const slice = sliceWith([msg("m1"), msg("m2"), msg("m3")]);
    expect(replaceAuthoritative(slice, [msg("m1"), msg("m2"), msg("m3")], false)).toBe(slice);
  });

  it("⑤b 区间内的全新 id(非配对、非已存在)不插入 order 中段(留 SQLite、避免 byId 孤儿键)", () => {
    // 窗口 [m1, m3];权威重读带来一条区间内但前所未见的乱序插入 m2x(sortKey=m2,落在 m1/m3 之间)。
    // 只更新窗口内已存在条目,不在历史中段凭空插新行 → m2x 不并入,order/byId 仍干净。
    const slice = sliceWith([msg("m1"), msg("m3")]);
    const next = replaceAuthoritative(
      slice,
      [msg("m1"), msg("m2x", { sortKey: "m2" }), msg("m3")],
      false,
    );
    expect(selectTimeline(next).map((e) => e.id)).toEqual(["m1", "m3"]);
    expect(next.byId["m2x"]).toBeUndefined();
    // byId 键 == order(无孤儿)。
    expect(Object.keys(next.byId).sort()).toEqual(["m1", "m3"]);
  });

  it("⑥ collapseToLatest=true(默认)与显式 true 等价 = 现状整窗塌缩(回归)", () => {
    // 同一输入,默认参与显式 true 必须产出逐字段等价的 order/byId(默认走塌缩路径,不受缝合影响)。
    const slice = sliceWith([msg("m1"), optimistic("c-1")]);
    const a = replaceAuthoritative(slice, [msg("m1"), msg("m2")]);
    const b = replaceAuthoritative(slice, [msg("m1"), msg("m2")], true);
    expect(selectTimeline(a).map((e) => e.id)).toEqual(selectTimeline(b).map((e) => e.id));
    // 塌缩路径:乐观气泡 c-1 贴底保留(未被权威收敛)。
    expect(selectTimeline(a).map((e) => e.id)).toEqual(["m1", "m2", "c-1"]);
    // 塌缩刷新 atCacheBottom=true + windowNewestSortKey=尾部有 sortKey 实体(m2)。
    expect(a.atCacheBottom).toBe(true);
    expect(a.windowNewestSortKey).toBe("m2");
  });
});

describe("valueEqual(内容等价深比)", () => {
  it("标量:Object.is 语义", () => {
    expect(valueEqual(1, 1)).toBe(true);
    expect(valueEqual("a", "a")).toBe(true);
    expect(valueEqual(undefined, undefined)).toBe(true);
    expect(valueEqual(1, 2)).toBe(false);
    expect(valueEqual(null, undefined)).toBe(false);
  });

  it("数组:逐元素且顺序敏感", () => {
    expect(valueEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(valueEqual([1, 2], [2, 1])).toBe(false);
    expect(valueEqual([1], [1, 2])).toBe(false);
  });

  it("对象:按键并集递归,键集不一致即不等(保守)", () => {
    expect(valueEqual({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
    expect(valueEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    // 显式 undefined 键 vs 缺键 → 不等(宁可多渲染一次,不可漏)。
    expect(valueEqual({ a: undefined }, {})).toBe(false);
  });

  it("嵌套 parts 数组逐 part 比较", () => {
    expect(
      valueEqual(
        { parts: [{ kind: "text", text: "x" }] },
        { parts: [{ kind: "text", text: "x" }] },
      ),
    ).toBe(true);
    expect(
      valueEqual(
        { parts: [{ kind: "text", text: "x" }] },
        { parts: [{ kind: "text", text: "y" }] },
      ),
    ).toBe(false);
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
