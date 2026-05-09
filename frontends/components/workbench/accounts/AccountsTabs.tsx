import { memo } from "react";

import { cn } from "@/lib/utils";

import { TAB_OPTIONS, type TabValue } from "./constants";

interface AccountsTabsProps {
  activeTab: TabValue;
  onTabChange: (t: TabValue) => void;
  tabCounts: Record<TabValue, number>;
}

export const AccountsTabs = memo(function AccountsTabs({
  activeTab,
  onTabChange,
  tabCounts,
}: AccountsTabsProps) {
  return (
    <nav
      role="tablist"
      aria-label="账号状态"
      className="flex min-w-0 gap-4 overflow-x-auto border-b border-workbench-line px-4"
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
              "focus-ring relative flex h-10 shrink-0 items-center gap-1 px-1 text-[13px] transition-colors",
              active
                ? "font-semibold text-workbench-accent"
                : "text-workbench-text-secondary hover:text-workbench-text",
            )}
          >
            <span>{tab.label}</span>
            <span
              className={cn(
                "wb-num font-numeric text-[12px] tabular-nums",
                active ? "text-workbench-accent" : "text-workbench-text-muted",
              )}
            >
              ({count})
            </span>
            {active && (
              <span
                aria-hidden
                className="absolute inset-x-0 bottom-0 h-[2px] rounded-md bg-workbench-accent"
              />
            )}
          </button>
        );
      })}
    </nav>
  );
});
