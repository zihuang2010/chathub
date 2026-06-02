// buildPolishContext 纯函数单测:覆盖方向前缀、附件占位、撤回过滤、最近 10 条截断、
// 1500 字符上限丢旧、空输入→""。
import { describe, expect, it } from "vitest";

import type { Message, MessagePart } from "../data";
import { buildPolishContext } from "./polishContext";

// 构造一条消息:只关心转录相关字段,其余取最小合法值。
function msg(
  partial: Pick<Message, "direction"> &
    Partial<Pick<Message, "text" | "parts" | "isRecalled">> & { id?: string },
): Message {
  return {
    id: partial.id ?? "m",
    conversationId: "conv-1",
    direction: partial.direction,
    text: partial.text ?? "",
    parts: partial.parts ?? [],
    sentAt: "2026-05-19T10:00:00.000Z",
    isRecalled: partial.isRecalled,
  };
}

const textPart = (t: string): MessagePart => ({ kind: "text", text: t });
const imagePart: MessagePart = { kind: "image", url: "u" };
const filePart: MessagePart = { kind: "file", url: "u" };
const voicePart: MessagePart = { kind: "voice", url: "u" };
const videoPart: MessagePart = { kind: "video", url: "u" };

describe("buildPolishContext", () => {
  it("方向前缀:in→客户、out→客服,旧→新,\\n 连接", () => {
    const out = buildPolishContext([
      msg({ direction: "in", text: "在吗" }),
      msg({ direction: "out", text: "在的" }),
    ]);
    expect(out).toBe("客户：在吗\n客服：在的");
  });

  it("文本非空(trim 后)优先用文本", () => {
    const out = buildPolishContext([
      msg({ direction: "in", text: "  你好  ", parts: [imagePart] }),
    ]);
    expect(out).toBe("客户：你好");
  });

  it("文本为空时按首个非文本 part 取占位", () => {
    const out = buildPolishContext([
      msg({ direction: "in", text: "", parts: [imagePart] }),
      msg({ direction: "out", text: "   ", parts: [filePart] }),
      msg({ direction: "in", text: "", parts: [voicePart] }),
      msg({ direction: "out", text: "", parts: [videoPart] }),
    ]);
    expect(out).toBe("客户：[图片]\n客服：[文件]\n客户：[语音]\n客服：[视频]");
  });

  it("文本为空且无 parts → [非文本消息]", () => {
    const out = buildPolishContext([msg({ direction: "in", text: "", parts: [] })]);
    expect(out).toBe("客户：[非文本消息]");
  });

  it("首个 part 为文本但 text 为空时,跳过文本 part 取首个非文本", () => {
    const out = buildPolishContext([
      msg({ direction: "in", text: "", parts: [textPart(""), filePart] }),
    ]);
    expect(out).toBe("客户：[文件]");
  });

  it("过滤撤回消息(isRecalled)", () => {
    const out = buildPolishContext([
      msg({ direction: "in", text: "保留1" }),
      msg({ direction: "out", text: "已撤回", isRecalled: true }),
      msg({ direction: "in", text: "保留2" }),
    ]);
    expect(out).toBe("客户：保留1\n客户：保留2");
  });

  it("只取最近 10 条(尾部),保持时间顺序", () => {
    const messages = Array.from({ length: 15 }, (_, i) =>
      msg({ direction: "in", text: `T${i + 1}`, id: String(i + 1) }),
    );
    const out = buildPolishContext(messages);
    const lines = out.split("\n");
    expect(lines).toHaveLength(10);
    // 最近 10 条 = T6..T15,旧→新。
    expect(lines[0]).toBe("客户：T6");
    expect(lines[9]).toBe("客户：T15");
  });

  it("撤回过滤后再取最近 10 条", () => {
    // 12 条,其中 2 条撤回,剩 10 条恰好全保留。
    const messages = Array.from({ length: 12 }, (_, i) =>
      msg({
        direction: "in",
        text: `T${i + 1}`,
        id: String(i + 1),
        isRecalled: i === 2 || i === 5,
      }),
    );
    const out = buildPolishContext(messages);
    expect(out.split("\n")).toHaveLength(10);
    expect(out).not.toContain("T3");
    expect(out).not.toContain("T6");
  });

  it("超 1500 字符上限时从最旧行起丢弃,保留最近", () => {
    // 5 条,每条内容 500 字 → 单行约 503 字("客户："+ 500 + 内容)。
    // 拼 4 行已远超 1500,应只保留最近 2~3 行,且最旧的被丢弃。
    const big = "字".repeat(500);
    const messages = [
      msg({ direction: "in", text: "OLD" + big, id: "1" }),
      msg({ direction: "in", text: "A" + big, id: "2" }),
      msg({ direction: "in", text: "B" + big, id: "3" }),
      msg({ direction: "in", text: "C" + big, id: "4" }),
    ];
    const out = buildPolishContext(messages);
    expect(out.length).toBeLessThanOrEqual(1500);
    // 最旧一行被丢弃。
    expect(out).not.toContain("OLD");
    // 最近一行保留。
    expect(out).toContain("C" + big);
  });

  it("文本内容经脱敏:手机号被遮成占位", () => {
    const out = buildPolishContext([msg({ direction: "in", text: "我的电话13800138000" })]);
    expect(out).toBe("客户：我的电话[手机号]");
  });

  it("空输入 → 空串", () => {
    expect(buildPolishContext([])).toBe("");
  });

  it("全部被撤回 → 空串", () => {
    const out = buildPolishContext([
      msg({ direction: "in", text: "x", isRecalled: true }),
      msg({ direction: "out", text: "y", isRecalled: true }),
    ]);
    expect(out).toBe("");
  });
});
