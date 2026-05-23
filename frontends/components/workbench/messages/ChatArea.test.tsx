import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Account } from "@/lib/types/account";

import { ChatArea } from "./ChatArea";
import type { Conversation, Message } from "./data";
import type { ScrollMetrics } from "./WorkbenchScrollArea";

const scrollAreaMock = vi.hoisted(() => ({
  viewport: null as HTMLDivElement | null,
  scrollTop: 0,
  scrollHeight: 900,
  clientHeight: 300,
  reset() {
    this.viewport = null;
    this.scrollTop = 0;
    this.scrollHeight = 900;
    this.clientHeight = 300;
  },
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
    MessageBubble: ({ message }: { message: Message }) =>
      React.createElement("div", { "data-testid": "message" }, message.text),
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
    }: {
      children: React.ReactNode;
      scrollRef?: React.Ref<HTMLDivElement>;
      onScrollMetrics?: (metrics: ScrollMetrics) => void;
      onUserScroll?: (metrics: ScrollMetrics) => void;
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

function renderChatArea(
  overrides: Partial<React.ComponentProps<typeof ChatArea>> & Record<string, unknown> = {},
) {
  const props = {
    conversation,
    messages: [],
    accounts,
    selectedAccount: null,
    onAccountChange: vi.fn(),
    detailsOpen: false,
    onToggleDetails: vi.fn(),
    ...overrides,
  };
  return render(<ChatArea {...(props as React.ComponentProps<typeof ChatArea>)} />);
}

beforeEach(() => {
  scrollAreaMock.reset();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe("ChatArea history scrolling", () => {
  it("scrolls to the latest message after the first real history page mounts", async () => {
    const { rerender } = renderChatArea({ loading: true, messages: [] });

    scrollAreaMock.scrollHeight = 1200;
    rerender(
      <ChatArea
        conversation={conversation}
        messages={[message("01"), message("02"), message("03")]}
        accounts={accounts}
        selectedAccount={null}
        onAccountChange={vi.fn()}
        detailsOpen={false}
        onToggleDetails={vi.fn()}
        loading={false}
      />,
    );

    await act(async () => undefined);

    expect(scrollAreaMock.scrollTop).toBe(1200);
  });

  it("loads older history when the user scrolls near the top", () => {
    const loadMore = vi.fn().mockResolvedValue(undefined);
    renderChatArea({
      messages: [message("03"), message("04"), message("05")],
      hasMoreHistory: true,
      onLoadMoreHistory: loadMore,
    });

    scrollAreaMock.scrollTop = 60;
    fireEvent.scroll(scrollAreaMock.viewport!);

    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it("preserves the visible anchor when older history is prepended", async () => {
    const loadMore = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderChatArea({
      messages: [message("03"), message("04"), message("05")],
      hasMoreHistory: true,
      onLoadMoreHistory: loadMore,
    });
    scrollAreaMock.scrollTop = 50;
    scrollAreaMock.scrollHeight = 1000;

    fireEvent.scroll(scrollAreaMock.viewport!);
    expect(loadMore).toHaveBeenCalledTimes(1);

    scrollAreaMock.scrollHeight = 1420;
    rerender(
      <ChatArea
        conversation={conversation}
        messages={[message("01"), message("02"), message("03"), message("04"), message("05")]}
        accounts={accounts}
        selectedAccount={null}
        onAccountChange={vi.fn()}
        detailsOpen={false}
        onToggleDetails={vi.fn()}
        hasMoreHistory
        onLoadMoreHistory={loadMore}
      />,
    );

    await act(async () => undefined);

    expect(scrollAreaMock.scrollTop).toBe(470);
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
        messages={[message("01"), message("02"), message("03")]}
        accounts={accounts}
        selectedAccount={null}
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
        messages={[message("01"), message("02"), message("03")]}
        accounts={accounts}
        selectedAccount={null}
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

describe("ChatArea unread divider", () => {
  const convUnread: Conversation = { ...conversation, unread: 2 };
  const sharedProps = {
    accounts,
    selectedAccount: null as string | null,
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
