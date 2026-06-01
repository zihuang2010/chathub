# 消息历史列表 上滑翻页过渡打磨 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让消息列表"上滑到顶翻历史"的过渡更精致丝滑——spinner 不再一闪、到顶有极轻回弹、全程尊重 reduce-motion——且不碰数据/滚动核心逻辑。

**Architecture:** 纯 UI 层改动。A1 新增计时 hook `useTransientVisibility` 给翻历史 spinner 加"最小展示时长 + 淡入淡出";A2 在共享组件 `WorkbenchScrollArea` 加一个**默认关**的 `overscrollBounce` prop，到顶上推时对滚动内容容器施加纯 `transform` 回弹（不触碰 `scrollTop`、不破坏现有精确差值锚定），仅 `ChatArea` 消息区开启。

**Tech Stack:** React 19 + TypeScript + Tailwind（`tailwindcss-animate`）+ Zustand；测试 Vitest + @testing-library/react（jsdom）。命令工作目录 = 仓库根，包管理器 pnpm。

依据规格：`docs/superpowers/specs/2026-06-01-messages-history-pagination-polish-design.md`

---

### Task 0: 刷新 GitNexus 索引 + 改前 impact 分析（项目规范要求）

**Files:** 无（只读分析）

- [ ] **Step 1: 刷新索引（索引停在 `ae6d0c0`，新代码未进图谱）**

Run: `npx gitnexus analyze --embeddings`
Expected: 分析完成、无致命错误（耗时数十秒级，可接受）。

- [ ] **Step 2: 对将改的符号跑 upstream impact**

用 MCP 工具分别跑：

- `gitnexus_impact({ target: "ChatArea", direction: "upstream", repo: "chathub" })`
- `gitnexus_impact({ target: "WorkbenchScrollArea", direction: "upstream", repo: "chathub" })`

Expected/已知预期：`ChatArea` 由 `MessagesPage` 渲染；`WorkbenchScrollArea` 被 `ChatArea`/`ConversationList`/`CustomerList`/`CustomerDetailPanel` 共用。风险预期 **LOW**（A2 prop 默认关，其余 3 处不受影响）。若返回 HIGH/CRITICAL，停下并向用户报告再继续。

---

### Task 1: A1 — `useTransientVisibility` 计时 hook（TDD）

**Files:**

- Create: `frontends/components/workbench/messages/hooks/useTransientVisibility.ts`
- Test: `frontends/components/workbench/messages/hooks/useTransientVisibility.test.ts`

- [ ] **Step 1: 写失败测试**

写入 `frontends/components/workbench/messages/hooks/useTransientVisibility.test.ts`：

```ts
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useTransientVisibility } from "./useTransientVisibility";

describe("useTransientVisibility", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders immediately when active", () => {
    const { result } = renderHook(
      ({ active }) => useTransientVisibility(active, { minVisibleMs: 400, fadeMs: 180 }),
      { initialProps: { active: true } },
    );
    expect(result.current.rendered).toBe(true);
    expect(result.current.leaving).toBe(false);
  });

  it("holds for minVisibleMs after going inactive, then fades out", () => {
    const { result, rerender } = renderHook(
      ({ active }) => useTransientVisibility(active, { minVisibleMs: 400, fadeMs: 180 }),
      { initialProps: { active: true } },
    );

    act(() => {
      rerender({ active: false });
    });
    expect(result.current.rendered).toBe(true);
    expect(result.current.leaving).toBe(false);

    act(() => {
      vi.advanceTimersByTime(399);
    });
    expect(result.current.rendered).toBe(true);
    expect(result.current.leaving).toBe(false);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.leaving).toBe(true);
    expect(result.current.rendered).toBe(true);

    act(() => {
      vi.advanceTimersByTime(180);
    });
    expect(result.current.rendered).toBe(false);
    expect(result.current.leaving).toBe(false);
  });

  it("cancels a pending leave when reactivated", () => {
    const { result, rerender } = renderHook(
      ({ active }) => useTransientVisibility(active, { minVisibleMs: 400, fadeMs: 180 }),
      { initialProps: { active: true } },
    );

    act(() => {
      rerender({ active: false });
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    act(() => {
      rerender({ active: true });
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.rendered).toBe(true);
    expect(result.current.leaving).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run frontends/components/workbench/messages/hooks/useTransientVisibility.test.ts`
Expected: FAIL —— 解析报错 "Failed to resolve import ./useTransientVisibility"（实现文件还没建）。

- [ ] **Step 3: 写最小实现**

写入 `frontends/components/workbench/messages/hooks/useTransientVisibility.ts`：

```ts
import { useEffect, useRef, useState } from "react";

interface TransientVisibility {
  /** 是否渲染该元素（含退出淡出阶段仍为 true）。 */
  rendered: boolean;
  /** 是否处于退出淡出阶段（供 data-state 切出场动画）。 */
  leaving: boolean;
}

interface Options {
  /** 一旦显示，至少停留这么久才允许进入退出（消除快加载一闪）。默认 400ms。 */
  minVisibleMs?: number;
  /** 退出淡出动画时长；这段时间后才真正卸载。默认 180ms。 */
  fadeMs?: number;
}

/**
 * 把"是否该显示"的布尔，转成带「最小展示时长 + 退出淡出」的渲染状态。
 *
 * - active 立即点亮 rendered；
 * - active 转 false：先补足 minVisibleMs（消除快加载一闪），再进入 leaving 持续
 *   fadeMs，最后卸载；
 * - 退出期间 active 再转 true：取消挂起的退出，回到常显。
 *
 * 纯计时、无数据副作用；最坏退化为"立即显隐"。
 */
export function useTransientVisibility(
  active: boolean,
  { minVisibleMs = 400, fadeMs = 180 }: Options = {},
): TransientVisibility {
  const [rendered, setRendered] = useState(active);
  const [leaving, setLeaving] = useState(false);
  const shownAtRef = useRef<number>(0);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // 显示：active 时在渲染期收敛点亮（React 官方「渲染期 setState」模式，React 丢弃当前渲染
  // 并立即重渲，条件收敛不死循环）。渲染期保持纯净，不调用 Date.now() 等不纯函数。
  if (active && !rendered) setRendered(true);
  if (active && leaving) setLeaving(false);

  // 记录"变为显示"的时刻：effect 可用不纯的 Date.now，且只写 ref、不 setState。
  useEffect(() => {
    if (active) shownAtRef.current = Date.now();
  }, [active]);

  // 隐藏：active 转 false 时排程「补足最小展示 → 淡出 → 卸载」。所有 setState 都在计时器
  // 回调里（异步，符合 react-hooks/set-state-in-effect）；effect 体内只做排程/清理。
  useEffect(() => {
    if (active || !rendered) {
      timersRef.current.forEach(clearTimeout);
      timersRef.current = [];
      return;
    }
    const elapsed = Date.now() - shownAtRef.current;
    const holdMs = Math.max(0, minVisibleMs - elapsed);
    const beginLeave = () => {
      setLeaving(true);
      timersRef.current.push(
        setTimeout(() => {
          setRendered(false);
          setLeaving(false);
        }, fadeMs),
      );
    };
    timersRef.current.push(setTimeout(beginLeave, holdMs));
    return () => {
      timersRef.current.forEach(clearTimeout);
      timersRef.current = [];
    };
  }, [active, rendered, minVisibleMs, fadeMs]);

  return { rendered, leaving };
}
```

> 实现说明：相较初版，为满足 `react-hooks/set-state-in-effect`（effect 体内禁同步 setState）与 `react-hooks/purity`（渲染期禁调 `Date.now()`），改为「渲染期收敛点亮 + effect 记录显示时刻 + 计时器回调里 setState」。行为契约与测试不变。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run frontends/components/workbench/messages/hooks/useTransientVisibility.test.ts`
Expected: PASS（3 个用例全绿）。

- [ ] **Step 5: 类型检查 + lint**

Run: `pnpm exec tsc --noEmit && pnpm lint`
Expected: 无报错。

- [ ] **Step 6: 提交**

```bash
git add frontends/components/workbench/messages/hooks/useTransientVisibility.ts frontends/components/workbench/messages/hooks/useTransientVisibility.test.ts
git commit -m "feat(messages): 新增 useTransientVisibility 计时 hook(最小展示+淡出)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: A1 — 翻历史 spinner 接入最小展示 + 淡入淡出

**Files:**

- Modify: `frontends/components/workbench/messages/ChatArea.tsx`

- [ ] **Step 1: 加 import**

在 ChatArea.tsx 顶部 import 区（与 `useScrollController` 同组，约 line 14 后）加：

```ts
import { useTransientVisibility } from "./hooks/useTransientVisibility";
```

- [ ] **Step 2: 组件体内计算 spinner 显示状态**

在 `useChatActions({...})` 调用之后、`return (` 之前，插入：

```tsx
// 翻历史 spinner:length>0 时的 loading 必是翻页加载(初次加载 length===0 走
// ChatLoadingState)。用 useTransientVisibility 给最小展示时长 + 淡入淡出,消除
// IPC 快时的一闪。
const historySpinnerActive =
  !error && localMessages.length > 0 && Boolean(loading) && hasMoreHistory;
const historySpinner = useTransientVisibility(historySpinnerActive, {
  minVisibleMs: 400,
  fadeMs: 180,
});
```

- [ ] **Step 3: 替换 spinner 渲染块**

把现有（约 line 206-210）：

```tsx
{
  /* 翻历史 spinner:length>0 时的 loading 必是翻页加载(初次加载 length===0 走
          ChatLoadingState 分支)。绝对定位顶部居中,不挤压消息流、不引发回弹位移。 */
}
{
  !error && localMessages.length > 0 && loading && hasMoreHistory && <HistoryLoadingIndicator />;
}
```

替换为：

```tsx
{
  /* 翻历史 spinner:显隐状态由 useTransientVisibility 托管(见上 historySpinner)。
          绝对定位顶部居中,不挤压消息流、不引发回弹位移。 */
}
{
  historySpinner.rendered && <HistoryLoadingIndicator leaving={historySpinner.leaving} />;
}
```

- [ ] **Step 4: 更新 HistoryLoadingIndicator 定义（接 leaving + data-state 切入/出动画）**

把现有 `HistoryLoadingIndicator`（约 line 395-411）整体替换为：

```tsx
const HistoryLoadingIndicator = memo(function HistoryLoadingIndicator({
  leaving,
}: {
  leaving: boolean;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-state={leaving ? "leaving" : "shown"}
      aria-label={STRINGS.status.loadingHistory}
      className={cn(
        "pointer-events-none absolute left-1/2 top-3 z-20 -translate-x-1/2",
        "inline-flex items-center gap-1.5 rounded-full border border-workbench-line bg-workbench-surface/95 px-2.5 py-1 text-wb-2xs font-medium text-workbench-text-secondary shadow-wb-popover backdrop-blur-md",
        "duration-200 data-[state=shown]:animate-in data-[state=shown]:fade-in data-[state=shown]:slide-in-from-top-1",
        "data-[state=leaving]:animate-out data-[state=leaving]:fade-out data-[state=leaving]:slide-out-to-top-1",
        "motion-reduce:animate-none",
      )}
    >
      <Loader2 size={13} className="shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />
      <span>{STRINGS.status.loadingHistory}</span>
    </div>
  );
});
```

- [ ] **Step 5: 类型检查 + lint + 现有测试**

Run: `pnpm exec tsc --noEmit && pnpm lint && pnpm exec vitest run frontends/components/workbench/messages/ChatArea.test.tsx`
Expected: 全绿。特别地 "uses a compact history-loading indicator" 用例仍通过（active=true → spinner 首帧即渲染，`getByRole("status", { name: "加载更早的消息" })` 命中；`.animate-pulse` 仍为 null）。

- [ ] **Step 6: 提交**

```bash
git add frontends/components/workbench/messages/ChatArea.tsx
git commit -m "feat(messages): 翻历史 spinner 加最小展示时长+淡入淡出,消一闪

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: A2 — 到顶 overscroll 回弹（WorkbenchScrollArea 默认关 prop）

**Files:**

- Modify: `frontends/components/workbench/messages/WorkbenchScrollArea.tsx`
- Modify: `frontends/components/workbench/messages/ChatArea.tsx`

- [ ] **Step 1: WorkbenchScrollArea props 加 overscrollBounce**

在 `WorkbenchScrollAreaProps` 接口里（`onWheelCapture?` 之后）加：

```ts
  /** 到顶继续上推时给一个极轻的 transform 回弹(不碰 scrollTop)。默认关,仅消息区开。 */
  overscrollBounce?: boolean;
```

并在组件参数解构里加入 `overscrollBounce`：

```tsx
export function WorkbenchScrollArea({
  children,
  className,
  viewportClassName,
  contentClassName,
  scrollRef,
  onScrollMetrics,
  onUserScroll,
  onWheelCapture,
  overscrollBounce,
}: WorkbenchScrollAreaProps) {
```

- [ ] **Step 2: 加 contentRef + 回弹 effect**

在组件体内（`const internalRef = useRef...` 之后）加：

```tsx
const contentRef = useRef<HTMLDivElement | null>(null);
```

在已有的 metrics effect（`useEffect(() => { ... }, [])`）之后，新增回弹 effect：

```tsx
// A2:到顶继续上推时给一个极轻的 overscroll 回弹(纯 transform,不碰 scrollTop/不破锚定)。
// 默认关,仅消息区开;reduce-motion 下整段禁用、不挂监听。
useEffect(() => {
  if (!overscrollBounce) return;
  const viewport = internalRef.current;
  const content = contentRef.current;
  if (!viewport || !content) return;
  const reduceMotion =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion) return;

  const MAX_PULL = 14; // 最大回弹位移(px)
  const DAMP = 0.28; // 阻尼:越界滚动量 → 位移
  const RELEASE_MS = 90; // 停止上推后多久开始回弹
  let offset = 0;
  let releaseTimer: ReturnType<typeof setTimeout> | null = null;

  const settle = () => {
    offset = 0;
    content.style.transition = "transform 220ms cubic-bezier(0.22, 1, 0.36, 1)";
    content.style.transform = "translateY(0px)";
  };

  const onWheel = (e: WheelEvent) => {
    // 仅"贴顶 + 继续上推"才回弹;其余交回原生滚动。
    if (e.deltaY >= 0 || viewport.scrollTop > 0) {
      if (offset !== 0) settle();
      return;
    }
    offset = Math.min(MAX_PULL, offset + -e.deltaY * DAMP);
    content.style.transition = "transform 0ms";
    content.style.transform = `translateY(${offset}px)`;
    if (releaseTimer) clearTimeout(releaseTimer);
    releaseTimer = setTimeout(settle, RELEASE_MS);
  };

  viewport.addEventListener("wheel", onWheel, { passive: true });
  return () => {
    viewport.removeEventListener("wheel", onWheel);
    if (releaseTimer) clearTimeout(releaseTimer);
    content.style.transition = "";
    content.style.transform = "";
  };
}, [overscrollBounce]);
```

- [ ] **Step 3: content 容器挂 ref**

把渲染里的内容容器（约 line 151）：

```tsx
<div className={contentClassName}>{children}</div>
```

改为：

```tsx
<div ref={contentRef} className={contentClassName}>
  {children}
</div>
```

- [ ] **Step 4: ChatArea 消息区开启 overscrollBounce**

在 ChatArea.tsx 的 `<WorkbenchScrollArea ...>`（约 line 177-185）属性里，`onWheelCapture={handleWheelCapture}` 之后加一行 `overscrollBounce`：

```tsx
          <WorkbenchScrollArea
            scrollRef={setScrollNode}
            onScrollMetrics={handleScrollMetrics}
            onUserScroll={handleUserScroll}
            onWheelCapture={handleWheelCapture}
            overscrollBounce
            className="flex-1 bg-workbench-surface"
            viewportClassName="overscroll-contain [overflow-anchor:none] bg-workbench-surface px-4 pt-5 pb-10 pr-6"
            contentClassName="flex w-full flex-col"
          >
```

- [ ] **Step 5: 类型检查 + lint + 受影响测试**

Run: `pnpm exec tsc --noEmit && pnpm lint && pnpm exec vitest run frontends/components/workbench/messages/WorkbenchScrollArea.test.tsx frontends/components/workbench/messages/ChatArea.test.tsx`
Expected: 全绿。`WorkbenchScrollArea.test`（不传 `overscrollBounce`）行为不变；ChatArea 渲染时回弹 effect 会挂 wheel 监听但 jsdom 不派发 wheel 事件，且 `matchMedia` 不存在时 guard 走 `typeof !== "function"` 分支不抛错。

- [ ] **Step 6: 提交**

```bash
git add frontends/components/workbench/messages/WorkbenchScrollArea.tsx frontends/components/workbench/messages/ChatArea.tsx
git commit -m "feat(messages): 到顶 overscroll 回弹(默认关,仅消息区;纯 transform 不破锚定)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 全量验证 + 真机手测清单

**Files:** 无（验证）

- [ ] **Step 1: 全量自动化**

Run: `pnpm exec tsc --noEmit && pnpm lint && pnpm test`
Expected: tsc/lint 无报错；`pnpm test` 全绿。若 `Sidebar.test.tsx` 出现 `getVersion()` 相关 console error，那是既有噪声、与本轮无关（不应是测试 fail）；本轮新增/改动文件相关测试必须全部 PASS。

- [ ] **Step 2: 真机手测（不可盲信已完成；建议 `pnpm tauri dev`）**

逐项确认并记录：

1. **A1**：在历史较多的会话里反复上滑到顶触发翻页 —— 快加载时 spinner 不一闪、进出有淡入淡出；慢加载时 spinner 稳定可见。
2. **A2**：到顶继续上推 —— 有极轻回弹、松手归零；系统开"减弱动态效果"(prefers-reduced-motion) 后回弹消失、spinner 也不再做进出动画。
3. **A3（回归验收）**：连续翻多页无累计漂移；加载中页面冻结后顺滑接回；失败消息的重发行、悬停时间戳显示正常（未被裁切）。

- [ ] **Step 3: 真机通过后收尾**

调用 superpowers:finishing-a-development-branch 决定合并/PR/清理。分支：`feat/messages-history-polish`。
若真机发现回弹手感过强/过弱，调 `WorkbenchScrollArea` 里的 `MAX_PULL`/`DAMP`/`RELEASE_MS` 三个常量即可，无需改结构。

---

## Self-Review

**Spec 覆盖：** A1 → Task 1+2；A2 → Task 3；A3 → Task 4 Step 2.3（验收点，无代码）；A4 → Task 2 Step 4（spinner `motion-reduce:animate-none`）+ Task 3 Step 2（reduce-motion 不挂监听）。性能项 B1/B2 已在 spec 判定不做，无对应任务（一致）。✓

**占位扫描：** 无 TBD/TODO；每个改代码的 step 都给了完整代码与精确命令。✓

**类型一致：** hook 名 `useTransientVisibility`、返回 `{ rendered, leaving }`、Options `{ minVisibleMs, fadeMs }` 在 Task 1 定义、Task 2 使用一致；`HistoryLoadingIndicator` 新增 `leaving: boolean` 与调用处 `leaving={historySpinner.leaving}` 一致；`overscrollBounce` prop 在 Task 3 定义并由 ChatArea 传入一致。✓
