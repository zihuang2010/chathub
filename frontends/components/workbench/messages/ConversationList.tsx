import { memo, useCallback, useMemo, useRef, useState } from "react";
import { BellOff, ChevronDown, Menu } from "lucide-react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { useVirtualizer } from "@tanstack/react-virtual";

import type { Account } from "@/lib/types/account";
import type { WecomFriend } from "@/lib/api/customers";
import { cn } from "@/lib/utils";

import { AccountDropdown } from "./AccountDropdown";
import { ConversationAvatar } from "./Avatar";
import type { Conversation } from "./data";
import { MessagesContactSearch } from "./MessagesContactSearch";
import { SkeletonRow } from "./MessagesSkeleton";
import { STRINGS } from "./strings";
import { extractAccountOperator } from "./utils";
import { WorkbenchScrollArea, type ScrollMetrics } from "./WorkbenchScrollArea";

const WECOM_SOURCE_LOGO = "/wecom-logo.png";

export type StatusTab = "all" | "unread" | "mentioned";

interface ConversationListProps {
  conversations: Conversation[];
  selectedId: string;
  onSelect: (id: string) => void;
  /** 右键菜单切换"置顶/取消置顶"。next 是切换后的目标态。
   *  乐观更新由后端 ChangeNotice → useResource refetch 接管,这里不必维护本地状态。 */
  onTogglePin?: (id: string, next: boolean) => void | Promise<void>;
  /** 右键菜单切换"消息免打扰/取消免打扰"。next 是切换后的目标态。乐观更新由后端 ChangeNotice → refetch 接管。 */
  onToggleMute?: (id: string, next: boolean) => void | Promise<void>;
  /** 右键菜单"移除会话"。V11 后端持久化软删除;新消息严格晚于 removed_at_ms 时自动恢复。 */
  onRemove?: (id: string) => void;
  width: number;
  accounts: readonly Account[];
  /** 选中账号的 `account.id`(= wecomAccountId),`null` = 全部。展示名按 id 反查 accounts。 */
  selectedAccountId: string | null;
  onAccountChange: (accountId: string | null) => void;
  /** 会话状态筛选(全部/未读/@我)。状态提升到父级:从搜索框/客户页打开会话时父级一并重置回"全部",
   *  避免停留在"未读"标签时,打开的(已读)会话被过滤掉而"看不见"。 */
  statusTab: StatusTab;
  onStatusChange: (value: StatusTab) => void;
  /** 滚动到底加载更老会话(默认列表续页 / 筛选态续页,由父级按当前态分派)。
   *  是否真的还有更多由父级 hook 内部 cursor/hasMore 自守(到底即 no-op),这里不再重复 gate。
   *  不传 = 不分页(退化为只展示传入的 conversations,与历史行为一致)。 */
  onLoadMore?: () => void;
  /** 分页请求 in-flight,期间不重复触发 onLoadMore。 */
  loading?: boolean;
  /** 搜索下拉里点击某个客户:父级解析「客户 → 会话」并打开。 */
  onOpenCustomer: (friend: WecomFriend) => void;
  /** 搜索框清空:父级据此退出 filtered 态(若有)回默认列表。 */
  onClearSearch: () => void;
  /** 切账号筛选后、新账号列表尚未返回的窗口期。为真时列表主体渲染骨架行(顶部搜索框/筛选条仍可见),
   *  避免"旧账号列表残留一瞬再突变"的闪烁。来自 useRecentFriends.switching。 */
  switching?: boolean;
}

export const ConversationList = memo(function ConversationList({
  conversations,
  selectedId,
  onSelect,
  onTogglePin,
  onToggleMute,
  onRemove,
  width,
  accounts,
  selectedAccountId,
  onAccountChange,
  statusTab,
  onStatusChange,
  onLoadMore,
  loading,
  onOpenCustomer,
  onClearSearch,
  switching,
}: ConversationListProps) {
  const [accountPickerOpen, setAccountPickerOpen] = useState(false);

  // 顶部搜索框已改为「搜客户 → 下拉 → 点击打开会话」(MessagesContactSearch),不再就地过滤会话
  // 列表。这里只按 status tab(未读)过滤;账号过滤由后端 list_recent_friends(accountFilter)
  // 负责(切账号时 stale-while-revalidate,前端不再二次过滤以免闪空)。
  const filteredConversations = useMemo(() => {
    if (statusTab !== "unread") return conversations;
    return conversations.filter((conversation) => conversation.unread > 0);
  }, [conversations, statusTab]);

  return (
    <div className="flex h-full shrink-0 flex-col bg-workbench-surface" style={{ width }}>
      <div className="flex flex-col gap-2 px-3 pb-1.5 pt-3">
        <MessagesContactSearch
          accounts={accounts}
          onOpenCustomer={onOpenCustomer}
          onClear={onClearSearch}
        />
        <FilterToolbar
          statusTab={statusTab}
          onStatusChange={onStatusChange}
          accounts={accounts}
          selectedAccountId={selectedAccountId}
          onAccountChange={onAccountChange}
          accountPickerOpen={accountPickerOpen}
          onAccountPickerOpenChange={setAccountPickerOpen}
        />
      </div>

      {switching ? (
        <ConversationListSkeleton />
      ) : (
        <VirtualizedList
          items={filteredConversations}
          selectedId={selectedId}
          onSelect={onSelect}
          onTogglePin={onTogglePin}
          onToggleMute={onToggleMute}
          onRemove={onRemove}
          onLoadMore={onLoadMore}
          loading={loading}
        />
      )}
    </div>
  );
});

// 切账号过渡期的列表骨架:复用首屏 SkeletonRow,padding 对齐 VirtualizedList 的滚动视口
// (pl-3 pr-2 pt-0.5 pb-1.5),数据到位切回真列表时不产生 layout shift。行数固定取首屏窗口
// 大致可见的条数。
const SWITCHING_SKELETON_ROWS = 8;
function ConversationListSkeleton() {
  return (
    <div className="flex-1 overflow-hidden pb-1.5 pl-3 pr-2 pt-0.5" aria-hidden>
      <div className="flex flex-col gap-1">
        {Array.from({ length: SWITCHING_SKELETON_ROWS }).map((_, i) => (
          <SkeletonRow key={i} />
        ))}
      </div>
    </div>
  );
}

// ─── Virtualized list body ──────────────────────────────────────────────────
// @tanstack/react-virtual 跑在 WorkbenchScrollArea 上层:接管"哪些 item 渲染 +
// 总高度 spacer";仍由 WorkbenchScrollArea 的 viewport 提供 native scroll 行为
// 与 ScrollMetrics 上报通道(后续若 ChatArea 模式的 anchor / unread divider
// 需要接入,直接复用)。
//
// 高度策略:estimateSize≈行内容 56 + ROW_GAP_PX 间隔 ≈ 60,measureElement
// 自动测量真实高度修正 scrollbar 拇指。overscan=8(上下各预渲染 8 条,滚动时
// 接 fill 充裕,避免边缘闪空白)。
//
// ROW_GAP_PX:卡片间留白。以每行 wrapper 的 padding-bottom 实现 —— measureElement
// 测的是 wrapper 的 border-box 高度(含 padding),故 totalSize / start 偏移会自动
// 把间隔算进去,行与行之间留出透明缝隙,卡片不再贴死。
const ROW_GAP_PX = 4;
const ROW_ESTIMATE_PX = 60;
// 距底 ≤ 该像素(约 4 行卡片缓冲)即触发翻更老一页。
const LOAD_MORE_BOTTOM_THRESHOLD_PX = 240;

const VirtualizedList = memo(function VirtualizedList({
  items,
  selectedId,
  onSelect,
  onTogglePin,
  onToggleMute,
  onRemove,
  onLoadMore,
  loading,
}: {
  items: Conversation[];
  selectedId: string;
  onSelect: (id: string) => void;
  onTogglePin?: (id: string, next: boolean) => void | Promise<void>;
  onToggleMute?: (id: string, next: boolean) => void | Promise<void>;
  onRemove?: (id: string) => void;
  onLoadMore?: () => void;
  loading?: boolean;
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

  const virtualItems = virtualizer.getVirtualItems();
  // 距底阈值内 → 拉更老一页。**只挂 onUserScroll(原生 scroll 事件),不挂 onScrollMetrics**:
  // 后者还会被 WorkbenchScrollArea 的 ResizeObserver/MutationObserver 重排 emit 触发,翻页后
  // 若新页被 dedupe 掉(items 不增长)会再次命中"距底阈值内"→ 无限重拉(历史 BUG:接待列表
  // 向下滑无休止循环)。改为仅用户主动滚动触发后,翻页完成不会自激重入。
  //   - scrollTop>0 守卫:短列表全可见、mount 即贴底但未滚动时不误拉(首调会播种远端 cursor)。
  //   - loading 期间不重复触发;是否真的还有更多由 hook 内部 cursor/hasMore 自守(到底即 no-op)。
  const handleNearBottom = useCallback(
    (m: ScrollMetrics) => {
      if (!onLoadMore || loading) return;
      if (m.scrollTop <= 0) return;
      if (m.scrollHeight - m.scrollTop - m.clientHeight > LOAD_MORE_BOTTOM_THRESHOLD_PX) return;
      onLoadMore();
    },
    [onLoadMore, loading],
  );

  if (items.length === 0) {
    return (
      <WorkbenchScrollArea className="flex-1" viewportClassName="pb-1.5 pt-0.5 pl-3 pr-2">
        <div className="px-5 py-8 text-center text-wb-2xs text-workbench-text-muted">
          {STRINGS.conversationList.noConversation}
        </div>
      </WorkbenchScrollArea>
    );
  }

  return (
    <WorkbenchScrollArea
      className="flex-1"
      viewportClassName="pb-1.5 pt-0.5 pl-3 pr-2"
      scrollRef={setScrollViewport}
      onUserScroll={handleNearBottom}
    >
      <div
        style={{
          height: virtualizer.getTotalSize(),
          position: "relative",
          width: "100%",
        }}
      >
        {virtualItems.map((virtualRow) => {
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
                paddingBottom: ROW_GAP_PX,
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <ConversationItem
                conversation={c}
                selected={c.id === selectedId}
                onSelect={onSelect}
                onTogglePin={onTogglePin}
                onToggleMute={onToggleMute}
                onRemove={onRemove}
              />
            </div>
          );
        })}
      </div>
    </WorkbenchScrollArea>
  );
});

// ─── Secondary filters ──────────────────────────────────────────────────────

// 静态配置,hoist 到模块级避免每次 render 新建数组(STRINGS 本就是模块级常量)。
const STATUS_TABS: { value: StatusTab; label: string }[] = [
  { value: "all", label: STRINGS.conversationList.statusAll },
  { value: "unread", label: STRINGS.conversationList.statusUnread },
  { value: "mentioned", label: STRINGS.conversationList.statusMentioned },
];

const FilterToolbar = memo(function FilterToolbar({
  statusTab,
  onStatusChange,
  accounts,
  selectedAccountId,
  onAccountChange,
  accountPickerOpen,
  onAccountPickerOpenChange,
}: {
  statusTab: StatusTab;
  onStatusChange: (value: StatusTab) => void;
  accounts: readonly Account[];
  selectedAccountId: string | null;
  onAccountChange: (accountId: string | null) => void;
  accountPickerOpen: boolean;
  onAccountPickerOpenChange: (open: boolean) => void;
}) {
  // 选中态存的是 account.id;展示名按 id 反查 accounts(同名账号也唯一区分)。
  const selectedAccountName = selectedAccountId
    ? (accounts.find((a) => a.id === selectedAccountId)?.name ?? null)
    : null;
  const accountLabel = selectedAccountName
    ? extractAccountOperator(selectedAccountName)
    : STRINGS.conversationList.accountFallback;

  return (
    <div className="text-wb-3xs flex h-9 min-w-0 items-center gap-1 font-medium text-workbench-text-secondary">
      <div
        role="tablist"
        aria-label={STRINGS.conversationList.statusTabsLabel}
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto pr-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <AccountDropdown
          accounts={accounts}
          selectedAccountId={selectedAccountId}
          onSelect={onAccountChange}
          open={accountPickerOpen}
          onOpenChange={onAccountPickerOpenChange}
        >
          <button
            type="button"
            aria-haspopup="listbox"
            aria-expanded={accountPickerOpen}
            className={cn(
              // min-w-0(替原 shrink-0):账号名过长时让账号按钮收缩截断,把宽度让给后面
              // 短而固定的状态 Tab(全部/未读/@我),避免 @我 被挤进 overflow 滚动区不可见。
              "focus-ring inline-flex h-9 min-w-0 max-w-[96px] items-center gap-1 rounded-md px-2 transition-colors",
              selectedAccountId
                ? "bg-workbench-surface-soft font-semibold text-[#5B7C99]"
                : "hover:bg-workbench-surface-active hover:text-[#5B7C99]",
            )}
            title={selectedAccountName ?? STRINGS.rangePill.allAccountsBare}
          >
            <span className="min-w-0 truncate">{accountLabel}</span>
            <ChevronDown
              size={12}
              className={cn(
                "shrink-0 text-current opacity-70 transition-transform",
                accountPickerOpen && "rotate-180",
              )}
            />
          </button>
        </AccountDropdown>
        {STATUS_TABS.map((tab) => {
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
                  ? "bg-workbench-surface-soft font-semibold text-[#5B7C99]"
                  : "hover:bg-workbench-surface-active hover:text-[#5B7C99]",
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
  onToggleMute,
  onRemove,
}: {
  conversation: Conversation;
  selected: boolean;
  onSelect: (id: string) => void;
  onTogglePin?: (id: string, next: boolean) => void | Promise<void>;
  onToggleMute?: (id: string, next: boolean) => void | Promise<void>;
  onRemove?: (id: string) => void;
}) {
  const {
    id,
    name,
    avatarColor,
    avatar,
    preview,
    account,
    time,
    unread,
    online,
    draftText,
    pinned,
    muted,
  } = conversation;
  const isPinned = pinned === true;
  const isMuted = muted === true;
  // selected 与 readPending(markRead 远端往返中)都抑制红标:前者"正在看"、后者"清零在途",
  // 二者都不应让红点在数据落地前现身。
  const showUnread = unread > 0 && !selected && conversation.readPending !== true;

  const row = (
    <button
      type="button"
      onClick={() => onSelect(id)}
      // 列表-导航语义:屏幕阅读器据此播报"当前项";视觉上 selected 以常驻 surface-active
      // 底色与 hover 的临时浅蓝区分(共用同一底色,selected 常驻、hover 临时)。
      aria-current={selected ? "true" : undefined}
      className={cn(
        "focus-ring group relative grid w-full grid-cols-[44px_minmax(0,1fr)] items-start gap-3 overflow-hidden rounded-md px-3 py-1.5 text-left transition-colors duration-100",
        // 置顶视觉用右上角折角(corner-fold,见下方 isPinned 元素)表达;行本体
        // 只保留选中/默认两态。折角内收绘制,不再贴住卡片圆角边缘。
        // ConversationAvatar.pinned prop 保留供搜索结果复用。
        // hover 与 selected 共用 surface-active(浅蓝),只是 selected 常驻、hover 临时,
        // 视觉统一;duration-100 比默认 150ms 更跟手。
        selected ? "bg-workbench-surface-active" : "hover:bg-workbench-surface-active",
      )}
    >
      {/* 置顶标记:作为内容区右上角的小折角,与时间文字错位摆放。 */}
      {isPinned && (
        <svg
          aria-hidden
          className="pointer-events-none absolute right-2.5 top-2 size-2.5"
          viewBox="0 0 10 10"
          style={{ color: "hsl(var(--wb-accent-soft) / 0.52)" }}
        >
          <path
            d="M7.9 0Q10 0 10 2.1V7.3Q10 10 8.05 8.05L1.5 1.5Q0 0 2.15 0H7.9Z"
            fill="currentColor"
          />
        </svg>
      )}
      <div className="relative mt-1">
        <ConversationAvatar name={name} color={avatarColor} avatarUrl={avatar} online={online} />
        {isMuted && (
          <span
            aria-hidden
            className="absolute -bottom-1 -right-1 grid size-[18px] place-items-center rounded-full border border-workbench-line-strong bg-workbench-surface-elevated text-workbench-text-secondary shadow-[0_1px_4px_rgba(15,23,42,0.16)]"
          >
            <BellOff size={11} strokeWidth={2.35} />
          </span>
        )}
      </div>
      <div className="min-w-0 pt-px">
        <div className="flex min-w-0 items-center gap-1.5 pr-20">
          <span className="truncate text-wb-xs font-medium text-workbench-text">{name}</span>
          <WeChatSourceIcon />
        </div>
        <div className="text-wb-3xs mt-px truncate pr-7 font-medium text-workbench-text-muted">
          {draftText ? (
            <>
              <span className="mr-1 font-medium text-amber-500">
                {STRINGS.conversationList.draftPrefix}
              </span>
              <span className="text-workbench-text-secondary">{draftText}</span>
            </>
          ) : (
            <>
              {showUnread && (
                // 与 preview 同色(muted),仅作语义标签。普通会话 [未读](量级由右侧红数字承担);
                // 免打扰会话改 [N 条](右侧只剩红点,前缀补回条数信息)。
                <span className="mr-1 font-medium">
                  {isMuted
                    ? STRINGS.conversationList.mutedCountPrefix(unread)
                    : STRINGS.conversationList.unreadPrefix}
                </span>
              )}
              {preview}
            </>
          )}
        </div>
        <div className="mt-px flex min-w-0 items-center gap-1.5 text-wb-4xs">
          <img
            src={WECOM_SOURCE_LOGO}
            alt=""
            aria-hidden
            className="size-3 shrink-0 rounded-[2px] object-contain"
          />
          <span className="min-w-0 truncate font-medium text-workbench-text-muted">{account}</span>
        </div>
      </div>
      {/* 右侧时间槽固定 48px,只显示时间;其它状态拆到头像/卡片中部。 */}
      <span className="text-wb-3xs absolute right-6 top-2.5 w-12 text-right text-workbench-text-disabled">
        <span className="wb-time">{time}</span>
      </span>
      {isMuted && showUnread && (
        <span
          aria-label={STRINGS.conversationList.unreadCount(unread)}
          className="absolute right-4 top-1/2 size-2 -translate-y-1/2 rounded-full bg-workbench-unread"
        />
      )}
      {!isMuted && showUnread && (
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
  if (!onTogglePin && !onToggleMute && !onRemove) return row;

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
          {onToggleMute && (
            <ContextMenu.Item
              onSelect={() => void onToggleMute(id, !isMuted)}
              className={itemClassName}
            >
              {isMuted
                ? STRINGS.conversationList.contextUnmute
                : STRINGS.conversationList.contextMute}
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

function WeChatSourceIcon() {
  return (
    <span
      aria-label={STRINGS.header.fromWeChat}
      title={STRINGS.header.fromWeChat}
      className="grid size-5 shrink-0 place-items-center rounded-full bg-workbench-wechat-bg/80"
    >
      <svg
        aria-hidden
        viewBox="0 0 16 16"
        className="text-workbench-wechat-text/72 size-[15px]"
        fill="none"
      >
        <path
          d="M7.1 3.2C4.3 3.2 2 4.9 2 7c0 1.2.7 2.2 1.8 2.9l-.4 1.3 1.5-.7c.7.2 1.4.3 2.2.3 2.8 0 5.1-1.7 5.1-3.8S9.9 3.2 7.1 3.2Z"
          fill="currentColor"
          opacity="0.95"
        />
        <path
          d="M10.5 6.3c2.1 0 3.7 1.3 3.7 2.9 0 .9-.5 1.7-1.4 2.2l.3 1-1.1-.5c-.5.2-1 .2-1.6.2-2.1 0-3.7-1.3-3.7-2.9s1.7-2.9 3.8-2.9Z"
          fill="currentColor"
          opacity="0.55"
        />
        <circle cx="5.5" cy="6.6" r="0.45" fill="hsl(var(--wb-wechat-bg))" />
        <circle cx="8.4" cy="6.6" r="0.45" fill="hsl(var(--wb-wechat-bg))" />
      </svg>
    </span>
  );
}
