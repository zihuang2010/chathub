// 消息页"首屏数据门"骨架占位。
//
// 用途:useRecentFriends.initialFetched=false 时(即本地 cache 还没读出来),
// MessagesPage 顶层短路渲染此骨架,避免 ChatArea/ConversationList/CustomerDetails
// 三个组件吃 MOCK 假数据先画一帧再被真数据覆盖造成的闪烁。
//
// 设计:
// - 容器结构与 MessagesPage 真实布局对齐(左 320px + 右 flex-1),避免数据到位后
//   骨架→真组件树切换时再次发生 layout shift。
// - 颜色完全对齐 WorkbenchPanel 内的 bg-white 白底 + workbench-surface-subtle 灰块,
//   不引入任何会"消失"的装饰。
// - 仅 animate-pulse,不引 framer-motion / shimmer 等额外动画。

import { WorkbenchPanel } from "@/components/workbench/WorkbenchPanel";

import { CONVERSATION_LIST_DEFAULT_WIDTH } from "./constants";

export function MessagesSkeleton() {
  return (
    <WorkbenchPanel className="relative">
      <aside
        className="flex h-full shrink-0 flex-col border-r border-workbench-line bg-workbench-surface"
        style={{ width: CONVERSATION_LIST_DEFAULT_WIDTH }}
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

function SkeletonRow() {
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
