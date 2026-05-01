import { memo, useEffect, useRef, useState } from "react";
import {
  CheckCheck,
  ChevronDown,
  FolderOpen,
  Image as ImageIcon,
  MoreHorizontal,
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
import { BLUE_GRADIENT, BLUE_GRADIENT_HOVER } from "@/lib/theme";

import type { Conversation, Message } from "./data";

interface ChatAreaProps {
  conversation: Conversation;
  messages: Message[];
}

export const ChatArea = memo(function ChatArea({ conversation, messages }: ChatAreaProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Scroll the message list to the bottom on conversation switch / new messages.
  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [conversation.id, messages.length]);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-white">
      <Header conversation={conversation} />
      <RangePill count={messages.length} />
      <div ref={scrollRef} className="flex-1 overflow-y-auto bg-white px-4 py-5">
        <div className="flex w-full flex-col gap-5">
          {messages.map((m, index) => (
            <Bubble
              key={m.id}
              message={m}
              showMeta={shouldShowMessageMeta(messages, index)}
              avatarName={conversation.name}
              avatarColor={conversation.avatarColor}
              account={conversation.account}
            />
          ))}
        </div>
      </div>
      {/* `key` resets the Composer's local draft when the conversation changes. */}
      <Composer key={conversation.id} />
    </div>
  );
});

// ─── Header ─────────────────────────────────────────────────────────────────

function Header({ conversation }: { conversation: Conversation }) {
  return (
    <div className="flex min-h-[64px] items-center justify-between gap-4 bg-white px-4 py-2.5 shadow-[0_1px_0_rgba(226,232,240,0.65)]">
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <CustomerAvatar name={conversation.name} color={conversation.avatarColor} size="header" />
        <div className="flex min-w-0 flex-col gap-0.5 leading-tight">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[14px] font-medium text-[#1F2937]">
              {conversation.name}
            </span>
            <span className="shrink-0 rounded bg-[#ECFDF3] px-1.5 py-px text-[10.5px] font-medium text-[#059669]">
              @微信
            </span>
          </div>
          <span className="truncate text-[11.5px] text-[#8A94A6]">
            来自：<span className="text-[#2563EB]">{conversation.account}</span>
          </span>
        </div>
      </div>
      <div className="flex max-w-[280px] shrink-0 flex-wrap items-center justify-end gap-1 text-[#6B7280]">
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
      className="grid size-8 place-items-center rounded-md text-[#6B7280] transition-colors hover:bg-[#F1F5F9] hover:text-[#1F2937]"
    >
      <Icon size={15} />
    </button>
  );
}

// ─── Range pill ─────────────────────────────────────────────────────────────

function RangePill({ count }: { count: number }) {
  return (
    <div className="bg-white px-4 pb-1.5 pt-2">
      <div className="flex items-center justify-between gap-3 text-[12px]">
        <span className="inline-flex min-w-0 items-center gap-1.5 rounded-md bg-[#F5F9FF] px-2 py-1 text-[#2563EB]">
          <Sparkles size={12} />
          <span className="truncate">当前范围：全部账号 ({count})</span>
        </span>
        <button
          type="button"
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[#8A94A6] transition-colors hover:bg-[#F5F8FF] hover:text-[#2563EB]"
        >
          <X size={12} />
          <span>清除筛选</span>
        </button>
      </div>
    </div>
  );
}

// ─── Single message bubble ──────────────────────────────────────────────────

const Bubble = memo(function Bubble({
  message,
  showMeta,
  avatarName,
  avatarColor,
  account,
}: {
  message: Message;
  showMeta: boolean;
  avatarName: string;
  avatarColor: string;
  account: string;
}) {
  const isOut = message.direction === "out";

  if (isOut) {
    return <OutgoingBubble message={message} account={account} showMeta={showMeta} />;
  }

  return (
    <IncomingBubble
      message={message}
      avatarName={avatarName}
      avatarColor={avatarColor}
      showMeta={showMeta}
    />
  );
});

function shouldShowMessageMeta(messages: Message[], index: number) {
  const message = messages[index];
  const nextMessage = messages[index + 1];

  return (
    !nextMessage || nextMessage.direction !== message.direction || nextMessage.time !== message.time
  );
}

function IncomingBubble({
  message,
  showMeta,
  avatarName,
  avatarColor,
}: {
  message: Message;
  showMeta: boolean;
  avatarName: string;
  avatarColor: string;
}) {
  return (
    <div className="flex w-full items-start gap-2 self-start">
      <CustomerAvatar name={avatarName} color={avatarColor} size="sm" />
      <div className="flex min-w-0 max-w-[76%] flex-col gap-1">
        <div className="flex min-h-11 items-center rounded-md border border-[#DDE6F0] bg-white px-3.5 py-2 text-[13px] leading-[1.65] text-[#1F2937] shadow-[0_1px_2px_rgba(15,23,42,0.06),0_6px_16px_rgba(15,23,42,0.035)]">
          {message.text}
        </div>
        {showMeta && <div className="px-1 text-[11px] text-[#9CA3AF]">{message.time}</div>}
      </div>
    </div>
  );
}

function OutgoingBubble({
  message,
  account,
  showMeta,
}: {
  message: Message;
  account: string;
  showMeta: boolean;
}) {
  return (
    <div className="flex w-full flex-row-reverse items-start gap-2 self-end">
      <AgentAvatar account={account} />
      <div className="flex min-w-0 max-w-[76%] flex-col items-end gap-1">
        <div className="flex min-h-11 items-center rounded-md border border-[#CBE2FA] bg-[#E3F1FF] px-3.5 py-2 text-[13px] leading-[1.65] text-[#1F2937] shadow-[0_1px_2px_rgba(15,23,42,0.06),0_6px_16px_rgba(15,23,42,0.035)]">
          {message.text}
        </div>
        {showMeta && (
          <div className="flex items-center gap-1 px-1 text-[11px] text-[#9CA3AF]">
            <span>{message.time}</span>
            {message.read && <span>已读</span>}
          </div>
        )}
      </div>
    </div>
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
        "grid shrink-0 place-items-center rounded-xl font-semibold text-[#1F2937] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.48)]",
        size === "header" ? "size-10 text-[15px]" : "size-11 text-[15px]",
      )}
      style={{ background: color }}
    >
      {name.slice(0, 1)}
    </div>
  );
}

function AgentAvatar({ account }: { account: string }) {
  const accountParts = account.split("-");
  const operator = accountParts[accountParts.length - 1] || account;

  return (
    <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-[#EEF3FA] text-[12px] font-medium text-[#5B6B86] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.55)]">
      {operator.slice(-2)}
    </div>
  );
}

// ─── Composer (input area) ──────────────────────────────────────────────────

function Composer() {
  const [draft, setDraft] = useState("");
  const [hover, setHover] = useState(false);
  const canSend = draft.trim().length > 0;

  return (
    <div className="border-t border-[#EEF2F7] bg-white px-3 py-3">
      <div className="flex w-full flex-col gap-3 bg-white">
        <div className="flex items-center gap-1 text-[#6B7280]">
          <ToolButton icon={Smile} label="表情" />
          <ToolButton icon={Scissors} label="剪辑" />
          <ToolButton icon={ImageIcon} label="图片" />
          <ToolButton icon={FolderOpen} label="文件" />
          <ToolButton icon={MoreHorizontal} label="更多" />
        </div>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.currentTarget.value)}
          rows={4}
          placeholder="好的，我这边为您安排试用申请，请问您现在方便留一下企业信息吗？"
          className="min-h-[132px] w-full resize-none border-0 bg-transparent px-2 py-3 text-[13px] leading-[1.65] text-[#1F2937] placeholder:text-[#9CA3AF] focus-visible:outline-none"
        />
        <div className="flex items-center gap-2 pt-0.5">
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1 rounded-md px-2.5 text-[12px] font-medium text-[#6B7280] transition-colors hover:bg-[#F1F5F9] hover:text-[#1F2937]"
          >
            <span>快捷回复</span>
          </button>
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1 rounded-md bg-[#F5F8FF] px-2.5 text-[12px] font-medium text-[#2563EB] transition-colors hover:bg-[#EEF4FF]"
          >
            <Sparkles size={12} />
            <span>AI 润色</span>
            <span className="rounded-sm bg-[#2563EB] px-1 py-px text-[8.5px] font-semibold uppercase leading-none text-white">
              NEW
            </span>
          </button>
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1 rounded-md border border-[#E5EBF2] px-2.5 text-[12px] text-[#4B5563] transition-colors hover:bg-[#F1F5F9]"
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
                background: canSend ? (hover ? BLUE_GRADIENT_HOVER : BLUE_GRADIENT) : "#DCEBFA",
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
                background: canSend ? (hover ? BLUE_GRADIENT_HOVER : BLUE_GRADIENT) : "#DCEBFA",
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
      className="grid size-7 place-items-center rounded-md transition-colors hover:bg-[#F5F8FF] hover:text-[#2563EB]"
    >
      <Icon size={13} />
    </button>
  );
}
