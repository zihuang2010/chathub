import { describe, expect, it, vi } from "vitest";

import type { Conversation, Message } from "../data";
import { buildTimelineItemsForTest } from "./useChatTimeline";

const conversation: Conversation = {
  id: "conv-1",
  name: "客户",
  preview: "",
  account: "账号",
  time: "12:00",
  unread: 0,
  online: false,
};

function message(id: string, replyTo?: string): Message {
  const n = Number(id);
  const hour = 10 + Math.floor(n / 60);
  const minute = n % 60;
  return {
    id,
    conversationId: conversation.id,
    direction: "in",
    text: `消息 ${id}`,
    parts: [{ kind: "text", text: `消息 ${id}` }],
    sentAt: `2026-05-19T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`,
    replyTo,
  };
}

describe("buildTimelineItemsForTest", () => {
  it("resolves reply targets while scanning the message list only once", () => {
    const messages = Array.from({ length: 120 }, (_, i) => {
      const id = String(i + 1);
      return message(id, i > 0 ? String(i) : undefined);
    });
    const findSpy = vi.spyOn(messages, "find");

    const items = buildTimelineItemsForTest(messages, conversation, null, 0);

    expect(findSpy).not.toHaveBeenCalled();
    const replied = items.find((item) => item.type === "message" && item.id === "120");
    expect(replied?.type === "message" ? replied.replyTarget?.text : undefined).toBe("消息 119");
  });
});
