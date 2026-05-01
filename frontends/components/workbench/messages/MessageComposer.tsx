import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import {
  ChevronDown,
  FolderOpen,
  Image as ImageIcon,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Scissors,
  Smile,
  Sparkles,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { WORKBENCH_ACTION_GRADIENT, WORKBENCH_ACTION_GRADIENT_HOVER } from "@/lib/theme";

import { COMPOSER_MAX_HEIGHT, COMPOSER_MIN_HEIGHT, RESIZE_KEYBOARD_STEP } from "./constants";

interface MessageComposerProps {
  height: number;
  onHeightChange: (height: number | ((height: number) => number)) => void;
  detailsOpen: boolean;
  onToggleDetails: () => void;
}

function clampComposerHeight(height: number) {
  return Math.min(Math.max(height, COMPOSER_MIN_HEIGHT), COMPOSER_MAX_HEIGHT);
}

export function MessageComposer({
  height,
  onHeightChange,
  detailsOpen,
  onToggleDetails,
}: MessageComposerProps) {
  const [draft, setDraft] = useState("");
  const [hover, setHover] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartRef = useRef({ y: 0, height });
  const canSend = draft.trim().length > 0;

  useEffect(() => {
    if (!isResizing) return;

    const handlePointerMove = (event: PointerEvent) => {
      const deltaY = resizeStartRef.current.y - event.clientY;
      onHeightChange(clampComposerHeight(resizeStartRef.current.height + deltaY));
    };
    const stopResizing = () => setIsResizing(false);
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResizing);
    window.addEventListener("pointercancel", stopResizing);

    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResizing);
      window.removeEventListener("pointercancel", stopResizing);
    };
  }, [isResizing, onHeightChange]);

  const handleResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    resizeStartRef.current = { y: event.clientY, height };
    setIsResizing(true);
  };

  const handleResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      event.key !== "ArrowUp" &&
      event.key !== "ArrowDown" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }
    event.preventDefault();
    onHeightChange((currentHeight) => {
      if (event.key === "Home") return COMPOSER_MIN_HEIGHT;
      if (event.key === "End") return COMPOSER_MAX_HEIGHT;
      const direction = event.key === "ArrowUp" ? 1 : -1;
      return clampComposerHeight(currentHeight + direction * RESIZE_KEYBOARD_STEP);
    });
  };

  const sendBackground = canSend
    ? hover
      ? WORKBENCH_ACTION_GRADIENT_HOVER
      : WORKBENCH_ACTION_GRADIENT
    : "#DCEBFA";
  const sendColor = canSend ? "#FFFFFF" : "#7CA2CF";

  return (
    <div
      className="relative shrink-0 border-t border-workbench-line bg-white px-3 py-3"
      style={{ height }}
    >
      <div
        role="separator"
        aria-label="调整消息编辑区高度"
        aria-orientation="horizontal"
        aria-valuemin={COMPOSER_MIN_HEIGHT}
        aria-valuemax={COMPOSER_MAX_HEIGHT}
        aria-valuenow={Math.round(height)}
        tabIndex={0}
        onPointerDown={handleResizePointerDown}
        onKeyDown={handleResizeKeyDown}
        className="group absolute inset-x-0 top-0 z-10 flex h-3 -translate-y-1.5 cursor-row-resize items-center justify-center outline-none"
      >
        <span
          aria-hidden
          className={cn(
            "h-px w-10 rounded-full bg-transparent transition-colors group-hover:bg-workbench-blue-light group-focus-visible:bg-workbench-blue-medium",
            isResizing && "bg-workbench-blue-medium",
          )}
        />
      </div>
      <div className="flex h-full w-full flex-col gap-3 bg-white">
        <div className="flex items-center gap-3 text-workbench-text-secondary">
          <ToolButton icon={Smile} label="表情" />
          <ToolButton icon={Scissors} label="剪辑" />
          <ToolButton icon={ImageIcon} label="图片" />
          <ToolButton icon={FolderOpen} label="文件" />
          <ToolButton icon={MoreHorizontal} label="更多" />
          <button
            type="button"
            title={detailsOpen ? "收起右栏" : "展开右栏"}
            aria-label={detailsOpen ? "收起右栏" : "展开右栏"}
            aria-pressed={detailsOpen}
            onClick={onToggleDetails}
            className={cn(
              "relative z-30 ml-auto grid size-9 place-items-center rounded-md transition-colors",
              detailsOpen
                ? "bg-workbench-surface-active text-workbench-blue-strong"
                : "text-workbench-text-secondary hover:bg-workbench-surface-subtle hover:text-workbench-blue-strong",
            )}
          >
            {detailsOpen ? (
              <PanelRightClose size={20} strokeWidth={1.45} />
            ) : (
              <PanelRightOpen size={20} strokeWidth={1.45} />
            )}
          </button>
        </div>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.currentTarget.value)}
          rows={4}
          placeholder="好的，我这边为您安排试用申请，请问您现在方便留一下企业信息吗？"
          className="min-h-[76px] w-full flex-1 resize-none border-0 bg-transparent px-2 py-3 text-[13px] leading-[1.65] text-workbench-text placeholder:text-workbench-text-muted focus-visible:outline-none"
        />
        <div className="flex items-center gap-2 pt-0.5">
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1 rounded-md px-2.5 text-[12px] font-medium text-workbench-text-secondary transition-colors hover:bg-workbench-surface-subtle hover:text-workbench-text"
          >
            <span>快捷回复</span>
          </button>
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1 rounded-md bg-workbench-surface-soft px-2.5 text-[12px] font-medium text-workbench-blue transition-colors"
          >
            <Sparkles size={12} />
            <span>AI 润色</span>
            <span className="rounded-sm bg-workbench-blue px-1 py-px text-[8.5px] font-semibold uppercase leading-none text-white">
              NEW
            </span>
          </button>
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1 rounded-md border border-workbench-line px-2.5 text-[12px] text-workbench-text-secondary transition-colors hover:bg-workbench-surface-subtle"
          >
            <span>正式</span>
            <ChevronDown size={11} />
          </button>
          <div className="ml-auto flex items-center gap-0">
            <Button
              type="button"
              disabled={!canSend}
              onMouseEnter={() => setHover(true)}
              onMouseLeave={() => setHover(false)}
              className="h-8 rounded-l-md rounded-r-none px-5 text-[13px] font-medium transition-all disabled:opacity-100"
              style={{ background: sendBackground, color: sendColor }}
            >
              发送
            </Button>
            <Button
              type="button"
              disabled={!canSend}
              className="h-8 rounded-l-none rounded-r-md border-l border-white/30 px-2 transition-all disabled:opacity-100"
              style={{ background: sendBackground, color: sendColor }}
              aria-label="发送选项"
            >
              <ChevronDown size={12} />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ToolButton({ icon: Icon, label }: { icon: typeof Smile; label: string }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className="grid size-9 place-items-center rounded-md text-workbench-text-secondary transition-colors hover:bg-workbench-surface-subtle hover:text-workbench-blue-strong"
    >
      <Icon size={20} strokeWidth={1.45} />
    </button>
  );
}
