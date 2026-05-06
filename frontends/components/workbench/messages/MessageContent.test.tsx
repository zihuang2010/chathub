import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import type { MessageAttachment, MessageBlock } from "./data";
import { MessageContent } from "./MessageContent";

afterEach(() => {
  cleanup();
});

function renderContent(props: {
  text?: string;
  blocks?: MessageBlock[];
  attachments?: MessageAttachment[];
}) {
  return render(
    <article data-testid="bubble">
      <MessageContent
        text={props.text ?? ""}
        blocks={props.blocks}
        attachments={props.attachments}
      />
    </article>,
  );
}

describe("MessageContent legacy path (no blocks)", () => {
  it("renders plain text without attachments when blocks is undefined", () => {
    const { getByTestId, queryAllByRole } = renderContent({ text: "你好" });
    expect(getByTestId("bubble").textContent).toBe("你好");
    expect(queryAllByRole("link")).toHaveLength(0);
  });

  it("renders legacy image attachment under text", () => {
    const { container } = renderContent({
      text: "看图",
      attachments: [{ type: "image", url: "https://e.example/x.png", name: "x.png" }],
    });
    // Legacy path goes to ImageAttachment which uses `title` to mark "open image".
    const links = container.querySelectorAll("a[title]");
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toBe("https://e.example/x.png");
  });

  it("falls through to file attachment for non-image type", () => {
    const { container } = renderContent({
      text: "",
      attachments: [
        { type: "file", url: "https://e.example/y.pdf", name: "y.pdf", sizeBytes: 1024 },
      ],
    });
    const link = container.querySelector("a[download]");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("https://e.example/y.pdf");
  });
});

describe("MessageContent blocks path", () => {
  it("renders single image block as standalone big card (matches legacy image bubble visual)", () => {
    const { container } = renderContent({
      blocks: [{ type: "image", url: "https://e.example/solo.png" }],
    });
    // Standalone uses `title` attr on the wrapping anchor (distinguishes from inline).
    const standalone = container.querySelector("a[title]");
    expect(standalone).not.toBeNull();
    expect(standalone?.getAttribute("href")).toBe("https://e.example/solo.png");
    expect(container.querySelectorAll("a.mx-1")).toHaveLength(0); // no inline image rendered
  });

  it("renders text + image + text in source order, image inline (not standalone)", () => {
    const { container } = renderContent({
      blocks: [
        { type: "text", value: "你好，" },
        { type: "image", url: "https://e.example/inline.png" },
        { type: "text", value: "请确认" },
      ],
    });
    // The inline image is wrapped in `<a class="... mx-1 ...">`.
    const inlineImages = container.querySelectorAll("a.mx-1");
    expect(inlineImages).toHaveLength(1);
    expect(inlineImages[0].getAttribute("href")).toBe("https://e.example/inline.png");

    // Standalone selector (`a[title]`) must NOT match — this is mixed content.
    expect(container.querySelectorAll("a[title]")).toHaveLength(0);

    // DOM-order assertion: the inline image's previous text node ends with "，"
    // and the next text node starts with "请".
    expect(container.textContent).toBe("你好，请确认");
  });

  it("renders multiple inline images in declared order", () => {
    const { container } = renderContent({
      blocks: [
        { type: "image", url: "https://e.example/a.png" },
        { type: "text", value: " " },
        { type: "image", url: "https://e.example/b.png" },
      ],
    });
    const inlineImages = container.querySelectorAll("a.mx-1");
    expect(inlineImages).toHaveLength(2);
    expect(inlineImages[0].getAttribute("href")).toBe("https://e.example/a.png");
    expect(inlineImages[1].getAttribute("href")).toBe("https://e.example/b.png");
  });

  it("filters image-type attachments when blocks are present (avoids double-rendering)", () => {
    const { container } = renderContent({
      blocks: [
        { type: "text", value: "hi" },
        { type: "image", url: "https://e.example/inline.png" },
      ],
      // Old code path kept this image in attachments — must NOT render it again.
      attachments: [{ type: "image", url: "https://e.example/legacy.png" }],
    });
    const allImages = container.querySelectorAll("img");
    expect(allImages).toHaveLength(1);
    expect(allImages[0].getAttribute("src")).toBe("https://e.example/inline.png");
  });

  it("keeps non-image attachments visible alongside blocks", () => {
    const { container } = renderContent({
      blocks: [
        { type: "text", value: "see file" },
        { type: "image", url: "https://e.example/inline.png" },
      ],
      attachments: [
        { type: "file", url: "https://e.example/doc.pdf", name: "doc.pdf", sizeBytes: 2048 },
      ],
    });
    expect(container.querySelectorAll("a.mx-1")).toHaveLength(1); // the inline image
    expect(container.querySelector("a[download]")).not.toBeNull(); // the file card
  });

  it("renders link / mention / emoji decorations inside text blocks", () => {
    const { container } = renderContent({
      blocks: [{ type: "text", value: "去 https://e.example/q 找 @张三" }],
    });
    const link = container.querySelector('a[href="https://e.example/q"]');
    expect(link).not.toBeNull();
    // mention span: formatRichText emits a span with workbench-accent text class
    const mention = container.querySelector("span.font-medium.text-workbench-accent");
    expect(mention?.textContent).toContain("张三");
  });
});
