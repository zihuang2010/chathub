import { memo, useState } from "react";
import { ChevronLeft, ChevronRight, Menu } from "lucide-react";

import { SyncStatusBadge } from "@/components/workbench/messages/SyncStatusBadge";
import { useHubSyncStatus } from "@/lib/data/useHubSyncStatus";
import { FROSTED_GLASS_STYLE, WORKBENCH_BLUE, WORKBENCH_NAV_TEXT } from "@/lib/theme";
import { cn } from "@/lib/utils";

import { NAV_ITEMS, type NavItem, type Section } from "./nav";

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
