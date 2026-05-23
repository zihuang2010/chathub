// frontends/components/workbench/Sidebar.test.tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { useCurrentProfile } from "@/lib/data/useCurrentProfile";

import { Sidebar } from "./Sidebar";

vi.mock("@/lib/data/useCurrentProfile", () => ({
  useCurrentProfile: vi.fn(),
}));

const mockUseCurrentProfile = vi.mocked(useCurrentProfile);

const PROFILE = {
  user_id: "u1",
  display_name: "测试员",
  avatar_url: "",
  role: "operator",
  tenant_id: "t1",
};

beforeEach(() => {
  // 默认未就绪;需要时各用例自行覆盖
  mockUseCurrentProfile.mockReturnValue(null);
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
  it("展开态渲染真实 display_name 与映射后的 role 副标题", () => {
    mockUseCurrentProfile.mockReturnValue(PROFILE);
    renderSidebar({ collapsed: false });
    expect(screen.getByText("测试员")).toBeTruthy();
    expect(screen.getByText("客服坐席")).toBeTruthy();
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

  it("role 为未知值时原样显示", () => {
    mockUseCurrentProfile.mockReturnValue({ ...PROFILE, role: "supervisor" });
    renderSidebar({ collapsed: false });
    expect(screen.getByText("supervisor")).toBeTruthy();
  });

  it("role 为空时不渲染副标题但仍渲染姓名", () => {
    mockUseCurrentProfile.mockReturnValue({ ...PROFILE, role: "" });
    renderSidebar({ collapsed: false });
    expect(screen.queryByText("客服坐席")).toBeNull();
    expect(screen.getByText("测试员")).toBeTruthy();
  });

  it("折叠态仅渲染头像首字符,不渲染姓名/副标题", () => {
    mockUseCurrentProfile.mockReturnValue(PROFILE);
    renderSidebar({ collapsed: true });
    expect(screen.queryByText("测试员")).toBeNull();
    expect(screen.queryByText("客服坐席")).toBeNull();
    expect(screen.getByText("测")).toBeTruthy();
  });
});
