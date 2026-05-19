import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { isMac } from "@/lib/platform";
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
      unlisten = await win.onResized(async () => {
        const next = await win.isMaximized();
        if (!cancelled) setMaximized(next);
      });
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
      <div className="group flex items-center gap-[8px] pl-[14px]">
        <TrafficLight color="#ff5f57" symbol="×" ariaLabel="关闭" onClick={controls.onClose} />
        <TrafficLight color="#ffbd2e" symbol="–" ariaLabel="最小化" onClick={controls.onMinimize} />
        <TrafficLight
          color="#28c840"
          symbol={controls.maximized ? "↙" : "↗"}
          ariaLabel={controls.maximized ? "还原" : "最大化"}
          onClick={controls.onToggleMaximize}
        />
      </div>
      {/* drag region — no app-name text, matches the DingTalk style */}
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
  return (
    <header
      className="absolute inset-x-0 top-0 z-[100] flex h-10 select-none items-center justify-between"
      style={{
        WebkitUserSelect: "none",
        ...(blurred ? FROSTED_GLASS_STYLE : { background: "transparent" }),
      }}
    >
      {/* drag region — no app-name text */}
      <div data-tauri-drag-region className="h-full flex-1" aria-hidden />
      <div className="flex h-full items-stretch">
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
        <ControlButton onClick={controls.onClose} aria-label="关闭" title="关闭" variant="close">
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
        "flex h-full w-[46px] items-center justify-center text-[#3b5470] transition-colors",
        variant === "close" ? "hover:bg-[#e81123] hover:text-white" : "hover:bg-black/5",
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
