import { memo } from "react";
import { ChevronLeft, ChevronRight, Menu } from "lucide-react";

import { SyncStatusBadge } from "@/components/workbench/messages/SyncStatusBadge";
import { useHubSyncStatus } from "@/lib/data/useHubSyncStatus";
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
  // 全局 hub 同步状态 — 把原来挂在接待列表搜索框右侧的 SyncStatusBadge 搬到这里,
  // 让"在线 / 离线 / 对齐中" 在任意页面都可见。
  const sync = useHubSyncStatus();

  if (collapsed) {
    return (
      <div className="flex flex-col items-center px-2 pb-2 pt-3">
        <AvatarMark />
      </div>
    );
  }

  return (
    <div className="flex min-h-[58px] items-center gap-2.5 px-3 pb-2 pt-3">
      <AvatarMark />
      <div className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-[13px] font-semibold text-[#1F2937]">匠多多</span>
        {/* min-w-0 + max-w-full 让 badge 永远适配父容器宽度,超长用 truncate 兜底 */}
        <div className="mt-1 flex min-w-0">
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
          "pointer-events-none opacity-0",
          "hover:pointer-events-auto hover:opacity-100",
          "peer-hover:pointer-events-auto peer-hover:opacity-100",
          "focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#60A5FA]/35",
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
