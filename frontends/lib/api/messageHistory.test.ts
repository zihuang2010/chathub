import { describe, expect, it } from "vitest";

import { adaptHistoryRecords, type HistoryMessage } from "./messageHistory";

function record(direction: number): HistoryMessage {
  return {
    localMessageId: `m-${direction}`,
    messageDirection: direction,
    messageType: 1,
    contentText: "hi",
    sendStatus: 3,
    messageTime: "2026-05-30 10:00:00",
    sortKey: `177000000000${direction}:x:m-${direction}`,
    attachments: [],
    gmtModifiedTime: "",
  };
}

describe("adaptHistoryRecords direction contract", () => {
  it("treats only backend-local direction 2 as outgoing", () => {
    const [incoming, outgoing, abnormal] = adaptHistoryRecords(
      [record(1), record(2), record(3)],
      "c1",
    );

    expect(incoming.direction).toBe("in");
    expect(incoming.status).toBeUndefined();
    expect(outgoing.direction).toBe("out");
    expect(outgoing.status).toBe("sent");
    expect(abnormal.direction).toBe("in");
    expect(abnormal.status).toBeUndefined();
  });

  it("does not override backend-local direction from colon sortKey", () => {
    const incoming = { ...record(1), sortKey: "1770000000000:1:00000000000000009001:m-in" };
    const outgoing = { ...record(2), sortKey: "1770000000001:2:00000000000000009002:m-out" };

    const [gotIncoming, gotOutgoing] = adaptHistoryRecords([incoming, outgoing], "c1");

    expect(gotIncoming.direction).toBe("in");
    expect(gotIncoming.status).toBeUndefined();
    expect(gotOutgoing.direction).toBe("out");
    expect(gotOutgoing.status).toBe("sent");
  });

  it("normalizes record order to oldest first before rendering", () => {
    const newest = { ...record(2), localMessageId: "newest", sortKey: "1770000000002:2:newest" };
    const middle = { ...record(1), localMessageId: "middle", sortKey: "1770000000001:1:middle" };
    const oldest = { ...record(1), localMessageId: "oldest", sortKey: "1770000000000:1:oldest" };

    const messages = adaptHistoryRecords([newest, middle, oldest], "c1");

    expect(messages.map((m) => m.id)).toEqual(["oldest", "middle", "newest"]);
  });

  it("未终态 sendStatus(1 待发送 / 2 发送中)映射为 sending,不当成功(避免重读路径假已发送)", () => {
    const pending = { ...record(2), localMessageId: "p", sendStatus: 1 };
    const inflight = { ...record(2), localMessageId: "f", sendStatus: 2 };
    const byId = new Map(adaptHistoryRecords([pending, inflight], "c1").map((m) => [m.id, m]));
    expect(byId.get("p")?.status).toBe("sending");
    expect(byId.get("f")?.status).toBe("sending");
  });
});

describe("adaptHistoryRecords 细分语义透传(revoked / failReason / requestMessageId)", () => {
  it("revoked=true → Message.isRecalled=true;缺省/false → undefined(不存在=未撤回)", () => {
    // adaptHistoryRecords 会按 sortKey 重排,故按 id 取而非按入参顺序解构。
    const revoked = { ...record(2), localMessageId: "rv", revoked: true };
    const notRevoked = { ...record(2), localMessageId: "nr", revoked: false };
    const absent = { ...record(2), localMessageId: "ab" };

    const byId = new Map(
      adaptHistoryRecords([revoked, notRevoked, absent], "c1").map((m) => [m.id, m]),
    );
    expect(byId.get("rv")?.isRecalled).toBe(true);
    expect(byId.get("nr")?.isRecalled).toBeUndefined();
    expect(byId.get("ab")?.isRecalled).toBeUndefined();
  });

  it("requestMessageId / failReason 原样透传到 Message(供乐观配对 / 失败原因展示)", () => {
    const r = {
      ...record(2),
      localMessageId: "m",
      sendStatus: 4,
      requestMessageId: "local-uuid-1",
      failReason: "对方已不是好友",
    };
    const [m] = adaptHistoryRecords([r], "c1");
    expect(m.requestMessageId).toBe("local-uuid-1");
    expect(m.failReason).toBe("对方已不是好友");
    expect(m.status).toBe("failed");
  });
});
