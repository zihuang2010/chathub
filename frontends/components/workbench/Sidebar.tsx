import { memo } from "react";
import { ChevronLeft, ChevronRight, Menu } from "lucide-react";

import { cn } from "@/lib/utils";
import { WORKBENCH_BLUE, WORKBENCH_NAV_TEXT, WORKBENCH_SIDEBAR_BG } from "@/lib/theme";

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
        "flex h-full shrink-0 select-none flex-col transition-[width] duration-200 ease-out",
        collapsed ? "w-16" : "w-36",
      )}
      style={{ background: WORKBENCH_SIDEBAR_BG }}
    >
      <UserBadge collapsed={collapsed} onToggleCollapsed={onToggleCollapsed} />
      <nav className={cn("flex flex-col gap-0.5 pt-2", collapsed ? "px-2" : "px-2")}>
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
          {!collapsed && <span className="text-[13.5px]">更多</span>}
        </button>
      </div>
    </aside>
  );
});

// ─── User badge ─────────────────────────────────────────────────────────────

function UserBadge({
  collapsed,
  onToggleCollapsed,
}: {
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-2 px-2 pb-2 pt-3">
        <AvatarMark />
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="grid size-8 place-items-center rounded-md text-[#4B6284] transition-colors hover:bg-white/45 hover:text-[#1F2937] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#60A5FA]/35"
          aria-label="展开侧边栏"
          aria-expanded={false}
        >
          <ChevronRight size={16} />
        </button>
      </div>
    );
  }

  return (
    <div className="flex min-h-[58px] items-center gap-2.5 px-3 pb-2 pt-3">
      <AvatarMark />
      <div className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-[13px] font-semibold text-[#1F2937]">匠多多</span>
      </div>
      <button
        type="button"
        onClick={onToggleCollapsed}
        className="grid size-7 shrink-0 place-items-center rounded-md text-[#4B6284] transition-colors hover:bg-white/60 hover:text-[#1F2937] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#60A5FA]/35"
        aria-label="收起侧边栏"
        aria-expanded={true}
      >
        <ChevronLeft size={14} />
      </button>
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
