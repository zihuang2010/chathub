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
});
