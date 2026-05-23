# 左侧栏顶部员工区重设计 + 对接登录员工信息 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把左侧栏顶部硬编码的身份卡片(`UserBadge`)替换为真实登录员工信息(头像 + 姓名 + 角色),并重排为横向卡片布局。

**Architecture:** 新增 `useCurrentProfile()` 数据 hook(镜像现有 `useCurrentEmployeeId`),在 `Sidebar.tsx` 的 `UserBadge` 内部直接调用,无 prop 钻取。`AvatarMark` 支持头像图片 + 首字符回退并移除写死的在线小点。role 经小映射表转中文副标题。同步状态行沿用现有 `SyncStatusBadge`。

**Tech Stack:** React + TypeScript + Tailwind,测试用 Vitest + @testing-library/react,Tauri `invoke`/`listen`。

参考规格:`docs/superpowers/specs/2026-05-23-sidebar-employee-badge-design.md`

---

## 文件结构

- **Create** `frontends/lib/data/useCurrentProfile.ts` —— 读 `current_session` 返回 `UserProfile | null`,登出清空。职责单一,遵循 `lib/data/` 一个 hook 一个文件的约定。
- **Modify** `frontends/components/workbench/Sidebar.tsx` —— `UserBadge` 重排布局并接真实数据;`AvatarMark` 支持图片+回退、去掉在线小点;新增 `roleLabel` / `initialOf` 两个纯函数;新增 `useState`、`useCurrentProfile` import。
- **Modify** `frontends/components/workbench/Sidebar.test.tsx` —— 模块级 mock `useCurrentProfile`,新增姓名/角色/头像回退/折叠态用例。

测试策略说明:`useCurrentProfile` 与现有 `useCurrentEmployeeId` 一样只是包一层 Tauri `invoke`/`listen`,jsdom 下无 Tauri runtime,无法有意义地单测(现有 `useCurrentEmployeeId` 也无测试)。因此**不为 hook 写单测**,改为在 `Sidebar.test.tsx` 里 mock 该 hook、在组件层验证渲染行为。

---

## Task 1: 新增 `useCurrentProfile` 数据 hook

**Files:**

- Create: `frontends/lib/data/useCurrentProfile.ts`

- [ ] **Step 1: 创建 hook 文件**

写入 `frontends/lib/data/useCurrentProfile.ts`:

```tsx
// useCurrentProfile — 提供当前登录员工的完整 UserProfile,供左侧栏顶部员工区展示。
//
// 设计与 useCurrentEmployeeId 一致:
//   - mount 时调一次 current_session 拿初态
//   - listen auth:logged_out 时清空(返 null = 未登录)
//   - 不缓存(current_session 走 SQLite 极快;每个实例独立读)

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { UserProfile } from "@/App";

export function useCurrentProfile(): UserProfile | null {
  const [profile, setProfile] = useState<UserProfile | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    void (async () => {
      try {
        const p = await invoke<UserProfile | null>("current_session");
        if (!cancelled) setProfile(p);
      } catch {
        if (!cancelled) setProfile(null);
      }
      // 登出 / 被踢时清空
      unlisten = await listen<{ reason?: string }>("auth:logged_out", () => {
        setProfile(null);
      });
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return profile;
}
```

- [ ] **Step 2: 类型检查通过**

Run: `npx tsc --noEmit`
Expected: 无错误(`UserProfile` 从 `@/App` 正常解析)。

- [ ] **Step 3: 提交**

```bash
git add frontends/lib/data/useCurrentProfile.ts
git commit -m "feat(frontend): 新增 useCurrentProfile hook 读取登录员工信息"
```

---

## Task 2: 重排 UserBadge 布局 + 对接真实数据(TDD)

**Files:**

- Test: `frontends/components/workbench/Sidebar.test.tsx`
- Modify: `frontends/components/workbench/Sidebar.tsx`

- [ ] **Step 1: 写失败测试**

把 `frontends/components/workbench/Sidebar.test.tsx` 整体替换为下面内容(保留原 3 个折叠 toggle 用例,新增 profile 相关用例,并加 `useCurrentProfile` 模块 mock):

```tsx
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
```

- [ ] **Step 2: 运行测试,确认新用例失败**

Run: `npx vitest run frontends/components/workbench/Sidebar.test.tsx`
Expected: 3 个折叠用例 PASS;6 个员工区用例中至少 "测试员"/"客服坐席"/"supervisor" 相关 FAIL(当前 `UserBadge` 写死 "匠多多",不读 profile)。

- [ ] **Step 3: 改 Sidebar.tsx —— import 与顶部 helper**

把第 1 行的 react import 改为带上 `useState`:

```tsx
import { memo, useState } from "react";
```

在 `import { NAV_ITEMS, type NavItem, type Section } from "./nav";` 之后、`interface SidebarProps` 之前,新增:

```tsx
import { useCurrentProfile } from "@/lib/data/useCurrentProfile";

// role 原始值来自 relay(自由字符串,实测如 "operator")。已知值映射成中文,
// 未知值原样显示,空值由调用方决定不渲染副标题。
const ROLE_LABELS: Record<string, string> = {
  operator: "客服坐席",
  admin: "管理员",
};

function roleLabel(role: string | undefined): string {
  if (!role) return "";
  return ROLE_LABELS[role] ?? role;
}

// 取首个字符作头像回退;用展开运算符正确处理多字节字符(CJK/emoji)。
function initialOf(name: string | undefined): string {
  const trimmed = name?.trim();
  return trimmed ? [...trimmed][0] : "·";
}
```

- [ ] **Step 4: 改 Sidebar.tsx —— 重写 `UserBadge`**

把现有 `UserBadge`(约 76–108 行)整体替换为:

```tsx
function UserBadge({ collapsed }: { collapsed: boolean }) {
  // 登录员工信息(头像/姓名/角色)+ 全局 hub 同步状态。两者都在组件内部自取,
  // Sidebar/Workbench 无需透传 props。
  const profile = useCurrentProfile();
  const sync = useHubSyncStatus();

  const name = profile?.display_name ?? "";
  const role = roleLabel(profile?.role);

  if (collapsed) {
    return (
      <div className="flex flex-col items-center px-2 pb-2 pt-3">
        <AvatarMark avatarUrl={profile?.avatar_url} displayName={name} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 px-3 pb-2 pt-3">
      <div className="flex items-center gap-2.5">
        <AvatarMark avatarUrl={profile?.avatar_url} displayName={name} />
        <div className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="truncate text-[13px] font-semibold text-[#1F2937]">{name}</span>
          {role && <span className="truncate text-[11px] text-[#6B7A90]">{role}</span>}
        </div>
      </div>
      {/* 同步状态独占一整行(原先嵌在姓名下方);min-w-0 让 badge 适配窄列。 */}
      <div className="flex min-w-0">
        <SyncStatusBadge
          connectionState={sync.connectionState}
          lastEventAt={sync.lastEventAt}
          lastRefreshAt={sync.lastRefreshAt}
          resyncing={sync.resyncing}
          error={null}
          onRefresh={() => void sync.refresh()}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 5: 改 Sidebar.tsx —— 重写 `AvatarMark`**

把现有 `AvatarMark`(约 110–125 行)整体替换为:

```tsx
function AvatarMark({ avatarUrl, displayName }: { avatarUrl?: string; displayName?: string }) {
  const [imgFailed, setImgFailed] = useState(false);
  const showImg = !!avatarUrl && !imgFailed;

  if (showImg) {
    return (
      <img
        src={avatarUrl}
        alt=""
        onError={() => setImgFailed(true)}
        className="size-10 shrink-0 rounded-xl object-cover shadow-[0_1px_2px_rgba(15,23,42,0.06)]"
      />
    );
  }

  return (
    <div
      className="grid size-10 shrink-0 place-items-center rounded-xl text-[14px] font-medium text-[#1F2937] shadow-[0_1px_2px_rgba(15,23,42,0.06)]"
      style={{ background: "#FCE7B8" }}
    >
      {initialOf(displayName)}
    </div>
  );
}
```

说明:相比原版,移除了包裹 `<div className="relative">` 与右下角绿色在线小点 `<span>`(规格 §6 决策:去掉在线小点)。`shrink-0` 直接挂在头像元素上。

- [ ] **Step 6: 运行测试,确认全部通过**

Run: `npx vitest run frontends/components/workbench/Sidebar.test.tsx`
Expected: 9 个用例全部 PASS。

- [ ] **Step 7: 类型检查 + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: 无 error。若 lint 报 import 顺序,运行 `npm run lint:fix` 后复跑。

- [ ] **Step 8: 提交**

```bash
git add frontends/components/workbench/Sidebar.tsx frontends/components/workbench/Sidebar.test.tsx
git commit -m "feat(frontend): 左侧栏顶部员工区接登录员工信息并重排为横向卡片"
```

---

## Task 3: 全量验证

- [ ] **Step 1: 跑全量前端测试**

Run: `npm test`
Expected: 全绿(含 Sidebar 9 用例)。

- [ ] **Step 2: 启动 dev 人工核对(展开/折叠两态)**

Run: `npm run dev`
人工检查清单:

- 展开态:头像左、姓名 + 角色副标题右排、同步状态行在下;
- 头像在 `avatar_url` 缺失时显示姓名首字符,字母块底色未变(`#FCE7B8`);
- 折叠态:仅头像居中,无姓名/副标题/同步行,无在线小点;
- 切换收起/展开过渡正常,导航项与"更多"按钮未受影响。

> 注:UI 正确性需肉眼确认;若运行环境无法启动 Tauri 桌面端,如实说明,不得仅凭测试通过即宣称 UI 完成。

---

## 自检结果

- **规格覆盖**:§3 数据来源 → Task 1 + UserBadge 取值;§4.1 hook → Task 1;§4.2 布局 → Task 2 Step 4;§4.3 头像+回退+去小点 → Task 2 Step 5;§4.4 role 映射 → Task 2 Step 3;§5 兜底(null/空)→ `initialOf`/`?? ""`/`role &&` + 测试用例;§7 测试 → Task 2 Step 1。无遗漏。
- **占位符**:无 TBD/TODO;每个改码步骤均含完整代码。
- **类型/命名一致**:`useCurrentProfile`、`roleLabel`、`initialOf`、`AvatarMark({avatarUrl, displayName})` 在 hook、组件、测试间命名一致;`UserProfile` 字段(`display_name`/`avatar_url`/`role`)与 `frontends/App.tsx` 定义一致。
