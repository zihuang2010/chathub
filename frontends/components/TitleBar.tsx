import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { detectWindows11, isMac } from "@/lib/platform";
import { FROSTED_GLASS_STYLE } from "@/lib/theme";
import { cn } from "@/lib/utils";

type Tone = "transparent" | "blue";

interface TitleBarProps {
  tone?: Tone;
}

interface WindowControls {
  maximized: boolean;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  onClose: () => void;
}

export function TitleBar({ tone = "transparent" }: TitleBarProps) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    const setup = async () => {
      const win = getCurrentWindow();
      const initial = await win.isMaximized();
      if (!cancelled) setMaximized(initial);
      if (cancelled) return;
      const un = await win.onResized(async () => {
        const next = await win.isMaximized();
        if (!cancelled) setMaximized(next);
      });
      if (cancelled) {
        un();
        return;
      }
      unlisten = un;
    };
    setup().catch(() => {
      // Outside a Tauri runtime (plain Vite dev server) the API throws —
      // ignore so the component still renders for design preview.
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // 把最大化状态镜像到 <html data-maximized>:Windows 透明窗口的圆角壳/8px 边距/阴影
  // (index.css)在最大化时必须撤掉,否则屏幕四周露缝。mac 的 zoom 行为维持原样不受影响
  // (CSS 选择器只对 windows 加了 :not([data-maximized="true"]) 条件)。
  useEffect(() => {
    document.documentElement.dataset.maximized = String(maximized);
  }, [maximized]);

  const safeWindow = () => {
    try {
      return getCurrentWindow();
    } catch {
      return null;
    }
  };

  const controls: WindowControls = {
    maximized,
    onMinimize: () => void safeWindow()?.minimize(),
    onToggleMaximize: () => void safeWindow()?.toggleMaximize(),
    onClose: () => void safeWindow()?.close(),
  };

  return isMac ? (
    <MacTitleBar controls={controls} tone={tone} />
  ) : (
    <WindowsTitleBar controls={controls} tone={tone} />
  );
}

// ─── Ambient backdrop: four small drifting orbs ──────────────────────────────

// 顶栏只有 40px 高,在右侧拖拽区散放 4 颗小气泡(与左栏同套配色,按远近分层:远层略深蓝、
// 近层近白、整体偏小且清晰不糊),轻柔 2D 漂浮营造"动态"。pointer-events-none + aria-hidden 保证不挡拖拽区与窗口按钮
// (它们以 relative z-10 绘制在其上);仅毛玻璃态渲染,避免 splash 透明态露出圆。
// prefers-reduced-motion 下由 index.css 自动静止为纯色圆点。
//
// 关键约束:顶栏毛玻璃叠在 #F1F5F9 上算出的颜色 ≈ #E2EDF8,正是下方 WorkbenchPanel
// 外层底色 —— 二者刻意一致才让"顶栏↔内容"无缝。气泡都贴顶摆放、不触 40px 底边,底部
// 再加一道轻渐隐兜底,保证底边那条恒为纯 #E2EDF8,不复现色差缝。气泡集中在右侧、避开
// 左侧交通灯。
function TitleBarBackdrop({ visible, rounded = false }: { visible: boolean; rounded?: boolean }) {
  if (!visible) return null;
  const fadeMask = "linear-gradient(to bottom, #000 80%, transparent 98%)";
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-0 z-0 overflow-hidden",
        rounded && "rounded-t-[10px]",
      )}
      style={{ maskImage: fadeMask, WebkitMaskImage: fadeMask }}
    >
      {/* 顶栏气泡精简为 4 颗,与左栏共用同一套配色/尺寸,清晰不糊(无柔焦):
          近=近白小 / 中=中蓝 #9FBDE6 / 远=略深蓝 #8AB0E6、稍大。 */}
      {/* 近层(near)。 */}
      <span
        className="absolute left-[30%] top-[8px] size-[9px] rounded-full bg-white/85"
        style={{ animation: "chTitleOrbA 22s ease-in-out infinite" }}
      />
      {/* 远层(far):略深蓝、稍大 —— 沉在最后。 */}
      <span
        className="absolute left-[50%] top-[7px] size-[11px] rounded-full bg-[#8AB0E6]/50"
        style={{ animation: "chTitleOrbB 26s ease-in-out infinite" }}
      />
      {/* 中层(mid)。 */}
      <span
        className="absolute left-[68%] top-[16px] size-[8px] rounded-full bg-[#9FBDE6]/55"
        style={{ animation: "chTitleOrbC 21s ease-in-out infinite" }}
      />
      {/* 近层(near):最小。 */}
      <span
        className="absolute right-[9%] top-[12px] size-[7px] rounded-full bg-white/80"
        style={{ animation: "chTitleOrbA 24s ease-in-out infinite" }}
      />
    </div>
  );
}

// ─── macOS layout ───────────────────────────────────────────────────────────

function MacTitleBar({ controls, tone }: { controls: WindowControls; tone: Tone }) {
  const blurred = tone === "blue";
  return (
    <header
      className="absolute inset-x-0 top-0 z-[100] flex h-10 select-none items-center rounded-t-[10px]"
      style={{
        WebkitUserSelect: "none",
        // 200ms 颜色过渡 —— 避免 splash 收尾瞬间 transparent → frosted 顿变。
        // backdrop-filter 浏览器对 transition 支持不一,但在 transparent → blur 切换
        // 期间和 background 同步生效,体感是"整体淡入"。
        transition: "background-color 200ms ease-out",
        // 与 Sidebar 共用 FROSTED_GLASS_STYLE，保证两者像素级一致——色差带的
        // 排查史在 plans 文件里。圆角在此处是因为 backdrop-filter 自带 stacking
        // context，不总能遵守祖先的 border-radius。
        ...(blurred ? FROSTED_GLASS_STYLE : { background: "transparent" }),
      }}
    >
      <TitleBarBackdrop visible={blurred} rounded />
      <div className="group relative z-10 flex items-center gap-[8px] pl-[14px]">
        <TrafficLight color="#ff5f57" symbol="×" ariaLabel="关闭" onClick={controls.onClose} />
        <TrafficLight color="#ffbd2e" symbol="–" ariaLabel="最小化" onClick={controls.onMinimize} />
        <TrafficLight
          color="#28c840"
          symbol={controls.maximized ? "↙" : "↗"}
          ariaLabel={controls.maximized ? "还原" : "最大化"}
          onClick={controls.onToggleMaximize}
        />
      </div>
      <div data-tauri-drag-region className="h-full flex-1" aria-hidden />
    </header>
  );
}

interface TrafficLightProps {
  color: string;
  symbol: string;
  ariaLabel: string;
  onClick: () => void;
}

function TrafficLight({ color, symbol, ariaLabel, onClick }: TrafficLightProps) {
  return (
    <button
      type="button"
      data-tauri-drag-region="false"
      aria-label={ariaLabel}
      title={ariaLabel}
      onClick={onClick}
      className="grid h-[12px] w-[12px] place-items-center rounded-full transition-[filter] hover:brightness-95 active:brightness-90"
      style={{
        background: color,
        boxShadow: "inset 0 0 0 0.5px rgba(0, 0, 0, 0.18), 0 1px 1.5px rgba(0, 0, 0, 0.12)",
      }}
    >
      <span
        aria-hidden
        className="block text-[8.5px] font-bold leading-none opacity-0 transition-opacity duration-100 group-hover:opacity-100"
        style={{ color: "rgba(0, 0, 0, 0.55)", transform: "translateY(-0.5px)" }}
      >
        {symbol}
      </span>
    </button>
  );
}

// ─── Windows / Linux layout ─────────────────────────────────────────────────

function WindowsTitleBar({ controls, tone }: { controls: WindowControls; tone: Tone }) {
  const blurred = tone === "blue";
  // 关闭按钮 hover 红区分系统版本:Win10 #e81123(亮)/ Win11 #c42b1c(暗)。
  // 检测异步返回(几毫秒,远早于用户 hover),默认 false 即先按 Win10 取值。
  // 两个字面量都静态出现在源码里,保证 Tailwind JIT 都能生成对应类。
  const [isWin11, setIsWin11] = useState(false);
  useEffect(() => {
    let alive = true;
    void detectWindows11().then((v) => {
      if (alive) setIsWin11(v);
    });
    return () => {
      alive = false;
    };
  }, []);
  const closeHover = isWin11 ? "hover:bg-[#c42b1c]" : "hover:bg-[#e81123]";
  return (
    <header
      className="absolute inset-x-0 top-0 z-[100] flex h-10 select-none items-center justify-between"
      style={{
        WebkitUserSelect: "none",
        ...(blurred ? FROSTED_GLASS_STYLE : { background: "transparent" }),
      }}
    >
      <TitleBarBackdrop visible={blurred} />
      <div data-tauri-drag-region className="relative z-10 h-full flex-1" aria-hidden />
      <div className="relative z-10 flex h-full items-stretch">
        <ControlButton onClick={controls.onMinimize} aria-label="最小化" title="最小化">
          <MinimizeIcon />
        </ControlButton>
        <ControlButton
          onClick={controls.onToggleMaximize}
          aria-label={controls.maximized ? "还原" : "最大化"}
          title={controls.maximized ? "还原" : "最大化"}
        >
          {controls.maximized ? <RestoreIcon /> : <MaximizeIcon />}
        </ControlButton>
        <ControlButton
          onClick={controls.onClose}
          aria-label="关闭"
          title="关闭"
          variant="close"
          className={closeHover}
        >
          <CloseIcon />
        </ControlButton>
      </div>
    </header>
  );
}

interface ControlButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  variant?: "default" | "close";
}

function ControlButton({ children, variant = "default", className, ...rest }: ControlButtonProps) {
  return (
    <button
      type="button"
      data-tauri-drag-region="false"
      className={cn(
        "flex h-full w-[46px] items-center justify-center text-[#1a1a1a] transition-colors",
        variant === "close" ? "hover:text-white" : "hover:bg-black/10",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

function MinimizeIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M2 6h8" stroke="currentColor" strokeWidth={1} strokeLinecap="round" />
    </svg>
  );
}

function MaximizeIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <rect x="1.5" y="1.5" width="9" height="9" rx="1" stroke="currentColor" strokeWidth={1} />
    </svg>
  );
}

function RestoreIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <rect x="1.5" y="3.5" width="7" height="7" rx="1" stroke="currentColor" strokeWidth={1} />
      <path
        d="M3.5 3.5V1.5h7V8.5h-2"
        stroke="currentColor"
        strokeWidth={1}
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" />
    </svg>
  );
}
