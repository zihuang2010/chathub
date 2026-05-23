import { describe, expect, it } from "vitest";

import { buildMessageParts } from "./data";
import type { Message, MessageAttachment, MessageBlock } from "./data";
import { isSafeUrl, messageReplyPreview } from "./utils";

function makeMessage(
  partial: Omit<Partial<Message>, "parts"> & {
    blocks?: MessageBlock[];
    attachments?: MessageAttachment[];
  },
): Message {
  const { text = "", blocks, attachments, ...rest } = partial;
  return {
    id: "m1",
    conversationId: "c1",
    direction: "in",
    sentAt: "2026-05-19T00:00:00.000Z",
    text,
    parts: buildMessageParts(text, blocks, attachments),
    ...rest,
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

describe("isSafeUrl", () => {
  it("放行 http/https 与应用自有 mediaproxy 协议", () => {
    expect(isSafeUrl("http://e.example/a.png", "link")).toBe(true);
    expect(isSafeUrl("https://e.example/a.png", "image")).toBe(true);
    expect(isSafeUrl("mediaproxy://abc", "image")).toBe(true);
    expect(isSafeUrl("mediaproxy://abc", "link")).toBe(true);
  });

  it("image 额外放行 data:image/ 与 blob:,但 link 不放行", () => {
    expect(isSafeUrl("data:image/png;base64,xxx", "image")).toBe(true);
    expect(isSafeUrl("blob:abc", "image")).toBe(true);
    expect(isSafeUrl("data:image/png;base64,xxx", "link")).toBe(false);
    expect(isSafeUrl("blob:abc", "link")).toBe(false);
  });

  it("拦截危险协议 javascript/file/vbscript 与 data:text/html", () => {
    expect(isSafeUrl("javascript:alert(1)", "link")).toBe(false);
    expect(isSafeUrl("file:///etc/passwd", "link")).toBe(false);
    expect(isSafeUrl("vbscript:msgbox(1)", "image")).toBe(false);
    expect(isSafeUrl("data:text/html,<script>alert(1)</script>", "image")).toBe(false);
  });

  it("拦截内嵌控制字符的协议绕过", () => {
    expect(isSafeUrl("java\nscript:alert(1)", "link")).toBe(false);
    expect(isSafeUrl("  java\tscript:alert(1)  ", "link")).toBe(false);
  });

  it("放行站内相对路径,但拦截协议相对 //host", () => {
    expect(isSafeUrl("/avatars/a01.png", "image")).toBe(true);
    expect(isSafeUrl("foo/bar.png", "image")).toBe(true);
    expect(isSafeUrl("//evil.example/x", "image")).toBe(false);
  });

  it("空值返回 false", () => {
    expect(isSafeUrl(undefined, "link")).toBe(false);
    expect(isSafeUrl("", "image")).toBe(false);
    expect(isSafeUrl("   ", "link")).toBe(false);
  });
});
