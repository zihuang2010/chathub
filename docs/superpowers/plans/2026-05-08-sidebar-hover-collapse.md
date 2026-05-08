# 侧边栏 hover 折叠把手 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把侧边栏顶部的 chevron 折叠按钮替换成钉钉风格的「鼠标靠近右边缘出现」的药丸把手。

**Architecture:** 单文件改动 (`frontends/components/workbench/Sidebar.tsx`)。`UserBadge` 仅保留头像与昵称，新增 `EdgeHandle` 子组件以 `peer` + `peer-hover` 纯 CSS 方式触发。`aside` 改为 `overflow-visible` 让药丸能骑跨右边线，原有内容裁切下移到内部容器。`Workbench` 状态管理（`sidebarCollapsed` / `onToggleCollapsed`）保持不变。

**Tech Stack:** React 19, TypeScript, Tailwind CSS, lucide-react, vitest + @testing-library/react。

**Spec:** [`docs/superpowers/specs/2026-05-08-sidebar-hover-collapse-design.md`](../specs/2026-05-08-sidebar-hover-collapse-design.md)

---

## File Map

| 路径                                              | 动作   | 责任                                                               |
| ------------------------------------------------- | ------ | ------------------------------------------------------------------ |
| `frontends/components/workbench/Sidebar.tsx`      | Modify | 重构 `UserBadge`、新增 `EdgeHandle`、调整 aside overflow / z-index |
| `frontends/components/workbench/Sidebar.test.tsx` | Create | toggle 按钮的回归测试（aria 标签、点击回调）                       |

---

## Task 1: 为侧栏 toggle 行为加回归测试

这一步是先用 `@testing-library/react` 锁住「按钮存在 + 点击触发回调」的行为，然后再做结构重构。CSS hover 行为在 jsdom 下不可靠测，故仅覆盖功能层。当前实现下这些测试就应该全部 PASS——它们的作用是 Task 2 重构时不破坏功能。

**Files:**

- Create: `frontends/components/workbench/Sidebar.test.tsx`

- [ ] **Step 1: 创建测试文件并写入用例**

```tsx
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
```

- [ ] **Step 2: 运行测试，确认全部通过（防止当前实现被破坏）**

Run: `pnpm test -- frontends/components/workbench/Sidebar.test.tsx`

Expected: 3 个用例全部 PASS。

- [ ] **Step 3: 提交**

```bash
git add frontends/components/workbench/Sidebar.test.tsx
git commit -m "test(sidebar): 给折叠 toggle 加回归测试"
```

---

## Task 2: 重构 Sidebar — 移除顶部 chevron、加 EdgeHandle、调整 overflow / z-index

把 `Sidebar.tsx` 整体替换成下面的新结构。改动包括：

1. `aside` 的 `overflow-hidden` → `overflow-visible`，加 `z-10`，保留 `rounded-bl-[10px]`（backdrop-filter 仍需要它）。
2. 内部内容容器加 `overflow-hidden rounded-bl-[10px]`，承接原本的内容裁切语义。
3. `UserBadge` 移除 `<` / `>` 按钮和 `onToggleCollapsed` prop，仅保留头像 + 昵称。
4. 新增 `EdgeHandle` 子组件：透明 `peer` 触发区 + 药丸按钮（鼠标 hover 边线时淡入）。

测试保持原状，重构完成后 Task 1 的 3 个用例仍应全部通过。

**Files:**

- Modify: `frontends/components/workbench/Sidebar.tsx`（整体替换）

- [ ] **Step 1: 用以下内容覆盖 `Sidebar.tsx`**

```tsx
import { memo } from "react";
import { ChevronLeft, ChevronRight, Menu } from "lucide-react";

import { FROSTED_GLASS_STYLE, WORKBENCH_BLUE, WORKBENCH_NAV_TEXT } from "@/lib/theme";
import { cn } from "@/lib/utils";

import { NAV_ITEMS, type NavItem, type Section } from "./nav";

interface SidebarProps {
  value: Section;
  onChange: (s: Section) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

export const Sidebar = memo(function Sidebar({
  value,
  onChange,
  collapsed,
  onToggleCollapsed,
}: SidebarProps) {
  return (
    <aside
      className={cn(
        // overflow-visible 是为了让 EdgeHandle 的药丸能外探到右侧消息列表之上；
        // z-10 让外探部分盖在 MessagesPage 的左边沿上方，否则同级 flex 子元素
        // 默认按 DOM 顺序堆叠会被后面的兄弟节点遮住。rounded-bl-[10px] 仍留在
        // aside 上，因为 backdrop-filter 自带 stacking context，圆角必须由它
        // 的元素本身承担。
        "relative z-10 flex h-full shrink-0 select-none flex-col overflow-visible rounded-bl-[10px] transition-[width] duration-200 ease-out",
        collapsed ? "w-16" : "w-36",
      )}
      style={{
        // 与 TitleBar 共用 FROSTED_GLASS_STYLE，保证两者像素级一致——任何一方
        // 偏移都会在交界处产生色差带。
        ...FROSTED_GLASS_STYLE,
      }}
    >
      <div className="relative z-10 flex h-full flex-col overflow-hidden rounded-bl-[10px]">
        <UserBadge collapsed={collapsed} />
        <nav className="flex flex-col gap-0.5 px-2 pt-2">
          {NAV_ITEMS.map((item) => (
            <NavButton
              key={item.value}
              item={item}
              active={item.value === value}
              onClick={() => onChange(item.value)}
              collapsed={collapsed}
            />
          ))}
        </nav>
        <div className="mt-auto px-2 pb-3 pt-2">
          <button
            type="button"
            className={cn(
              "flex h-10 w-full items-center rounded-md transition-colors hover:bg-white/45 hover:text-[#1F2937]",
              collapsed ? "justify-center px-0" : "gap-3 px-3",
            )}
            style={{ color: WORKBENCH_NAV_TEXT }}
            aria-label="更多"
          >
            <Menu size={18} />
            {!collapsed && <span className="text-[13.5px] font-medium">更多</span>}
          </button>
        </div>
      </div>
      <EdgeHandle collapsed={collapsed} onToggle={onToggleCollapsed} />
    </aside>
  );
});

// ─── User badge ─────────────────────────────────────────────────────────────

function UserBadge({ collapsed }: { collapsed: boolean }) {
  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-2 px-2 pb-2 pt-3">
        <AvatarMark />
      </div>
    );
  }

  return (
    <div className="flex min-h-[58px] items-center gap-2.5 px-3 pb-2 pt-3">
      <AvatarMark />
      <div className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-[13px] font-semibold text-[#1F2937]">匠多多</span>
      </div>
    </div>
  );
}

function AvatarMark() {
  return (
    <div className="relative shrink-0">
      <div
        className="grid size-10 place-items-center rounded-xl text-[14px] font-medium text-[#1F2937] shadow-[0_1px_2px_rgba(15,23,42,0.06)]"
        style={{ background: "#FCE7B8" }}
      >
        M
      </div>
      <span
        aria-hidden
        className="absolute bottom-[-2px] right-[-2px] size-[10px] rounded-full border-2 border-[#EEF6FF] bg-[#10B981]"
      />
    </div>
  );
}

// ─── Edge handle ────────────────────────────────────────────────────────────

function EdgeHandle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  return (
    <>
      {/* 透明的 hover 触发区，水平骑跨右边线、左右各 7px 感应。
         peer 让相邻按钮在 hover 它时也保持可见。 */}
      <div aria-hidden className="peer absolute bottom-0 right-0 top-0 w-3.5 translate-x-1/2" />
      <button
        type="button"
        onClick={onToggle}
        aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
        aria-expanded={!collapsed}
        className={cn(
          "absolute right-0 top-1/2 z-20",
          "-translate-y-1/2 translate-x-1/2",
          "grid h-10 w-4 place-items-center",
          "rounded-full border border-[rgba(15,23,42,0.06)] bg-white",
          "shadow-[0_1px_2px_rgba(15,23,42,0.06)]",
          "text-[#4B6284] transition-opacity duration-150 ease-out hover:text-[#1F2937]",
          "opacity-0 hover:opacity-100 peer-hover:opacity-100",
          "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#60A5FA]/35",
        )}
      >
        {collapsed ? <ChevronRight size={12} /> : <ChevronLeft size={12} />}
      </button>
    </>
  );
}

// ─── Nav button ─────────────────────────────────────────────────────────────

function NavButton({
  item,
  active,
  onClick,
  collapsed,
}: {
  item: NavItem;
  active: boolean;
  onClick: () => void;
  collapsed: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative flex h-10 items-center rounded-md transition-colors",
        collapsed ? "justify-center px-0" : "gap-3 px-3",
        active
          ? "bg-white shadow-[0_1px_3px_rgba(15,23,42,0.045)]"
          : "hover:bg-white/45 hover:text-[#1F2937]",
      )}
      style={{
        color: active ? WORKBENCH_BLUE : WORKBENCH_NAV_TEXT,
        backgroundColor: active ? "#FFFFFF" : undefined,
      }}
      aria-pressed={active}
      aria-label={item.label}
    >
      <item.Icon size={18} strokeWidth={1.8} />
      {!collapsed && <span className="text-[13.5px] font-medium">{item.label}</span>}
      {item.badge !== undefined && item.badge > 0 && (
        <span
          aria-hidden
          className={cn(
            "grid h-[17px] min-w-[17px] place-items-center rounded-full bg-[#EF4444] px-1 text-[10.5px] font-semibold leading-none text-white",
            collapsed ? "absolute right-1 top-1" : "ml-auto",
          )}
        >
          {item.badge > 99 ? "99+" : item.badge}
        </span>
      )}
    </button>
  );
}
```

- [ ] **Step 2: 运行 Sidebar 单元测试，确认仍然全部通过**

Run: `pnpm test -- frontends/components/workbench/Sidebar.test.tsx`

Expected: 3 个用例全部 PASS（按钮 aria 与点击回调没有回归）。

- [ ] **Step 3: 运行整体测试套件**

Run: `pnpm test`

Expected: 所有测试 PASS。

- [ ] **Step 4: 运行 lint**

Run: `pnpm lint`

Expected: 0 errors, 0 warnings。如果有 warning 与本次改动相关，修掉再继续。

- [ ] **Step 5: 提交**

```bash
git add frontends/components/workbench/Sidebar.tsx
git commit -m "refactor(sidebar): 用边缘 hover 药丸把手替换顶部 chevron 按钮"
```

---

## Task 3: 视觉验证（dev server）

CSS hover、overflow 与 z-index 的实际效果在 jsdom 里不可靠，必须在浏览器里手动确认。

- [ ] **Step 1: 启动开发服务器**

Run: `pnpm dev`

打开浏览器到 vite 输出的本地地址（一般是 `http://localhost:1420` 或 `http://localhost:5173`）。如果应用入口需要登录，按照常规登录流程进入 Workbench。

- [ ] **Step 2: 走查清单**

逐项目视确认（任一项不符即视为失败）：

1. **顶部用户行干净**：展开态下匠多多名字旁边没有 `<` 按钮；折叠态下头像下方没有 `>` 按钮。
2. **展开态 hover 触发**：sidebar 当前展开。鼠标移动到右边线 ±7px 范围内时，药丸（带 ChevronLeft 图标）以 ~150ms 淡入；移开后淡出。
3. **展开态点击折叠**：点击药丸，sidebar 宽度从 144px 收缩到 64px，过渡顺滑（200ms）。
4. **折叠态 hover 触发**：sidebar 折叠后，再次 hover 右边线 → 药丸出现，图标变 ChevronRight。
5. **折叠态点击展开**：点击药丸，sidebar 恢复展开，图标方向同步切换。
6. **药丸位置**：药丸垂直居中、半个身体在 sidebar 内、半个外探到 MessagesPage 的最左侧像素之上，不被遮挡也不被裁掉。
7. **药丸不阻挡 MessagesPage 内部点击**：在药丸不可见时（鼠标远离边线），消息列表最左侧依然可点击/可滚动。
8. **键盘可达**：Tab 键能聚焦到药丸（`focus-visible` 蓝色 ring 出现且药丸保持可见），按 Enter 或 Space 触发折叠/展开。
9. **frosted glass 圆角**：sidebar 左下角圆角仍然正常，没有出现因 `overflow-visible` 改动导致的方角或溢出。

- [ ] **Step 3: 如有问题，回到 Task 2 调整后再走一遍清单。无问题则关闭 dev server，结束流程。**

走查清单全部通过，且 Task 2 已经提交，则改动完成；不需要额外 commit。

---

## 备注

- **不引入 React state**：药丸的显隐完全由 Tailwind 的 `peer` + `peer-hover` 与按钮自身的 `hover` 完成，没有 `useState`，重渲染开销为 0。
- **`overflow-visible` 是否会让宽度过渡溢出？** 不会。内部容器仍然 `overflow-hidden`，宽度过渡过程中文字依然被裁切；外部 aside 的 `overflow-visible` 只影响绝对定位且明确想要外探的 EdgeHandle。
- **z-index 选取**：aside `z-10`（让 sidebar 这个 stacking context 高于同级 MessagesPage），EdgeHandle 内部药丸 `z-20`（同 stacking context 内压在 `peer` 触发区上方）。两者数值并非全局共享，仅在各自父级内有效，安全。
