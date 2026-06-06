// 消息页"首屏数据门"骨架占位。
//
// 用途:useRecentFriends.initialFetched=false 时(即本地 cache 还没读出来),
// MessagesPage 顶层短路渲染此骨架,避免 ChatArea/ConversationList/CustomerDetails
// 三个组件吃 MOCK 假数据先画一帧再被真数据覆盖造成的闪烁。
//
// 设计:
// - 容器结构与 MessagesPage 真实布局对齐(左列按真实列表同一比例公式定宽 + 右 flex-1),
//   避免数据到位后骨架→真组件树切换时再次发生 layout shift。
// - 颜色完全对齐 WorkbenchPanel 内的 bg-white 白底 + workbench-surface-subtle 灰块,
//   不引入任何会"消失"的装饰。
// - 仅 animate-pulse,不引 framer-motion / shimmer 等额外动画。

import { WorkbenchPanel } from "@/components/workbench/WorkbenchPanel";

import {
  CONVERSATION_LIST_DEFAULT_RATIO,
  CONVERSATION_LIST_DEFAULT_WIDTH,
  CONVERSATION_LIST_MAX_WIDTH,
  CONVERSATION_LIST_MIN_WIDTH,
} from "./constants";

// 左列骨架宽度:与真实列表挂载后的初次比例公式对齐 —— clamp(MIN, 0.21 × innerWidth, MAX)。
// 真实列表(MessagesPage)首帧即按记忆比例(默认 0.21)× innerWidth 再钳制重算宽度;骨架若用
// 定长 260 会在切到真组件时跳变,故此处用同一公式消除首屏 layout shift。骨架无 page/details
// 布局上限可参照,只取窗口级钳制(默认态、详情未开,与真实列表初次落点一致)。window 不可用
// (SSR)时回退到默认宽。
function computeListWidth(): number {
  if (typeof window === "undefined") return CONVERSATION_LIST_DEFAULT_WIDTH;
  const target = window.innerWidth * CONVERSATION_LIST_DEFAULT_RATIO;
  return Math.min(Math.max(target, CONVERSATION_LIST_MIN_WIDTH), CONVERSATION_LIST_MAX_WIDTH);
}

export function MessagesSkeleton() {
  const listWidth = computeListWidth();
  return (
    <WorkbenchPanel className="relative">
      <aside
        className="flex h-full shrink-0 flex-col border-r border-workbench-line bg-workbench-surface"
        style={{ width: listWidth }}
      >
        {/* Tabs / 搜索条占位 */}
        <div className="px-3 pb-2 pt-3">
          <div className="h-9 animate-pulse rounded-md bg-workbench-surface-subtle" />
        </div>
        <div className="flex gap-2 px-3 pb-2">
          <div className="h-7 w-14 animate-pulse rounded-md bg-workbench-surface-subtle" />
          <div className="h-7 w-14 animate-pulse rounded-md bg-workbench-surface-subtle" />
          <div className="h-7 w-14 animate-pulse rounded-md bg-workbench-surface-subtle" />
        </div>
        {/* 列表行占位 × 6 */}
        <div className="flex flex-col gap-1 px-2 pt-1">
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonRow key={i} />
          ))}
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 items-center justify-center bg-white">
        <span className="text-wb-2xs text-workbench-text-muted">加载中…</span>
      </div>
    </WorkbenchPanel>
  );
}

// 单条会话行骨架。首屏整页骨架与切账号时的列表骨架(ConversationList)共用,保证两处占位一致。
export function SkeletonRow() {
  return (
    <div className="grid grid-cols-[44px_minmax(0,1fr)] items-center gap-3 rounded-xl px-3 py-2">
      <div className="size-11 animate-pulse rounded-lg bg-workbench-surface-subtle" />
      <div className="flex flex-col gap-1.5">
        <div className="h-3 w-24 animate-pulse rounded bg-workbench-surface-subtle" />
        <div className="h-2.5 w-32 animate-pulse rounded bg-workbench-surface-subtle" />
        <div className="h-2.5 w-20 animate-pulse rounded bg-workbench-surface-subtle" />
      </div>
    </div>
  );
}
