import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Account } from "@/lib/types/account";
import { DEFAULT_SETTINGS, useSettingsStore } from "@/lib/data/settingsStore";

import { ChatArea } from "./ChatArea";
import { STRINGS } from "./strings";
import type { Conversation, Message } from "./data";
import type { ChatMessageEntity } from "./store/chatStore";
import { clearImageDimsCache, rememberMeasuredDims } from "./imageDimsCache";
import {
  estimateTimelineRowHeight,
  getVirtualOverscan,
  timelineRowHeightCacheKey,
} from "./virtualListSizing";

// Tauri 边界 mock:ChatArea 经 useHubSyncStatus 监听 hub:connection / 调 hub_state;
// jsdom 无原生 Tauri,不 mock 会让 listen/invoke 真跑而抛错。
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
  isTauri: () => false,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

// react-virtuoso 替身:jsdom 无真实布局,真实 Virtuoso 的 initialTopMostItemIndex={index:'LAST'}
// 需测量才能定位 → 在 MockContext 下渲染不出行。故用同步替身,语义聚焦本测要验的「接线契约」:
//   - 虚拟化:只渲染数据尾部的固定窗口(VIRTUAL_WINDOW 条),渲染行数 < 总数 → 证明已窗口化;
//   - itemContent:对窗口内每条调用真实 itemContent(收敛零 remount / 分隔条顺序据此可断言);
//   - computeItemKey:用它给每行 React key,乐观→权威 id 变而 key 不变时不 remount(契约核心);
//   - startReached:挂载后触发一次(模拟首屏顶部即在视口、Virtuoso 触顶语义),验翻历史接线;
//   - ref.scrollToIndex:no-op 桩(滚动位置交真实 Virtuoso/firstItemIndex,真机验)。
// 像素级滚动位置(贴底/锚定/pan)不在此验 —— 那些是真实 Virtuoso + 真实布局的职责。
const VIRTUAL_WINDOW = 30;
interface MockVirtuosoProps {
  data?: unknown[];
  itemContent?: (index: number, item: unknown) => React.ReactNode;
  computeItemKey?: (index: number, item: unknown) => string | number;
  firstItemIndex?: number;
  rangeChanged?: (range: { startIndex: number; endIndex: number }) => void;
  scrollerRef?: (el: HTMLElement | Window | null) => void;
  startReached?: () => void;
  atBottomStateChange?: (atBottom: boolean) => void;
}
// scrollToIndex 间谍:验「切会话/首挂不命令式滚动(防上→下闪),同会话追加才滚」的接线契约。
const virtuosoMock = vi.hoisted(() => ({
  emitAtBottom: undefined as ((atBottom: boolean) => void) | undefined,
  scroller: undefined as HTMLElement | undefined,
  scrollToIndex: vi.fn(),
}));
vi.mock("react-virtuoso", async () => {
  const React = await import("react");
  const Virtuoso = React.forwardRef(function MockVirtuoso(props: MockVirtuosoProps, ref) {
    const {
      data = [],
      itemContent,
      computeItemKey,
      firstItemIndex = 0,
      rangeChanged,
      scrollerRef,
      startReached,
      atBottomStateChange,
    } = props;
    React.useImperativeHandle(ref, () => ({
      scrollToIndex: virtuosoMock.scrollToIndex,
      scrollTo: () => undefined,
      scrollBy: () => undefined,
      scrollIntoView: () => undefined,
      autoscrollToBottom: () => undefined,
      getState: () => undefined,
    }));
    // 挂载后触发一次 startReached(模拟首屏顶部在视口 → 触顶)。仅首挂触发,不随重渲重复。
    const firedRef = React.useRef(false);
    React.useLayoutEffect(() => {
      if (firedRef.current) return;
      firedRef.current = true;
      startReached?.();
    }, [startReached]);
    React.useLayoutEffect(() => {
      const el = document.createElement("div");
      el.tabIndex = 0;
      Object.defineProperty(el, "scrollHeight", { configurable: true, value: 100 });
      Object.defineProperty(el, "clientHeight", { configurable: true, value: 100 });
      Object.defineProperty(el, "scrollTop", { configurable: true, value: 0 });
      virtuosoMock.scroller = el;
      scrollerRef?.(el);
      return () => {
        if (virtuosoMock.scroller === el) {
          virtuosoMock.scroller = undefined;
        }
        scrollerRef?.(null);
      };
    }, [scrollerRef]);
    React.useLayoutEffect(() => {
      virtuosoMock.emitAtBottom = atBottomStateChange;
      atBottomStateChange?.(false);
      return () => {
        if (virtuosoMock.emitAtBottom === atBottomStateChange) {
          virtuosoMock.emitAtBottom = undefined;
        }
      };
    }, [atBottomStateChange]);
    // 只渲染数据尾部窗口(贴底语义):start..end,渲染行数 < 总数即证明窗口化。
    const start = Math.max(0, data.length - VIRTUAL_WINDOW);
    React.useLayoutEffect(() => {
      if (data.length === 0) return;
      rangeChanged?.({
        startIndex: firstItemIndex + start,
        endIndex: firstItemIndex + data.length - 1,
      });
    }, [data.length, firstItemIndex, rangeChanged, start]);
    const rows: React.ReactNode[] = [];
    for (let index = start; index < data.length; index++) {
      const item = data[index];
      const key = computeItemKey ? computeItemKey(index, item) : index;
      rows.push(
        React.createElement(
          "div",
          { key, "data-index": index },
          itemContent ? itemContent(index, item) : null,
        ),
      );
    }
    return React.createElement("div", { "data-testid": "virtuoso", role: "log" }, rows);
  });
  return {
    Virtuoso,
    VirtuosoMockContext: { Provider: ({ children }: { children: unknown }) => children },
  };
});

const messageBubbleMock = vi.hoisted(() => ({
  render: vi.fn(),
}));

vi.mock("./ChatHeader", async () => {
  const React = await import("react");
  return {
    ChatHeader: ({ conversation }: { conversation: Conversation }) =>
      React.createElement("div", { "data-testid": "chat-header" }, conversation.name),
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

afterEach(() => {
  messageBubbleMock.render.mockClear();
  virtuosoMock.emitAtBottom = undefined;
  virtuosoMock.scroller = undefined;
  virtuosoMock.scrollToIndex.mockClear();
  clearImageDimsCache();
  cleanup();
});

describe("ChatArea switch-to-bottom flash guard", () => {
  const conv2: Conversation = { ...conversation, id: "conv-2" };
  const msg2 = (id: string): Message => ({ ...message(id), conversationId: conv2.id });
  const base = {
    accounts,
    selectedAccountId: null,
    onAccountChange: vi.fn(),
    detailsOpen: false,
    onToggleDetails: vi.fn(),
    hasMoreHistory: false,
  } as const;

  it("does not imperatively scrollToIndex on mount or conversation switch (initial bottom owned by Virtuoso initialTopMostItemIndex → no top→bottom flash)", () => {
    virtuosoMock.scrollToIndex.mockClear();
    const { rerender } = render(
      <ChatArea
        {...base}
        conversation={conversation}
        chatStoreKey="A"
        messages={[message("01"), message("02")]}
      />,
    );
    // 首挂的「首个有数据帧」:贴底交给 initialTopMostItemIndex,不命令式滚动。
    expect(virtuosoMock.scrollToIndex).not.toHaveBeenCalled();

    // 切会话(chatStoreKey 变 → Virtuoso 重挂):同样不命令式滚动。
    rerender(
      <ChatArea
        {...base}
        conversation={conv2}
        chatStoreKey="B"
        messages={[msg2("11"), msg2("12")]}
      />,
    );
    expect(virtuosoMock.scrollToIndex).not.toHaveBeenCalled();
  });

  it("keeps the newly mounted timeline hidden until tail range is ready without showing a skeleton mask", async () => {
    const { getByTestId, getAllByTestId, queryByRole, rerender } = render(
      <ChatArea
        {...base}
        conversation={conversation}
        chatStoreKey="A"
        messages={[message("01"), message("02")]}
      />,
    );
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(getByTestId("timeline-visible-plane").className).toContain("opacity-100");

    rerender(
      <ChatArea
        {...base}
        conversation={conv2}
        chatStoreKey="B"
        messages={[msg2("11"), msg2("12")]}
      />,
    );

    expect(queryByRole("status", { name: "切换会话中" })).toBeNull();
    expect(getAllByTestId("virtuoso")).toHaveLength(2);
    const settlingClassName = getByTestId("timeline-staging-plane").className;
    expect(settlingClassName).toContain("opacity-0");
    expect(getByTestId("timeline-visible-plane").className).toContain("opacity-100");
    expect(queryByRole("button", { name: "回到底部" })).toBeNull();

    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await waitFor(() => expect(queryByRole("status", { name: "切换会话中" })).toBeNull());
    expect(getByTestId("timeline-visible-plane").className).toContain("opacity-100");
  });

  it("keeps the previous whole chat surface visible during the next conversation landing frame", async () => {
    const { getAllByTestId, getByTestId, queryByTestId, rerender } = render(
      <ChatArea
        {...base}
        conversation={conversation}
        chatStoreKey="A"
        messages={[message("01"), message("02")]}
      />,
    );
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(getAllByTestId("message").map((node) => node.textContent)).toContain("01");

    rerender(
      <ChatArea
        {...base}
        conversation={{ ...conv2, name: "新会话" }}
        chatStoreKey="B"
        messages={[msg2("11"), msg2("12")]}
      />,
    );

    expect(queryByTestId("timeline-switch-mask")).toBeNull();
    expect(queryByTestId("timeline-static-frame")).toBeNull();
    expect(getByTestId("chat-header").textContent).toBe("胡娟");
    const visiblePlane = getByTestId("timeline-visible-plane");
    const stagingPlane = getByTestId("timeline-staging-plane");
    const messages = within(visiblePlane)
      .getAllByTestId("message")
      .map((node) => node.textContent);
    expect(messages).toContain("01");
    expect(messages).not.toContain("11");
    expect(
      within(stagingPlane)
        .getAllByTestId("message")
        .map((node) => node.textContent),
    ).toContain("11");
    expect(visiblePlane.className).toContain("opacity-100");
    expect(stagingPlane.className).toContain("opacity-0");
  });

  it("keeps the previous timeline visible while the next conversation is still loading (in-flight switch)", async () => {
    const { getByTestId, queryByTestId, rerender } = render(
      <ChatArea
        {...base}
        conversation={conversation}
        chatStoreKey="A"
        messages={[message("01"), message("02")]}
      />,
    );
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

    // 切到冷会话的首帧:store 分片尚未建立 → loading=true(见 useMessageHistory:121,
    // 真实数据流里冷会话首帧 loading 必为 true)。crossfade 应在「在途」期间保持旧时间线可见,
    // 避免「胡娟 → 空 → 新会话」的三段闪;放行的逃生出口只在 loading 落定后才生效。
    rerender(
      <ChatArea
        {...base}
        conversation={{ ...conv2, name: "新会话" }}
        chatStoreKey="B"
        messages={[]}
        loading
      />,
    );

    expect(queryByTestId("empty")).toBeNull();
    expect(queryByTestId("loading")).toBeNull();
    expect(queryByTestId("timeline-staging-plane")).toBeNull();
    const visiblePlane = getByTestId("timeline-visible-plane");
    expect(visiblePlane.className).toContain("opacity-100");
    expect(
      within(visiblePlane)
        .getAllByTestId("message")
        .map((node) => node.textContent),
    ).toContain("01");
    expect(getByTestId("chat-header").textContent).toBe("胡娟");
  });

  it("settles to the next conversation once its load completes empty (no stale previous timeline)", async () => {
    const { getByTestId, queryByTestId, queryAllByTestId, rerender } = render(
      <ChatArea
        {...base}
        conversation={conversation}
        chatStoreKey="A"
        messages={[message("01"), message("02")]}
      />,
    );
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

    // 新加客户=冷会话,readCache 读完 records 为空 → loading=false 且 messages=[]。此时必须放行到
    // 新会话(空态),不能冻在旧会话——否则就是线上「接待列表已切新人、聊天区却停在上一个人」的 bug。
    rerender(
      <ChatArea
        {...base}
        conversation={{ ...conv2, name: "新会话" }}
        chatStoreKey="B"
        messages={[]}
        loading={false}
      />,
    );
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

    expect(getByTestId("chat-header").textContent).toBe("新会话");
    expect(queryByTestId("empty")).not.toBeNull();
    expect(queryByTestId("loading")).toBeNull();
    expect(queryByTestId("timeline-visible-plane")).toBeNull();
    expect(queryByTestId("timeline-staging-plane")).toBeNull();
    expect(queryAllByTestId("message")).toHaveLength(0);
  });

  it("keeps the current visible timeline when same-conversation history briefly reports an empty window", async () => {
    const { getByTestId, queryByTestId, rerender } = render(
      <ChatArea
        {...base}
        conversation={conversation}
        chatStoreKey="A"
        messages={[message("01"), message("02")]}
      />,
    );
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

    rerender(
      <ChatArea {...base} conversation={conversation} chatStoreKey="A" messages={[]} loading />,
    );

    expect(queryByTestId("empty")).toBeNull();
    expect(queryByTestId("loading")).toBeNull();
    const visiblePlane = getByTestId("timeline-visible-plane");
    expect(visiblePlane.className).toContain("opacity-100");
    expect(
      within(visiblePlane)
        .getAllByTestId("message")
        .map((node) => node.textContent),
    ).toContain("01");
  });

  it("does not show scroll-to-bottom after reveal until Virtuoso confirms the new timeline is at bottom", async () => {
    const { getByTestId, queryByRole } = render(
      <ChatArea
        {...base}
        conversation={conversation}
        chatStoreKey="A"
        messages={[message("01"), message("02")]}
      />,
    );

    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

    const className = getByTestId("timeline-visible-plane").className;
    expect(className).not.toContain("opacity-0");
    expect(queryByRole("button", { name: "回到底部" })).toBeNull();
  });

  it("shows scroll-to-bottom only after the user scrolls away from bottom", async () => {
    const { queryByRole } = render(
      <ChatArea
        {...base}
        conversation={conversation}
        chatStoreKey="A"
        messages={[message("01"), message("02")]}
      />,
    );

    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

    expect(queryByRole("button", { name: "回到底部" })).toBeNull();

    act(() => virtuosoMock.emitAtBottom?.(true));
    expect(queryByRole("button", { name: "回到底部" })).toBeNull();

    act(() => virtuosoMock.emitAtBottom?.(false));
    expect(queryByRole("button", { name: "回到底部" })).toBeNull();

    act(() => {
      virtuosoMock.scroller?.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
    });
    act(() => virtuosoMock.emitAtBottom?.(false));
    expect(queryByRole("button", { name: "回到底部" })).not.toBeNull();
  });

  it("imperatively scrolls to bottom when new messages append within the same conversation", () => {
    virtuosoMock.scrollToIndex.mockClear();
    const { rerender } = render(
      <ChatArea
        {...base}
        conversation={conversation}
        chatStoreKey="A"
        messages={[message("01"), message("02")]}
      />,
    );
    expect(virtuosoMock.scrollToIndex).not.toHaveBeenCalled();

    // 同会话尾部追加(发送/新到达)+ 仍在底部 → 显式滚到底兜底。
    act(() => {
      rerender(
        <ChatArea
          {...base}
          conversation={conversation}
          chatStoreKey="A"
          messages={[message("01"), message("02"), message("03")]}
        />,
      );
    });
    expect(virtuosoMock.scrollToIndex).toHaveBeenCalled();
  });

  it("re-asserts bottom after the append frame so late row measurement cannot leave the newest message hidden", async () => {
    virtuosoMock.scrollToIndex.mockClear();
    const { rerender } = render(
      <ChatArea
        {...base}
        conversation={conversation}
        chatStoreKey="A"
        messages={[message("01"), message("02")]}
      />,
    );
    act(() => virtuosoMock.emitAtBottom?.(true));

    act(() => {
      rerender(
        <ChatArea
          {...base}
          conversation={conversation}
          chatStoreKey="A"
          messages={[message("01"), message("02"), message("03")]}
        />,
      );
    });
    // 首针:追加当帧立即贴底(新行此刻仍是估高)。
    const immediate = virtuosoMock.scrollToIndex.mock.calls.length;
    expect(immediate).toBeGreaterThan(0);

    // 补针:双 rAF(实测行高落地)后必须重申贴底,否则「实测 > 估高」的差值把新消息留在视口下方。
    await act(
      async () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(virtuosoMock.scrollToIndex.mock.calls.length).toBeGreaterThan(immediate);
    // 所有针都打向底部,不存在其他落点。
    for (const call of virtuosoMock.scrollToIndex.mock.calls) {
      expect(call[0]).toMatchObject({ index: "LAST", align: "end" });
    }
  });

  it("abandons the bottom re-assert when the user scrolls away before it fires", async () => {
    virtuosoMock.scrollToIndex.mockClear();
    const { rerender } = render(
      <ChatArea
        {...base}
        conversation={conversation}
        chatStoreKey="A"
        messages={[message("01"), message("02")]}
      />,
    );
    act(() => virtuosoMock.emitAtBottom?.(true));

    act(() => {
      rerender(
        <ChatArea
          {...base}
          conversation={conversation}
          chatStoreKey="A"
          messages={[message("01"), message("02"), message("03")]}
        />,
      );
    });
    const immediate = virtuosoMock.scrollToIndex.mock.calls.length;

    // 用户在补针点位前上滚离底(滚动事件先行翻 atBottom=false)→ 全部补针放弃,不抢滚动。
    act(() => virtuosoMock.emitAtBottom?.(false));
    await act(
      async () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 220));
    expect(virtuosoMock.scrollToIndex.mock.calls.length).toBe(immediate);
  });
});

describe("ChatArea history scrolling", () => {
  it("virtualizes long image-heavy timelines, mounting only a window of the timeline", async () => {
    const manyImages = Array.from({ length: 80 }, (_, i) => ({
      ...imageMessage(String(i + 1).padStart(2, "0"), {
        width: i % 2 === 0 ? 320 : 900,
        height: i % 2 === 0 ? 900 : 320,
      }),
      sentAt: `2026-05-19T10:${String(i % 50).padStart(2, "0")}:00.000Z`,
    }));

    // 虚拟化:Virtuoso 只渲染窗口子集(替身渲染数据尾部窗口),而非 80 条全渲染。
    const { container } = renderChatArea({ messages: manyImages });
    await act(async () => undefined);

    const rendered = container.querySelectorAll('[data-testid="message"]');
    // 远少于 80,证明已虚拟化只挂窗口子集。
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

  it("keeps an already-populated timeline visible while older messages load", () => {
    const { getByTestId } = renderChatArea({
      messages: [message("03"), message("04"), message("05")],
      loading: true,
      hasMoreHistory: true,
    });

    const className = getByTestId("timeline-visible-plane").className;
    expect(className).not.toContain("opacity-0");
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

    // 已显示的 03/04/05 不因 prepend 重渲(computeItemKey 稳定);仅新行 01/02 渲染。
    const reRenderedExisting = messageBubbleMock.render.mock.calls
      .map(([id]) => id)
      .filter((id) => id === "03" || id === "04" || id === "05");
    expect(reRenderedExisting).toEqual([]);
  });

  it("mounts the first real history page when it arrives after loading", async () => {
    // 首屏「滚到底」交真实 Virtuoso 的 initialTopMostItemIndex={index:'LAST'};jsdom 无真实布局,
    // 无法断言具体 scrollTop 像素值(真实滚动位置需真机验)。此处断言 jsdom 可观测的部分:loading
    // 结束后首个真实历史页的消息行确实挂载进 DOM(此前为空 → ChatLoadingState)。
    const { container, rerender, queryByTestId } = renderChatArea({ loading: true, messages: [] });
    expect(queryByTestId("loading")).not.toBeNull();

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

  it("requests older history when Virtuoso reports the top is reached", async () => {
    // 翻历史接线:Virtuoso 触顶 startReached → ChatArea 调 onLoadMoreHistory(Virtuoso 自带「触发
    // 一次」语义,无需边沿门)。像素级锚定稳定性交 firstItemIndex,需真机验。
    const loadMore = vi.fn().mockResolvedValue(undefined);
    renderChatArea({
      messages: [message("03"), message("04"), message("05")],
      hasMoreHistory: true,
      onLoadMoreHistory: loadMore,
    });
    await act(async () => undefined);

    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it("does not request older history when there is no more history", async () => {
    // hasMoreHistory=false:即便 startReached 触发,守卫也挡住,不调 onLoadMoreHistory。
    const loadMore = vi.fn().mockResolvedValue(undefined);
    renderChatArea({
      messages: [message("03"), message("04"), message("05")],
      hasMoreHistory: false,
      onLoadMoreHistory: loadMore,
    });
    await act(async () => undefined);

    expect(loadMore).not.toHaveBeenCalled();
  });

  it("keeps message bubbles mounted (zero remount) when an optimistic row converges to authoritative", async () => {
    // computeItemKey=clientMsgId??id:乐观气泡(clientMsgId 稳定)被权威条目替换(id 变、clientMsgId
    // 不变)时,行 key 不变 → 不 remount。这里用同一 clientMsgId 的两个不同 message 对象模拟收敛,
    // 断言 MessageBubble 不因 key 变化整行重建(收敛后仍渲染该行、内容更新)。
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

describe("ChatArea 拖拽文件遮罩(设置开关门控)", () => {
  it("拖文件悬停聊天区:出现统一「松开发送」遮罩;设置关闭则不响应", async () => {
    // 确保设置 store 带默认值(dragDrop=true)
    act(() => {
      useSettingsStore.setState({ settings: structuredClone(DEFAULT_SETTINGS), loaded: true });
    });
    const { container } = renderChatArea();
    const root = container.firstElementChild as HTMLElement;

    // 拖入文件 → 遮罩出现
    fireEvent.dragOver(root, { dataTransfer: { types: ["Files"] } });
    await waitFor(() => expect(screen.queryByText(STRINGS.composer.dropTitle)).toBeTruthy());
    expect(screen.queryByText(STRINGS.composer.dropHint)).toBeTruthy();

    // 拖出聊天区 → 遮罩消失
    fireEvent.dragLeave(root, { relatedTarget: document.body });
    await waitFor(() => expect(screen.queryByText(STRINGS.composer.dropTitle)).toBeNull());

    // 关掉设置开关 → 再拖不出遮罩
    act(() => {
      useSettingsStore.setState((s) => ({
        settings: { ...s.settings, composer: { ...s.settings.composer, dragDrop: false } },
      }));
    });
    fireEvent.dragOver(root, { dataTransfer: { types: ["Files"] } });
    expect(screen.queryByText(STRINGS.composer.dropTitle)).toBeNull();
  });
});

describe("ChatArea 失败/发送中出站行抬升 z-index(防「重发」被下一行盖住点不动)", () => {
  // 回归保护:失败气泡的「重发」状态行是 absolute 浮在气泡下方间距(下一行 pt)里的,虚拟列表里
  // 下一行为 DOM 后续兄弟、其透明 pt 命中区会盖住浮出的按钮 → 点不动。修复是给「出站 + 发送中/
  // 失败 + 未撤回」的行 relative + 抬升 z-index,让本行连同浮出的状态行画在下一行之上 → 可点击;
  // 且不占额外高度(原 pb-6 会在下一行 pt 之上再叠 24px,凭空多出间距)。z 随 index 递减,保证
  // 连续失败时上一条盖过下一条,都点得到。
  function outMsg(id: string, status: NonNullable<Message["status"]>): Message {
    return {
      id,
      conversationId: conversation.id,
      direction: "out",
      text: id,
      parts: [{ kind: "text", text: id }],
      sentAt: `2026-05-19T10:${id.padStart(2, "0")}:00.000Z`,
      status,
    };
  }

  function rowFor(plane: HTMLElement, text: string): HTMLElement {
    const node = within(plane)
      .getAllByTestId("message")
      .find((n) => n.textContent === text);
    expect(node, `应渲染出文本为 ${text} 的气泡`).toBeTruthy();
    const row = node!.closest("[data-message-row-id]") as HTMLElement | null;
    expect(row, `文本 ${text} 应在带 data-message-row-id 的行内`).toBeTruthy();
    return row!;
  }

  it("出站 sending/failed 行 relative + 抬升 z-index;sent 与入站不抬升;连续失败上一条 z 更高", async () => {
    const { getByTestId } = renderChatArea({
      chatStoreKey: "c1",
      messages: [
        message("01"), // 入站
        outMsg("02", "sent"), // 出站已发送
        outMsg("03", "failed"), // 出站失败(重发按钮所在)
        outMsg("04", "sending"), // 出站发送中(紧跟失败 → 连续场景)
      ],
    });
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

    const plane = getByTestId("timeline-visible-plane");
    const failedRow = rowFor(plane, "03");
    const sendingRow = rowFor(plane, "04");

    // 失败/发送中:relative + 正 z-index → 浮出的「重发」画在下一行之上,可点
    expect(failedRow.className).toContain("relative");
    expect(Number(failedRow.style.zIndex)).toBeGreaterThan(0);
    expect(sendingRow.className).toContain("relative");
    expect(Number(sendingRow.style.zIndex)).toBeGreaterThan(0);
    // 连续失败:上一条(03)z 必须 > 下一条(04),否则 03 的「重发」又被 04 盖住
    expect(Number(failedRow.style.zIndex)).toBeGreaterThan(Number(sendingRow.style.zIndex));
    // 不再用 pb-6 预留高度(避免在下一行 pt 之上多叠间距)
    expect(failedRow.className).not.toContain("pb-6");
    expect(sendingRow.className).not.toContain("pb-6");
    // 已发送 / 入站:无状态行,不抬升
    expect(rowFor(plane, "02").className).not.toContain("relative");
    expect(rowFor(plane, "02").style.zIndex).toBe("");
    expect(rowFor(plane, "01").className).not.toContain("relative");
    expect(rowFor(plane, "01").style.zIndex).toBe("");
  });
});
