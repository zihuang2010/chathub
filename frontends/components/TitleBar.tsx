import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { cn } from "@/lib/utils";
import { isMac } from "@/lib/platform";

const LOGO_BG = "linear-gradient(145deg, #2791ff, #0869f2)";

interface TitleBarProps {
  showTitle?: boolean;
}

interface WindowControls {
  maximized: boolean;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  onClose: () => void;
}

export function TitleBar({ showTitle = true }: TitleBarProps) {
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
    <MacTitleBar controls={controls} showTitle={showTitle} />
  ) : (
    <WindowsTitleBar controls={controls} showTitle={showTitle} />
  );
}

// ─── macOS layout ───────────────────────────────────────────────────────────

function MacTitleBar({ controls, showTitle }: { controls: WindowControls; showTitle: boolean }) {
  return (
    <header
      className="absolute inset-x-0 top-0 z-[100] flex h-8 select-none items-center"
      style={{ WebkitUserSelect: "none" }}
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
      <div
        data-tauri-drag-region
        className="flex flex-1 items-center justify-center text-[12px] font-medium tracking-tight"
        style={{ color: showTitle ? "rgba(15, 37, 68, 0.65)" : "transparent" }}
        aria-hidden={!showTitle}
      >
        ChatHub
      </div>
      {/* spacer matches the traffic-light cluster width so the title is truly centered */}
      <div data-tauri-drag-region className="h-full w-[80px]" aria-hidden />
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

function WindowsTitleBar({
  controls,
  showTitle,
}: {
  controls: WindowControls;
  showTitle: boolean;
}) {
  return (
    <header
      className="absolute inset-x-0 top-0 z-[100] flex h-8 select-none items-center justify-between"
      style={{ WebkitUserSelect: "none" }}
    >
      <div
        data-tauri-drag-region
        className="flex h-full flex-1 items-center gap-[8px] pl-3 text-[12px]"
        style={{ color: "#3b5470" }}
      >
        {showTitle && (
          <>
            <span
              className="grid h-[18px] w-[18px] place-items-center rounded-[5px]"
              style={{ background: LOGO_BG, boxShadow: "0 4px 10px rgba(22,119,255,.25)" }}
            >
              <svg
                viewBox="0 0 24 24"
                width="11"
                height="11"
                fill="none"
                stroke="white"
                strokeWidth={2.4}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M7 8h10M7 12h6M6 19l-3 2v-4a8 8 0 0 1-1-4C2 7.5 6.5 4 12 4s10 3.5 10 9-4.5 9-10 9a12 12 0 0 1-6-1.6Z" />
              </svg>
            </span>
            <span className="font-semibold tracking-tight">ChatHub</span>
          </>
        )}
      </div>
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
        "flex h-full w-[46px] items-center justify-center transition-colors",
        variant === "close"
          ? "text-[#3b5470] hover:bg-[#e81123] hover:text-white"
          : "text-[#3b5470] hover:bg-black/5",
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
