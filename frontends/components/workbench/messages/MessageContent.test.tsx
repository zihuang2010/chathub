import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

// mock @tauri-apps/api/core 让 assetImageSrc 在测试环境下正常工作
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  convertFileSrc: (p: string) => `asset://localhost/${encodeURIComponent(p)}`,
}));

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
    // 重构后 ImageAttachment 使用 button[title] 而非 a[title]（点击打开灯箱）。
    const btns = container.querySelectorAll("button[title]");
    expect(btns).toHaveLength(1);
    // img src 包含原始 URL（经 cachedImageSrc 编码）
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toContain("e.example");
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
    // 重构后 ImageStandalone 使用 button[title] 而非 a[title]（点击打开灯箱）。
    const standalone = container.querySelector("button[title]");
    expect(standalone).not.toBeNull();
    // img src 包含原始 URL
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toContain("solo.png");
    expect(container.querySelectorAll("button.mx-1")).toHaveLength(0); // no inline image rendered
  });

  it("renders text + image + text in source order, image inline (not standalone)", () => {
    const { container } = renderContent({
      blocks: [
        { type: "text", value: "你好，" },
        { type: "image", url: "https://e.example/inline.png" },
        { type: "text", value: "请确认" },
      ],
    });
    // 重构后内联图片包裹在 button.mx-1（而非 a.mx-1）。
    const inlineImages = container.querySelectorAll("button.mx-1");
    expect(inlineImages).toHaveLength(1);
    // img src 包含原始 URL
    const img = inlineImages[0].querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toContain("inline.png");

    // Standalone selector（button[title]）不应匹配 — 这是混合内容。
    expect(container.querySelectorAll("button[title]")).toHaveLength(0);

    // DOM 顺序断言：内联图前面文本以"，"结尾，后面文本以"请"开头。
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
    // 重构后内联图片包裹在 button.mx-1。
    const inlineImages = container.querySelectorAll("button.mx-1");
    expect(inlineImages).toHaveLength(2);
    // 检查 img src 包含对应 URL
    const img0 = inlineImages[0].querySelector("img");
    const img1 = inlineImages[1].querySelector("img");
    expect(img0!.getAttribute("src")).toContain("a.png");
    expect(img1!.getAttribute("src")).toContain("b.png");
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
    // src 经过 cachedImageSrc 编码，检查包含原始 URL 片段
    expect(allImages[0].getAttribute("src")).toContain("inline.png");
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
    // 重构后内联图片包裹在 button.mx-1
    expect(container.querySelectorAll("button.mx-1")).toHaveLength(1); // the inline image
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
  it("uses bottom-aligned clipped media buttons to avoid inline baseline whitespace", () => {
    const { container } = renderContent({
      blocks: [{ type: "image", url: "https://e.example/img.png" }],
    });

    const button = container.querySelector("button[title]")!;
    expect(button.className).toContain("align-bottom");
    expect(button.className).toContain("overflow-hidden");
    expect(button.className).toContain("rounded-xl");
  });

  it("renders a fixed-size container + opacity-0 img + skeleton in loading state", () => {
    const { container } = renderContent({
      blocks: [{ type: "image", url: "https://e.example/img.png" }],
    });
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    // img stays opacity-0 until onLoad fires — 杜绝 broken-icon 闪现。
    expect(img?.className).toContain("opacity-0");
    // 无宽高时回退固定 192×192 方盒（内联样式）。
    const sizedContainer = img!.parentElement!;
    expect(sizedContainer.style.width).toBe("192px");
    expect(sizedContainer.style.height).toBe("192px");
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

  it("keeps the loaded image visible while a different src is pending", () => {
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
    const images = container.querySelectorAll("img");
    expect(images[0].getAttribute("src")).toContain("a.png");
    expect(images[0].className).not.toContain("opacity-0");
    expect(images[1].getAttribute("src")).toContain("b.png");
    expect(images[1].className).toContain("opacity-0");
    expect(container.querySelector("span.animate-pulse")).toBeNull();
  });

  it("skips skeleton when the same image src has already loaded once", () => {
    const { container, unmount } = renderContent({
      attachments: [{ type: "image", url: "https://e.example/warm.png", name: "warm.png" }],
    });
    const firstImg = container.querySelector("img")!;
    act(() => {
      fireEvent.load(firstImg);
    });
    unmount();

    const second = renderContent({
      attachments: [{ type: "image", url: "https://e.example/warm.png", name: "warm.png" }],
    });

    expect(second.container.querySelector("span.animate-pulse")).toBeNull();
    expect(second.container.querySelector("img")?.className).not.toContain("opacity-0");
  });

  it("keeps the loaded remote image visible while switching to a pending asset src", () => {
    const { container, rerender } = render(
      <article>
        <MessageContent
          parts={[{ kind: "image", url: "https://filet.jdd51.com/a.png", width: 400, height: 200 }]}
        />
      </article>,
    );
    const remoteImg = container.querySelector("img")!;
    act(() => {
      fireEvent.load(remoteImg);
    });

    rerender(
      <article>
        <MessageContent
          parts={[
            {
              kind: "image",
              url: "https://filet.jdd51.com/a.png",
              width: 400,
              height: 200,
              localPath: "/c/a.img",
            },
          ]}
        />
      </article>,
    );

    const images = container.querySelectorAll("img");
    expect(images[0].getAttribute("src")).toContain("filet.jdd51.com");
    expect(images[0].className).not.toContain("opacity-0");
    expect(images[1].getAttribute("src")).toContain("asset://localhost");
    expect(images[1].className).toContain("opacity-0");
    expect(container.querySelector("span.animate-pulse")).toBeNull();
  });
});

describe("MessageImage 比例盒 + asset 源（R1/R2/R4）", () => {
  it("有本地路径+宽高：img 有 object-contain 类、外层盒有 aspectRatio 内联样式", () => {
    // 直接渲染带 localPath+宽高的 part
    render(
      <article>
        <MessageContent
          parts={[
            {
              kind: "image",
              url: "https://filet.jdd51.com/a.png",
              width: 400,
              height: 200,
              localPath: "/c/a.img",
            },
          ]}
        />
      </article>,
    );
    const img = screen.getByRole("img", { hidden: true }) as HTMLImageElement;
    // 有 object-contain
    expect(img.className).toContain("object-contain");
    // 外层盒有 aspectRatio 内联样式（2:1）
    const box = img.parentElement!;
    expect(box.style.aspectRatio).toBe("400 / 200");
  });

  it("无宽高时回退 192×192 固定尺寸盒（向后兼容）", () => {
    const { container } = render(
      <article>
        <MessageContent parts={[{ kind: "image", url: "https://e.example/img.png" }]} />
      </article>,
    );
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    const box = img!.parentElement!;
    // 无宽高：内联 style.width 和 style.height 均为 192px
    expect(box.style.width).toBe("192px");
    expect(box.style.height).toBe("192px");
  });

  it("有本地路径时不渲染骨架", () => {
    const { container } = render(
      <article>
        <MessageContent
          parts={[
            {
              kind: "image",
              url: "https://filet.jdd51.com/a.png",
              width: 400,
              height: 200,
              localPath: "/c/a.img",
            },
          ]}
        />
      </article>,
    );
    // 有 localPath → asset src → 初始为 loaded，不画骨架
    expect(container.querySelector("span.animate-pulse")).toBeNull();
    // img 不应该是 opacity-0
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.className).not.toContain("opacity-0");
  });

  it("容器样式含 rounded-xl ring-1 ring-workbench-line（四边一致）", () => {
    const { container } = render(
      <article>
        <MessageContent parts={[{ kind: "image", url: "https://e.example/img.png" }]} />
      </article>,
    );
    const img = container.querySelector("img");
    const box = img!.parentElement!;
    expect(box.className).toContain("rounded-xl");
    expect(box.className).toContain("ring-1");
    expect(box.className).toContain("ring-workbench-line");
  });

  it("本地 asset 图用 eager+sync、远程回退用 lazy+async（重挂同帧出像素、消空白闪）", () => {
    // 本地 asset 源(已落盘、WebView 可靠缓存)→ eager + 同步解码:重挂/切回/上滑同帧出像素。
    const local = render(
      <article>
        <MessageContent
          parts={[
            {
              kind: "image",
              url: "https://filet.jdd51.com/a.png",
              width: 400,
              height: 200,
              localPath: "/c/a.img",
            },
          ]}
        />
      </article>,
    );
    const localImg = local.container.querySelector("img")!;
    expect(localImg.getAttribute("loading")).toBe("eager");
    expect(localImg.getAttribute("decoding")).toBe("sync");
    local.unmount();

    // 远程回退源(cachedimg://,预取未完成的过渡态)→ lazy + 异步,省屏外解码内存。
    const remote = render(
      <article>
        <MessageContent parts={[{ kind: "image", url: "https://e.example/img.png" }]} />
      </article>,
    );
    const remoteImg = remote.container.querySelector("img")!;
    expect(remoteImg.getAttribute("loading")).toBe("lazy");
    expect(remoteImg.getAttribute("decoding")).toBe("async");
  });

  it("首次无后端宽高：onLoad 读 <img> 固有宽高即切比例盒（消白边二段跳）", () => {
    const { container } = render(
      <article>
        <MessageContent parts={[{ kind: "image", url: "https://e.example/p.png" }]} />
      </article>,
    );
    const img = container.querySelector("img")!;
    // 加载前无任何 dims → 固定 192 方盒（此刻 object-contain 会把非方图留白边）。
    expect(img.parentElement!.style.width).toBe("192px");
    expect(img.parentElement!.style.height).toBe("192px");
    // jsdom 不解码，手动赋固有宽高模拟"图片字节加载完"。
    Object.defineProperty(img, "naturalWidth", { value: 300, configurable: true });
    Object.defineProperty(img, "naturalHeight", { value: 150, configurable: true });
    act(() => {
      fireEvent.load(img);
    });
    // 加载后立刻按固有比例 2:1 切比例盒（不再 192 方盒、不再留白边）。
    const box = img.parentElement!;
    expect(box.style.aspectRatio).toBe("300 / 150");
    expect(box.style.width).toBe("100%");
  });
});
