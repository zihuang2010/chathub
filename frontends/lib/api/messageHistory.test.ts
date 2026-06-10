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

describe("附件按权威 attachmentType 分类(实时推送无 fileSuffix 的回归)", () => {
  // 用户实测的实时推送图片附件:只带 attachmentType=1 + ossFilePath(→ mediaId),无 fileSuffix/fileName。
  it("attachmentType=1 + 空 fileType → 渲染为 image(此前会误判成 file)", () => {
    const r: HistoryMessage = {
      ...record(2),
      messageType: 2,
      contentText: "",
      attachments: [
        {
          mediaId: "t/dev/wechat-business-app/wecom/chat/2026/06/04/190543_5ddad58e.jpg",
          fileName: "",
          fileSize: 2341,
          attachmentType: 1,
          fileType: "",
        },
      ],
    };
    const [m] = adaptHistoryRecords([r], "c1");
    expect(m.parts.map((p) => p.kind)).toEqual(["image"]);
  });

  it("attachmentType 2/3/4 → file/voice/video", () => {
    const mk = (attachmentType: number): HistoryMessage => ({
      ...record(2),
      localMessageId: `a${attachmentType}`,
      messageType: attachmentType === 2 ? 3 : attachmentType === 3 ? 4 : 6,
      contentText: "",
      attachments: [{ mediaId: "t/x", fileName: "", fileSize: 1, attachmentType, fileType: "" }],
    });
    const byId = new Map(
      adaptHistoryRecords([mk(2), mk(3), mk(4)], "c1").map((m) => [m.id, m.parts[0]?.kind]),
    );
    expect(byId.get("a2")).toBe("file");
    expect(byId.get("a3")).toBe("voice");
    expect(byId.get("a4")).toBe("video");
  });

  it("缺省 attachmentType 时回退按扩展名分类(向后兼容旧缓存)", () => {
    const r: HistoryMessage = {
      ...record(2),
      messageType: 2,
      contentText: "",
      // 无 attachmentType,fileType=png → 仍判 image。
      attachments: [{ mediaId: "t/x.png", fileName: "x.png", fileSize: 1, fileType: "png" }],
    };
    const [m] = adaptHistoryRecords([r], "c1");
    expect(m.parts.map((p) => p.kind)).toEqual(["image"]);
  });

  it("纯媒体大类的 [图片] 占位被剥离;图文混合(5)保留正文 + 图片", () => {
    const image: HistoryMessage = {
      ...record(2),
      localMessageId: "img",
      messageType: 2,
      contentText: "[图片]",
      attachments: [
        { mediaId: "t/a.jpg", fileName: "", fileSize: 1, attachmentType: 1, fileType: "" },
      ],
    };
    const mixed: HistoryMessage = {
      ...record(2),
      localMessageId: "mix",
      messageType: 5,
      contentText: "看这张图",
      attachments: [
        { mediaId: "t/b.jpg", fileName: "", fileSize: 1, attachmentType: 1, fileType: "" },
      ],
    };
    const byId = new Map(adaptHistoryRecords([image, mixed], "c1").map((m) => [m.id, m]));
    // 图片:占位剥离,只剩 image part。
    expect(byId.get("img")?.text).toBe("");
    expect(byId.get("img")?.parts.map((p) => p.kind)).toEqual(["image"]);
    // 图文混合:正文保留,text + image 两段。
    expect(byId.get("mix")?.text).toBe("看这张图");
    expect(byId.get("mix")?.parts.map((p) => p.kind)).toEqual(["text", "image"]);
  });
});

describe("未知消息类型兜底(messageType=99,无文本无附件)", () => {
  // 用户实测的实时推送:messageType=99、无 contentText(后端按 contentText 落库 → 空)、
  // attachments=[]。此前 parts 为空 → 渲染空白气泡;现兜底为 unknown 占位 part。
  it("空内容 + 空附件 → parts 兜底为单个 unknown", () => {
    const r: HistoryMessage = {
      ...record(1),
      localMessageId: "u99",
      messageType: 99,
      contentText: "",
      attachments: [],
    };
    const [m] = adaptHistoryRecords([r], "c1");
    expect(m.parts.map((p) => p.kind)).toEqual(["unknown"]);
    expect(m.text).toBe("");
  });

  it("未知类型但带可渲染附件时仍渲染附件(不被 unknown 覆盖)", () => {
    const r: HistoryMessage = {
      ...record(1),
      localMessageId: "u99img",
      messageType: 99,
      contentText: "",
      attachments: [
        { mediaId: "t/x.jpg", fileName: "", fileSize: 1, attachmentType: 1, fileType: "" },
      ],
    };
    const [m] = adaptHistoryRecords([r], "c1");
    expect(m.parts.map((p) => p.kind)).toEqual(["image"]);
  });
});

describe("出站失败附件消息回填顶层重发字段(messageType/filePath/...)", () => {
  // 回归:附件发送失败 → persistOutboxFailure 落库 → 权威重读替换乐观气泡。此前
  // historyToMessage 不回填这些字段,重发分支拿不到 filePath/messageType → 误走纯文本
  // 路径发出空文本必败,且 failBubble 再以 messageType=1 + "[]" 覆盖 outbox 行,
  // 气泡退化成「暂不支持该消息类型」。
  it("失败语音消息 → 顶层带 messageType/filePath/fileName/fileSize/durationSeconds", () => {
    const r: HistoryMessage = {
      ...record(2),
      localMessageId: "fv",
      messageType: 4,
      contentText: "",
      sendStatus: 4,
      attachments: [
        {
          mediaId: "t/dev/voice/a.amr",
          fileName: "a.amr",
          fileSize: 2048,
          attachmentType: 3,
          fileType: "amr",
          durationSeconds: 7,
        },
      ],
    };
    const [m] = adaptHistoryRecords([r], "c1");
    expect(m.status).toBe("failed");
    expect(m.messageType).toBe(4);
    expect(m.filePath).toBe("t/dev/voice/a.amr");
    expect(m.fileName).toBe("a.amr");
    expect(m.fileSize).toBe(2048);
    expect(m.durationSeconds).toBe(7);
  });

  it("失败附件但 mediaId 为空(未上传成功)→ filePath 不写,留给重发守卫提示重新选择文件", () => {
    const r: HistoryMessage = {
      ...record(2),
      localMessageId: "fi",
      messageType: 2,
      contentText: "",
      sendStatus: 4,
      attachments: [
        { mediaId: "", fileName: "x.png", fileSize: 1, attachmentType: 1, fileType: "png" },
      ],
    };
    const [m] = adaptHistoryRecords([r], "c1");
    expect(m.messageType).toBe(2);
    expect(m.filePath).toBeUndefined();
    expect(m.fileName).toBe("x.png");
  });

  it("成功出站附件 / 入站消息不回填(维持「纯文本/入站不写」的既有语义)", () => {
    const sentOut: HistoryMessage = {
      ...record(2),
      localMessageId: "so",
      messageType: 2,
      contentText: "",
      sendStatus: 3,
      attachments: [
        { mediaId: "t/a.jpg", fileName: "", fileSize: 1, attachmentType: 1, fileType: "" },
      ],
    };
    const incoming: HistoryMessage = {
      ...record(1),
      localMessageId: "in1",
      messageType: 2,
      contentText: "",
      attachments: [
        { mediaId: "t/b.jpg", fileName: "", fileSize: 1, attachmentType: 1, fileType: "" },
      ],
    };
    const byId = new Map(adaptHistoryRecords([sentOut, incoming], "c1").map((m) => [m.id, m]));
    expect(byId.get("so")?.filePath).toBeUndefined();
    expect(byId.get("so")?.messageType).toBeUndefined();
    expect(byId.get("in1")?.filePath).toBeUndefined();
    expect(byId.get("in1")?.messageType).toBeUndefined();
  });
});
