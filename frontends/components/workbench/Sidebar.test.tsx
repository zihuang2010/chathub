// frontends/components/workbench/Sidebar.test.tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { Sidebar } from "./Sidebar";

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
