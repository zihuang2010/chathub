import { memo, useMemo, useState } from "react";
import { ChevronDown, Menu, Search } from "lucide-react";

import {
  WORKBENCH_BLUE,
  WORKBENCH_LINE,
  WORKBENCH_LINE_STRONG,
  WORKBENCH_NUMERIC_FONT,
  WORKBENCH_SOFT_BG,
  WORKBENCH_TEXT_MUTED,
  WORKBENCH_TEXT_PRIMARY,
  WORKBENCH_TEXT_SECONDARY,
} from "@/lib/theme";
import { cn } from "@/lib/utils";

import type { Conversation } from "./data";
import { WorkbenchScrollArea } from "./WorkbenchScrollArea";

// ─── Types & static data ────────────────────────────────────────────────────

type StatusTab = "all" | "unread" | "mentioned";

// ─── Component ──────────────────────────────────────────────────────────────

interface ConversationListProps {
  conversations: Conversation[];
  selectedId: string;
  onSelect: (id: string) => void;
  width: number;
  accountOptions: string[];
  selectedAccount: string | null;
  onAccountChange: (account: string | null) => void;
}

export const ConversationList = memo(function ConversationList({
  conversations,
  selectedId,
  onSelect,
  width,
  accountOptions,
  selectedAccount,
  onAccountChange,
}: ConversationListProps) {
  const [statusTab, setStatusTab] = useState<StatusTab>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [accountPickerOpen, setAccountPickerOpen] = useState(false);
  const isCompact = width < 300;

  const filteredConversations = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();

    return conversations.filter((conversation) => {
      if (statusTab === "unread" && conversation.unread <= 0) return false;
      if (selectedAccount && conversation.account !== selectedAccount) return false;
      if (!normalizedQuery) return true;

      return [conversation.name, conversation.account, conversation.preview].some((value) =>
        value.toLowerCase().includes(normalizedQuery),
      );
    });
  }, [conversations, searchQuery, selectedAccount, statusTab]);

  return (
    <div className="flex h-full shrink-0 flex-col bg-white" style={{ width }}>
      <div className="relative flex flex-col gap-2 px-3 pb-1.5 pt-3">
        <SearchBar value={searchQuery} onChange={setSearchQuery} compact={isCompact} />
        <FilterToolbar
          statusTab={statusTab}
          onStatusChange={setStatusTab}
          selectedAccount={selectedAccount}
          onAccountClick={() => setAccountPickerOpen((open) => !open)}
        />
        {accountPickerOpen && (
          <AccountPicker
            accounts={accountOptions}
            selectedAccount={selectedAccount}
            onSelect={(account) => {
              onAccountChange(account);
              setAccountPickerOpen(false);
            }}
          />
        )}
      </div>

      <WorkbenchScrollArea
        className="flex-1"
        viewportClassName="pb-1.5 pt-0.5 pr-2"
        contentClassName="min-h-full"
      >
        {filteredConversations.length > 0 ? (
          filteredConversations.map((c) => (
            <ConversationItem
              key={c.id}
              conversation={c}
              selected={c.id === selectedId}
              onSelect={onSelect}
            />
          ))
        ) : (
          <div className="px-5 py-8 text-center text-[12px] text-[#9CA3AF]">暂无匹配会话</div>
        )}
      </WorkbenchScrollArea>
    </div>
  );
});

// ─── Search and secondary filters ───────────────────────────────────────────

function SearchBar({
  value,
  onChange,
  compact,
}: {
  value: string;
  onChange: (value: string) => void;
  compact: boolean;
}) {
  return (
    <div
      className="flex h-9 items-center gap-2 rounded-lg border bg-white px-2.5 transition-colors focus-within:ring-2 focus-within:ring-[#2563EB]/10"
      style={{ borderColor: WORKBENCH_LINE, color: WORKBENCH_TEXT_MUTED }}
    >
      <Search size={15} className="shrink-0" />
      <input
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={compact ? "搜索客户" : "搜索客户 / 账号"}
        className="min-w-0 flex-1 bg-transparent text-[12px] font-medium focus:outline-none"
        style={{ color: WORKBENCH_TEXT_PRIMARY }}
      />
    </div>
  );
}

function FilterToolbar({
  statusTab,
  onStatusChange,
  selectedAccount,
  onAccountClick,
}: {
  statusTab: StatusTab;
  onStatusChange: (value: StatusTab) => void;
  selectedAccount: string | null;
  onAccountClick: () => void;
}) {
  const accountParts = selectedAccount?.split("-");
  const selectedAccountLabel = accountParts
    ? accountParts[accountParts.length - 1] || selectedAccount
    : null;
  const accountLabel = selectedAccountLabel ?? "账号";
  const statusTabs: { value: StatusTab; label: string }[] = [
    { value: "all", label: "全部" },
    { value: "unread", label: "未读" },
    { value: "mentioned", label: "@我" },
  ];

  return (
    <div
      className="flex h-8 min-w-0 items-center gap-1 text-[11px] font-medium"
      style={{ color: WORKBENCH_TEXT_SECONDARY }}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto pr-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <button
          type="button"
          onClick={onAccountClick}
          className={cn(
            "inline-flex h-[30px] max-w-[96px] shrink-0 items-center gap-1 rounded-md px-2 transition-colors",
            selectedAccount
              ? "bg-[#EAF2FF] text-[#2563EB]"
              : "hover:bg-[#EAF2FF] hover:text-[#2563EB]",
          )}
          style={
            !selectedAccount
              ? { background: WORKBENCH_SOFT_BG, color: WORKBENCH_TEXT_PRIMARY }
              : undefined
          }
          title={selectedAccount ?? "全部账号"}
        >
          <span className="min-w-0 truncate">{accountLabel}</span>
          <ChevronDown size={12} className="shrink-0 text-current opacity-70" />
        </button>
        {statusTabs.map((tab) => {
          const active = tab.value === statusTab;
          return (
            <button
              key={tab.value}
              type="button"
              onClick={() => onStatusChange(tab.value)}
              className={cn(
                "inline-flex h-[30px] shrink-0 items-center rounded-md px-2 transition-colors",
                active ? "bg-[#EAF2FF] text-[#2563EB]" : "hover:bg-[#F7FAFD] hover:text-[#1F2937]",
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      <button
        type="button"
        aria-label="筛选"
        title="筛选"
        className="grid size-[30px] shrink-0 place-items-center rounded-md transition-colors hover:bg-[#F7FAFD] hover:text-[#2563EB]"
        style={{ color: WORKBENCH_TEXT_SECONDARY }}
      >
        <Menu size={18} strokeWidth={2} />
      </button>
    </div>
  );
}

function AccountPicker({
  accounts,
  selectedAccount,
  onSelect,
}: {
  accounts: string[];
  selectedAccount: string | null;
  onSelect: (account: string | null) => void;
}) {
  return (
    <div
      className="absolute left-3 right-3 top-full z-20 mt-1 rounded-lg border bg-white p-2 shadow-[0_12px_32px_rgba(15,23,42,0.10)]"
      style={{ borderColor: WORKBENCH_LINE }}
    >
      <div className="mb-1 px-1 text-[12px] font-medium" style={{ color: WORKBENCH_TEXT_PRIMARY }}>
        按账号筛选
      </div>
      <AccountOption active={!selectedAccount} label="全部账号" onClick={() => onSelect(null)} />
      {accounts.map((account) => (
        <AccountOption
          key={account}
          active={selectedAccount === account}
          label={account}
          onClick={() => onSelect(account)}
        />
      ))}
    </div>
  );
}

function AccountOption({
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
      className={cn(
        "group relative mx-2 my-0.5 grid w-[calc(100%-1rem)] grid-cols-[44px_minmax(0,1fr)] items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors",
        selected ? "bg-[#EAF2FF]" : "hover:bg-[#F7FAFD]",
      )}
    >
      <ConversationAvatar name={name} color={avatarColor} online={online} />
      <div className="min-w-0 pr-11 pt-px">
        <div className="flex min-w-0 items-center">
          <span
            className="truncate text-[13.5px] font-medium leading-[18px]"
            style={{ color: WORKBENCH_TEXT_PRIMARY }}
          >
            {name}
          </span>
        </div>
        <div
          className="mt-0.5 truncate text-[12px] font-normal leading-[17px]"
          style={{ color: WORKBENCH_TEXT_MUTED }}
        >
          {preview}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] font-medium leading-[15px]">
          <span className="shrink-0" style={{ color: WORKBENCH_TEXT_MUTED }}>
            来自
          </span>
          <span className="min-w-0 truncate font-medium" style={{ color: WORKBENCH_BLUE }}>
            {account}
          </span>
          <WeChatBadge />
        </div>
      </div>
      <span
        className="absolute right-3 top-3 w-11 text-right text-[11px] tabular-nums leading-[16px]"
        style={{ color: WORKBENCH_TEXT_MUTED, fontFamily: WORKBENCH_NUMERIC_FONT }}
      >
        {time}
      </span>
      {unread > 0 && (
        <span className="absolute right-3 top-1/2 grid h-4 min-w-4 translate-y-[-10%] place-items-center rounded-full bg-[#EF4444] px-1 text-[10px] font-semibold tabular-nums leading-none text-white shadow-[0_1px_2px_rgba(239,68,68,0.24)]">
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
        className="grid size-11 place-items-center rounded-xl text-[15px] font-medium shadow-[inset_0_0_0_1px_rgba(255,255,255,0.45)]"
        style={{ background: color, color: WORKBENCH_TEXT_PRIMARY }}
      >
        {initial}
      </div>
      {online && (
        <span
          aria-hidden
          className="absolute bottom-0 right-0 size-2.5 rounded-full border-2 bg-[#10B981]"
          style={{ borderColor: WORKBENCH_LINE_STRONG }}
        />
      )}
    </div>
  );
}
