import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

import { buildMessageParts } from "./data";
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
  const parts = buildMessageParts(props.text ?? "", props.blocks, props.attachments);
  return render(
    <article data-testid="bubble">
      <MessageContent parts={parts} />
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

describe("MessageImage layout-shift + error fallback", () => {
  it("renders a min-sized container + opacity-0 img + skeleton in loading state", () => {
    const { container } = renderContent({
      blocks: [{ type: "image", url: "https://e.example/img.png" }],
    });
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    // img stays opacity-0 until onLoad fires — 杜绝 broken-icon 闪现。
    expect(img?.className).toContain("opacity-0");
    // min-h-32 / min-w-32 锁住容器尺寸,避免加载完成时的 layout shift。
    const sizedContainer = container.querySelector("span.min-h-32.min-w-32");
    expect(sizedContainer).not.toBeNull();
    // 骨架 overlay 存在。
    const skeleton = container.querySelector("span.animate-pulse");
    expect(skeleton).not.toBeNull();
  });

  it("reveals img and drops skeleton after onLoad", () => {
    const { container } = renderContent({
      attachments: [{ type: "image", url: "https://e.example/ok.png", name: "ok.png" }],
    });
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    act(() => {
      fireEvent.load(img!);
    });
    expect(img?.className).not.toContain("opacity-0");
    expect(container.querySelector("span.animate-pulse")).toBeNull();
  });

  it("swaps to error placeholder (no img element) when onError fires", () => {
    const { container, queryByLabelText } = renderContent({
      attachments: [{ type: "image", url: "mediaproxy://abc", name: "x.png" }],
    });
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    act(() => {
      fireEvent.error(img!);
    });
    // 失败后 img 卸载,杜绝浏览器 broken-icon 兜底。
    expect(container.querySelector("img")).toBeNull();
    // 稳定的中文占位代替 broken-icon。
    expect(queryByLabelText("图片加载失败")).not.toBeNull();
  });

  it("resets state to loading when src changes", () => {
    const { container, rerender } = render(
      <article>
        <MessageContent
          parts={buildMessageParts("", undefined, [
            { type: "image", url: "https://e.example/a.png" },
          ])}
        />
      </article>,
    );
    const firstImg = container.querySelector("img")!;
    act(() => {
      fireEvent.load(firstImg);
    });
    expect(firstImg.className).not.toContain("opacity-0");

    rerender(
      <article>
        <MessageContent
          parts={buildMessageParts("", undefined, [
            { type: "image", url: "https://e.example/b.png" },
          ])}
        />
      </article>,
    );
    const secondImg = container.querySelector("img")!;
    expect(secondImg.getAttribute("src")).toBe("https://e.example/b.png");
    expect(secondImg.className).toContain("opacity-0");
  });
});
