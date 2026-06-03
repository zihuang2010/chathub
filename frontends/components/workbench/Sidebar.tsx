import { memo, useState, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { ChevronLeft, ChevronRight, LogOut, Menu, Trash2 } from "lucide-react";

import type { UserProfile } from "@/App";
import { DriftingWave } from "@/components/illustrations";
import { useCurrentProfile } from "@/lib/data/useCurrentProfile";
import { useHubSyncStatus } from "@/lib/data/useHubSyncStatus";
import type { HubConnectionState } from "@/lib/data/useResource";
import { isWindows } from "@/lib/platform";
import { FROSTED_GLASS_STYLE, WORKBENCH_BLUE, WORKBENCH_NAV_TEXT } from "@/lib/theme";
import { cn } from "@/lib/utils";

import { ClearHistoryConfirmDialog } from "./ClearHistoryConfirmDialog";
import { LogoutConfirmDialog } from "./LogoutConfirmDialog";
import { NAV_ITEMS, type NavItem, type Section } from "./nav";
import { UserMenu } from "./UserMenu";

// 头像回退底色 —— 贴主题的蓝色品牌渐变,作为左栏顶部的视觉锚点。
const AVATAR_GRADIENT = "linear-gradient(140deg, #6FA8F0 0%, #3E7BD6 100%)";

// 底部波浪 viewBox 高/宽 与无缝平移量。窄栏(144px)里要"丝滑大波澜",必须用超长波长:
// 周期 2560(viewBox 宽 1280 只露半个周期 → 同一时刻一道平缓大波,坡度低)。路径画到
// 2× 周期(5120)宽,配合 DriftingWave 平移 -2560 无缝循环。
const WAVE_BOTTOM = 240;
const WAVE_SHIFT = 2560;

// 生成宽周期波浪路径。crest=true 起手波峰,false 波谷,两层错相叠出层次。
function broadWavePath(baseline: number, amplitude: number, bottom: number, crest = true): string {
  const ctrl = crest ? baseline - amplitude : baseline + amplitude;
  return (
    `M0,${baseline} ` +
    `Q640,${ctrl} 1280,${baseline} T2560,${baseline} T3840,${baseline} T5120,${baseline} ` +
    `L5120,${bottom} L0,${bottom} Z`
  );
}

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
    case "rejected":
      // 鉴权被拒终态(verifyToken allowed=false / 会话失效):红点。回登录页由 TokenInvalid 链路驱动,
      // 此 badge 仅过渡展示;详细 reject 文案在接待列表 SyncStatusBadge 的 tooltip。
      return { label: "未登录", dot: "#EF4444", text: "#DC2626" };
    case "disconnected":
      return { label: "离线", dot: "#9CA3AF", text: "#6B7280" };
    case "connecting":
      return { label: "连接中", dot: "#F59E0B", text: "#B45309" };
    default:
      // null(还没拿到首条 hub:connection)→ 连接中;未知态(后端 drift)→ 当离线兜底(不误显在线/连接中)。
      return conn == null
        ? { label: "连接中", dot: "#F59E0B", text: "#B45309" }
        : { label: "离线", dot: "#9CA3AF", text: "#6B7280" };
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
        "relative flex h-full shrink-0 select-none flex-col overflow-visible rounded-bl-[10px] transition-[width] duration-200 ease-out",
        // Windows:工作台顶到 top-0(见 Workbench),左栏要盖在 z-100 顶栏左半之上——顶栏控件
        // 在右上角,左半只是空拖拽区,两者又共用同款毛玻璃,覆盖处无缝;这样头像才能露在顶部
        // 40px 内,补上"左上空白"。macOS 维持 z-10(顶栏整条在工作台之上,左栏不需上浮)。
        isWindows ? "z-[101]" : "z-10",
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
          {/* 始终占位(mt-1 + h-px + mb-1 ≈ 9px)且渐变常驻,仅以 opacity 跟随收/展淡入淡出:
              既保证收/展两态高度一致(下方导航不上跳),又避免分隔线在切换瞬间硬生生闪现。 */}
          <div
            aria-hidden
            className={cn(
              "mx-3 mb-1 mt-1 h-px bg-gradient-to-r from-transparent via-[#9DB6D8]/45 to-transparent transition-opacity duration-200 ease-out",
              collapsed ? "opacity-0" : "opacity-100",
            )}
          />
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
            {/* 「更多」即「账户菜单」触发器(关于 / 退出),菜单从按钮底部向右弹出。 */}
            <UserMenu>
              <button
                type="button"
                className="flex h-10 w-full items-center rounded-md transition-colors hover:bg-white/55 hover:text-[#1F2937]"
                style={{ color: WORKBENCH_NAV_TEXT }}
                aria-label="更多"
              >
                <span className="grid w-12 shrink-0 place-items-center">
                  <Menu size={18} />
                </span>
                <span
                  className={cn(
                    "truncate text-[13.5px] font-medium transition-opacity duration-150 ease-out",
                    collapsed ? "opacity-0" : "opacity-100",
                  )}
                >
                  更多
                </span>
              </button>
            </UserMenu>
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
      {/* 装饰层:渐变之上、内容之下。常驻挂载,仅以 opacity 跟随收/展淡入淡出 ——
          收缩时不再"硬切消失"造成闪烁,而是与宽度动画(200ms)同步柔和淡出。 */}
      <div
        className={cn(
          "absolute inset-0 transition-opacity duration-200 ease-out",
          collapsed ? "opacity-0" : "opacity-100",
        )}
      >
        {/* 中下部空白区的 5 颗低调装饰圈点(底部锚定,浮在波浪之上),大小/位置/相位
            各异,chSidebarHaloA/B/C 缓慢漂移营造呼吸感;prefers-reduced-motion 下由
            index.css 自动静止为纯色背景。 */}
        <span
          className="absolute bottom-[300px] right-7 size-3 rounded-full bg-[#9FBDE6]/40"
          style={{ animation: "chSidebarHaloB 28s ease-in-out infinite" }}
        />
        <span
          className="absolute bottom-[252px] left-9 size-4 rounded-full bg-[#A9C7F0]/35"
          style={{ animation: "chSidebarHaloC 32s ease-in-out infinite" }}
        />
        <span
          className="absolute bottom-[372px] right-10 size-2.5 rounded-full bg-[#B8D2F4]/40"
          style={{ animation: "chSidebarHaloA 24s ease-in-out infinite" }}
        />
        <span
          className="absolute bottom-[212px] right-12 size-1.5 rounded-full bg-white/55"
          style={{ animation: "chSidebarHaloC 36s ease-in-out infinite" }}
        />
        <span className="absolute bottom-[340px] left-12 size-2 rounded-full bg-white/55" />
        {/* 底部柔光波浪,托在"更多"上方给左栏一个底部重心。超长波长 → 平缓大波澜,
            两层反向错相缓慢漂移。波幅收敛、铺得更低,整体更含蓄。 */}
        <svg
          className="absolute inset-x-0 bottom-0 h-56 w-full"
          viewBox={`0 0 1280 ${WAVE_BOTTOM}`}
          preserveAspectRatio="none"
        >
          <DriftingWave
            d={broadWavePath(132, 64, WAVE_BOTTOM, true)}
            fill="#7BA7E0"
            opacity={0.16}
            dur="32s"
            shift={WAVE_SHIFT}
          />
          <DriftingWave
            d={broadWavePath(164, 50, WAVE_BOTTOM, false)}
            fill="#638CCD"
            opacity={0.12}
            dur="24s"
            shift={WAVE_SHIFT}
          />
        </svg>
      </div>
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

  // 单一布局:头像恒定居左(px-2.5 → 头像中心 32px,与导航图标左槽中心对齐),收/展
  // 两态零位移;名称/状态常驻挂载,仅以 opacity 淡入淡出 —— 收缩时不再整树替换造成跳动。
  return (
    <div className="flex items-end px-2.5 pb-1 pt-4">
      {/* 头像即「个人信息」触发器,点击在右侧弹出个人信息卡片。button 仅作触发壳,不改
          AvatarMark 视觉:套同款 rounded-lg + focus-ring,hover 轻微放大提示可点击。收/展两态都可用。 */}
      <ProfilePopover profile={profile} status={status}>
        <button
          type="button"
          aria-label="个人信息"
          className="focus-ring shrink-0 rounded-lg transition-transform duration-150 hover:scale-[1.04] active:scale-95"
        >
          <AvatarMark avatarUrl={profile?.avatar_url} displayName={name} />
        </button>
      </ProfilePopover>
      <div
        className={cn(
          "ml-2.5 flex min-w-0 flex-1 flex-col gap-1.5 leading-tight transition-opacity duration-150 ease-out",
          collapsed ? "opacity-0" : "opacity-100",
        )}
      >
        <span className="truncate text-[14px] font-semibold text-[#1F2937]">{name}</span>
        <span className="flex items-center gap-1.5">
          <span className="size-[7px] shrink-0 rounded-full" style={{ background: status.dot }} />
          {/* whitespace-nowrap 是纵向不跳动的关键:收缩态文字块被挤到 ~0 宽,若状态文字
              换行就会把整个顶部区撑高,从而把下方导航图标推下去(展开复原又收回)。 */}
          <span
            className="whitespace-nowrap text-[11px] font-medium"
            style={{ color: status.text }}
          >
            {status.label}
          </span>
        </span>
      </div>
    </div>
  );
}

// ─── 个人信息卡片 ─────────────────────────────────────────────────────────────

// 点头像在右侧弹出的个人信息卡。字段取自 UserProfile(标题=display_name 即 nickName;
// 用户名/手机号/账号),在线状态复用 UserBadge 已派生的 status。底部「清除聊天记录」「退出
// 登录」分别复用 ClearHistoryConfirmDialog / LogoutConfirmDialog —— 确认弹窗渲染在 Popover
// 之外,避免点按钮时弹层关闭把弹窗一起卸载。
function ProfilePopover({
  profile,
  status,
  children,
}: {
  profile: UserProfile | null;
  status: ReturnType<typeof onlineStatus>;
  children: ReactNode;
}) {
  const name = profile?.display_name ?? "";
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);

  return (
    <>
      <Popover.Root>
        <Popover.Trigger asChild>{children}</Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            side="right"
            align="start"
            sideOffset={10}
            collisionPadding={12}
            className="z-[120] w-64 rounded-xl border border-workbench-line bg-workbench-surface p-4 shadow-wb-popover-strong outline-none"
          >
            <div className="flex items-center gap-3">
              <AvatarMark avatarUrl={profile?.avatar_url} displayName={name} />
              <div className="flex min-w-0 flex-col gap-1">
                <span className="truncate text-[15px] font-semibold text-workbench-text">
                  {name || "未登录"}
                </span>
                <span className="flex items-center gap-1.5">
                  <span
                    className="size-[7px] shrink-0 rounded-full"
                    style={{ background: status.dot }}
                  />
                  <span className="text-[11px] font-medium" style={{ color: status.text }}>
                    {status.label}
                  </span>
                </span>
              </div>
            </div>
            <div aria-hidden className="my-3 h-px bg-workbench-line" />
            <dl className="flex flex-col gap-2.5 text-[12.5px]">
              <ProfileRow label="用户名" value={profile?.username} />
              <ProfileRow label="手机号" value={profile?.mobile} />
              <ProfileRow label="账号" value={profile?.user_id} />
            </dl>
            <div aria-hidden className="my-3 h-px bg-workbench-line" />
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => setClearOpen(true)}
                className="focus-ring flex w-full items-center justify-center gap-1.5 rounded-lg border border-workbench-line py-2 text-[13px] font-medium text-workbench-text-muted transition-colors hover:bg-workbench-surface-subtle"
              >
                <Trash2 size={14} />
                清除聊天记录
              </button>
              <button
                type="button"
                onClick={() => setLogoutOpen(true)}
                className="focus-ring flex w-full items-center justify-center gap-1.5 rounded-lg border border-workbench-line py-2 text-[13px] font-medium text-workbench-danger transition-colors hover:bg-workbench-danger/10"
              >
                <LogOut size={14} />
                退出登录
              </button>
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <ClearHistoryConfirmDialog open={clearOpen} onClose={() => setClearOpen(false)} />
      <LogoutConfirmDialog open={logoutOpen} onClose={() => setLogoutOpen(false)} />
    </>
  );
}

function ProfileRow({ label, value }: { label: string; value?: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="shrink-0 text-workbench-text-muted">{label}</dt>
      <dd className="truncate text-right font-medium text-workbench-text">{value || "—"}</dd>
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
        className="size-11 shrink-0 rounded-lg object-cover shadow-[0_4px_10px_rgba(62,123,214,0.28)]"
      />
    );
  }

  return (
    <div
      className="relative grid size-11 shrink-0 place-items-center overflow-hidden rounded-lg text-[16px] font-semibold text-white shadow-[0_4px_10px_rgba(62,123,214,0.28)]"
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
        "relative flex h-10 w-full items-center rounded-md transition-colors",
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
      {/* 图标恒定居于 48px 左槽中心(收/展两态像素一致),收缩时图标"零位移",只让标签
          淡入淡出 —— 这是丝滑的关键:消除 justify-center↔px 切换造成的图标横向瞬移。 */}
      <span className="grid w-12 shrink-0 place-items-center">
        <item.Icon size={18} strokeWidth={1.8} />
      </span>
      <span
        className={cn(
          "truncate text-[13.5px] font-medium transition-opacity duration-150 ease-out",
          collapsed ? "opacity-0" : "opacity-100",
        )}
      >
        {item.label}
      </span>
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
