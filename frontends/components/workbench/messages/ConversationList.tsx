import { memo, useMemo, useState } from "react";
import { ChevronDown, Menu, Search } from "lucide-react";

import { cn } from "@/lib/utils";

import { AccountDropdown } from "./AccountDropdown";
import { ConversationAvatar } from "./Avatar";
import type { Conversation } from "./data";
import { STRINGS } from "./strings";
import { extractAccountOperator } from "./utils";
import { WeChatBadge } from "./WeChatBadge";
import { WorkbenchScrollArea } from "./WorkbenchScrollArea";

type StatusTab = "all" | "unread" | "mentioned";

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
    <div className="flex h-full shrink-0 flex-col bg-workbench-surface" style={{ width }}>
      <div className="flex flex-col gap-2 px-3 pb-1.5 pt-3">
        <SearchBar value={searchQuery} onChange={setSearchQuery} compact={isCompact} />
        <FilterToolbar
          statusTab={statusTab}
          onStatusChange={setStatusTab}
          accountOptions={accountOptions}
          selectedAccount={selectedAccount}
          onAccountChange={onAccountChange}
          accountPickerOpen={accountPickerOpen}
          onAccountPickerOpenChange={setAccountPickerOpen}
        />
      </div>

      <WorkbenchScrollArea className="flex-1" viewportClassName="pb-1.5 pt-0.5 pr-2">
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
          <div className="px-5 py-8 text-center text-[12px] text-workbench-text-muted">
            {STRINGS.conversationList.noConversation}
          </div>
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
    <div className="flex h-9 items-center gap-2 rounded-lg border border-workbench-line bg-workbench-surface px-2.5 text-workbench-text-muted transition-colors focus-within:border-workbench-accent/40 focus-within:ring-2 focus-within:ring-workbench-accent/20">
      <Search size={15} className="shrink-0" />
      <input
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={
          compact
            ? STRINGS.conversationList.searchPlaceholderCompact
            : STRINGS.conversationList.searchPlaceholder
        }
        className="min-w-0 flex-1 bg-transparent text-[12px] font-medium text-workbench-text focus:outline-none"
      />
    </div>
  );
}

function FilterToolbar({
  statusTab,
  onStatusChange,
  accountOptions,
  selectedAccount,
  onAccountChange,
  accountPickerOpen,
  onAccountPickerOpenChange,
}: {
  statusTab: StatusTab;
  onStatusChange: (value: StatusTab) => void;
  accountOptions: string[];
  selectedAccount: string | null;
  onAccountChange: (account: string | null) => void;
  accountPickerOpen: boolean;
  onAccountPickerOpenChange: (open: boolean) => void;
}) {
  const accountLabel = selectedAccount
    ? extractAccountOperator(selectedAccount)
    : STRINGS.conversationList.accountFallback;
  const statusTabs: { value: StatusTab; label: string }[] = [
    { value: "all", label: STRINGS.conversationList.statusAll },
    { value: "unread", label: STRINGS.conversationList.statusUnread },
    { value: "mentioned", label: STRINGS.conversationList.statusMentioned },
  ];

  return (
    <div className="flex h-9 min-w-0 items-center gap-1 text-[11px] font-medium text-workbench-text-secondary">
      <div
        role="tablist"
        aria-label={STRINGS.conversationList.statusTabsLabel}
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto pr-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <AccountDropdown
          accounts={accountOptions}
          selectedAccount={selectedAccount}
          onSelect={onAccountChange}
          open={accountPickerOpen}
          onOpenChange={onAccountPickerOpenChange}
          title={STRINGS.conversationList.accountFilterTitle}
        >
          <button
            type="button"
            aria-haspopup="listbox"
            aria-expanded={accountPickerOpen}
            className={cn(
              "focus-ring inline-flex h-9 max-w-[96px] shrink-0 items-center gap-1 rounded-md px-2 transition-colors",
              selectedAccount
                ? "bg-workbench-surface-active text-workbench-accent"
                : "bg-workbench-surface-soft text-workbench-text hover:bg-workbench-surface-active hover:text-workbench-accent",
            )}
            title={selectedAccount ?? STRINGS.rangePill.allAccountsBare}
          >
            <span className="min-w-0 truncate">{accountLabel}</span>
            <ChevronDown size={12} className="shrink-0 text-current opacity-70" />
          </button>
        </AccountDropdown>
        {statusTabs.map((tab) => {
          const active = tab.value === statusTab;
          return (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => onStatusChange(tab.value)}
              className={cn(
                "focus-ring inline-flex h-9 shrink-0 items-center rounded-md px-2 transition-colors",
                active
                  ? "bg-workbench-surface-active text-workbench-accent"
                  : "hover:bg-workbench-surface-subtle hover:text-workbench-text",
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      <button
        type="button"
        aria-label={STRINGS.conversationList.filter}
        title={STRINGS.conversationList.filter}
        className="focus-ring grid size-9 shrink-0 place-items-center rounded-md text-workbench-text-secondary transition-colors hover:bg-workbench-surface-subtle hover:text-workbench-accent"
      >
        <Menu size={18} strokeWidth={2} />
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
      className={cn(
        "focus-ring group relative mx-2 my-0.5 grid w-[calc(100%-1rem)] grid-cols-[44px_minmax(0,1fr)] items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors",
        selected ? "bg-workbench-surface-active" : "hover:bg-workbench-surface-subtle",
      )}
    >
      <ConversationAvatar name={name} color={avatarColor} online={online} />
      <div className="min-w-0 pr-11 pt-px">
        <div className="flex min-w-0 items-center">
          <span className="truncate text-[13.5px] font-medium leading-[18px] text-workbench-text">
            {name}
          </span>
        </div>
        <div className="mt-0.5 truncate text-[11.5px] font-normal leading-[17px] text-workbench-text-muted/70">
          {unread > 0 && (
            <span className="font-numeric tabular-nums">
              {STRINGS.conversationList.unreadPreviewPrefix(unread)}
            </span>
          )}
          {preview}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] font-medium leading-[15px]">
          <span className="shrink-0 text-workbench-text-muted">
            {STRINGS.conversationList.fromShort}
          </span>
          <span className="min-w-0 truncate font-medium text-workbench-text">{account}</span>
          <WeChatBadge />
        </div>
      </div>
      <span className="absolute right-3 top-3 w-11 text-right font-numeric text-[11px] tabular-nums leading-[16px] text-workbench-text-muted">
        {time}
      </span>
      {unread > 0 && (
        <span
          aria-label={STRINGS.conversationList.unreadCount(unread)}
          className="absolute bottom-4 right-3 size-2 rounded-full bg-workbench-unread/85"
        />
      )}
    </button>
  );
});
