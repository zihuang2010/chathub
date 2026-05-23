// frontends/components/workbench/Sidebar.test.tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { useCurrentProfile } from "@/lib/data/useCurrentProfile";
import { useHubSyncStatus } from "@/lib/data/useHubSyncStatus";
import type { HubConnectionState } from "@/lib/data/useResource";

import { Sidebar } from "./Sidebar";

vi.mock("@/lib/data/useCurrentProfile", () => ({
  useCurrentProfile: vi.fn(),
}));

vi.mock("@/lib/data/useHubSyncStatus", () => ({
  useHubSyncStatus: vi.fn(),
}));

const mockUseCurrentProfile = vi.mocked(useCurrentProfile);
const mockUseHubSyncStatus = vi.mocked(useHubSyncStatus);

const PROFILE = {
  user_id: "u1",
  display_name: "测试员",
  avatar_url: "",
  role: "operator",
  tenant_id: "t1",
};

function syncWith(connectionState: HubConnectionState | null) {
  return {
    connectionState,
    lastEventAt: null,
    lastRefreshAt: null,
    resyncing: false,
    refresh: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  // 默认未就绪;需要时各用例自行覆盖
  mockUseCurrentProfile.mockReturnValue(null);
  mockUseHubSyncStatus.mockReturnValue(syncWith(null));
});

afterEach(() => {
  cleanup();
});

function renderSidebar(props: { collapsed: boolean; onToggleCollapsed?: () => void }) {
  return render(
    <Sidebar
      value="messages"
      onChange={() => {}}
      collapsed={props.collapsed}
      onToggleCollapsed={props.onToggleCollapsed ?? (() => {})}
    />,
  );
}

describe("Sidebar collapse toggle", () => {
  it("折叠态下渲染『展开侧边栏』按钮，且 aria-expanded=false", () => {
    renderSidebar({ collapsed: true });
    const button = screen.getByRole("button", { name: "展开侧边栏" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("展开态下渲染『收起侧边栏』按钮，且 aria-expanded=true", () => {
    renderSidebar({ collapsed: false });
    const button = screen.getByRole("button", { name: "收起侧边栏" });
    expect(button.getAttribute("aria-expanded")).toBe("true");
  });

  it("点击 toggle 按钮时调用 onToggleCollapsed 一次", () => {
    const onToggle = vi.fn();
    renderSidebar({ collapsed: false, onToggleCollapsed: onToggle });
    fireEvent.click(screen.getByRole("button", { name: "收起侧边栏" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

describe("Sidebar 顶部员工区", () => {
  it("展开态渲染真实 display_name", () => {
    mockUseCurrentProfile.mockReturnValue(PROFILE);
    renderSidebar({ collapsed: false });
    expect(screen.getByText("测试员")).toBeTruthy();
  });

  it("avatar_url 为空时回退展示 display_name 首字符", () => {
    mockUseCurrentProfile.mockReturnValue({ ...PROFILE, avatar_url: "" });
    renderSidebar({ collapsed: false });
    expect(screen.getByText("测")).toBeTruthy();
  });

  it("avatar_url 有值时渲染 img 且 src 正确", () => {
    mockUseCurrentProfile.mockReturnValue({ ...PROFILE, avatar_url: "https://x/a.png" });
    const { container } = renderSidebar({ collapsed: false });
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe("https://x/a.png");
  });

  it("connectionState=subscribed 显示『在线』", () => {
    mockUseCurrentProfile.mockReturnValue(PROFILE);
    mockUseHubSyncStatus.mockReturnValue(syncWith({ state: "subscribed" }));
    renderSidebar({ collapsed: false });
    expect(screen.getByText("在线")).toBeTruthy();
  });

  it("connectionState=disconnected 显示『离线』", () => {
    mockUseCurrentProfile.mockReturnValue(PROFILE);
    mockUseHubSyncStatus.mockReturnValue(syncWith({ state: "disconnected" }));
    renderSidebar({ collapsed: false });
    expect(screen.getByText("离线")).toBeTruthy();
  });

  it("connectionState=null 显示『连接中』", () => {
    mockUseCurrentProfile.mockReturnValue(PROFILE);
    mockUseHubSyncStatus.mockReturnValue(syncWith(null));
    renderSidebar({ collapsed: false });
    expect(screen.getByText("连接中")).toBeTruthy();
  });

  it("折叠态:头像首字符常显,姓名/在线状态以 opacity-0 淡出隐藏(常驻挂载保证收展丝滑)", () => {
    mockUseCurrentProfile.mockReturnValue(PROFILE);
    mockUseHubSyncStatus.mockReturnValue(syncWith({ state: "subscribed" }));
    renderSidebar({ collapsed: true });
    // 头像首字符照常渲染。
    expect(screen.getByText("测")).toBeTruthy();
    // 姓名/状态不再卸载,而是常驻 DOM、所在文字块以 opacity-0 隐藏 —— 这样收/展两态间
    // 才能做 opacity 交叉淡入淡出,避免整树替换造成的跳动闪烁。
    const nameBlock = screen.getByText("测试员").closest("div");
    expect(nameBlock?.className).toContain("opacity-0");
    expect(screen.getByText("在线")).toBeTruthy();
  });
});
