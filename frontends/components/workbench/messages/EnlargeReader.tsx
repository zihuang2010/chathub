import { useState } from "react";
import { Minus, Plus, X } from "lucide-react";

import { Modal } from "@/components/ui/Modal";
import { isMac } from "@/lib/platform";
import { cn } from "@/lib/utils";

import { STRINGS } from "./strings";

// 字号档位(px):大字阅读用,起始适中,上下各留几档。step 一致,按钮到边界即禁用。
const FONT_MIN = 18;
const FONT_MAX = 56;
const FONT_STEP = 6;
const FONT_DEFAULT = 30;

interface EnlargeReaderProps {
  /** 要放大阅读的纯文本(取 message.text)。 */
  text: string;
  onClose: () => void;
}

/**
 * 放大阅读弹层:把一条消息的文本在居中卡片里大字呈现,右上角 −/+ 调字号。
 * 纯展示、无副作用;复用 ui/Modal(Esc / 点遮罩关闭),主题用 workbench-* token。
 */
export function EnlargeReader({ text, onClose }: EnlargeReaderProps) {
  const [fontSize, setFontSize] = useState(FONT_DEFAULT);
  const zoomOut = () => setFontSize((s) => Math.max(FONT_MIN, s - FONT_STEP));
  const zoomIn = () => setFontSize((s) => Math.min(FONT_MAX, s + FONT_STEP));

  const title = (
    <span className="text-wb-xs font-medium text-workbench-text-secondary">
      {STRINGS.enlarge.title}
    </span>
  );
  // 工具组:Mac 复刻系统左上"交通灯"——红=关闭/黄=缩小/绿=放大,symbol 悬停浮现、
  // 到字号档位边界置灰(贴 macOS 失效控件);Windows 维持中性按钮(顺序 −/+/×,关闭贴右)。
  const tools = isMac ? (
    <div className="group flex items-center gap-[8px]">
      <MacTrafficButton
        color="#ff5f57"
        symbol="×"
        label={STRINGS.enlarge.close}
        onClick={onClose}
      />
      <MacTrafficButton
        color="#ffbd2e"
        symbol="−"
        label={STRINGS.enlarge.zoomOut}
        onClick={zoomOut}
        disabled={fontSize <= FONT_MIN}
      />
      <MacTrafficButton
        color="#28c840"
        symbol="+"
        label={STRINGS.enlarge.zoomIn}
        onClick={zoomIn}
        disabled={fontSize >= FONT_MAX}
      />
    </div>
  ) : (
    <div className="flex items-center gap-1">
      <ToolButton label={STRINGS.enlarge.zoomOut} onClick={zoomOut} disabled={fontSize <= FONT_MIN}>
        <Minus size={16} strokeWidth={2} aria-hidden />
      </ToolButton>
      <ToolButton label={STRINGS.enlarge.zoomIn} onClick={zoomIn} disabled={fontSize >= FONT_MAX}>
        <Plus size={16} strokeWidth={2} aria-hidden />
      </ToolButton>
      <ToolButton label={STRINGS.enlarge.close} onClick={onClose}>
        <X size={16} strokeWidth={2} aria-hidden />
      </ToolButton>
    </div>
  );

  return (
    <Modal
      open
      onClose={onClose}
      ariaLabel={STRINGS.enlarge.title}
      className="flex h-[min(80vh,640px)] w-[min(90vw,760px)] flex-col"
    >
      {/* 顶部工具条:标题与工具组按平台镜像 —— Mac 工具组在左、标题在右;Windows 反之。 */}
      <div className="flex shrink-0 items-center justify-between border-b border-workbench-line-subtle px-4 py-2.5">
        {isMac ? (
          <>
            {tools}
            {title}
          </>
        ) : (
          <>
            {title}
            {tools}
          </>
        )}
      </div>
      {/* 正文:可滚动,大字居中(垂直居中短文本,长文本顶部对齐滚动)。 */}
      <div className="flex flex-1 items-center justify-center overflow-y-auto px-8 py-10">
        <p
          className="w-full whitespace-pre-wrap text-center font-[450] leading-relaxed text-workbench-text [overflow-wrap:anywhere]"
          style={{ fontSize }}
        >
          {text}
        </p>
      </div>
    </Modal>
  );
}

function ToolButton({
  children,
  label,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        "focus-ring grid size-8 place-items-center rounded-lg text-workbench-text-muted transition-colors",
        "hover:bg-workbench-surface-subtle hover:text-workbench-accent",
        "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-workbench-text-muted",
      )}
    >
      {children}
    </button>
  );
}

// Mac 专用:系统窗口控件同款圆形"交通灯"按钮(尺寸/描边/悬停浮字复刻 TitleBar),
// 额外支持禁用态——置灰、不浮 symbol,用于字号到达最小/最大档位。
function MacTrafficButton({
  color,
  symbol,
  label,
  onClick,
  disabled,
}: {
  color: string;
  symbol: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        "focus-ring grid size-[12px] place-items-center rounded-full transition-[filter]",
        disabled ? "cursor-not-allowed" : "hover:brightness-95 active:brightness-90",
      )}
      style={{
        background: disabled ? "#d2d4d8" : color,
        boxShadow: "inset 0 0 0 0.5px rgba(0, 0, 0, 0.18), 0 1px 1.5px rgba(0, 0, 0, 0.12)",
      }}
    >
      <span
        aria-hidden
        className={cn(
          "block text-[8.5px] font-bold leading-none opacity-0 transition-opacity duration-100",
          !disabled && "group-hover:opacity-100",
        )}
        style={{ color: "rgba(0, 0, 0, 0.55)", transform: "translateY(-0.5px)" }}
      >
        {symbol}
      </span>
    </button>
  );
}
