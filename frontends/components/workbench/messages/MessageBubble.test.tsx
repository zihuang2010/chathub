import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import type { Message } from "./data";
import { MessageBubble } from "./MessageBubble";

afterEach(() => {
  cleanup();
});

const LONG_UNBREAKABLE = "1".repeat(200);

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "m1",
    conversationId: "c1",
    direction: "out",
    text: LONG_UNBREAKABLE,
    sentAt: "2026-05-08T09:51:00.000Z",
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
