import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import type { Message } from "./data";
import { MessageBubble } from "./MessageBubble";

afterEach(() => {
  cleanup();
});

const LONG_UNBREAKABLE = "1".repeat(200);

function makeMessage(overrides: Partial<Message> = {}): Message {
  const text = overrides.text ?? LONG_UNBREAKABLE;
  return {
    id: "m1",
    conversationId: "c1",
    direction: "out",
    sentAt: "2026-05-08T09:51:00.000Z",
    text,
    parts: [{ kind: "text", text }],
    ...overrides,
  };
}

// jsdom does not run real layout, so we cannot observe overflow widths directly.
// Instead, encode the contract in classNames: the article must allow shrinking
// (min-w-0 + max-w-full) and the text wrapper must use overflow-wrap:anywhere
// so min-content of unbreakable runs collapses. That is the actual fix for the
// long-text overflow bug — `break-words` alone does NOT shrink min-content and
// lets the article blow out of its capped column.
describe("MessageBubble — long-text wrapping", () => {
  it("outgoing bubble article shrinks below content min-content", () => {
    const { container } = render(
      <MessageBubble message={makeMessage({ direction: "out" })} avatarName="小美" account="me" />,
    );
    const article = container.querySelector("article");
    expect(article).not.toBeNull();
    const cls = article!.className;
    expect(cls).toContain("min-w-0");
    expect(cls).toContain("max-w-full");
  });

  it("incoming bubble article shrinks below content min-content", () => {
    const { container } = render(
      <MessageBubble message={makeMessage({ direction: "in" })} avatarName="小美" account="me" />,
    );
    const article = container.querySelector("article");
    expect(article).not.toBeNull();
    const cls = article!.className;
    expect(cls).toContain("min-w-0");
    expect(cls).toContain("max-w-full");
  });

  it("text wrapper uses overflow-wrap:anywhere so unbreakable runs can wrap", () => {
    const { container } = render(
      <MessageBubble message={makeMessage()} avatarName="小美" account="me" />,
    );
    const article = container.querySelector("article");
    // Pick the actual text wrapper (article also contains the time tooltip span).
    const textWrapper = article!.querySelector("span.whitespace-pre-wrap");
    expect(textWrapper).not.toBeNull();
    expect(textWrapper!.className).toContain("[overflow-wrap:anywhere]");
  });
});

// 纯附件消息(文件/语音、无文本)走"无气泡 chrome"分支:卡片本身即气泡,剥掉外层灰底/内边距/
// 描边,消除卡中卡双重边框。带文本的消息仍保留气泡(文字需要承载容器)。
describe("MessageBubble — attachment-only chrome-less", () => {
  it("file-only message drops bubble background/padding (card is the bubble)", () => {
    const { container } = render(
      <MessageBubble
        message={makeMessage({
          direction: "out",
          text: "",
          parts: [{ kind: "file", url: "https://e.example/a.pdf", name: "a.pdf", sizeBytes: 1024 }],
        })}
        avatarName="小美"
        account="me"
      />,
    );
    const cls = container.querySelector("article")!.className;
    expect(cls).not.toContain("bg-workbench-bubble-out");
    expect(cls).not.toContain("px-4");
    // 文件卡片本身仍渲染(重构后仅以下载按钮触发保存,不再是整卡 a[download])。
    expect(container.textContent).toContain("a.pdf");
    expect(container.querySelector("button[aria-label]")).not.toBeNull();
  });

  it("voice-only message drops bubble background", () => {
    const { container } = render(
      <MessageBubble
        message={makeMessage({
          direction: "in",
          text: "",
          parts: [{ kind: "voice", url: "https://e.example/v.amr", durationSec: 8 }],
        })}
        avatarName="小美"
        account="me"
      />,
    );
    const cls = container.querySelector("article")!.className;
    expect(cls).not.toContain("bg-workbench-bubble-in");
  });

  it("file-with-caption message keeps the bubble (text needs a container)", () => {
    const { container } = render(
      <MessageBubble
        message={makeMessage({
          direction: "out",
          text: "见附件",
          parts: [
            { kind: "text", text: "见附件" },
            { kind: "file", url: "https://e.example/a.pdf", name: "a.pdf", sizeBytes: 1024 },
          ],
        })}
        avatarName="小美"
        account="me"
      />,
    );
    const cls = container.querySelector("article")!.className;
    expect(cls).toContain("bg-workbench-bubble-out");
  });
});

// 重发抖动根因:失败状态行若占文档流高度,点重发(failed→sending)会让气泡列高塌缩、
// 下方消息上移,失败回弹再下移 → 抖动。修复约束:失败/重发状态行必须脱离文档流
// (absolute + top-full),浮在气泡下方间距里,使 sending/failed/sent 三态行高一致、
// 状态切换不撑动布局。jsdom 无真实布局,故以 className 契约编码该不变量。
describe("MessageBubble — failed status line out of flow (no resend flicker)", () => {
  it("failed/resend status line is absolutely positioned below the bubble", () => {
    const { container } = render(
      <MessageBubble
        message={makeMessage({ direction: "out", text: "hi", status: "failed" })}
        avatarName="小美"
        account="me"
      />,
    );
    const resendBtn = container.querySelector('button[title="重发"]');
    expect(resendBtn).not.toBeNull();
    const statusLine = resendBtn!.parentElement!;
    expect(statusLine.className).toContain("absolute");
    expect(statusLine.className).toContain("top-full");
    // 「发送失败 重发」必须单行,不能在窄气泡下被挤成竖排折行。
    expect(statusLine.className).toContain("whitespace-nowrap");
  });
});
