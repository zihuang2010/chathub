import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Conversation, Message } from "../data";
import { selectTimeline, useChatStore } from "../store/chatStore";
import {
  toAmrFileName,
  useChatActions,
  voiceExceedsLimit,
  type UseChatActionsParams,
} from "./useChatActions";

vi.mock("@/components/ui/toast", () => ({ showToast: vi.fn() }));

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

afterEach(() => {
  useChatStore.getState().reset();
  vi.clearAllMocks();
});

describe("useChatActions", () => {
  it("handleSend 入队乐观气泡 + 调 onSendMessage(text, clientMsgId) + 贴底 + 清引用", async () => {
    const onSendMessage = vi
      .fn()
      .mockResolvedValue({ localMessageId: "srv-1", sendStatus: 1, messageTime: "" });
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
      .mockResolvedValue({ localMessageId: "srv-9", sendStatus: 1, messageTime: "" });
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
