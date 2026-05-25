import { describe, expect, it } from "vitest";

import { buildMessageParts } from "./data";
import type { Message, MessageAttachment, MessageBlock } from "./data";
import { afterEach } from "vitest";

import { isSafeUrl, messageReplyPreview, thumbWidth } from "./utils";

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

// 缩略图宽度的 DPR 自适应 + 封顶逻辑(「切会话 + 滑动图片历史」内存优化里唯一可在 jsdom
// faithful 验证的部分:它决定 webview 解码位图的面积 = 内存大头)。锁死:低分屏取显示宽(省内存)、
// 视网膜维持历史 384(画质不变)、任何情况封顶 384(永不比旧硬编码更耗内存)。overscan / 虚拟化
// 阈值的内存收益依赖真实布局,jsdom 无法复现,不在此测。
describe("thumbWidth:DPR 自适应缩略图宽(封顶 384)", () => {
  const setDpr = (v: number) =>
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: v });
  afterEach(() => setDpr(1)); // jsdom 默认 1,复位避免污染其他用例

  it("低分屏(1×):取显示宽,解码位图最小", () => {
    setDpr(1);
    expect(thumbWidth(192)).toBe(192); // 192 盒(独立图 / 附件图)
    expect(thumbWidth(260)).toBe(260); // 内联图(max-w 260)
  });

  it("视网膜(2×):与旧硬编码 384 一致,画质不变", () => {
    setDpr(2);
    expect(thumbWidth(192)).toBe(384); // 192×2
    expect(thumbWidth(260)).toBe(384); // 260×2=520 → 封顶 384
  });

  it("超高 dpr(3×):dpr 系数上限 2,再被 384 总封顶", () => {
    setDpr(3);
    expect(thumbWidth(192)).toBe(384);
    expect(thumbWidth(260)).toBe(384);
  });

  it("中等 dpr(1.5×,常见于 Windows):按比例缩,仍不超 384", () => {
    setDpr(1.5);
    expect(thumbWidth(192)).toBe(288); // 192×1.5
    expect(thumbWidth(260)).toBe(384); // 260×1.5=390 → 封顶 384
  });

  it("任何 cssWidth 都不超过 384(永不比旧固定值更耗内存)", () => {
    setDpr(2);
    for (const w of [192, 260, 300, 400]) {
      expect(thumbWidth(w)).toBeLessThanOrEqual(384);
    }
  });
});
