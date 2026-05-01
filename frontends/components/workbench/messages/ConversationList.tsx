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

      <div className="flex-1 overflow-y-auto py-1">
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
              "inline-flex h-6 items-center gap-1 rounded px-2 transition-colors",
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
        className="ml-auto grid size-6 place-items-center rounded text-[#6B7280] transition-colors hover:bg-[#F5F8FF] hover:text-[#2563EB]"
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
        "group relative flex w-full items-center gap-3 px-3 py-3 text-left transition-colors",
        selected ? "bg-[#EAF2FF]" : "hover:bg-[#F7FAFF]",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute bottom-3 left-0 top-3 w-[2px] rounded-r-full transition-colors",
          selected ? "bg-[#2196FA]" : "bg-transparent group-hover:bg-[#BFDBFE]",
        )}
      />
      <ConversationAvatar name={name} color={avatarColor} online={online} />
      <div className="min-w-0 flex-1">
        <ConversationMetaLine name={name} account={account} time={time} />
        <div className="mt-1 flex items-center justify-between gap-2">
          <span className="truncate text-[12px] leading-[1.35] text-[#6B7280]">{preview}</span>
          {unread > 0 && (
            <span className="grid h-[16px] min-w-[16px] shrink-0 place-items-center rounded-full bg-[#EF4444] px-1 text-[10px] font-semibold leading-none text-white shadow-[0_1px_2px_rgba(239,68,68,0.28)]">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </div>
      </div>
    </button>
  );
});

function ConversationMetaLine({
  name,
  account,
  time,
}: {
  name: string;
  account: string;
  time: string;
}) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="truncate text-[13.5px] font-medium leading-[18px] text-[#1F2937]">
          {name}
        </span>
        <span className="shrink-0 rounded bg-[#ECFDF3] px-1.5 py-px text-[10px] font-semibold leading-[15px] text-[#059669]">
          @微信
        </span>
        <span className="min-w-0 truncate text-[11px] font-medium leading-[16px] text-[#2563EB]">
          {account}
        </span>
      </div>
      <span className="shrink-0 text-[11px] leading-[16px] text-[#9CA3AF]">{time}</span>
    </div>
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
        className="grid size-11 place-items-center rounded-xl text-[15px] font-semibold text-[#1F2937] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.48)]"
        style={{ background: color }}
      >
        {initial}
      </div>
      {online && (
        <span
          aria-hidden
          className="absolute bottom-[-2px] right-[-2px] size-2 rounded-full border-2 border-white bg-[#10B981]"
        />
      )}
    </div>
  );
}
