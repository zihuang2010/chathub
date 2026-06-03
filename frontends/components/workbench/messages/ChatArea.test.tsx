import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Account } from "@/lib/types/account";

import { ChatArea } from "./ChatArea";
import type { Conversation, Message } from "./data";
import { clearImageDimsCache, rememberMeasuredDims } from "./imageDimsCache";
import {
  estimateTimelineRowHeight,
  getVirtualOverscan,
  timelineRowHeightCacheKey,
} from "./virtualListSizing";
import type { ScrollMetrics } from "./WorkbenchScrollArea";

// Tauri 边界 mock:ChatArea 经 useHubSyncStatus 监听 hub:connection / 调 hub_state;
// jsdom 无原生 Tauri,不 mock 会让 listen/invoke 真跑而抛错。
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
  isTauri: () => false,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

const scrollAreaMock = vi.hoisted(() => ({
  viewport: null as HTMLDivElement | null,
  scrollTop: 0,
  scrollHeight: 900,
  clientHeight: 300,
  preventedWheels: 0,
  reset() {
    this.viewport = null;
    this.scrollTop = 0;
    this.scrollHeight = 900;
    this.clientHeight = 300;
    this.preventedWheels = 0;
  },
}));

const messageBubbleMock = vi.hoisted(() => ({
  render: vi.fn(),
}));

vi.mock("framer-motion", async () => {
  const React = await import("react");
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    motion: {
      div: React.forwardRef<
        HTMLDivElement,
        React.HTMLAttributes<HTMLDivElement> & {
          animate?: unknown;
          exit?: unknown;
          initial?: unknown;
          transition?: unknown;
        }
      >(function MotionDiv({ children, initial, animate, exit, transition, ...props }, ref) {
        void initial;
        void animate;
        void exit;
        void transition;
        return React.createElement("div", { ...props, ref }, children);
      }),
    },
  };
});

vi.mock("./ChatHeader", async () => {
  const React = await import("react");
  return {
    ChatHeader: () => React.createElement("div", { "data-testid": "chat-header" }),
  };
});

vi.mock("./RangePill", async () => {
  const React = await import("react");
  return {
    RangePill: () => React.createElement("div", { "data-testid": "range-pill" }),
  };
});

vi.mock("./MessageComposer", async () => {
  const React = await import("react");
  return {
    MessageComposer: () => React.createElement("div", { "data-testid": "composer" }),
  };
});

vi.mock("./MessageBubble", async () => {
  const React = await import("react");
  return {
    DateDivider: ({ label }: { label: string }) =>
      React.createElement("div", { "data-testid": "date-divider" }, label),
    MessageBubble: ({ message }: { message: Message }) => (
      messageBubbleMock.render(message.id),
      React.createElement("div", { "data-testid": "message" }, message.text)
    ),
    UnreadDivider: ({ count }: { count: number }) =>
      React.createElement("div", { "data-testid": "unread-divider" }, `${count}`),
  };
});

vi.mock("./ChatStates", async () => {
  const React = await import("react");
  return {
    ChatEmptyState: () => React.createElement("div", { "data-testid": "empty" }),
    ChatErrorState: () => React.createElement("div", { "data-testid": "error" }),
    ChatLoadingState: () => React.createElement("div", { "data-testid": "loading" }),
  };
});

vi.mock("./WorkbenchScrollArea", async () => {
  const React = await import("react");
  const computeMetrics = (): ScrollMetrics => ({
    scrollTop: scrollAreaMock.scrollTop,
    scrollHeight: scrollAreaMock.scrollHeight,
    clientHeight: scrollAreaMock.clientHeight,
    atBottom:
      scrollAreaMock.scrollHeight - scrollAreaMock.scrollTop - scrollAreaMock.clientHeight < 24,
  });
  return {
    WorkbenchScrollArea: ({
      children,
      scrollRef,
      onScrollMetrics,
      onUserScroll,
      onWheelCapture,
    }: {
      children: React.ReactNode;
      scrollRef?: React.Ref<HTMLDivElement>;
      onScrollMetrics?: (metrics: ScrollMetrics) => void;
      onUserScroll?: (metrics: ScrollMetrics) => void;
      onWheelCapture?: React.WheelEventHandler<HTMLDivElement>;
    }) => {
      const ref = React.useRef<HTMLDivElement | null>(null);
      React.useLayoutEffect(() => {
        const node = ref.current;
        if (!node) return;
        scrollAreaMock.viewport = node;
        Object.defineProperty(node, "clientHeight", {
          configurable: true,
          get: () => scrollAreaMock.clientHeight,
        });
        Object.defineProperty(node, "scrollHeight", {
          configurable: true,
          get: () => scrollAreaMock.scrollHeight,
        });
        Object.defineProperty(node, "scrollTop", {
          configurable: true,
          get: () => scrollAreaMock.scrollTop,
          set: (value: number) => {
            scrollAreaMock.scrollTop = value;
          },
        });
        node.scrollTo = ((x?: ScrollToOptions | number, y?: number) => {
          if (typeof x === "number") {
            scrollAreaMock.scrollTop = typeof y === "number" ? y : x;
            return;
          }
          if (typeof x?.top === "number") scrollAreaMock.scrollTop = x.top;
        }) as HTMLDivElement["scrollTo"];
        if (typeof scrollRef === "function") {
          scrollRef(node);
        } else if (scrollRef) {
          (scrollRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
        }
        onScrollMetrics?.(computeMetrics());
      });
      return React.createElement(
        "div",
        {
          "data-testid": "viewport",
          ref,
          onWheelCapture: (event: React.WheelEvent<HTMLDivElement>) => {
            onWheelCapture?.(event);
            if (event.isDefaultPrevented()) scrollAreaMock.preventedWheels += 1;
          },
          onScroll: () => {
            onUserScroll?.(computeMetrics());
            onScrollMetrics?.(computeMetrics());
          },
        },
        children,
      );
    },
  };
});

const conversation: Conversation = {
  id: "conv-1",
  name: "胡娟",
  preview: "最新消息",
  account: "昆山销售·新",
  time: "12:00",
  unread: 0,
  online: false,
};

const accounts: Account[] = [
  {
    id: "acct-1",
    name: "昆山销售·新",
    colorToken: 1,
  },
];

function message(id: string, text = id): Message {
  return {
    id,
    conversationId: conversation.id,
    direction: "in",
    text,
    parts: [{ kind: "text", text }],
    sentAt: `2026-05-19T10:${id.padStart(2, "0")}:00.000Z`,
  };
}

function imageMessage(id: string, dimensions?: { width?: number; height?: number }): Message {
  return {
    id,
    conversationId: conversation.id,
    direction: "in",
    text: "",
    parts: [
      {
        kind: "image",
        url: `asset://image-${id}`,
        width: dimensions?.width,
        height: dimensions?.height,
      },
    ],
    sentAt: `2026-05-19T10:${id.padStart(2, "0")}:00.000Z`,
  };
}

function renderChatArea(
  overrides: Partial<React.ComponentProps<typeof ChatArea>> & Record<string, unknown> = {},
) {
  const props = {
    conversation,
    chatStoreKey: "c1",
    messages: [],
    accounts,
    selectedAccountId: null,
    onAccountChange: vi.fn(),
    detailsOpen: false,
    onToggleDetails: vi.fn(),
    ...overrides,
  };
  return render(<ChatArea {...(props as React.ComponentProps<typeof ChatArea>)} />);
}

beforeEach(() => {
  scrollAreaMock.reset();
  messageBubbleMock.render.mockClear();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearImageDimsCache();
  cleanup();
});

describe("ChatArea history scrolling", () => {
  it("renders long image-heavy timelines as stable DOM rows instead of variable-height virtual rows", async () => {
    const manyImages = Array.from({ length: 80 }, (_, i) => ({
      ...imageMessage(String(i + 1).padStart(2, "0"), {
        width: i % 2 === 0 ? 320 : 900,
        height: i % 2 === 0 ? 900 : 320,
      }),
      sentAt: `2026-05-19T10:${String(i % 50).padStart(2, "0")}:00.000Z`,
    }));

    const { container } = renderChatArea({ messages: manyImages });
    await act(async () => undefined);

    expect(container.querySelectorAll('[data-testid="message"]')).toHaveLength(80);
    expect(container.querySelector("[data-index]")).toBeNull();
  });

  it("shows no history-loading indicator while older messages load (silent prepend)", () => {
    const { container, queryByRole } = renderChatArea({
      messages: [message("03"), message("04"), message("05")],
      loading: true,
      hasMoreHistory: true,
    });

    // 翻历史不再显示"加载更早的消息"指示器,也无骨架动画 —— 旧消息静默插入。
    expect(queryByRole("status", { name: "加载更早的消息" })).toBeNull();
    expect(container.querySelector(".animate-pulse")).toBeNull();
  });

  it("does not re-render existing message bubbles when older rows are prepended", async () => {
    const msg03 = message("03");
    const msg04 = message("04");
    const msg05 = message("05");
    const { rerender } = renderChatArea({
      messages: [msg03, msg04, msg05],
      hasMoreHistory: true,
    });
    await act(async () => undefined);
    messageBubbleMock.render.mockClear();

    rerender(
      <ChatArea
        conversation={conversation}
        chatStoreKey="c1"
        messages={[imageMessage("01"), imageMessage("02"), msg03, msg04, msg05]}
        accounts={accounts}
        selectedAccountId={null}
        onAccountChange={vi.fn()}
        detailsOpen={false}
        onToggleDetails={vi.fn()}
        hasMoreHistory
      />,
    );
    await act(async () => undefined);

    expect(messageBubbleMock.render.mock.calls.map(([id]) => id)).toEqual(["01", "02"]);
  });

  it("scrolls to the latest message after the first real history page mounts", async () => {
    const { rerender } = renderChatArea({ loading: true, messages: [] });

    scrollAreaMock.scrollHeight = 1200;
    rerender(
      <ChatArea
        conversation={conversation}
        chatStoreKey="c1"
        messages={[message("01"), message("02"), message("03")]}
        accounts={accounts}
        selectedAccountId={null}
        onAccountChange={vi.fn()}
        detailsOpen={false}
        onToggleDetails={vi.fn()}
        loading={false}
      />,
    );

    await act(async () => undefined);

    expect(scrollAreaMock.scrollTop).toBe(1200);
  });

  it("prefetches older history once the viewport is within one screen of the top", () => {
    const loadMore = vi.fn().mockResolvedValue(undefined);
    renderChatArea({
      messages: [message("03"), message("04"), message("05")],
      hasMoreHistory: true,
      onLoadMoreHistory: loadMore,
    });

    // clientHeight=300 → 预取阈值 = max(HISTORY_PREFETCH_MIN_PX=400, 300) = 400。
    // 远离顶部(scrollTop > 阈值):不预取。
    scrollAreaMock.scrollTop = 500;
    fireEvent.scroll(scrollAreaMock.viewport!);
    expect(loadMore).not.toHaveBeenCalled();

    // 进入预取区(scrollTop ≤ 阈值):尚未贴顶也已开始后台加载(提前预取)。
    scrollAreaMock.scrollTop = 200;
    fireEvent.scroll(scrollAreaMock.viewport!);
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it("prefetches via an upward wheel inside the prefetch zone without preventing native scroll", () => {
    const loadMore = vi.fn().mockResolvedValue(undefined);
    renderChatArea({
      messages: [message("03"), message("04"), message("05")],
      hasMoreHistory: true,
      onLoadMoreHistory: loadMore,
    });
    const viewport = scrollAreaMock.viewport!;

    // 远离顶部(>阈值 400):上滑不预取,也不吞滚轮。
    scrollAreaMock.scrollTop = 500;
    const farWheel = fireEvent.wheel(viewport, { deltaY: -40, cancelable: true });
    expect(farWheel).toBe(true);
    expect(loadMore).not.toHaveBeenCalled();

    // 进入预取区(≤400)向上滑:后台加载,但**不** preventDefault —— 原生滚动顺畅继续。
    scrollAreaMock.scrollTop = 200;
    const zoneWheel = fireEvent.wheel(viewport, { deltaY: -40, cancelable: true });
    expect(zoneWheel).toBe(true);
    expect(scrollAreaMock.preventedWheels).toBe(0);
    expect(loadMore).toHaveBeenCalledTimes(1);

    // 加载在飞:重复上滑被 in-flight 守卫吸收,不二次加载、也不吞滚轮。
    fireEvent.wheel(viewport, { deltaY: -40, cancelable: true });
    expect(loadMore).toHaveBeenCalledTimes(1);
    expect(scrollAreaMock.preventedWheels).toBe(0);

    // 向下滚:任何位置都不触发。
    const downWheel = fireEvent.wheel(viewport, { deltaY: 40, cancelable: true });
    expect(downWheel).toBe(true);
  });

  it("restores the scroll offset when older history is prepended", async () => {
    const loadMore = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderChatArea({
      messages: [message("03"), message("04"), message("05")],
      hasMoreHistory: true,
      onLoadMoreHistory: loadMore,
    });
    scrollAreaMock.scrollTop = 0;
    scrollAreaMock.scrollHeight = 1000;

    fireEvent.scroll(scrollAreaMock.viewport!);
    expect(loadMore).toHaveBeenCalledTimes(1);

    scrollAreaMock.scrollHeight = 1420;
    rerender(
      <ChatArea
        conversation={conversation}
        chatStoreKey="c1"
        messages={[message("01"), message("02"), message("03"), message("04"), message("05")]}
        accounts={accounts}
        selectedAccountId={null}
        onAccountChange={vi.fn()}
        detailsOpen={false}
        onToggleDetails={vi.fn()}
        hasMoreHistory
        onLoadMoreHistory={loadMore}
      />,
    );

    await act(async () => undefined);

    expect(scrollAreaMock.scrollTop).toBe(420);
  });

  it("keeps the current page anchored with no double-load while a prefetch is in flight", async () => {
    let resolveLoadMore: (() => void) | undefined;
    const loadMore = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLoadMore = resolve;
        }),
    );
    const { rerender } = renderChatArea({
      messages: [message("03"), message("04"), message("05")],
      hasMoreHistory: true,
      onLoadMoreHistory: loadMore,
    });
    scrollAreaMock.scrollTop = 0;
    scrollAreaMock.scrollHeight = 1000;

    const viewport = scrollAreaMock.viewport!;
    // 进入预取区上滑触发加载，锚点捕获于 {scrollHeight:1000, scrollTop:0}。
    fireEvent.wheel(viewport, { deltaY: -40, cancelable: true });
    expect(loadMore).toHaveBeenCalledTimes(1);

    // 加载进行中：后续滚轮不 preventDefault（原生滚动继续），但 in-flight 守卫挡住二次加载、页面不动。
    fireEvent.wheel(viewport, { deltaY: -40, cancelable: true });
    expect(scrollAreaMock.preventedWheels).toBe(0);
    expect(loadMore).toHaveBeenCalledTimes(1);
    expect(scrollAreaMock.scrollTop).toBe(0);

    // 下一页到达：prepend 后用 scrollHeight 差值在 paint 前一次性恢复。
    scrollAreaMock.scrollHeight = 1420;
    rerender(
      <ChatArea
        conversation={conversation}
        chatStoreKey="c1"
        messages={[
          imageMessage("01"),
          imageMessage("02"),
          message("03"),
          message("04"),
          message("05"),
        ]}
        accounts={accounts}
        selectedAccountId={null}
        onAccountChange={vi.fn()}
        detailsOpen={false}
        onToggleDetails={vi.fn()}
        hasMoreHistory
        onLoadMoreHistory={loadMore}
      />,
    );
    resolveLoadMore?.();
    await act(async () => undefined);

    // T_new = max(0, scrollHeight_new − scrollHeight_old + scrollTop_old) = 1420 − 1000 + 0 = 420
    expect(scrollAreaMock.scrollTop).toBe(420);
  });

  it("does not retarget the prepend anchor from wheel movement while loading", async () => {
    let resolveLoadMore: (() => void) | undefined;
    const loadMore = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLoadMore = resolve;
        }),
    );
    const { rerender } = renderChatArea({
      messages: [message("03"), message("04"), message("05")],
      hasMoreHistory: true,
      onLoadMoreHistory: loadMore,
    });
    scrollAreaMock.scrollTop = 0;
    scrollAreaMock.scrollHeight = 1000;

    const viewport = scrollAreaMock.viewport!;
    // 触发加载，锚点固定为 {scrollHeight:1000, scrollTop:0}。
    fireEvent.wheel(viewport, { deltaY: -40, cancelable: true });
    expect(loadMore).toHaveBeenCalledTimes(1);

    // 加载中连续滚轮:不 preventDefault,但 in-flight/已有锚点守卫挡住——既不重捕锚点也不二次加载。
    fireEvent.wheel(viewport, { deltaY: -40, cancelable: true });
    fireEvent.wheel(viewport, { deltaY: -40, cancelable: true });
    expect(scrollAreaMock.preventedWheels).toBe(0);
    expect(loadMore).toHaveBeenCalledTimes(1);
    expect(scrollAreaMock.scrollTop).toBe(0);

    scrollAreaMock.scrollHeight = 1420;
    rerender(
      <ChatArea
        conversation={conversation}
        chatStoreKey="c1"
        messages={[
          imageMessage("01"),
          imageMessage("02"),
          message("03"),
          message("04"),
          message("05"),
        ]}
        accounts={accounts}
        selectedAccountId={null}
        onAccountChange={vi.fn()}
        detailsOpen={false}
        onToggleDetails={vi.fn()}
        hasMoreHistory
        onLoadMoreHistory={loadMore}
      />,
    );
    resolveLoadMore?.();
    await act(async () => undefined);

    // 锚点未被滚轮重捕，仍用最初的 {1000,0}：T_new = 1420 − 1000 + 0 = 420。
    expect(scrollAreaMock.scrollTop).toBe(420);
  });

  it("restores the scroll offset by scrollHeight delta when image rows are prepended", async () => {
    const loadMore = vi.fn().mockResolvedValue(undefined);
    const baseProps = {
      conversation,
      chatStoreKey: "c1",
      accounts,
      selectedAccountId: null,
      onAccountChange: vi.fn(),
      detailsOpen: false,
      onToggleDetails: vi.fn(),
      hasMoreHistory: true,
      onLoadMoreHistory: loadMore,
    };
    const { rerender } = renderChatArea({
      messages: [message("03"), message("04"), message("05")],
      hasMoreHistory: true,
      onLoadMoreHistory: loadMore,
    });
    scrollAreaMock.scrollTop = 0;
    scrollAreaMock.scrollHeight = 1000;

    fireEvent.scroll(scrollAreaMock.viewport!);
    expect(loadMore).toHaveBeenCalledTimes(1);

    const withOlderImages = [
      imageMessage("01", { width: 300, height: 900 }),
      imageMessage("02", { width: 900, height: 300 }),
      message("03"),
      message("04"),
      message("05"),
    ];

    // 图片行高在挂载首帧即冻结，prepend 后高度即终值 → 单次差值恢复到位：1420 − 1000 + 0 = 420。
    scrollAreaMock.scrollHeight = 1420;
    rerender(<ChatArea {...baseProps} messages={withOlderImages} />);
    await act(async () => undefined);
    expect(scrollAreaMock.scrollTop).toBe(420);
  });

  it("keeps the latest message pinned when image content increases scroll height", async () => {
    const { rerender } = renderChatArea({
      messages: [message("01"), message("02"), message("03")],
    });

    await act(async () => undefined);
    expect(scrollAreaMock.scrollTop).toBe(900);

    scrollAreaMock.scrollHeight = 1240;
    rerender(
      <ChatArea
        conversation={conversation}
        chatStoreKey="c1"
        messages={[message("01"), message("02"), message("03")]}
        accounts={accounts}
        selectedAccountId={null}
        onAccountChange={vi.fn()}
        detailsOpen={false}
        onToggleDetails={vi.fn()}
      />,
    );

    await act(async () => undefined);

    expect(scrollAreaMock.scrollTop).toBe(1240);
  });

  it("does not force the viewport back to bottom after a user scrolls upward", async () => {
    const { rerender } = renderChatArea({
      messages: [message("01"), message("02"), message("03")],
    });
    await act(async () => undefined);

    scrollAreaMock.scrollTop = 420;
    fireEvent.scroll(scrollAreaMock.viewport!);

    scrollAreaMock.scrollHeight = 1240;
    rerender(
      <ChatArea
        conversation={conversation}
        chatStoreKey="c1"
        messages={[message("01"), message("02"), message("03")]}
        accounts={accounts}
        selectedAccountId={null}
        onAccountChange={vi.fn()}
        detailsOpen={false}
        onToggleDetails={vi.fn()}
      />,
    );

    await act(async () => undefined);

    expect(scrollAreaMock.scrollTop).toBe(420);
  });

  it("renders a stable loading state instead of a blank frame while switching conversations", () => {
    const { getByTestId } = renderChatArea({ loading: true, messages: [] });

    expect(getByTestId("loading")).toBeTruthy();
  });
});

describe("ChatArea virtual list sizing", () => {
  it("estimates image row height from real dimensions to reduce first-frame correction", () => {
    const wideImage = estimateTimelineRowHeight({
      type: "message",
      id: "wide",
      message: imageMessage("10", { width: 800, height: 400 }),
      isFirstInBurst: true,
    });
    const tallImage = estimateTimelineRowHeight({
      type: "message",
      id: "tall",
      message: imageMessage("11", { width: 400, height: 900 }),
      isFirstInBurst: true,
    });
    const unknownImage = estimateTimelineRowHeight({
      type: "message",
      id: "unknown",
      message: imageMessage("12"),
      isFirstInBurst: true,
    });

    // 媒体独占图片行额外高已按 isMediaOnly 降为 +12(不再统一 +60):无 dims 回退
    // 192 + 12 = 204;有真实 dims 的宽图按比例更矮,短于回退盒。
    expect(wideImage).toBeLessThan(unknownImage);
    expect(tallImage).toBeGreaterThan(wideImage);
    expect(unknownImage).toBe(204);
  });

  it("uses a smaller overscan window for image-dense histories", () => {
    const imageDense = Array.from({ length: 30 }, (_, i) => ({
      type: "message" as const,
      id: `image-${i}`,
      message: imageMessage(String(i + 1)),
      isFirstInBurst: true,
    }));
    const textDense = Array.from({ length: 30 }, (_, i) => ({
      type: "message" as const,
      id: `text-${i}`,
      message: message(String(i + 1)),
      isFirstInBurst: true,
    }));

    expect(getVirtualOverscan(imageDense)).toBeLessThan(getVirtualOverscan(textDense));
  });

  it("includes image layout dimensions in row height cache key so stale placeholder measurements are not reused", () => {
    const item = {
      type: "message" as const,
      id: "image-row",
      message: imageMessage("cache-key"),
      isFirstInBurst: true,
    };
    const before = timelineRowHeightCacheKey("c1", item);

    rememberMeasuredDims("asset://image-cache-key", { w: 400, h: 100 });

    expect(timelineRowHeightCacheKey("c1", item)).not.toBe(before);
  });
});

describe("ChatArea unread divider", () => {
  const convUnread: Conversation = { ...conversation, unread: 2 };
  const sharedProps = {
    chatStoreKey: "c1",
    accounts,
    selectedAccountId: null as string | null,
    onAccountChange: vi.fn(),
    detailsOpen: false,
    onToggleDetails: vi.fn(),
  };

  const orderedTimeline = (container: HTMLElement) =>
    Array.from(
      container.querySelectorAll('[data-testid="message"],[data-testid="unread-divider"]'),
    ).map((el) =>
      el.getAttribute("data-testid") === "unread-divider"
        ? `divider:${el.textContent}`
        : `msg:${el.textContent}`,
    );

  it("anchors the divider to the entry boundary and keeps it fixed when active-conversation messages arrive", async () => {
    const { container, rerender } = render(
      <ChatArea
        {...sharedProps}
        conversation={convUnread}
        messages={[message("01"), message("02"), message("03"), message("04")]}
      />,
    );
    await act(async () => undefined);

    // 进入时:unread=2 → 分隔条钉在最后 2 条 in 消息的第一条("03")之前。
    expect(orderedTimeline(container)).toEqual([
      "msg:01",
      "msg:02",
      "divider:2",
      "msg:03",
      "msg:04",
    ]);

    // 活跃会话实时收到新消息 "05":分隔条必须仍钉在 "03" 之前、计数仍为 2,
    // 新消息落在底部不计未读 —— 而不是随尾部漂移到 "04" 之前。
    rerender(
      <ChatArea
        {...sharedProps}
        conversation={convUnread}
        messages={[message("01"), message("02"), message("03"), message("04"), message("05")]}
      />,
    );
    await act(async () => undefined);

    expect(orderedTimeline(container)).toEqual([
      "msg:01",
      "msg:02",
      "divider:2",
      "msg:03",
      "msg:04",
      "msg:05",
    ]);
  });
});
