import { describe, expect, it } from "vitest";

import type { Message } from "./data";
import { messageReplyPreview } from "./utils";

function makeMessage(partial: Partial<Message>): Message {
  return {
    id: "m1",
    conversationId: "c1",
    direction: "in",
    text: "",
    sentAt: "2026-05-19T00:00:00.000Z",
    ...partial,
  };
}

describe("messageReplyPreview", () => {
  it("returns trimmed text when present", () => {
    expect(messageReplyPreview(makeMessage({ text: "  hi there  " }))).toBe("hi there");
  });

  it("falls back to [图片] for image-only blocks (empty text)", () => {
    const msg = makeMessage({
      text: "",
      blocks: [{ type: "image", url: "data:image/png;base64,xxx" }],
    });
    expect(messageReplyPreview(msg)).toBe("[图片]");
  });

  it("falls back to [图片] for image attachment", () => {
    const msg = makeMessage({
      text: "",
      attachments: [{ type: "image", url: "https://x/y.png" }],
    });
    expect(messageReplyPreview(msg)).toBe("[图片]");
  });

  it("falls back to [文件] for file attachment", () => {
    const msg = makeMessage({
      text: "",
      attachments: [{ type: "file", url: "blob:abc", name: "x.pdf" }],
    });
    expect(messageReplyPreview(msg)).toBe("[文件]");
  });

  it("falls back to [语音] for voice attachment", () => {
    const msg = makeMessage({
      text: "",
      attachments: [{ type: "voice", url: "blob:v", durationSec: 5 }],
    });
    expect(messageReplyPreview(msg)).toBe("[语音]");
  });

  it("falls back to [视频] for video attachment", () => {
    const msg = makeMessage({
      text: "",
      attachments: [{ type: "video", url: "blob:vd" }],
    });
    expect(messageReplyPreview(msg)).toBe("[视频]");
  });

  it("prefers text over blocks/attachments when both are present", () => {
    const msg = makeMessage({
      text: "hello",
      blocks: [{ type: "image", url: "x" }],
      attachments: [{ type: "file", url: "y" }],
    });
    expect(messageReplyPreview(msg)).toBe("hello");
  });

  it("whitespace-only text falls through to attachment placeholder", () => {
    const msg = makeMessage({
      text: "   \n  ",
      attachments: [{ type: "image", url: "x" }],
    });
    expect(messageReplyPreview(msg)).toBe("[图片]");
  });

  it("returns empty string when no content is available", () => {
    expect(messageReplyPreview(makeMessage({ text: "" }))).toBe("");
  });
});
