import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Account } from "@/lib/types/account";

import { ChatArea } from "./ChatArea";
import type { Conversation, Message } from "./data";
import type { ChatMessageEntity } from "./store/chatStore";
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
        // @tanstack/react-virtual 经 observeElementRect → getRect 读 viewport 的
        // offsetHeight 作为可视高度(outerSize)。jsdom 下默认 0 → calculateRange 直接返回
        // 空(outerSize>0 不成立)→ 一行都不渲染。给 viewport 注入 offsetHeight=clientHeight,
        // 让虚拟器能算出可见窗口(给虚拟器一个可测视口高度,而非删断言)。行 offsetHeight 的
        // 桩在 beforeEach 里挂在 HTMLElement.prototype 上(实例属性优先,故 viewport 仍取此处)。
        Object.defineProperty(node, "offsetHeight", {
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

// 虚拟行(measureElement 量的绝对定位盒)在 jsdom 下 offsetHeight=0,会被虚拟器记成 0 →
// 整列塌缩。给 HTMLElement.prototype.offsetHeight 一个正值桩,让行有可测高度;viewport 自身在
// mock 内用实例属性覆盖为 clientHeight(实例优先于原型)。仅作用于行盒,保存原描述符以便还原。
const ROW_STUB_HEIGHT = 60;
let originalOffsetHeightDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  scrollAreaMock.reset();
  messageBubbleMock.render.mockClear();
  originalOffsetHeightDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetHeight",
  );
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => ROW_STUB_HEIGHT,
  });
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  if (originalOffsetHeightDescriptor) {
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", originalOffsetHeightDescriptor);
  } else {
    delete (HTMLElement.prototype as unknown as { offsetHeight?: number }).offsetHeight;
  }
  vi.unstubAllGlobals();
  clearImageDimsCache();
  cleanup();
});

describe("ChatArea history scrolling", () => {
  it("virtualizes long image-heavy timelines, mounting only the visible window plus overscan", async () => {
    const manyImages = Array.from({ length: 80 }, (_, i) => ({
      ...imageMessage(String(i + 1).padStart(2, "0"), {
        width: i % 2 === 0 ? 320 : 900,
        height: i % 2 === 0 ? 900 : 320,
      }),
      sentAt: `2026-05-19T10:${String(i % 50).padStart(2, "0")}:00.000Z`,
    }));

    // Stage B 渲染虚拟化:给虚拟器一个可测视口高度(viewport offsetHeight=clientHeight=300,
    // 见 WorkbenchScrollArea mock),仅可见窗口 + overscan 的行进入 DOM,而非 80 条全渲染。
    const { container } = renderChatArea({ messages: manyImages });
    await act(async () => undefined);

    const rendered = container.querySelectorAll('[data-testid="message"]');
    // 远少于 80(可见 ~2-3 行 + 图片密集 overscan 3),证明已虚拟化只挂可见窗口。
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(80);
    // 虚拟行盒带 data-index(虚拟化的结构标记),反向证明不是全量 .map。
    expect(container.querySelector("[data-index]")).not.toBeNull();
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

  it("mounts the first real history page when it arrives after loading", async () => {
    // 新契约:首屏「滚到底」由控制器写一次 scrollTop=scrollHeight,随后 virtual-core 接管 settle
    // (anchorTo:'end' 的 wasAtEnd 补偿)。jsdom 无真实布局,库的 scrollToEnd/锚定恢复会按虚拟器内部
    // 估高(行桩 60px)算出与 mock.scrollHeight 无关的 offset 并写回,故无法断言具体 scrollTop 像素值
    // (真实滚动位置需真机验)。此处断言库不覆盖、jsdom 可观测的部分:loading 结束后首个真实历史页
    // 的消息行确实挂载进 DOM(此前为空 → ChatLoadingState)。
    const { container, rerender, queryByTestId } = renderChatArea({ loading: true, messages: [] });
    expect(queryByTestId("loading")).not.toBeNull();

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

    expect(queryByTestId("loading")).toBeNull();
    expect(container.querySelectorAll('[data-testid="message"]').length).toBeGreaterThan(0);
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

  it("prepends older history once per zone entry without re-loading after the page lands", async () => {
    // 新契约:翻历史的「可见内容稳定」(原断言 scrollTop===420)已交 virtual-core anchorTo:'end',
    // 控制器不再手写 scrollTop,jsdom 无布局测不了像素位置(需真机验)。此处断言控制器仍负责的部分:
    //   ① 进入预取区(距顶 ≤ 一屏)只触发一次 loadMore(边沿门);
    //   ② 旧页 prepend 落地后,即便再来滚动事件也不二次加载(边沿门已消耗、未滚出预取区);
    //   ③ prepend 后旧行确实进入时间线(数据层正常合并)。
    const loadMore = vi.fn().mockResolvedValue(undefined);
    const { container, rerender } = renderChatArea({
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

    // 旧行进入时间线(顶部窗口含 "01")。
    const ids = Array.from(container.querySelectorAll('[data-testid="message"]')).map(
      (el) => el.textContent,
    );
    expect(ids).toContain("01");

    // 仍在预取区内(未滚出 > 阈值再回)→ 边沿门已消耗,后续滚动不再二次加载。
    fireEvent.scroll(scrollAreaMock.viewport!);
    expect(loadMore).toHaveBeenCalledTimes(1);
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
    // 进入预取区上滑触发加载(in-flight 守卫期间不二次加载)。
    fireEvent.wheel(viewport, { deltaY: -40, cancelable: true });
    expect(loadMore).toHaveBeenCalledTimes(1);

    // 加载进行中：后续滚轮不 preventDefault（原生滚动继续），但 in-flight 守卫挡住二次加载、页面不动。
    fireEvent.wheel(viewport, { deltaY: -40, cancelable: true });
    expect(scrollAreaMock.preventedWheels).toBe(0);
    expect(loadMore).toHaveBeenCalledTimes(1);
    expect(scrollAreaMock.scrollTop).toBe(0);

    // 下一页到达：prepend 落地，旧行进入时间线。可见内容稳定(原断言 scrollTop===420)已交
    // virtual-core anchorTo:'end',控制器不再手写 scrollTop,jsdom 测不了像素位置(需真机验)。
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

    // in-flight 期间不二次加载(边沿门 + in-flight 守卫):全程仅一次 loadMore。
    // (旧行是否进入 DOM 取决于虚拟窗口——顶部行被虚拟化卸载,故不在此断言渲染内容。)
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it("does not double-load from repeated wheel movement while a page is in flight", async () => {
    // 原断言锚点不被滚轮重捕(手搓 prependAnchor)。锚点捕获已交 virtual-core(在 setOptions 时按
    // 可见项 key 取一次,与滚轮无关),控制器侧只剩 in-flight + 已发标记两道守卫挡住二次加载。本测断言
    // 这两道守卫:加载中连续上滑只加载一页、不吞滚轮、加载中不手写 scrollTop;落地后旧行进入时间线。
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
    fireEvent.wheel(viewport, { deltaY: -40, cancelable: true });
    expect(loadMore).toHaveBeenCalledTimes(1);

    // 加载中连续滚轮:不 preventDefault,且 in-flight/已发标记守卫挡住二次加载;控制器不手写 scrollTop。
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

    // 全程只加载一页(可见内容稳定交 anchorTo,需真机验像素位置;顶部旧行被虚拟化卸载,不断言渲染)。
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it("prepends image rows into the timeline after a top-zone prefetch", async () => {
    // 原断言 scrollTop===420(手搓 scrollHeight 差值恢复)。图片行高冻结 + 差值恢复的「可见内容稳定」
    // 已交 virtual-core anchorTo:'end'(按可见项 key 恢复,免疫图片行高),控制器不再手写 scrollTop,
    // jsdom 测不了像素位置(需真机验)。此处断言控制器仍负责的:进区只触发一次 loadMore + 旧图片行
    // 落地进时间线。
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
    const { container, rerender } = renderChatArea({
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

    scrollAreaMock.scrollHeight = 1420;
    rerender(<ChatArea {...baseProps} messages={withOlderImages} />);
    await act(async () => undefined);

    // 旧图片行进入时间线(顶部窗口含 "01" 行盒)。
    expect(container.querySelector('[data-message-row-id="01"]')).not.toBeNull();
  });

  it("does not raise a false unread-below count when content height grows without new messages", async () => {
    // 原断言贴底时手写 scrollTop 跟随到底(===900 / ===1240)。贴底跟随交 virtual-core followOnAppend、
    // 贴底内容增高的补偿交 resizeItem 的 wasAtEnd,控制器不再手写 scrollTop,jsdom 无真实布局测不了
    // 像素位置(库会按行桩估高把 scrollTop 写成与 mock.scrollHeight 无关的值),贴底跟随需真机验。
    // 仍可观测、且不依赖真实几何的契约:仅内容增高、无新 INCOMING 消息时,不冒出未读 below 计数
    // ("N 条新消息"角标)—— 这正是被保留的 new-message-follow「只数 INCOMING」逻辑要守的不变量。
    const { queryByText, rerender } = renderChatArea({
      messages: [message("01"), message("02"), message("03")],
    });

    await act(async () => undefined);

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

    // 无新 INCOMING 消息 → 未读 below 计数为 0 → 不显示"N 条新消息"角标。
    expect(queryByText(/条新消息/)).toBeNull();
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

  it("pans the rendered window when the user scrolls a long timeline", async () => {
    // 80 条文本(行桩高 60px → 总高 ~4800),viewport 300。在顶部时窗口含首条;滚到中部并触发
    // scroll 事件(虚拟器经 observeElementOffset 读 scrollTop 更新 offset)后,窗口平移、首条移出 DOM,
    // 中部某条进入 —— 证明渲染随滚动平移而非全量常驻。
    const many = Array.from({ length: 80 }, (_, i) => ({
      ...message(String(i + 1).padStart(2, "0"), `m${i + 1}`),
      sentAt: `2026-05-19T10:${String(i % 50).padStart(2, "0")}:00.000Z`,
    }));
    const { container } = renderChatArea({ messages: many });
    await act(async () => undefined);

    const idsAt = () =>
      Array.from(container.querySelectorAll("[data-index]")).map((el) =>
        el.getAttribute("data-index"),
      );
    const topWindow = idsAt();
    expect(topWindow).toContain("0"); // 首条在顶部窗口内
    expect(topWindow.length).toBeLessThan(80);

    // 滚到中部:虚拟器在 scroll 事件里读 viewport.scrollTop 重算窗口。
    scrollAreaMock.scrollTop = 2400;
    await act(async () => {
      fireEvent.scroll(scrollAreaMock.viewport!);
    });

    const midWindow = idsAt();
    expect(midWindow).not.toContain("0"); // 首条已移出 DOM(窗口平移)
    // 中部窗口应含 2400/60 ≈ 第 40 行附近的下标。
    expect(midWindow.some((i) => Number(i) >= 30 && Number(i) <= 50)).toBe(true);
  });

  it("keeps message bubbles mounted (zero remount) when an optimistic row converges to authoritative", async () => {
    // getItemKey=clientMsgId??id:乐观气泡(clientMsgId 稳定)被权威条目替换(id 变、clientMsgId 不变)
    // 时,虚拟行 key 不变 → 不 remount。这里用同一 clientMsgId 的两个不同 message 对象模拟收敛,
    // 断言 MessageBubble 不因 key 变化整行重建(render 次数不暴涨为"卸载+新建")。
    const optimistic: ChatMessageEntity = {
      id: "optimistic-1",
      clientMsgId: "cid-1",
      conversationId: conversation.id,
      direction: "out",
      text: "hi",
      parts: [{ kind: "text", text: "hi" }],
      sentAt: "2026-05-19T10:01:00.000Z",
    };
    const authoritative: ChatMessageEntity = {
      ...optimistic,
      id: "auth-1", // 权威 id 不同,但 clientMsgId 相同 → 行 key 稳定
    };

    const { rerender } = renderChatArea({ messages: [optimistic] });
    await act(async () => undefined);
    const mountedKeys = new Set(messageBubbleMock.render.mock.calls.map(([id]) => id));
    expect(mountedKeys.has("optimistic-1")).toBe(true);
    messageBubbleMock.render.mockClear();

    rerender(
      <ChatArea
        conversation={conversation}
        chatStoreKey="c1"
        messages={[authoritative]}
        accounts={accounts}
        selectedAccountId={null}
        onAccountChange={vi.fn()}
        detailsOpen={false}
        onToggleDetails={vi.fn()}
      />,
    );
    await act(async () => undefined);

    // 收敛后仍渲染该行(内容更新),且只渲染这一行(无其它行卷入 remount)。
    expect(messageBubbleMock.render.mock.calls.map(([id]) => id)).toEqual(["auth-1"]);
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

    // 媒体独占图片行额外高已按 isMediaOnly 降为 +12(不再统一 +60):无 dims 回退 192 + 12,
    // 再加 burst 首条行间距 pt-12=48(isFirstInBurst:true)= 252;有真实 dims 的宽图按比例更矮。
    expect(wideImage).toBeLessThan(unknownImage);
    expect(tallImage).toBeGreaterThan(wideImage);
    expect(unknownImage).toBe(192 + 12 + 48);
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
