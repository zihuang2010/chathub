import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// mock @tauri-apps/api/core 让 assetImageSrc 在测试环境下正常工作
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  convertFileSrc: (p: string) => `asset://localhost/${encodeURIComponent(p)}`,
}));

// mock benz-amr-recorder:语音点击播放经动态 import 该库解码;此处用最小桩暴露
// initWithBlob/play 的 spy,验证本地预览语音确实走进了应用内解码路径。
const benzMock = vi.hoisted(() => ({
  initWithBlob: vi.fn(() => Promise.resolve()),
  play: vi.fn(),
}));
vi.mock("benz-amr-recorder", () => ({
  default: class {
    initWithBlob = benzMock.initWithBlob;
    play = benzMock.play;
    onPlay() {}
    onStop() {}
    onEnded() {}
    getDuration() {
      return 0;
    }
    isPlaying() {
      return false;
    }
    stop() {}
  },
}));

import { buildMessageParts } from "./data";
import type { MessageAttachment, MessageBlock } from "./data";
import { MessageContent } from "./MessageContent";
import { STRINGS } from "./strings";

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
    // 文件卡仅以下载按钮触发保存(不再是整卡 a[download]);校验卡片渲染 + 下载按钮存在。
    expect(container.textContent).toContain("y.pdf");
    expect(container.querySelector("button[aria-label]")).not.toBeNull();
  });
});

describe("MessageContent blocks path", () => {
  it("renders single image block as standalone big card (matches legacy image bubble visual)", () => {
    const { container } = renderContent({
      blocks: [{ type: "image", url: "https://e.example/solo.png" }],
    });
    // 单图独占大卡复用 ImageAttachment,使用 button[title] 而非 a[title]（点击打开灯箱）。
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
    expect(container.textContent).toContain("doc.pdf"); // the file card
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
    // 无宽高时占位用中性 4:3 比例盒(width:100%),非旧的 192 方盒 — 宽度跨态恒定、只高度收敛。
    const sizedContainer = img!.parentElement!;
    expect(sizedContainer.style.width).toBe("100%");
    expect(sizedContainer.style.aspectRatio).toBe("4 / 3");
    // 静态占位 overlay 存在,不做 pulse 动画。
    const placeholder = container.querySelector('[data-testid="image-loading-placeholder"]');
    expect(placeholder).not.toBeNull();
    expect(placeholder?.className).not.toContain("animate-pulse");
  });

  it("uses a static loading placeholder so prepended history images do not visually flash", () => {
    const { container } = renderContent({
      attachments: [{ type: "image", url: "https://e.example/history.png", name: "history.png" }],
    });

    const placeholder = container.querySelector('[data-testid="image-loading-placeholder"]');
    expect(placeholder).not.toBeNull();
    expect(placeholder?.className).not.toContain("animate-pulse");
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
    expect(container.querySelector('[data-testid="image-loading-placeholder"]')).toBeNull();
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
    expect(container.querySelector('[data-testid="image-loading-placeholder"]')).toBeNull();
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

    expect(second.container.querySelector('[data-testid="image-loading-placeholder"]')).toBeNull();
    expect(second.container.querySelector("img")?.className).not.toContain("opacity-0");
  });

  it("data: 内联图发送瞬间直接 loaded(无骨架、eager+sync),消除发图首帧骨架闪", () => {
    const { container } = renderContent({
      blocks: [{ type: "image", url: "data:image/png;base64,iVBORw0KGgo=" }],
    });
    const img = container.querySelector("img")!;
    expect(img).not.toBeNull();
    // 首帧即 loaded:无骨架 overlay、img 不 opacity-0。
    expect(container.querySelector('[data-testid="image-loading-placeholder"]')).toBeNull();
    expect(img.className).not.toContain("opacity-0");
    // 内存源 eager + sync,同帧出像素(不走远程源的 lazy/async)。
    expect(img.getAttribute("loading")).toBe("eager");
    expect(img.getAttribute("decoding")).toBe("sync");
  });

  it("收敛切源塌缩时复用已解码的过渡 <img>(不原地改写可见 src → 不重解码、不闪)", () => {
    // 乐观气泡:内联图 data: 源,首帧即 loaded。
    const { container, rerender } = render(
      <article>
        <MessageContent
          parts={buildMessageParts("", undefined, [
            { type: "image", url: "data:image/png;base64,iVBORw0KGgo=" },
          ])}
        />
      </article>,
    );

    // 收敛:权威重读把 url 换成远端 OSS,触发过渡态(保留 data: 可见、隐藏预载远端源)。
    rerender(
      <article>
        <MessageContent
          parts={buildMessageParts("", undefined, [
            { type: "image", url: "https://e.example/conv.png" },
          ])}
        />
      </article>,
    );
    const images = container.querySelectorAll("img");
    expect(images).toHaveLength(2);
    // 隐藏的过渡 <img> 承载远端源(opacity-0,后台解码)。
    const pending = images[1];
    expect(pending.getAttribute("src")).toContain("e.example");
    expect(pending.className).toContain("opacity-0");

    // 远端源解码完成 → 塌缩成单图。关键:存活的那个 <img> 必须是「过渡元素本身」(已解码),
    // 而非旧 data: 元素被改写 src(那会逼可见元素重新解码 → 闪)。
    act(() => {
      fireEvent.load(pending);
    });
    const survivors = container.querySelectorAll("img");
    expect(survivors).toHaveLength(1);
    expect(survivors[0]).toBe(pending); // 同一 DOM 节点被复用,而非旧元素改写 src
    expect(survivors[0].getAttribute("src")).toContain("e.example");
    expect(survivors[0].className).not.toContain("opacity-0");
    expect(container.querySelector('[data-testid="image-loading-placeholder"]')).toBeNull();
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
    expect(container.querySelector('[data-testid="image-loading-placeholder"]')).toBeNull();
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

  it("无宽高时回退中性 4:3 占位比例盒（width:100%，非正方形）", () => {
    const { container } = render(
      <article>
        <MessageContent parts={[{ kind: "image", url: "https://e.example/img.png" }]} />
      </article>,
    );
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    const box = img!.parentElement!;
    // 无宽高：占位盒用 width:100% + 中性 4:3 比例(与有 dims 盒同宽度口径),不再是固定 192 方盒。
    expect(box.style.width).toBe("100%");
    expect(box.style.aspectRatio).toBe("4 / 3");
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
    expect(container.querySelector('[data-testid="image-loading-placeholder"]')).toBeNull();
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

  it("首次无后端宽高：onLoad 只缓存固有宽高，不改当前已绘制比例盒", () => {
    const { container } = render(
      <article>
        <MessageContent parts={[{ kind: "image", url: "https://e.example/p.png" }]} />
      </article>,
    );
    const img = container.querySelector("img")!;
    // 加载前无任何 dims → 中性 4:3 占位比例盒(width:100%);加载后切到真实比例,宽度恒定只高度收敛。
    expect(img.parentElement!.style.width).toBe("100%");
    expect(img.parentElement!.style.aspectRatio).toBe("4 / 3");
    // jsdom 不解码，手动赋固有宽高模拟"图片字节加载完"。
    Object.defineProperty(img, "naturalWidth", { value: 300, configurable: true });
    Object.defineProperty(img, "naturalHeight", { value: 150, configurable: true });
    act(() => {
      fireEvent.load(img);
    });
    // 当前已绘制行保持稳定 4:3，不因图片逐张加载而推高/塌陷整列。
    const box = img.parentElement!;
    expect(box.style.aspectRatio).toBe("4 / 3");
    expect(box.style.width).toBe("100%");
  });

  it("首次无宽高时，即使后续权威回读补齐宽高，当前已绘制行也不二段改变比例", () => {
    const { container, rerender } = render(
      <article>
        <MessageContent parts={[{ kind: "image", url: "https://e.example/late-meta.png" }]} />
      </article>,
    );
    const box = container.querySelector("img")!.parentElement!;
    expect(box.style.aspectRatio).toBe("4 / 3");

    rerender(
      <article>
        <MessageContent
          parts={[
            { kind: "image", url: "https://e.example/late-meta.png", width: 300, height: 900 },
          ]}
        />
      </article>,
    );

    expect(container.querySelector("img")!.parentElement!.style.aspectRatio).toBe("4 / 3");
  });

  it("onLoad 缓存固有宽高后，重挂首帧按缓存比例就位", () => {
    // 首次渲染并加载：当前行不改比例，但固有宽高写入模块缓存。
    const first = render(
      <article>
        <MessageContent parts={[{ kind: "image", url: "https://e.example/remount.png" }]} />
      </article>,
    );
    const img1 = first.container.querySelector("img")!;
    Object.defineProperty(img1, "naturalWidth", { value: 400, configurable: true });
    Object.defineProperty(img1, "naturalHeight", { value: 100, configurable: true });
    act(() => {
      fireEvent.load(img1);
    });
    expect(img1.parentElement!.style.aspectRatio).toBe("4 / 3");
    first.unmount();

    // 重新挂载同 URL（模拟虚拟列表滚出再滚入 / 切会话重渲）：未触发任何 load，
    // 比例盒应已从缓存首帧就位——不再是 192 方盒，故不发生"方盒→比例盒"的重排抖动。
    const second = render(
      <article>
        <MessageContent parts={[{ kind: "image", url: "https://e.example/remount.png" }]} />
      </article>,
    );
    const box2 = second.container.querySelector("img")!.parentElement!;
    expect(box2.style.aspectRatio).toBe("400 / 100");
    // 有尺寸的非配文图用确定 px 宽(= min(上限256, 真实宽400) = 256),让 aspectRatio 首帧即
    // 算出高度、不依赖图片解码 —— 消除发图首帧「盒子宽塌成 0→解码后弹满」的整列位移。
    expect(box2.style.width).toBe("256px");
  });
});

describe("图文图片铺满 + 独占图本征宽度", () => {
  it("带配文的图片附件铺满气泡宽度(block w-full)", () => {
    const { container } = renderContent({
      text: "看图",
      attachments: [{ type: "image", url: "https://e.example/cap.png", name: "cap.png" }],
    });
    const btn = container.querySelector("button[title]")!;
    expect(btn.className).toContain("block w-full");
    expect(btn.className).not.toContain("inline-block");
  });

  it("独占单图保持本征宽度(inline-block,不强制铺满)", () => {
    const { container } = renderContent({
      attachments: [{ type: "image", url: "https://e.example/solo2.png", name: "solo2.png" }],
    });
    const btn = container.querySelector("button[title]")!;
    expect(btn.className).toContain("inline-block");
    expect(btn.className).not.toContain("block w-full");
  });
});

describe("VoiceAttachment 播放接线", () => {
  it("Web 可解码格式(mp3)渲染 <audio> 元素", () => {
    const { container } = renderContent({
      attachments: [{ type: "voice", url: "https://e.example/clip.mp3", durationSec: 5 }],
    });
    const audio = container.querySelector("audio");
    expect(audio).not.toBeNull();
    expect(audio!.getAttribute("src")).toContain("clip.mp3");
    // 播放按钮存在(点击在应用内播放)。
    expect(container.querySelector("button")).not.toBeNull();
  });

  it("amr 不渲染原生 <audio>(改用 benz-amr-recorder 应用内解码播放)", () => {
    const { container } = renderContent({
      attachments: [{ type: "voice", url: "https://e.example/clip.amr", durationSec: 5 }],
    });
    // amr 不挂原生 <audio>:点击时经后端取字节 + benz 解码在应用内播放。
    expect(container.querySelector("audio")).toBeNull();
    // 仍渲染播放按钮。
    expect(container.querySelector("button")).not.toBeNull();
  });

  it("本地乐观预览(blob:)语音点击后走 benz 应用内解码(发送后可播放)", async () => {
    // 发送后乐观气泡的语音 url 是本地 blob:(原始文件,可能是 amr,webview <audio> 解不了),
    // 旧逻辑 isSafeUrl(...,"link") 判 blob 不安全 → 点击直接 return 不播放。修复后:本地预览
    // 视为可播,统一走 benz 取本地 Blob 解码播放。
    const origFetch = global.fetch;
    global.fetch = vi.fn(() =>
      Promise.resolve({ blob: () => Promise.resolve(new Blob()) }),
    ) as unknown as typeof fetch;
    try {
      const { container } = renderContent({
        attachments: [{ type: "voice", url: "blob:tauri://localhost/abc", durationSec: 3 }],
      });
      // 本地预览不挂原生 <audio>(blob 可能是 amr),统一走 benz。
      expect(container.querySelector("audio")).toBeNull();
      const btn = container.querySelector("button")!;
      await act(async () => {
        fireEvent.click(btn);
      });
      await waitFor(() => expect(benzMock.initWithBlob).toHaveBeenCalledTimes(1));
    } finally {
      global.fetch = origFetch;
      benzMock.initWithBlob.mockClear();
      benzMock.play.mockClear();
    }
  });
});

describe("MessageContent 未知消息占位", () => {
  it("unknown part 渲染为「暂不支持」提示(含问号图标),不渲染附件卡/图片", () => {
    const { container } = render(
      <article data-testid="bubble">
        <MessageContent parts={[{ kind: "unknown" }]} />
      </article>,
    );
    expect(container.textContent).toContain(STRINGS.unknown.bubble);
    // 类文本内联提示,不落附件卡/图片。
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("button")).toBeNull();
    // 带 aria-hidden 的问号图标(lucide CircleHelp 渲染为 svg)。
    expect(container.querySelector("svg")).not.toBeNull();
  });
});
