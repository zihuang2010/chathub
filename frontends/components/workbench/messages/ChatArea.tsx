import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import {
  CheckCheck,
  ChevronDown,
  FolderOpen,
  Image as ImageIcon,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Phone,
  Scissors,
  Smile,
  Sparkles,
  UserPlus,
  Video,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  WORKBENCH_ACTION_GRADIENT,
  WORKBENCH_ACTION_GRADIENT_HOVER,
  WORKBENCH_BLUE,
  WORKBENCH_LINE,
  WORKBENCH_LINE_SUBTLE,
  WORKBENCH_NUMERIC_FONT,
  WORKBENCH_OUT_BUBBLE,
  WORKBENCH_OUT_BUBBLE_BORDER,
  WORKBENCH_SOFT_BG,
  WORKBENCH_TEXT_MUTED,
  WORKBENCH_TEXT_PRIMARY,
  WORKBENCH_TEXT_SECONDARY,
} from "@/lib/theme";

import type { Conversation, Message } from "./data";
import { WorkbenchScrollArea, type ScrollMetrics } from "./WorkbenchScrollArea";

interface ChatAreaProps {
  conversation: Conversation;
  messages: Message[];
  accountOptions: string[];
  selectedAccount: string | null;
  onAccountChange: (account: string | null) => void;
  detailsOpen: boolean;
  onToggleDetails: () => void;
}

const COMPOSER_DEFAULT_HEIGHT = 244;
const COMPOSER_MIN_HEIGHT = 184;
const COMPOSER_MAX_HEIGHT = 360;
const COMPOSER_KEYBOARD_RESIZE_STEP = 16;

type TimelineItem =
  | { type: "date-divider"; id: string; label: string }
  | { type: "message"; id: string; message: Message };

export const ChatArea = memo(function ChatArea({
  conversation,
  messages,
  accountOptions,
  selectedAccount,
  onAccountChange,
  detailsOpen,
  onToggleDetails,
}: ChatAreaProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const wasAtBottomRef = useRef(true);
  const [composerHeight, setComposerHeight] = useState(COMPOSER_DEFAULT_HEIGHT);
  const timelineItems = useMemo(() => buildTimelineItems(messages), [messages]);

  // Track whether the user is parked at the bottom so new messages only pull
  // the view down when they were already there. We piggyback on the metrics
  // the scrollbar already computes — no separate scroll listener / layout read.
  const handleScrollMetrics = useCallback((m: ScrollMetrics) => {
    wasAtBottomRef.current = m.atBottom;
  }, []);

  // Switching conversations always jumps to the latest message.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
    wasAtBottomRef.current = true;
  }, [conversation.id]);

  // New messages only pull the view down when the user was already at bottom.
  useEffect(() => {
    if (!wasAtBottomRef.current) return;
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [messages.length]);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-white">
      <Header conversation={conversation} />
      <RangePill
        accountOptions={accountOptions}
        selectedAccount={selectedAccount}
        onAccountChange={onAccountChange}
      />
      <WorkbenchScrollArea
        scrollRef={scrollRef}
        onScrollMetrics={handleScrollMetrics}
        className="flex-1 bg-white"
        viewportClassName="bg-white px-4 py-5 pr-6"
        contentClassName="flex w-full flex-col gap-4"
      >
        {timelineItems.map((item) =>
          item.type === "date-divider" ? (
            <DateDivider key={item.id} label={item.label} />
          ) : (
            <Bubble
              key={item.id}
              message={item.message}
              avatarName={conversation.name}
              avatarColor={conversation.avatarColor}
              account={conversation.account}
            />
          ),
        )}
      </WorkbenchScrollArea>
      {/* `key` resets the Composer's local draft when the conversation changes. */}
      <Composer
        key={conversation.id}
        height={composerHeight}
        onHeightChange={setComposerHeight}
        detailsOpen={detailsOpen}
        onToggleDetails={onToggleDetails}
      />
    </div>
  );
});

function buildTimelineItems(messages: Message[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  let previousDateLabel: string | null = null;

  for (const message of messages) {
    if (message.dateLabel !== previousDateLabel) {
      items.push({
        type: "date-divider",
        id: `date-${message.dateLabel}-${message.id}`,
        label: message.dateLabel,
      });
      previousDateLabel = message.dateLabel;
    }

    items.push({ type: "message", id: message.id, message });
  }

  return items;
}

function getMessageTimeLabel(message: Message) {
  return `${message.dateLabel} ${message.timeLabel || message.time}`.trim();
}

// ─── Header ─────────────────────────────────────────────────────────────────

function Header({ conversation }: { conversation: Conversation }) {
  return (
    <div
      className="flex min-h-[76px] items-center justify-between gap-4 border-b bg-white px-4 py-3.5"
      style={{ borderColor: WORKBENCH_LINE }}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <CustomerAvatar name={conversation.name} color={conversation.avatarColor} size="header" />
        <div className="flex min-w-0 flex-col gap-1 leading-tight">
          <div className="flex min-w-0 items-center gap-1.5">
            <span
              className="truncate text-[14px] font-medium"
              style={{ color: WORKBENCH_TEXT_PRIMARY }}
            >
              {conversation.name}
            </span>
            <span className="shrink-0 rounded bg-[#ECFDF3] px-1.5 py-px text-[10.5px] font-medium text-[#059669]">
              @微信
            </span>
          </div>
          <span
            className="truncate text-[12px] leading-[17px]"
            style={{ color: WORKBENCH_TEXT_MUTED }}
          >
            来自：<span style={{ color: WORKBENCH_BLUE }}>{conversation.account}</span>
          </span>
        </div>
      </div>
      <div
        className="flex max-w-[280px] shrink-0 flex-wrap items-center justify-end gap-1"
        style={{ color: WORKBENCH_TEXT_SECONDARY }}
      >
        <HeaderIconButton icon={Phone} label="语音通话" />
        <HeaderIconButton icon={Video} label="视频通话" />
        <HeaderIconButton icon={CheckCheck} label="完成跟进" />
        <HeaderIconButton icon={UserPlus} label="加入群聊" />
        <HeaderIconButton icon={FolderOpen} label="资料库" />
        <HeaderIconButton icon={MoreHorizontal} label="更多" />
      </div>
    </div>
  );
}

function HeaderIconButton({ icon: Icon, label }: { icon: typeof Phone; label: string }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className="grid size-8 place-items-center rounded-md transition-colors hover:bg-[#F7FAFD] hover:text-[#1F2937]"
      style={{ color: WORKBENCH_TEXT_SECONDARY }}
    >
      <Icon size={15} />
    </button>
  );
}

// ─── Range pill ─────────────────────────────────────────────────────────────

function RangePill({
  accountOptions,
  selectedAccount,
  onAccountChange,
}: {
  accountOptions: string[];
  selectedAccount: string | null;
  onAccountChange: (account: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const label = selectedAccount ?? `全部账号 (${accountOptions.length})`;

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && wrapperRef.current?.contains(target)) return;
      setOpen(false);
    };

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  const handleSelect = (account: string | null) => {
    onAccountChange(account);
    setOpen(false);
  };

  return (
    <div className="bg-white px-4 pb-1.5 pt-2">
      <div className="flex items-center justify-between gap-3 text-[12px]">
        <div ref={wrapperRef} className="relative min-w-0">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
            className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors hover:bg-[#EAF2FF]"
            style={{ background: WORKBENCH_SOFT_BG, color: WORKBENCH_BLUE }}
          >
            <Sparkles size={12} className="shrink-0" />
            <span className="min-w-0 truncate">当前范围：{label}</span>
            <ChevronDown
              size={12}
              className={cn("shrink-0 transition-transform", open && "rotate-180")}
            />
          </button>
          {open && (
            <div
              className="absolute left-0 top-full z-20 mt-1 w-[240px] rounded-lg border bg-white p-2 shadow-[0_12px_32px_rgba(15,23,42,0.10)]"
              style={{ borderColor: WORKBENCH_LINE }}
            >
              <RangeAccountOption
                active={!selectedAccount}
                label="全部账号"
                onClick={() => handleSelect(null)}
              />
              {accountOptions.map((account) => (
                <RangeAccountOption
                  key={account}
                  active={selectedAccount === account}
                  label={account}
                  onClick={() => handleSelect(account)}
                />
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => handleSelect(null)}
          disabled={!selectedAccount}
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 transition-colors hover:bg-[#F7FAFD] hover:text-[#2563EB]"
          style={{ color: WORKBENCH_TEXT_MUTED }}
        >
          <X size={12} />
          <span>清除筛选</span>
        </button>
      </div>
    </div>
  );
}

function RangeAccountOption({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-8 w-full items-center justify-between gap-2 rounded-md px-2 text-left text-[12px] transition-colors",
        active ? "bg-[#EAF2FF] text-[#2563EB]" : "hover:bg-[#F7FAFD]",
      )}
      style={!active ? { color: WORKBENCH_TEXT_SECONDARY } : undefined}
    >
      <span className="truncate">{label}</span>
      {active && <span className="size-1.5 rounded-full bg-[#2563EB]" />}
    </button>
  );
}

// ─── Single message bubble ──────────────────────────────────────────────────

const Bubble = memo(function Bubble({
  message,
  avatarName,
  avatarColor,
  account,
}: {
  message: Message;
  avatarName: string;
  avatarColor: string;
  account: string;
}) {
  const isOut = message.direction === "out";

  if (isOut) {
    return <OutgoingBubble message={message} account={account} />;
  }

  return <IncomingBubble message={message} avatarName={avatarName} avatarColor={avatarColor} />;
});

function IncomingBubble({
  message,
  avatarName,
  avatarColor,
}: {
  message: Message;
  avatarName: string;
  avatarColor: string;
}) {
  return (
    <div className="flex w-full items-start gap-2 self-start">
      <CustomerAvatar name={avatarName} color={avatarColor} size="sm" />
      <div className="flex min-w-0 max-w-[76%] flex-col">
        <div
          tabIndex={0}
          aria-label={`${message.text}，发送时间 ${getMessageTimeLabel(message)}`}
          className="group relative flex min-h-11 items-center rounded-md border bg-white px-3.5 py-2 text-[13px] leading-[1.65] shadow-[0_1px_1px_rgba(15,23,42,0.025),0_4px_12px_rgba(15,23,42,0.018)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]/15"
          style={{ borderColor: WORKBENCH_LINE_SUBTLE, color: WORKBENCH_TEXT_PRIMARY }}
        >
          <MessageTimeTooltip label={getMessageTimeLabel(message)} align="left" />
          {message.text}
        </div>
      </div>
    </div>
  );
}

function OutgoingBubble({ message, account }: { message: Message; account: string }) {
  return (
    <div className="flex w-full flex-row-reverse items-start gap-2 self-end">
      <AgentAvatar account={account} />
      <div className="flex min-w-0 max-w-[76%] flex-col items-end">
        <div
          tabIndex={0}
          aria-label={`${message.text}，发送时间 ${getMessageTimeLabel(message)}`}
          className="group relative flex min-h-11 items-center rounded-md border px-3.5 py-2 text-[13px] leading-[1.65] shadow-[0_1px_1px_rgba(37,99,235,0.026),0_4px_12px_rgba(37,99,235,0.018)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]/15"
          style={{
            background: WORKBENCH_OUT_BUBBLE,
            borderColor: WORKBENCH_OUT_BUBBLE_BORDER,
            color: WORKBENCH_TEXT_PRIMARY,
          }}
        >
          <MessageTimeTooltip label={getMessageTimeLabel(message)} align="right" />
          {message.text}
        </div>
      </div>
    </div>
  );
}

function DateDivider({ label }: { label: string }) {
  return (
    <div className="flex justify-center py-2.5">
      <span
        className="text-[12px] font-medium tabular-nums"
        style={{ color: WORKBENCH_TEXT_MUTED, fontFamily: WORKBENCH_NUMERIC_FONT }}
      >
        {label}
      </span>
    </div>
  );
}

function MessageTimeTooltip({ label, align }: { label: string; align: "left" | "right" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute -top-6 z-10 whitespace-nowrap text-[11px] font-medium tabular-nums opacity-0 transition-opacity duration-100 group-hover:opacity-100 group-focus-visible:opacity-100",
        align === "right" ? "right-0" : "left-0",
      )}
      style={{ color: WORKBENCH_TEXT_MUTED, fontFamily: WORKBENCH_NUMERIC_FONT }}
    >
      {label}
    </span>
  );
}

function CustomerAvatar({
  name,
  color,
  size,
}: {
  name: string;
  color: string;
  size: "header" | "sm";
}) {
  return (
    <div
      className={cn(
        "grid shrink-0 place-items-center rounded-xl font-semibold shadow-[inset_0_0_0_1px_rgba(255,255,255,0.48)]",
        size === "header" ? "size-11 text-[16px]" : "size-11 text-[15px]",
      )}
      style={{ background: color, color: WORKBENCH_TEXT_PRIMARY }}
    >
      {name.slice(0, 1)}
    </div>
  );
}

function AgentAvatar({ account }: { account: string }) {
  const accountParts = account.split("-");
  const operator = accountParts[accountParts.length - 1] || account;

  return (
    <div
      className="grid size-11 shrink-0 place-items-center rounded-xl text-[12px] font-medium shadow-[inset_0_0_0_1px_rgba(255,255,255,0.55)]"
      style={{ background: WORKBENCH_SOFT_BG, color: WORKBENCH_TEXT_SECONDARY }}
    >
      {operator.slice(-2)}
    </div>
  );
}

// ─── Composer (input area) ──────────────────────────────────────────────────

function clampComposerHeight(height: number) {
  return Math.min(Math.max(height, COMPOSER_MIN_HEIGHT), COMPOSER_MAX_HEIGHT);
}

function Composer({
  height,
  onHeightChange,
  detailsOpen,
  onToggleDetails,
}: {
  height: number;
  onHeightChange: (height: number | ((height: number) => number)) => void;
  detailsOpen: boolean;
  onToggleDetails: () => void;
}) {
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
      return clampComposerHeight(currentHeight + direction * COMPOSER_KEYBOARD_RESIZE_STEP);
    });
  };

  return (
    <div
      className="relative shrink-0 border-t bg-white px-3 py-3"
      style={{ height, borderColor: WORKBENCH_LINE }}
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
        className={cn(
          "group absolute inset-x-0 top-0 z-10 flex h-3 -translate-y-1.5 cursor-row-resize items-center justify-center outline-none",
          isResizing && "cursor-row-resize",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "h-px w-10 rounded-full bg-transparent transition-colors group-hover:bg-[#93C5FD] group-focus-visible:bg-[#60A5FA]",
            isResizing && "bg-[#60A5FA]",
          )}
        />
      </div>
      <div className="flex h-full w-full flex-col gap-3 bg-white">
        <div className="flex items-center gap-3" style={{ color: WORKBENCH_TEXT_SECONDARY }}>
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
                ? "bg-[#EAF2FF] text-[#2563EB]"
                : "hover:bg-[#F7FAFD] hover:text-[#2563EB]",
            )}
            style={!detailsOpen ? { color: WORKBENCH_TEXT_SECONDARY } : undefined}
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
          className="min-h-[76px] w-full flex-1 resize-none border-0 bg-transparent px-2 py-3 text-[13px] leading-[1.65] placeholder:text-[#8A96A8] focus-visible:outline-none"
          style={{ color: WORKBENCH_TEXT_PRIMARY }}
        />
        <div className="flex items-center gap-2 pt-0.5">
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1 rounded-md px-2.5 text-[12px] font-medium transition-colors hover:bg-[#F7FAFD] hover:text-[#1F2937]"
            style={{ color: WORKBENCH_TEXT_SECONDARY }}
          >
            <span>快捷回复</span>
          </button>
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1 rounded-md px-2.5 text-[12px] font-medium transition-colors"
            style={{ background: WORKBENCH_SOFT_BG, color: WORKBENCH_BLUE }}
          >
            <Sparkles size={12} />
            <span>AI 润色</span>
            <span
              className="rounded-sm px-1 py-px text-[8.5px] font-semibold uppercase leading-none text-white"
              style={{ background: WORKBENCH_BLUE }}
            >
              NEW
            </span>
          </button>
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1 rounded-md border px-2.5 text-[12px] transition-colors hover:bg-[#F7FAFD]"
            style={{ borderColor: WORKBENCH_LINE, color: WORKBENCH_TEXT_SECONDARY }}
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
              style={{
                background: canSend
                  ? hover
                    ? WORKBENCH_ACTION_GRADIENT_HOVER
                    : WORKBENCH_ACTION_GRADIENT
                  : "#DCEBFA",
                color: canSend ? "#FFFFFF" : "#7CA2CF",
              }}
            >
              发送
            </Button>
            <Button
              type="button"
              disabled={!canSend}
              className="h-8 rounded-l-none rounded-r-md border-l border-white/30 px-2 transition-all disabled:opacity-100"
              style={{
                background: canSend
                  ? hover
                    ? WORKBENCH_ACTION_GRADIENT_HOVER
                    : WORKBENCH_ACTION_GRADIENT
                  : "#DCEBFA",
                color: canSend ? "#FFFFFF" : "#7CA2CF",
              }}
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
      className="grid size-9 place-items-center rounded-md transition-colors hover:bg-[#F7FAFD] hover:text-[#2563EB]"
      style={{ color: WORKBENCH_TEXT_SECONDARY }}
    >
      <Icon size={20} strokeWidth={1.45} />
    </button>
  );
}
