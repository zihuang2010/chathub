import { memo, useState } from "react";
import { Menu } from "lucide-react";

import { cn } from "@/lib/utils";

import type { Conversation } from "./data";

// ─── Types & static data ────────────────────────────────────────────────────

type StatusTab = "all" | "unread" | "mentioned";

const STATUS_TABS: { value: StatusTab; label: string; count: number }[] = [
  { value: "all", label: "全部", count: 32 },
  { value: "unread", label: "未读", count: 12 },
  { value: "mentioned", label: "@我", count: 5 },
];

// ─── Component ──────────────────────────────────────────────────────────────

interface ConversationListProps {
  conversations: Conversation[];
  selectedId: string;
  onSelect: (id: string) => void;
  width: number;
}

export const ConversationList = memo(function ConversationList({
  conversations,
  selectedId,
  onSelect,
  width,
}: ConversationListProps) {
  const [statusTab, setStatusTab] = useState<StatusTab>("all");

  return (
    <div className="flex h-full shrink-0 flex-col bg-white" style={{ width }}>
      <div className="border-b border-[#EEF2F7] px-3 py-2.5">
        <StatusTabs value={statusTab} onChange={setStatusTab} />
      </div>

      <div className="flex-1 overflow-y-auto py-1.5">
        {conversations.map((c) => (
          <ConversationItem
            key={c.id}
            conversation={c}
            selected={c.id === selectedId}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  );
});

// ─── Status tabs ────────────────────────────────────────────────────────────

function StatusTabs({ value, onChange }: { value: StatusTab; onChange: (v: StatusTab) => void }) {
  return (
    <div className="flex items-center gap-1 text-[12px]">
      {STATUS_TABS.map((tab) => {
        const active = tab.value === value;
        return (
          <button
            key={tab.value}
            type="button"
            onClick={() => onChange(tab.value)}
            className={cn(
              "inline-flex h-7 items-center gap-1 rounded-md px-2 transition-colors",
              active
                ? "bg-[#EAF2FF] text-[#2563EB]"
                : "text-[#6B7280] hover:bg-[#F5F8FF] hover:text-[#1F2937]",
            )}
          >
            {tab.label}
            {tab.count > 0 && (
              <span
                className={cn(
                  "rounded-full px-1.5 text-[10px] font-semibold leading-[16px]",
                  tab.value === "unread"
                    ? "bg-[#EF4444] text-white"
                    : active
                      ? "bg-white text-[#2563EB]"
                      : "bg-[#EEF2F7] text-[#6B7280]",
                )}
              >
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
      <button
        type="button"
        aria-label="更多筛选"
        title="更多筛选"
        className="ml-auto grid size-7 place-items-center rounded-md text-[#6B7280] transition-colors hover:bg-[#F5F8FF] hover:text-[#2563EB]"
      >
        <Menu size={14} />
      </button>
    </div>
  );
}

// ─── Single conversation row ────────────────────────────────────────────────

const ConversationItem = memo(function ConversationItem({
  conversation,
  selected,
  onSelect,
}: {
  conversation: Conversation;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const { id, name, avatarColor, preview, account, time, unread, online } = conversation;

  return (
    <button
      type="button"
      onClick={() => onSelect(id)}
      title={`来自 ${account}`}
      className={cn(
        "group relative mx-2 my-1 grid w-[calc(100%-1rem)] grid-cols-[46px_minmax(0,1fr)] items-start gap-3 rounded-xl px-3 py-3.5 text-left transition-colors",
        selected ? "bg-[#EEF6FF]" : "hover:bg-[#F7FBFF]",
      )}
    >
      <ConversationAvatar name={name} color={avatarColor} online={online} />
      <div className="min-w-0 pr-11 pt-0.5">
        <div className="flex min-w-0 items-center">
          <span className="truncate text-[13.5px] font-medium leading-[18px] text-[#1F2937]">
            {name}
          </span>
        </div>
        <div className="mt-1 truncate text-[12px] leading-[17px] text-[#6B7280]">{preview}</div>
        <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[10.5px] leading-[15px]">
          <span className="shrink-0 text-[#A0A9B8]">来自</span>
          <span className="font-nomarl min-w-0 truncate text-[#2563EB]">{account}</span>
          <WeChatBadge />
        </div>
      </div>
      <span className="absolute right-3 top-3 text-[11px] leading-[16px] text-[#9CA3AF]">
        {time}
      </span>
      {unread > 0 && (
        <span className="absolute right-3 top-1/2 grid h-4 min-w-4 translate-y-[-10%] place-items-center rounded-full bg-[#EF4444] px-1 text-[10px] font-semibold leading-none text-white shadow-[0_1px_2px_rgba(239,68,68,0.24)]">
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </button>
  );
});

function WeChatBadge() {
  return (
    <span
      aria-label="微信"
      title="微信"
      className="grid size-4 shrink-0 place-items-center rounded bg-[#ECFDF3] text-[#07C160]"
    >
      <svg
        aria-hidden
        viewBox="0 0 16 16"
        className="size-[13px]"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M6.7 3.2C3.9 3.2 1.8 4.8 1.8 6.9c0 1.2.7 2.2 1.8 2.9l-.4 1.3 1.5-.8c.6.2 1.2.3 2 .3 2.8 0 4.9-1.6 4.9-3.7S9.5 3.2 6.7 3.2Z"
          fill="currentColor"
          opacity="0.95"
        />
        <path
          d="M9.8 6.6c2.4 0 4.4 1.4 4.4 3.3 0 1-.6 1.9-1.5 2.5l.3 1.1-1.3-.7c-.5.2-1.1.3-1.8.3-2.4 0-4.4-1.4-4.4-3.2 0-1.9 1.9-3.3 4.3-3.3Z"
          fill="currentColor"
          opacity="0.55"
        />
        <circle cx="5.1" cy="6.5" r="0.45" fill="white" />
        <circle cx="8" cy="6.5" r="0.45" fill="white" />
      </svg>
    </span>
  );
}

// ─── Avatar with optional online dot ────────────────────────────────────────

function ConversationAvatar({
  name,
  color,
  online,
}: {
  name: string;
  color: string;
  online: boolean;
}) {
  const initial = name.slice(0, 1);

  return (
    <div className="relative shrink-0">
      <div
        className="grid size-[46px] place-items-center rounded-xl text-[16px] font-medium text-[#243041] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.45)]"
        style={{ background: color }}
      >
        {initial}
      </div>
      {online && (
        <span
          aria-hidden
          className="absolute bottom-0 right-0 size-2.5 rounded-full border-2 border-white bg-[#10B981]"
        />
      )}
    </div>
  );
}
