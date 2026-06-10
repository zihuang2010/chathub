import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearOutboxRow, persistOutboxFailure, uploadAttachment } from "@/lib/api/messageHistory";
import { showToast } from "@/components/ui/toast";

import type { Conversation, Message } from "../data";
import { COMPOSER_MAX_CHARS } from "../constants";
import { selectTimeline, useChatStore } from "../store/chatStore";
import { resetSendPacing, setSendPacingConfig } from "../store/sendPacer";
import { STRINGS } from "../strings";
import {
  toAmrFileName,
  useChatActions,
  voiceExceedsLimit,
  type SendMessageOptions,
  type UseChatActionsParams,
} from "./useChatActions";

vi.mock("@/components/ui/toast", () => ({ showToast: vi.fn() }));
// 只 stub uploadAttachment(避免真发 Tauri invoke),其余导出(含 SEND_STATUS)保留真实值,
// 否则整模块替换会让 useChatActions 里 import 的 SEND_STATUS 变 undefined。
vi.mock("@/lib/api/messageHistory", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/api/messageHistory")>()),
  uploadAttachment: vi.fn(),
  persistOutboxFailure: vi.fn().mockResolvedValue(undefined),
  clearOutboxRow: vi.fn().mockResolvedValue(undefined),
}));

const conversation = { id: "c1", name: "张三" } as Conversation;

function flush() {
  return act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function setup(onSendMessage?: UseChatActionsParams["onSendMessage"]) {
  const wasAtBottomRef = { current: false };
  const setReplyDraft = vi.fn();
  const { result } = renderHook(() =>
    useChatActions({
      conversation,
      chatStoreKey: "c1",
      onSendMessage,
      wasAtBottomRef,
      setReplyDraft,
    }),
  );
  return { result, wasAtBottomRef, setReplyDraft };
}

function timeline() {
  return selectTimeline(useChatStore.getState().conversations.c1);
}

function outMsg(id: string): Message {
  return {
    id,
    conversationId: "c1",
    direction: "out",
    text: id,
    sentAt: "2026-05-19T00:00:00.000Z",
    parts: [{ kind: "text", text: id }],
    status: "failed",
  };
}

beforeEach(() => {
  // 关节流(间隔置 0):既有发送用例只验证编排/状态流转,不应被真实节流间隔拖住。
  setSendPacingConfig({ minIntervalMs: 0 });
});

afterEach(() => {
  useChatStore.getState().reset();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  resetSendPacing();
});

describe("useChatActions", () => {
  it("handleSend 入队乐观气泡 + 调 onSendMessage(text, clientMsgId) + 贴底 + 清引用", async () => {
    const onSendMessage = vi
      .fn()
      .mockResolvedValue({ localMessageId: "srv-1", sendStatus: 3, messageTime: "" });
    const { result, wasAtBottomRef, setReplyDraft } = setup(onSendMessage);

    await act(async () => {
      result.current.handleSend("你好");
    });

    const t = timeline();
    expect(t).toHaveLength(1);
    expect(t[0].text).toBe("你好");
    expect(t[0].direction).toBe("out");
    expect(t[0].clientMsgId).toBe(t[0].id);
    expect(onSendMessage).toHaveBeenCalledWith("你好", t[0].id);
    expect(wasAtBottomRef.current).toBe(true);
    expect(setReplyDraft).toHaveBeenCalledWith(null);

    // 成功 → markSent 钉 serverId、status=sent。
    await flush();
    const sent = timeline()[0];
    expect(sent.status).toBe("sent");
    expect(sent.serverId).toBe("srv-1");
  });

  it("handleSend 失败 → markFailed,气泡保留供重发", async () => {
    const onSendMessage = vi.fn().mockRejectedValue(new Error("network"));
    const { result } = setup(onSendMessage);

    await act(async () => {
      result.current.handleSend("在吗");
    });
    await flush();

    const t = timeline();
    expect(t).toHaveLength(1);
    expect(t[0].status).toBe("failed");
  });

  it("handleSend 同步返回 sendStatus=4(失败)→ 立即 markFailed,不当成功(不钉 serverId)", async () => {
    // 同步接口已知失败:不能等回调。否则回调不来时会假「已发送」(本次根因)。
    const onSendMessage = vi
      .fn()
      .mockResolvedValue({ localMessageId: "srv-x", sendStatus: 4, messageTime: "" });
    const { result } = setup(onSendMessage);

    await act(async () => {
      result.current.handleSend("会失败");
    });
    await flush();

    const t = timeline();
    expect(t).toHaveLength(1);
    expect(t[0].status).toBe("failed");
    expect(t[0].serverId).toBeUndefined();
  });

  it("handleSend 同步返回 sendStatus=2(发送中)→ 保持发送中,不假成功也不钉 serverId", async () => {
    // 未终态:留给回调(权威重读按 requestMessageId)收敛终态。
    const onSendMessage = vi
      .fn()
      .mockResolvedValue({ localMessageId: "srv-y", sendStatus: 2, messageTime: "" });
    const { result } = setup(onSendMessage);

    await act(async () => {
      result.current.handleSend("在途");
    });
    await flush();

    const t = timeline();
    expect(t).toHaveLength(1);
    expect(t[0].status).toBe("sending");
    expect(t[0].serverId).toBeUndefined();
  });

  it("发送命中限流(http 403)→ 退避自动重试,最终成功不标失败", async () => {
    vi.useFakeTimers();
    // 前两次抛 403 限流错(可重试),第三次成功 → 应自动恢复为已发送,期间不弹失败。
    const onSendMessage = vi
      .fn()
      .mockRejectedValueOnce({ message: "send_message returned http 403" })
      .mockRejectedValueOnce({ message: "send_message returned http 403" })
      .mockResolvedValueOnce({ localMessageId: "srv-9", sendStatus: 3, messageTime: "" });
    const { result } = setup(onSendMessage);

    await act(async () => {
      result.current.handleSend("快速连发");
    });
    // 推进定时器跑完两次退避(400 + 800ms)。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1300);
    });

    expect(onSendMessage).toHaveBeenCalledTimes(3);
    const t = timeline();
    expect(t).toHaveLength(1);
    expect(t[0].status).toBe("sent");
    expect(t[0].serverId).toBe("srv-9");
    vi.useRealTimers();
  });

  it("发送持续限流、重试耗尽 → markFailed,气泡保留供手动重发", async () => {
    vi.useFakeTimers();
    const onSendMessage = vi.fn().mockRejectedValue({ message: "send too fast" });
    const { result } = setup(onSendMessage);

    await act(async () => {
      result.current.handleSend("一直被限流");
    });
    // 首发 1 次 + MAX_SEND_RETRY(3) 次重试,退避 400 + 800 + 1600ms。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(onSendMessage).toHaveBeenCalledTimes(4);
    const t = timeline();
    expect(t).toHaveLength(1);
    expect(t[0].status).toBe("failed");
    vi.useRealTimers();
  });

  it("非限流错误(如 http 500)不重试,立即 markFailed", async () => {
    const onSendMessage = vi.fn().mockRejectedValue({ message: "send_message returned http 500" });
    const { result } = setup(onSendMessage);

    await act(async () => {
      result.current.handleSend("普通失败");
    });
    await flush();

    expect(onSendMessage).toHaveBeenCalledTimes(1);
    const t = timeline();
    expect(t[0].status).toBe("failed");
  });

  it("handleSend 图片块乐观气泡保留本地宽高，避免发送后权威回读时变尺寸", () => {
    const { result } = setup(vi.fn());

    act(() => {
      result.current.handleSend("", [
        {
          type: "image",
          url: "data:image/png;base64,iVBORw0KGgo=",
          name: "photo.png",
          width: 900,
          height: 1600,
        },
      ]);
    });

    const [message] = timeline();
    expect(message.parts).toEqual([
      expect.objectContaining({
        kind: "image",
        url: "data:image/png;base64,iVBORw0KGgo=",
        width: 900,
        height: 1600,
      }),
    ]);
  });

  it("多附件:上传并行、发送按编辑器顺序串行", async () => {
    // fetchBytes 走 global.fetch:返回任意字节即可。
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(2) })),
    );

    // 闸门卡住第一条附件的上传:串行实现下第二条上传不会在第一条发送前发生 →
    // 并行实现下两条上传在任何发送完成前都已发起(核心并行断言)。
    const uploadCalls: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => (releaseFirst = r));
    vi.mocked(uploadAttachment).mockImplementation(async ({ fileName }) => {
      uploadCalls.push(fileName);
      if (fileName === "a.bin") await firstGate;
      return { objectName: `obj/${fileName}`, fileName, fileSize: 1 };
    });

    const sendFilePaths: Array<string | undefined> = [];
    const onSendMessage: UseChatActionsParams["onSendMessage"] = vi.fn(
      async (_text: string, _id: string, opts?: SendMessageOptions) => {
        sendFilePaths.push(opts?.filePath);
        return { localMessageId: "s", sendStatus: 3, messageTime: "" };
      },
    );
    const { result } = setup(onSendMessage);

    await act(async () => {
      result.current.handleSend("", undefined, [
        { type: "file", url: "blob:a", name: "a.bin" },
        { type: "file", url: "blob:b", name: "b.bin" },
      ]);
      // 第一条上传被闸门卡住时,第二条上传应已并行发起。
      await vi.waitFor(() => expect(uploadCalls).toContain("b.bin"));
      // 此刻第一条仍卡在上传 → 不应有任何消息已发送。
      expect(sendFilePaths).toHaveLength(0);
      releaseFirst();
      // 放行后:发送严格按编辑器顺序 a → b。
      await vi.waitFor(() => expect(sendFilePaths).toEqual(["obj/a.bin", "obj/b.bin"]));
    });
  });

  it("超长文本转临时文件上传失败时释放 blob URL", async () => {
    const blobUrl = "blob:long-text";
    vi.spyOn(URL, "createObjectURL").mockReturnValue(blobUrl);
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("blob fetch failed")));
    const { result } = setup(vi.fn());

    await act(async () => {
      result.current.handleSend("长".repeat(COMPOSER_MAX_CHARS));
    });

    await waitFor(() => expect(revokeSpy).toHaveBeenCalledWith(blobUrl));
    expect(timeline()[0].status).toBe("failed");
  });

  it('handleAction "delete" 确认后从 store 移除该条', () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { result } = setup(vi.fn());
    act(() => {
      useChatStore.getState().enqueueOptimistic("c1", { ...outMsg("m1"), clientMsgId: "m1" });
    });
    expect(timeline()).toHaveLength(1);

    act(() => {
      result.current.handleAction("delete", outMsg("m1"));
    });
    expect(confirmSpy).toHaveBeenCalled();
    expect(timeline()).toHaveLength(0);
  });

  it('handleAction "delete" 确认后记本地删除墓碑(权威补回据此过滤,删了不复活)', async () => {
    // 用本文件独有 id,避免与其它 delete 用例共享的模块级墓碑单例互相污染。
    const { isMessageDeleted } = await import("../store/deletedMessages");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { result } = setup(vi.fn());
    act(() => {
      useChatStore
        .getState()
        .enqueueOptimistic("c1", { ...outMsg("tomb-1"), clientMsgId: "tomb-1" });
    });
    expect(isMessageDeleted("c1", ["tomb-1"])).toBe(false);

    act(() => {
      result.current.handleAction("delete", outMsg("tomb-1"));
    });
    expect(isMessageDeleted("c1", ["tomb-1"])).toBe(true);
  });

  it('handleAction "delete" 取消则保留该条(防误触)', () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { result } = setup(vi.fn());
    act(() => {
      useChatStore.getState().enqueueOptimistic("c1", { ...outMsg("m1"), clientMsgId: "m1" });
    });
    expect(timeline()).toHaveLength(1);

    act(() => {
      result.current.handleAction("delete", outMsg("m1"));
    });
    expect(confirmSpy).toHaveBeenCalled();
    expect(timeline()).toHaveLength(1);
  });

  it('handleAction "recall" 置 isRecalled', () => {
    const { result } = setup(vi.fn());
    act(() => {
      useChatStore.getState().enqueueOptimistic("c1", { ...outMsg("m1"), clientMsgId: "m1" });
    });

    act(() => {
      result.current.handleAction("recall", outMsg("m1"));
    });
    const t = timeline()[0];
    expect(t.isRecalled).toBe(true);
    expect(t.status).toBeUndefined();
  });

  it('handleAction "reply" 写入引用草稿(取消息预览)', () => {
    const { result, setReplyDraft } = setup(vi.fn());
    act(() => {
      result.current.handleAction("reply", outMsg("hello"));
    });
    expect(setReplyDraft).toHaveBeenCalledWith(
      expect.objectContaining({ id: "hello", conversationId: "c1", text: "hello" }),
    );
  });

  it('handleAction "resend" 置 sending 并重发', async () => {
    const onSendMessage = vi
      .fn()
      .mockResolvedValue({ localMessageId: "srv-9", sendStatus: 3, messageTime: "" });
    const { result } = setup(onSendMessage);
    act(() => {
      useChatStore.getState().enqueueOptimistic("c1", { ...outMsg("m1"), clientMsgId: "m1" });
    });

    await act(async () => {
      result.current.handleAction("resend", outMsg("m1"));
    });
    expect(onSendMessage).toHaveBeenCalledWith("m1", "m1");
    await flush();
    // 就地收敛同一条:不在下方新增气泡。
    expect(timeline()).toHaveLength(1);
    expect(timeline()[0].status).toBe("sent");
    expect(timeline()[0].serverId).toBe("srv-9");
  });

  it('handleAction "resend" 再次失败仍就地复用同一条(不新增、沿用原 requestMessageId)', async () => {
    const onSendMessage = vi.fn().mockRejectedValue(new Error("network"));
    const { result } = setup(onSendMessage);
    act(() => {
      useChatStore.getState().enqueueOptimistic("c1", { ...outMsg("m1"), clientMsgId: "m1" });
    });

    await act(async () => {
      result.current.handleAction("resend", outMsg("m1"));
    });
    await flush();

    // 复用原 clientMsgId(= request_message_id)发送,而非生成新键。
    expect(onSendMessage).toHaveBeenCalledWith("m1", "m1");
    // 再次失败:仍只有 1 条,就地回到 failed,clientMsgId 不变。
    expect(timeline()).toHaveLength(1);
    expect(timeline()[0].status).toBe("failed");
    expect(timeline()[0].clientMsgId).toBe("m1");
  });
});

// ─── failBubble / outbox 相关用例 ──────────────────────────────────────────
//
// 这 4 个用例覆盖 Plan B 落地的 3 条路径:
//   1. handleSend 失败 → persistOutboxFailure 被调(有身份)
//   2. 无会话身份降级 → persistOutboxFailure 不调,气泡仍 markFailed
//   3. never-uploaded 重发拦截 → showToast(outboxReselectFile),不触发 onSendMessage
//   4. 有 filePath 的失败气泡重发 → clearOutboxRow 被调

/** 带 wecomAccountId/externalUserId 身份的 renderHook 快捷方式。*/
function setupWithIdentity(
  onSendMessage?: UseChatActionsParams["onSendMessage"],
  extra?: Partial<UseChatActionsParams>,
) {
  const wasAtBottomRef = { current: false };
  const setReplyDraft = vi.fn();
  const { result } = renderHook(() =>
    useChatActions({
      conversation,
      chatStoreKey: "c1",
      onSendMessage,
      wasAtBottomRef,
      setReplyDraft,
      wecomAccountId: "wa-001",
      externalUserId: "ext-001",
      ...extra,
    }),
  );
  return { result, wasAtBottomRef, setReplyDraft };
}

describe("failBubble / outbox 持久化", () => {
  it("handleSend 失败 → persistOutboxFailure 被调(含 clientMsgId/messageType/failReason)", async () => {
    const onSendMessage = vi.fn().mockRejectedValue(new Error("network error"));
    const { result } = setupWithIdentity(onSendMessage);

    await act(async () => {
      result.current.handleSend("hi");
    });
    await flush();

    // 气泡保留且状态 failed
    const t = timeline();
    expect(t).toHaveLength(1);
    expect(t[0].status).toBe("failed");

    // persistOutboxFailure 必须被调用一次,参数含关键字段
    expect(vi.mocked(persistOutboxFailure)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(persistOutboxFailure)).toHaveBeenCalledWith(
      expect.objectContaining({
        clientMsgId: expect.stringMatching(/^local-/),
        messageType: 1,
        contentText: "hi",
        attachmentsJson: "[]",
        wecomAccountId: "wa-001",
        externalUserId: "ext-001",
        failReason: expect.any(String),
      }),
    );
    // failReason 不应为空字符串
    const callArg = vi.mocked(persistOutboxFailure).mock.calls[0][0];
    expect(callArg.failReason.length).toBeGreaterThan(0);
  });

  it("缺会话身份 → persistOutboxFailure 不调,气泡仍 markFailed(降级到纯内存)", async () => {
    const onSendMessage = vi.fn().mockRejectedValue(new Error("network error"));
    // 显式不传 wecomAccountId/externalUserId(使用普通 setup)
    const { result } = setup(onSendMessage);

    await act(async () => {
      result.current.handleSend("hi");
    });
    await flush();

    // 气泡 markFailed(内存降级)
    const t = timeline();
    expect(t).toHaveLength(1);
    expect(t[0].status).toBe("failed");

    // 没有身份 → IPC 不应被调
    expect(vi.mocked(persistOutboxFailure)).toHaveBeenCalledTimes(0);
  });

  it("never-uploaded 重发拦截:showToast(outboxReselectFile),onSendMessage 不被触发", async () => {
    const onSendMessage = vi
      .fn()
      .mockResolvedValue({ localMessageId: "srv-1", sendStatus: 3, messageTime: "" });
    const { result } = setupWithIdentity(onSendMessage);

    // 塞一条图片(messageType=2)且无 filePath 的失败气泡
    act(() => {
      useChatStore.getState().enqueueOptimistic("c1", {
        ...outMsg("m1"),
        clientMsgId: "m1",
        status: "failed",
        messageType: 2,
        // 故意不设 filePath → never-uploaded
      });
    });

    await act(async () => {
      result.current.handleAction("resend", { ...outMsg("m1"), messageType: 2 });
    });
    await flush();

    // 弹 outboxReselectFile 提示
    expect(vi.mocked(showToast)).toHaveBeenCalledWith(
      STRINGS.toast.outboxReselectFile,
      expect.objectContaining({ type: "error" }),
    );
    // onSendMessage 不应被调(拦截成功)
    expect(onSendMessage).toHaveBeenCalledTimes(0);
  });

  it("无 filePath 且空文本(存量损坏 outbox 行)重发拦截:不发空文本,气泡保持 failed", async () => {
    const onSendMessage = vi
      .fn()
      .mockResolvedValue({ localMessageId: "srv-x", sendStatus: 3, messageTime: "" });
    const { result } = setupWithIdentity(onSendMessage);

    // 模拟历史损坏行读回的形态:messageType=1、text=""、无 filePath(此前被空文本重发
    // 覆盖成 type=1 + attachments "[]" 的行,渲染为「暂不支持」占位)。
    const corrupted: Message = {
      ...outMsg("m3"),
      text: "",
      parts: [{ kind: "unknown" }],
      messageType: 1,
    };
    act(() => {
      useChatStore.getState().enqueueOptimistic("c1", { ...corrupted, clientMsgId: "m3" });
    });

    await act(async () => {
      result.current.handleAction("resend", corrupted);
    });
    await flush();

    expect(vi.mocked(showToast)).toHaveBeenCalledWith(
      STRINGS.toast.outboxReselectFile,
      expect.objectContaining({ type: "error" }),
    );
    expect(onSendMessage).toHaveBeenCalledTimes(0);
    // 拦截发生在置 sending 之前 → 不会卡在「发送中」。
    expect(timeline()[0].status).toBe("failed");
  });

  it("有 filePath 的失败气泡重发 → clearOutboxRow 被调(含 clientMsgId)", async () => {
    const onSendMessage = vi
      .fn()
      .mockResolvedValue({ localMessageId: "srv-2", sendStatus: 3, messageTime: "" });
    const { result } = setupWithIdentity(onSendMessage);

    // 塞一条文件(messageType=3)且有 filePath 的失败气泡
    act(() => {
      useChatStore.getState().enqueueOptimistic("c1", {
        ...outMsg("m2"),
        clientMsgId: "m2",
        status: "failed",
        messageType: 3,
        filePath: "oss-obj-1",
        fileName: "doc.pdf",
        fileSize: 1024,
      });
    });

    await act(async () => {
      result.current.handleAction("resend", {
        ...outMsg("m2"),
        messageType: 3,
        filePath: "oss-obj-1",
      });
    });
    await flush();

    // clearOutboxRow 必须被调用,参数含 clientMsgId
    expect(vi.mocked(clearOutboxRow)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(clearOutboxRow)).toHaveBeenCalledWith(
      expect.objectContaining({ clientMsgId: "m2" }),
    );
  });
});

describe("语音发送前置校验", () => {
  it("toAmrFileName 把后缀改成 .amr,无后缀则追加", () => {
    expect(toAmrFileName("hello.mp3")).toBe("hello.amr");
    expect(toAmrFileName("a.b.wav")).toBe("a.b.amr");
    expect(toAmrFileName("novoice")).toBe("novoice.amr");
  });

  it("voiceExceedsLimit 超 60 秒或超 2MB 判超限,缺时长时仅看大小", () => {
    expect(voiceExceedsLimit(30, 100_000)).toBe(false);
    expect(voiceExceedsLimit(60, 100_000)).toBe(false);
    expect(voiceExceedsLimit(61, 100_000)).toBe(true);
    expect(voiceExceedsLimit(undefined, 100_000)).toBe(false);
    expect(voiceExceedsLimit(undefined, 3 * 1024 * 1024)).toBe(true);
  });
});
