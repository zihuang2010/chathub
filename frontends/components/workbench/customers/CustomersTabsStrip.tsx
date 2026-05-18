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
      className="flex min-w-0 items-center gap-5 overflow-x-auto px-3"
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
              "focus-ring relative inline-flex h-10 shrink-0 items-center gap-1.5 text-[12.5px] transition-colors",
              active
                ? "font-semibold text-workbench-text"
                : "text-workbench-text-secondary hover:text-workbench-text",
            )}
          >
            <span>{tab.label}</span>
            {/* 数字位宽预留到 5 位数(含千分位逗号,如 "99,999" = 6 字符);
                `text-left` 让数字紧贴 label,右侧预留宽度做成 tab 内的"占位",
                位数变化(0/30/100/1,234/99,999)时 tab 横向不再 reflow。
                `tabular-nums` 等宽数字,`inline-block` 让 `min-w` 生效。 */}
            <span
              className={cn(
                "wb-num inline-block min-w-[6ch] text-left text-[12.5px] tabular-nums",
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
