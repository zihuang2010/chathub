// 切账号筛选的过渡交互回归测试:
//   1. 骨架延迟出现 —— switching 刚置真时继续渲染旧列表(不闪骨架);持续超过
//      SWITCHING_SKELETON_DELAY_MS(250ms) 的慢路径才切骨架;switching 复位立即回真列表。
//      钉死"快路径下数据到位一次性整体替换、无『真列表→骨架→真列表』闪烁"的行为。
//   2. 滚动复位 —— 快路径不再经历骨架卸载/重挂,新账号数据落地时显式把滚动归零。

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 搜索框牵入 useFriends(Tauri invoke),与过渡行为无关 → 占位 mock。
vi.mock("./MessagesContactSearch", () => ({
  MessagesContactSearch: () => null,
}));

import type { Account } from "@/lib/types/account";

import { ConversationList } from "./ConversationList";
import type { Conversation } from "./data";

const ACCOUNTS: readonly Account[] = [
  { id: "acc-1", name: "账号一", colorToken: 1 },
  { id: "acc-2", name: "账号二", colorToken: 2 },
];

function conv(id: string, account: string): Conversation {
  return {
    id,
    name: `客户${id}`,
    preview: "你好",
    account,
    time: "11:24",
    unread: 0,
    online: true,
  };
}

const CONVERSATIONS = [conv("c1", "账号一"), conv("c2", "账号一")];

function baseProps(overrides: Partial<Parameters<typeof ConversationList>[0]> = {}) {
  return {
    conversations: CONVERSATIONS,
    selectedId: "c1",
    onSelect: vi.fn(),
    width: 280,
    accounts: ACCOUNTS,
    selectedAccountId: null as string | null,
    statusTab: "all" as const,
    onStatusChange: vi.fn(),
    onOpenCustomer: vi.fn(),
    onClearSearch: vi.fn(),
    ...overrides,
  };
}

/** 骨架行特征:SkeletonRow 的 animate-pulse 占位块(真实会话行不用该类)。 */
function hasSkeleton(container: HTMLElement): boolean {
  return container.querySelectorAll(".animate-pulse").length > 0;
}

function viewportEl(container: HTMLElement): HTMLDivElement | null {
  return container.querySelector<HTMLDivElement>(".overflow-y-scroll");
}

beforeEach(() => {
  vi.useFakeTimers();
  class ResizeObserverMock {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  }
  class MutationObserverMock {
    observe = vi.fn();
    disconnect = vi.fn();
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  vi.stubGlobal("MutationObserver", MutationObserverMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ConversationList 切账号过渡", () => {
  it("快路径:switching 短暂为真不闪骨架,数据到位一次性替换", () => {
    const { container, rerender } = render(<ConversationList {...baseProps()} />);
    expect(hasSkeleton(container)).toBe(false);

    // 切账号:switching=true,items 仍是旧账号数据 → 继续渲染旧列表,不切骨架
    rerender(<ConversationList {...baseProps({ selectedAccountId: "acc-2", switching: true })} />);
    expect(hasSkeleton(container)).toBe(false);

    // 100ms 后新数据落地(未超 250ms 延迟阈值)→ 全程无骨架
    act(() => void vi.advanceTimersByTime(100));
    expect(hasSkeleton(container)).toBe(false);
    rerender(
      <ConversationList
        {...baseProps({
          selectedAccountId: "acc-2",
          switching: false,
          conversations: [conv("c3", "账号二")],
        })}
      />,
    );
    expect(hasSkeleton(container)).toBe(false);
  });

  it("慢路径:switching 持续超过延迟阈值才显示骨架,复位后立即回真列表", () => {
    const { container, rerender } = render(<ConversationList {...baseProps()} />);
    rerender(<ConversationList {...baseProps({ selectedAccountId: "acc-2", switching: true })} />);
    expect(hasSkeleton(container)).toBe(false);

    act(() => void vi.advanceTimersByTime(250));
    expect(hasSkeleton(container)).toBe(true);

    rerender(
      <ConversationList
        {...baseProps({
          selectedAccountId: "acc-2",
          switching: false,
          conversations: [conv("c3", "账号二")],
        })}
      />,
    );
    expect(hasSkeleton(container)).toBe(false);
  });

  it("列表/空态 viewport 常驻滚动条轨道,骨架右距对齐,消息↔未读切换不发生宽度跳动", () => {
    // 经典滚动条(6px)出现/消失会让整列内容左右跳。scrollbar-gutter:stable 在 WKWebView
    // 上按原生滚动条宽度(≈15px)预留、与自定义 6px 不一致,反而引入反向跳动(真机已踩坑),
    // 故改为 overflow-y:scroll 常驻轨道:有无内容溢出都精确占 6px,机制无关。
    // 1) 正常列表 viewport:overflow-y-scroll 必须替换掉基类的 overflow-y-auto
    const { container, rerender } = render(<ConversationList {...baseProps()} />);
    expect(viewportEl(container)).not.toBeNull();
    expect(viewportEl(container)!.className).not.toContain("overflow-y-auto");
    expect(viewportEl(container)!.className).not.toContain("scrollbar-gutter");

    // 2) 空列表分支(筛选/未读结果为空)同样常驻轨道
    rerender(<ConversationList {...baseProps({ conversations: [] })} />);
    expect(viewportEl(container)).not.toBeNull();

    // 3) 切账号骨架分支无滚动条,右侧 padding 补足"pr-2(8px)+轨道 6px=14px"对齐真列表
    rerender(<ConversationList {...baseProps({ selectedAccountId: "acc-2", switching: true })} />);
    act(() => void vi.advanceTimersByTime(250));
    expect(hasSkeleton(container)).toBe(true);
    const skeletonHost = container.querySelector(".flex-1.overflow-hidden");
    expect(skeletonHost?.className).toContain("pr-3.5");
  });

  it("快路径:新账号数据落地时滚动复位到顶部", () => {
    const { container, rerender } = render(<ConversationList {...baseProps()} />);
    const viewport = viewportEl(container);
    expect(viewport).not.toBeNull();
    viewport!.scrollTop = 120;

    // switching 期间(渲染旧列表)不动滚动
    rerender(<ConversationList {...baseProps({ selectedAccountId: "acc-2", switching: true })} />);
    expect(viewport!.scrollTop).toBe(120);

    // 新数据落地 → layout effect 在绘制前归零
    rerender(
      <ConversationList
        {...baseProps({
          selectedAccountId: "acc-2",
          switching: false,
          conversations: [conv("c3", "账号二")],
        })}
      />,
    );
    expect(viewport!.scrollTop).toBe(0);
  });
});
