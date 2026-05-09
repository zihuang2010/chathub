import { memo } from "react";

import { cn } from "@/lib/utils";

import { TAB_OPTIONS, type CustomerTab } from "./constants";

interface CustomersTabsStripProps {
  activeTab: CustomerTab;
  onTabChange: (tab: CustomerTab) => void;
  tabCounts: Record<CustomerTab, number>;
}

/**
 * 客户管理页顶部 KPI Tab 条。每 tab：label + 计数；活跃 tab 文字加粗 + 数字
 * 使用 accent 色 + 底部 2px 蓝色横线指示。计数在筛选状态下随 selectedAccountIds
 * 变化，但不响应搜索/标签/阶段 — 见 useCustomersFilters.tabCounts 注释。
 */
export const CustomersTabsStrip = memo(function CustomersTabsStrip({
  activeTab,
  onTabChange,
  tabCounts,
}: CustomersTabsStripProps) {
  return (
    <nav
      role="tablist"
      aria-label="客户视图"
      className="flex min-w-0 items-center gap-6 overflow-x-auto px-4"
    >
      {TAB_OPTIONS.map((tab) => {
        const active = tab.value === activeTab;
        const count = tabCounts[tab.value] ?? 0;
        return (
          <button
            key={tab.value}
            role="tab"
            type="button"
            aria-selected={active}
            onClick={() => onTabChange(tab.value)}
            className={cn(
              "focus-ring relative inline-flex h-12 shrink-0 items-center gap-2 text-[13px] transition-colors",
              active
                ? "font-semibold text-workbench-text"
                : "text-workbench-text-secondary hover:text-workbench-text",
            )}
          >
            <span>{tab.label}</span>
            <span
              className={cn(
                "wb-num text-[13px] tabular-nums",
                active ? "text-workbench-accent" : "text-workbench-text-muted",
              )}
            >
              {formatCount(count)}
            </span>
            {active && (
              <span
                aria-hidden
                className="absolute inset-x-0 bottom-0 h-[2px] rounded-t bg-workbench-accent"
              />
            )}
          </button>
        );
      })}
    </nav>
  );
});

function formatCount(n: number): string {
  if (n >= 1000) {
    return n.toLocaleString("en-US");
  }
  return `${n}`;
}
