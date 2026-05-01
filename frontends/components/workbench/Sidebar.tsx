import { memo } from "react";
import { ChevronDown, Menu } from "lucide-react";

import { cn } from "@/lib/utils";
import { BLUE_GRADIENT, WORKBENCH_SIDEBAR_BG } from "@/lib/theme";

import { NAV_ITEMS, type NavItem, type Section } from "./nav";

interface SidebarProps {
  value: Section;
  onChange: (s: Section) => void;
}

export const Sidebar = memo(function Sidebar({ value, onChange }: SidebarProps) {
  return (
    <aside
      className="flex h-full w-[160px] shrink-0 select-none flex-col"
      style={{ background: WORKBENCH_SIDEBAR_BG }}
    >
      <UserBadge />
      <nav className="flex flex-col gap-0.5 px-2 pt-2">
        {NAV_ITEMS.map((item) => (
          <NavButton
            key={item.value}
            item={item}
            active={item.value === value}
            onClick={() => onChange(item.value)}
          />
        ))}
      </nav>
      <div className="mt-auto px-2 pb-3 pt-2">
        <button
          type="button"
          className="flex h-10 w-full items-center gap-3 rounded-md px-3 text-[#3B5174] transition-colors hover:bg-white/55 hover:text-[#1F2937]"
          aria-label="更多"
        >
          <Menu size={18} />
          <span className="text-[13.5px]">更多</span>
        </button>
      </div>
    </aside>
  );
});

// ─── User badge ─────────────────────────────────────────────────────────────

function UserBadge() {
  return (
    <div className="flex items-center gap-2.5 px-3 pb-3 pt-3">
      <div className="relative shrink-0">
        <div
          className="grid size-9 place-items-center rounded-full text-[14px] font-medium text-[#1F2937] shadow-sm"
          style={{ background: "#FCE7B8" }}
        >
          M
        </div>
        <span
          aria-hidden
          className="absolute bottom-[-2px] right-[-2px] size-[10px] rounded-full border-2 border-[#E8F0FE] bg-[#10B981]"
        />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 leading-tight">
        <span className="truncate text-[13px] font-semibold text-[#1F2937]">匠多多</span>
        <span
          className="inline-flex w-fit items-center rounded-full px-1.5 py-px text-[10px] font-semibold tracking-wide text-white shadow-sm"
          style={{ background: BLUE_GRADIENT }}
        >
          专业版
        </span>
      </div>
      <ChevronDown size={13} className="shrink-0 text-[#5A6B83]" />
    </div>
  );
}

// ─── Nav button ─────────────────────────────────────────────────────────────

function NavButton({
  item,
  active,
  onClick,
}: {
  item: NavItem;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-10 items-center gap-3 rounded-md px-3 transition-colors",
        active
          ? "bg-white text-[#2563EB] shadow-sm"
          : "text-[#3B5174] hover:bg-white/55 hover:text-[#1F2937]",
      )}
      aria-pressed={active}
      aria-label={item.label}
    >
      <item.Icon size={18} strokeWidth={1.8} />
      <span className="text-[13.5px] font-medium">{item.label}</span>
      {item.badge !== undefined && item.badge > 0 && (
        <span
          aria-hidden
          className="ml-auto grid h-[17px] min-w-[17px] place-items-center rounded-full bg-[#EF4444] px-1 text-[10.5px] font-semibold leading-none text-white"
        >
          {item.badge > 99 ? "99+" : item.badge}
        </span>
      )}
    </button>
  );
}
