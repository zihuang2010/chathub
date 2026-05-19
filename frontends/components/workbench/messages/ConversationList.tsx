import { memo, useCallback, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ChevronDown, Menu, Search } from "lucide-react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { useVirtualizer } from "@tanstack/react-virtual";

import type { Account } from "@/lib/types/account";
import { cn } from "@/lib/utils";

import { AccountDropdown } from "./AccountDropdown";
import { ConversationAvatar } from "./Avatar";
import type { Conversation } from "./data";
import { STRINGS } from "./strings";
import { extractAccountOperator } from "./utils";
import { WorkbenchScrollArea } from "./WorkbenchScrollArea";

type StatusTab = "all" | "unread" | "mentioned";

interface ConversationListProps {
  conversations: Conversation[];
  selectedId: string;
  onSelect: (id: string) => void;
  /** 右键菜单切换"置顶/取消置顶"。next 是切换后的目标态。
   *  乐观更新由后端 ChangeNotice → useResource refetch 接管,这里不必维护本地状态。 */
  onTogglePin?: (id: string, next: boolean) => void | Promise<void>;
  /** 右键菜单"移除会话"。V11 后端持久化软删除;新消息严格晚于 removed_at_ms 时自动恢复。 */
  onRemove?: (id: string) => void;
  width: number;
  accounts: readonly Account[];
  selectedAccount: string | null;
  onAccountChange: (account: string | null) => void;
  /** 搜索框右边的辅助 slot,目前用于挂同步状态色点。 */
  syncSlot?: ReactNode;
}

export const ConversationList = memo(function ConversationList({
  conversations,
  selectedId,
  onSelect,
  onTogglePin,
  onRemove,
  width,
  accounts,
  selectedAccount,
  onAccountChange,
  syncSlot,
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
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <SearchBar value={searchQuery} onChange={setSearchQuery} compact={isCompact} />
          </div>
          {syncSlot}
        </div>
        <FilterToolbar
          statusTab={statusTab}
          onStatusChange={setStatusTab}
          accounts={accounts}
          selectedAccount={selectedAccount}
          onAccountChange={onAccountChange}
          accountPickerOpen={accountPickerOpen}
          onAccountPickerOpenChange={setAccountPickerOpen}
        />
      </div>

      <VirtualizedList
        items={filteredConversations}
        selectedId={selectedId}
        onSelect={onSelect}
        onTogglePin={onTogglePin}
        onRemove={onRemove}
      />
    </div>
  );
});

// ─── Virtualized list body ──────────────────────────────────────────────────
// @tanstack/react-virtual 跑在 WorkbenchScrollArea 上层:接管"哪些 item 渲染 +
// 总高度 spacer";仍由 WorkbenchScrollArea 的 viewport 提供 native scroll 行为
// 与 ScrollMetrics 上报通道(后续若 ChatArea 模式的 anchor / unread divider
// 需要接入,直接复用)。
//
// 高度策略:estimateSize=64(行 py-2 + 内容 ~48px 头像 ≈ 64px),measureElement
// 自动测量真实高度修正 scrollbar 拇指。overscan=8(上下各预渲染 8 条,滚动时
// 接 fill 充裕,避免边缘闪空白)。
const ROW_ESTIMATE_PX = 64;

const VirtualizedList = memo(function VirtualizedList({
  items,
  selectedId,
  onSelect,
  onTogglePin,
  onRemove,
}: {
  items: Conversation[];
  selectedId: string;
  onSelect: (id: string) => void;
  onTogglePin?: (id: string, next: boolean) => void | Promise<void>;
  onRemove?: (id: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const setScrollViewport = useCallback((node: HTMLDivElement | null) => {
    if (node) scrollRef.current = node;
  }, []);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE_PX,
    overscan: 8,
    // 用 conversation.id 作 stable key,切账号/搜索后顺序变化时 react-virtual
    // 仍能正确按 index 复用已测尺寸。
    getItemKey: (index) => items[index]?.id ?? index,
  });

  if (items.length === 0) {
    return (
      <WorkbenchScrollArea className="flex-1" viewportClassName="pb-1.5 pt-0.5 pr-2">
        <div className="px-5 py-8 text-center text-wb-2xs text-workbench-text-muted">
          {STRINGS.conversationList.noConversation}
        </div>
      </WorkbenchScrollArea>
    );
  }

  return (
    <WorkbenchScrollArea
      className="flex-1"
      viewportClassName="pb-1.5 pt-0.5 pr-2"
      scrollRef={setScrollViewport}
    >
      <div
        style={{
          height: virtualizer.getTotalSize(),
          position: "relative",
          width: "100%",
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const c = items[virtualRow.index];
          if (!c) return null;
          return (
            <div
              key={c.id}
              ref={virtualizer.measureElement}
              data-index={virtualRow.index}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <ConversationItem
                conversation={c}
                selected={c.id === selectedId}
                onSelect={onSelect}
                onTogglePin={onTogglePin}
                onRemove={onRemove}
              />
            </div>
          );
        })}
      </div>
    </WorkbenchScrollArea>
  );
});

// ─── Search and secondary filters ───────────────────────────────────────────

const SearchBar = memo(function SearchBar({
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
        className="min-w-0 flex-1 bg-transparent text-wb-2xs font-medium text-workbench-text focus:outline-none"
      />
    </div>
  );
});

const FilterToolbar = memo(function FilterToolbar({
  statusTab,
  onStatusChange,
  accounts,
  selectedAccount,
  onAccountChange,
  accountPickerOpen,
  onAccountPickerOpenChange,
}: {
  statusTab: StatusTab;
  onStatusChange: (value: StatusTab) => void;
  accounts: readonly Account[];
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
    <div className="flex h-9 min-w-0 items-center gap-1 text-wb-3xs font-medium text-workbench-text-secondary">
      <div
        role="tablist"
        aria-label={STRINGS.conversationList.statusTabsLabel}
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto pr-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <AccountDropdown
          accounts={accounts}
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
});

// ─── Single conversation row ────────────────────────────────────────────────

const ConversationItem = memo(function ConversationItem({
  conversation,
  selected,
  onSelect,
  onTogglePin,
  onRemove,
}: {
  conversation: Conversation;
  selected: boolean;
  onSelect: (id: string) => void;
  onTogglePin?: (id: string, next: boolean) => void | Promise<void>;
  onRemove?: (id: string) => void;
}) {
  const { id, name, avatarColor, preview, account, time, unread, online, draftText, pinned } =
    conversation;
  const isPinned = pinned === true;

  const row = (
    <button
      type="button"
      onClick={() => onSelect(id)}
      className={cn(
        "focus-ring group relative mx-2 grid w-[calc(100%-1rem)] grid-cols-[44px_minmax(0,1fr)] items-start gap-3 overflow-hidden rounded-xl px-3 py-2 text-left transition-colors",
        // 置顶视觉指示已经搬到头像左上 pin 徽标,行本体只有选中/默认两态。
        selected ? "bg-workbench-surface-active" : "hover:bg-workbench-surface-subtle",
      )}
    >
      <div className="relative mt-1">
        <ConversationAvatar name={name} color={avatarColor} online={online} pinned={isPinned} />
      </div>
      <div className="min-w-0 pr-11 pt-px">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-wb-xs font-medium text-workbench-text">{name}</span>
          <span className="shrink-0 rounded px-1 py-px text-wb-3xs font-medium text-workbench-wechat-text">
            {STRINGS.header.fromWeChat}
          </span>
        </div>
        <div className="mt-0.5 truncate text-wb-2xs font-medium text-workbench-text-muted">
          {draftText ? (
            <>
              <span className="mr-1 font-medium text-rose-500">
                {STRINGS.conversationList.draftPrefix}
              </span>
              <span className="text-workbench-text-secondary">{draftText}</span>
            </>
          ) : (
            <>
              {unread > 0 && (
                // 与 preview 同色(muted),仅作"未读"语义标签;红色由右侧数字徽标承担。
                <span className="mr-1 font-medium">{STRINGS.conversationList.unreadPrefix}</span>
              )}
              {preview}
            </>
          )}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-wb-3xs">
          <span className="shrink-0 font-medium text-workbench-text-muted">
            {STRINGS.conversationList.fromShort}
          </span>
          <span className="min-w-0 truncate font-medium text-workbench-text-secondary">
            {account}
          </span>
        </div>
      </div>
      <span className="wb-num absolute right-3 top-2.5 w-11 text-right text-wb-3xs text-workbench-text-muted">
        {time}
      </span>
      {unread > 0 && (
        // 圆点 → 数字徽标:1-2 位居中圆形,3 位(99+)自动横向撑出胶囊形。
        // 与 preview 前缀 [未读] 互补:文字表状态、数字表量级;尺寸刻意 14×14 (text-[9px])
        // 让数字徽标"知趣",不与文本流抢眼。bottom-5 比原 bottom-3 微抬 8px,落在
        // preview 行与 from 行之间,不贴底也不顶第二行。
        <span
          aria-label={STRINGS.conversationList.unreadCount(unread)}
          className="wb-num absolute bottom-5 right-3 grid h-[14px] min-w-[14px] place-items-center rounded-full bg-workbench-unread px-1 text-[9px] font-semibold leading-none text-white"
        >
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </button>
  );

  // 没有任何菜单操作可用时退化为纯 button,避免 mock/占位环境下闪一个空菜单。
  if (!onTogglePin && !onRemove) return row;

  const itemClassName = cn(
    "cursor-default rounded px-2 py-1.5 text-wb-2xs text-workbench-text outline-none transition-colors",
    "data-[highlighted]:bg-workbench-surface-subtle",
  );

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{row}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className="z-30 min-w-[140px] overflow-hidden rounded-md border border-workbench-line bg-workbench-surface p-1 shadow-wb-popover"
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          {onTogglePin && (
            <ContextMenu.Item
              onSelect={() => void onTogglePin(id, !isPinned)}
              className={itemClassName}
            >
              {isPinned
                ? STRINGS.conversationList.contextUnpin
                : STRINGS.conversationList.contextPin}
            </ContextMenu.Item>
          )}
          {onRemove && (
            <ContextMenu.Item
              onSelect={() => onRemove(id)}
              className={cn(itemClassName, "text-workbench-danger")}
            >
              {STRINGS.conversationList.contextRemove}
            </ContextMenu.Item>
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
});
