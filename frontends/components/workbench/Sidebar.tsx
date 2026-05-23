import { memo, useState } from "react";
import { ChevronLeft, ChevronRight, Menu } from "lucide-react";

import { DriftingWave, buildWavePath } from "@/components/illustrations";
import { useCurrentProfile } from "@/lib/data/useCurrentProfile";
import { useHubSyncStatus } from "@/lib/data/useHubSyncStatus";
import type { HubConnectionState } from "@/lib/data/useResource";
import { FROSTED_GLASS_STYLE, WORKBENCH_BLUE, WORKBENCH_NAV_TEXT } from "@/lib/theme";
import { cn } from "@/lib/utils";

import { NAV_ITEMS, type NavItem, type Section } from "./nav";

// 头像回退底色 —— 贴主题的蓝色品牌渐变,作为左栏顶部的视觉锚点。
const AVATAR_GRADIENT = "linear-gradient(140deg, #6FA8F0 0%, #3E7BD6 100%)";

// 底部波浪 viewBox 高度。复用 Splash 的无缝漂移方案(buildWavePath 生成 2× 宽路径,
// DriftingWave 平移 -1280 无缝循环);viewBox 宽固定 1280,preserveAspectRatio=none 拉伸进窄栏。
const WAVE_BOTTOM = 240;

// 取首个字符作头像回退;用展开运算符正确处理多字节字符(CJK/emoji)。
function initialOf(name: string | undefined): string {
  const trimmed = name?.trim();
  return trimmed ? [...trimmed][0] : "·";
}

// 在线状态由 hub 连接态派生:在线绿 / 连接中琥珀 / 离线灰。不写死。
function onlineStatus(conn: HubConnectionState | null): {
  label: string;
  dot: string;
  text: string;
} {
  switch (conn?.state) {
    case "subscribed":
      return { label: "在线", dot: "#10B981", text: "#0E9F6E" };
    case "disconnected":
      return { label: "离线", dot: "#9CA3AF", text: "#6B7280" };
    default:
      // connecting 或 null(还没拿到首条 hub:connection)
      return { label: "连接中", dot: "#F59E0B", text: "#B45309" };
  }
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
        {/* 渐变层 + 装饰层,垫在内容之下,营造层次/重心/呼吸感。 */}
        <SidebarBackdrop collapsed={collapsed} />
        <div className="relative z-10 flex flex-1 flex-col">
          <UserBadge collapsed={collapsed} />
          {!collapsed && (
            // 徽章与导航之间的渐隐分隔线 —— 制造层次,不抢镜。
            <div
              aria-hidden
              className="mx-3 mb-1 mt-1 h-px bg-gradient-to-r from-transparent via-[#9DB6D8]/45 to-transparent"
            />
          )}
          <nav className="flex flex-col gap-0.5 px-2 pt-1">
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
                "flex h-10 w-full items-center rounded-md transition-colors hover:bg-white/55 hover:text-[#1F2937]",
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
      </div>
      <EdgeHandle collapsed={collapsed} onToggle={onToggleCollapsed} />
    </aside>
  );
});

// ─── Backdrop: 渐变 + 装饰圈点 + 底部波浪 ─────────────────────────────────────

function SidebarBackdrop({ collapsed }: { collapsed: boolean }) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
      {/* 竖向渐变。顶端 0% 必须为完全透明 —— 否则与上方 TitleBar(纯 FROSTED_GLASS)
          在 y=40 交界处产生色差带(这正是之前"颜色不统一"的根因)。冷白只在边沿下方
          晕开,底部偏蓝增加纵深。 */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.26) 15%, rgba(255,255,255,0) 45%, rgba(99,140,205,0.18) 100%)",
        }}
      />
      {/* 装饰只在展开态出现,折叠态保持干净。 */}
      {!collapsed && (
        <>
          {/* 缓慢漂移的装饰圈点。chSidebarHalo* 周期各异(24/28/32s)避免可见循环;
              prefers-reduced-motion 下由 index.css 自动静止为纯色背景。 */}
          <span className="absolute right-3 top-2 size-2 rounded-full bg-white/60" />
          <span
            className="absolute left-4 top-7 size-7 rounded-full border border-[#9FBDE6]/45"
            style={{ animation: "chSidebarHaloA 24s ease-in-out infinite" }}
          />
          <span
            className="absolute right-5 top-[60px] size-2.5 rounded-full bg-[#9FBDE6]/40"
            style={{ animation: "chSidebarHaloB 28s ease-in-out infinite" }}
          />
          <span
            className="absolute left-7 top-[128px] size-4 rounded-full bg-[#A9C7F0]/35"
            style={{ animation: "chSidebarHaloC 32s ease-in-out infinite" }}
          />
          {/* 底部柔光波浪,托在"更多"上方给左栏一个底部重心。两层反向缓慢漂移。 */}
          <svg
            className="absolute inset-x-0 bottom-0 h-40 w-full"
            viewBox={`0 0 1280 ${WAVE_BOTTOM}`}
            preserveAspectRatio="none"
          >
            <DriftingWave
              d={buildWavePath(112, 46, WAVE_BOTTOM)}
              fill="#7BA7E0"
              opacity={0.16}
              dur="30s"
            />
            <DriftingWave
              d={buildWavePath(158, 36, WAVE_BOTTOM)}
              fill="#638CCD"
              opacity={0.12}
              dur="22s"
            />
          </svg>
        </>
      )}
    </div>
  );
}

// ─── User badge ─────────────────────────────────────────────────────────────

function UserBadge({ collapsed }: { collapsed: boolean }) {
  // 登录员工信息(头像/姓名)+ hub 连接态(派生在线状态)。两者都在组件内部自取,
  // Sidebar/Workbench 无需透传 props。
  const profile = useCurrentProfile();
  const sync = useHubSyncStatus();

  const name = profile?.display_name ?? "";
  const status = onlineStatus(sync.connectionState);

  if (collapsed) {
    return (
      <div className="flex flex-col items-center px-2 pb-2 pt-3">
        <AvatarMark avatarUrl={profile?.avatar_url} displayName={name} />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2.5 px-3 pb-1 pt-4">
      <AvatarMark avatarUrl={profile?.avatar_url} displayName={name} />
      <div className="flex min-w-0 flex-1 flex-col gap-1 leading-tight">
        <span className="truncate text-[14px] font-semibold text-[#1F2937]">{name}</span>
        <span className="flex items-center gap-1.5">
          <span className="size-[7px] shrink-0 rounded-full" style={{ background: status.dot }} />
          <span className="text-[11px] font-medium" style={{ color: status.text }}>
            {status.label}
          </span>
        </span>
      </div>
    </div>
  );
}

function AvatarMark({ avatarUrl, displayName }: { avatarUrl?: string; displayName?: string }) {
  // 存储"导致失败的那个 url"，avatarUrl 变化时失败态自动失效，无需 useEffect。
  const [failedUrl, setFailedUrl] = useState<string | undefined>(undefined);
  const showImg = !!avatarUrl && avatarUrl !== failedUrl;

  if (showImg) {
    return (
      <img
        src={avatarUrl}
        alt=""
        onError={() => setFailedUrl(avatarUrl)}
        className="size-11 shrink-0 rounded-[14px] object-cover shadow-[0_4px_10px_rgba(62,123,214,0.28)]"
      />
    );
  }

  return (
    <div
      className="relative grid size-11 shrink-0 place-items-center overflow-hidden rounded-[14px] text-[16px] font-semibold text-white shadow-[0_4px_10px_rgba(62,123,214,0.28)]"
      style={{ background: AVATAR_GRADIENT }}
    >
      {/* 顶部高光,增加立体感/高级感。 */}
      <span
        aria-hidden
        className="absolute inset-x-0 top-0 h-1/2"
        style={{
          background: "linear-gradient(180deg, rgba(255,255,255,0.28), rgba(255,255,255,0))",
        }}
      />
      <span className="relative">{initialOf(displayName)}</span>
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
