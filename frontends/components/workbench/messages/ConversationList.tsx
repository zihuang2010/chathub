import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BellOff, ListFilter } from "lucide-react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { useVirtualizer } from "@tanstack/react-virtual";

import type { Account } from "@/lib/types/account";
import type { WecomFriend } from "@/lib/api/customers";
import { cn } from "@/lib/utils";

import { ConversationAvatar, WeChatSourceBadge } from "./Avatar";
import type { Conversation } from "./data";
import { MessagesContactSearch } from "./MessagesContactSearch";
import { SkeletonRow } from "./MessagesSkeleton";
import { STRINGS } from "./strings";
import { WorkbenchScrollArea, type ScrollMetrics } from "./WorkbenchScrollArea";

const WECOM_SOURCE_LOGO = "/wecom-logo.png";

export type StatusTab = "all" | "unread";

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
  /** 选中账号的 `account.id`(= wecomAccountId),`null` = 全部。账号切换入口已移到聊天区
   *  RangePill;这里仅用于切账号时的骨架过渡与滚动复位(committedAccountKey)。 */
  selectedAccountId: string | null;
  /** 会话状态筛选(消息/未读)。状态提升到父级:从搜索框/客户页打开会话时父级一并重置回"消息",
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

// 切账号骨架的延迟出现阈值:本地 cache 命中时新列表几十毫秒即返回,立刻切骨架反而造成
// 「真列表 → 骨架 → 真列表」两次突变的闪烁。switching 持续超过该阈值(冷缓存需远端预填的
// 慢路径)才显示骨架;快路径保持渲染旧列表,数据到位后一次性整体替换。
const SWITCHING_SKELETON_DELAY_MS = 250;

/** switching 持续超过阈值才返回 true(骨架延迟出现);switching 结束立即复位。 */
function useDelayedSwitching(switching: boolean): boolean {
  const [delayed, setDelayed] = useState(false);
  useEffect(() => {
    if (!switching) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDelayed(false);
      return;
    }
    const timer = window.setTimeout(() => setDelayed(true), SWITCHING_SKELETON_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [switching]);
  return switching && delayed;
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
  statusTab,
  onStatusChange,
  onLoadMore,
  loading,
  onOpenCustomer,
  onClearSearch,
  switching,
}: ConversationListProps) {
  // 骨架延迟出现:快路径(本地读几十毫秒)不闪骨架,继续渲染旧账号列表直到新数据落地整体替换。
  const showSwitchingSkeleton = useDelayedSwitching(!!switching);

  // 滚动条拇指显隐:光标在接待列表区域(搜索框+筛选条+列表整块)内才显示。
  // 用 JS mouseenter/mouseleave 切 class 而非 CSS :hover —— WebKit 上祖先 :hover
  // 变化不重绘 scrollbar 伪元素(详见 index.css .wb-scrollbar-autohide 注释)。
  const [scrollbarVisible, setScrollbarVisible] = useState(false);
  const showScrollbar = useCallback(() => setScrollbarVisible(true), []);
  const hideScrollbar = useCallback(() => setScrollbarVisible(false), []);

  // 「已落地」的账号 key:switching 期间保持旧值,新账号数据真正渲染(switching 复位)时才
  // 提交新值。VirtualizedList 据它在新列表首帧绘制前把滚动复位到顶部 —— 原先靠骨架
  // 卸载/重挂列表顺带归零滚动,快路径不再卸载后需要显式补偿。
  const [committedAccountKey, setCommittedAccountKey] = useState(selectedAccountId);
  if (!switching && committedAccountKey !== selectedAccountId) {
    setCommittedAccountKey(selectedAccountId);
  }

  // 顶部搜索框已改为「搜客户 → 下拉 → 点击打开会话」(MessagesContactSearch),不再就地过滤会话
  // 列表。这里只按 status tab(未读)过滤;账号过滤由后端 list_recent_friends(accountFilter)
  // 负责(切账号时 stale-while-revalidate,前端不再二次过滤以免闪空)。
  const filteredConversations = useMemo(() => {
    if (statusTab !== "unread") return conversations;
    return conversations.filter((conversation) => conversation.unread > 0);
  }, [conversations, statusTab]);

  return (
    <div
      className="flex h-full shrink-0 flex-col bg-workbench-surface"
      style={{ width }}
      onMouseEnter={showScrollbar}
      onMouseLeave={hideScrollbar}
    >
      <div className="flex flex-col gap-2 px-3 pb-1.5 pt-3">
        <MessagesContactSearch
          accounts={accounts}
          onOpenCustomer={onOpenCustomer}
          onClear={onClearSearch}
        />
        <FilterToolbar statusTab={statusTab} onStatusChange={onStatusChange} />
      </div>

      {showSwitchingSkeleton ? (
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
          resetScrollKey={committedAccountKey}
          scrollbarVisible={scrollbarVisible}
          emptyText={
            statusTab === "unread"
              ? STRINGS.conversationList.noUnread
              : STRINGS.conversationList.noConversation
          }
        />
      )}
    </div>
  );
});

// 切账号过渡期的列表骨架:复用首屏 SkeletonRow,padding 对齐 VirtualizedList 的滚动视口。
// 右距取 pr-3.5(14px)= 真列表的 pr-2(8px)+ 常驻滚动条轨道 6px —— 本容器 overflow-hidden
// 无轨道,用 padding 补足,数据到位切回真列表时不产生 layout shift。行数固定取首屏窗口
// 大致可见的条数。
const SWITCHING_SKELETON_ROWS = 8;
function ConversationListSkeleton() {
  return (
    <div className="flex-1 overflow-hidden pb-1.5 pl-3 pr-3.5 pt-0.5" aria-hidden>
      <div className="flex flex-col gap-0.5">
        {Array.from({ length: SWITCHING_SKELETON_ROWS }).map((_, i) => (
          <SkeletonRow key={i} />
        ))}
      </div>
    </div>
  );
}

// 空态插画:开口纸箱(线稿 + 箱口蓝色渐变),配合下方占位文案垂直居中展示。
// 纯内联 SVG,无外部资源;颜色取与 workbench 骨架/弱文本一致的浅灰系。
function EmptyBoxIllustration() {
  return (
    <svg width="92" height="80" viewBox="0 0 120 104" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="conv-empty-box-blue" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#85C1FA" />
          <stop offset="1" stopColor="#4796F0" />
        </linearGradient>
      </defs>
      {/* 顶部三条放射短线 */}
      <g stroke="#C9D2DE" strokeWidth="3" strokeLinecap="round">
        <line x1="40" y1="12" x2="34" y2="3" />
        <line x1="60" y1="10" x2="60" y2="1" />
        <line x1="80" y1="12" x2="86" y2="3" />
      </g>
      {/* 向外翻开的两片箱盖 */}
      <g fill="#FFFFFF" stroke="#C9D2DE" strokeWidth="2.5" strokeLinejoin="round">
        <polygon points="60,28 22,42 10,32 48,18" />
        <polygon points="60,28 98,42 110,32 72,18" />
      </g>
      {/* 箱口(蓝色渐变) */}
      <polygon
        points="60,28 98,42 60,56 22,42"
        fill="url(#conv-empty-box-blue)"
        stroke="#C9D2DE"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      {/* 箱体两个可见面 */}
      <g fill="#FFFFFF" stroke="#C9D2DE" strokeWidth="2.5" strokeLinejoin="round">
        <polygon points="22,42 22,76 60,90 60,56" />
        <polygon points="98,42 98,76 60,90 60,56" />
      </g>
    </svg>
  );
}

// ─── Virtualized list body ──────────────────────────────────────────────────
// @tanstack/react-virtual 跑在 WorkbenchScrollArea 上层:接管"哪些 item 渲染 +
// 总高度 spacer";仍由 WorkbenchScrollArea 的 viewport 提供 native scroll 行为
// 与 ScrollMetrics 上报通道(后续若 ChatArea 模式的 anchor / unread divider
// 需要接入,直接复用)。
//
// 高度策略:estimateSize≈行内容 60(头像 44 + py-2 上下 16,两行文本 ≈42 居中)
// + ROW_GAP_PX 间隔 ≈ 62,measureElement 自动测量真实高度修正 scrollbar 拇指。
// overscan=8(上下各预渲染 8 条,滚动时接 fill 充裕,避免边缘闪空白)。
//
// ROW_GAP_PX:卡片间留白。以每行 wrapper 的 padding-bottom 实现 —— measureElement
// 测的是 wrapper 的 border-box 高度(含 padding),故 totalSize / start 偏移会自动
// 把间隔算进去,行与行之间留出透明缝隙,卡片不再贴死。
const ROW_GAP_PX = 2;
const ROW_ESTIMATE_PX = 62;
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
  resetScrollKey,
  scrollbarVisible,
  emptyText,
}: {
  items: Conversation[];
  selectedId: string;
  onSelect: (id: string) => void;
  onTogglePin?: (id: string, next: boolean) => void | Promise<void>;
  onToggleMute?: (id: string, next: boolean) => void | Promise<void>;
  onRemove?: (id: string) => void;
  onLoadMore?: () => void;
  loading?: boolean;
  /** 变化时(= 切账号后新数据已落地)在绘制前把滚动复位到顶部。切账号快路径下列表
   *  不再经历骨架卸载/重挂,旧账号的滚动位置会残留,靠它显式归零。 */
  resetScrollKey?: string | null;
  /** 光标在接待列表区域内为 true,viewport 挂 .wb-scrollbar-on 显示滚动条拇指。 */
  scrollbarVisible?: boolean;
  /** 列表为空时的占位文案,由父级按当前 statusTab 区分("暂无未读消息"/"暂无匹配会话")。 */
  emptyText: string;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const setScrollViewport = useCallback((node: HTMLDivElement | null) => {
    if (node) scrollRef.current = node;
  }, []);

  // useLayoutEffect:在新账号列表首帧绘制前归零滚动,避免"先按旧偏移画一帧再跳顶"的闪动。
  const prevResetKeyRef = useRef(resetScrollKey);
  useLayoutEffect(() => {
    if (prevResetKeyRef.current === resetScrollKey) return;
    prevResetKeyRef.current = resetScrollKey;
    const viewport = scrollRef.current;
    if (viewport) viewport.scrollTop = 0;
  }, [resetScrollKey]);

  // WebKit 不会因 class 变化重绘已画出的滚动条:移入能出现是鼠标在容器上移动顺带触发了
  // 重绘,移出后没有事件再碰它,摘掉 .wb-scrollbar-on 拇指也不消失。这里在显隐切换时把
  // overflow-y 置 hidden 再还原,强制销毁重建滚动条 —— 同一 JS 任务内完成(中间读
  // offsetHeight 触发同步 layout),不产生可见中间帧;overflow:hidden 仍是滚动容器,
  // scrollTop 不丢。useLayoutEffect 保证在本次绘制前生效,移出即消失。
  useLayoutEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    viewport.style.overflowY = "hidden";
    void viewport.offsetHeight;
    viewport.style.overflowY = "";
  }, [scrollbarVisible]);

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
    // 空态仍走 WorkbenchScrollArea + overflow-y-scroll:与真列表保持同一常驻 6px 滚动条
    // 轨道,「消息↔未读」空/非空切换不发生宽度跳动(轨道说明见下方非空分支注释)。
    // 内容经 contentClassName 撑满 viewport 高度后垂直居中;pb-12 让视觉重心略高于
    // 几何中心,更稳。
    return (
      <WorkbenchScrollArea
        className="flex-1"
        viewportClassName={cn(
          "wb-scrollbar-autohide overflow-y-scroll pb-1.5 pl-3 pr-2 pt-0.5",
          scrollbarVisible && "wb-scrollbar-on",
        )}
        contentClassName="flex min-h-full flex-col items-center justify-center gap-4 px-5 pb-12"
      >
        <EmptyBoxIllustration />
        <p className="text-wb-xs text-workbench-text-muted">{emptyText}</p>
      </WorkbenchScrollArea>
    );
  }

  // overflow-y-scroll(经 cn/tailwind-merge 替换基类的 overflow-y-auto):常驻 6px 滚动条
  // 轨道,「消息↔未读」切换时不再因滚动条出现/消失让整列内容左右跳;轨道透明、无溢出时
  // 不画拇指,视觉无感。不用 scrollbar-gutter:stable —— WKWebView 按原生滚动条宽度
  // (≈15px)预留 gutter,与自定义 ::-webkit-scrollbar 的 6px 不一致,会引入反向跳动;
  // 常驻轨道在 macOS WebKit 与 Windows WebView2(Blink) 上行为一致。
  return (
    <WorkbenchScrollArea
      className="flex-1"
      viewportClassName={cn(
        "wb-scrollbar-autohide overflow-y-scroll pb-1.5 pl-3 pr-2 pt-0.5",
        scrollbarVisible && "wb-scrollbar-on",
      )}
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
  { value: "all", label: STRINGS.conversationList.statusMessages },
  { value: "unread", label: STRINGS.conversationList.statusUnread },
];

/** 筛选工具栏:左侧会话类型胶囊(当前仅支持单聊,静态展示)+ 右侧「消息/未读」分段切换。
 *  账号切换入口已收敛到聊天区头部的 RangePill,这里不再放账号下拉。 */
const FilterToolbar = memo(function FilterToolbar({
  statusTab,
  onStatusChange,
}: {
  statusTab: StatusTab;
  onStatusChange: (value: StatusTab) => void;
}) {
  return (
    <div className="text-wb-3xs flex min-w-0 items-center justify-between gap-2 font-medium text-workbench-text-secondary">
      {/* 会话类型:仅"单聊"一种,渲染为不可交互的胶囊(无下拉/无关闭),后续支持群聊再升级为筛选器。 */}
      <span
        title={STRINGS.conversationList.chatTypeFilterTitle}
        className="inline-flex h-8 min-w-0 cursor-default items-center gap-1.5 rounded-full bg-workbench-surface-soft px-3"
      >
        <ListFilter size={13} className="shrink-0 text-[#6B86A6]" />
        <span className="min-w-0 truncate">{STRINGS.conversationList.chatTypeSingle}</span>
      </span>
      {/* 消息/未读分段切换:灰底圆角轨道,选中段白底浮起(shadow-wb-card)。 */}
      <div
        role="tablist"
        aria-label={STRINGS.conversationList.statusTabsLabel}
        className="flex h-8 shrink-0 items-center rounded-full bg-workbench-surface-soft p-[3px]"
      >
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
                "focus-ring-inset inline-flex h-full items-center rounded-full px-3 transition-colors",
                active
                  ? "bg-workbench-surface-elevated font-semibold text-workbench-text shadow-wb-card"
                  : "hover:text-workbench-text",
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
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
  // 第二行(预览/草稿/未读徽标)无内容时渲染等高占位行:名称行的垂直位置与有概要的行
  // 保持一致(不因缺概要下移到行内居中),行高统一也让虚拟列表 estimateSize 更准。
  const hasSecondLine = Boolean(draftText) || Boolean(preview) || showUnread;

  const row = (
    <button
      type="button"
      onClick={() => onSelect(id)}
      // 列表-导航语义:屏幕阅读器据此播报"当前项"。
      aria-current={selected ? "true" : undefined}
      className={cn(
        "focus-ring group relative grid w-full grid-cols-[44px_minmax(0,1fr)] items-center gap-3 overflow-hidden rounded-lg px-3 py-2 text-left transition-colors duration-100",
        // 置顶视觉用右上角折角(corner-fold,见下方 isPinned 元素)表达;行本体
        // 保留选中/悬停/默认三态。ConversationAvatar.pinned prop 保留供搜索结果复用。
        // hover 用更浅的 surface-soft、selected 常驻 surface-active:两态分离,鼠标扫过
        // 其它行时不会与选中行混淆;按下时临时落到 surface-active 提供 press 反馈。
        // duration-100 比默认 150ms 更跟手。
        selected
          ? "bg-workbench-surface-active"
          : "hover:bg-workbench-surface-soft active:bg-workbench-surface-active",
      )}
    >
      {/* 置顶标记:贴卡片右上角的小折角。时间已改为行内文档流,折角收进圆角内侧即可。 */}
      {isPinned && (
        <svg
          aria-hidden
          className="pointer-events-none absolute right-1 top-1 size-2.5"
          viewBox="0 0 10 10"
          style={{ color: "hsl(var(--wb-accent-soft) / 0.52)" }}
        >
          <path
            d="M7.9 0Q10 0 10 2.1V7.3Q10 10 8.05 8.05L1.5 1.5Q0 0 2.15 0H7.9Z"
            fill="currentColor"
          />
        </svg>
      )}
      <div className="relative">
        <ConversationAvatar name={name} color={avatarColor} avatarUrl={avatar} online={online} />
        {/* 客户来源角标:微信小图标贴头像左下角(右下角已被在线点/免打扰铃铛占用)。
            与 SourceChip 的企微 logo 分工:角标=客户从微信来,chip=归属哪个企微账号接待。
            视觉与聊天头部(ChatHeader)共用 WeChatSourceBadge,保证两处一致。 */}
        <WeChatSourceBadge />
        {isMuted && (
          <span
            aria-hidden
            className="absolute -bottom-1 -right-1 grid size-[18px] place-items-center rounded-full border border-workbench-line-strong bg-workbench-surface-elevated text-workbench-text-secondary shadow-[0_1px_4px_rgba(15,23,42,0.16)]"
          >
            <BellOff size={11} strokeWidth={2.35} />
          </span>
        )}
      </div>
      <div className="min-w-0">
        {/* 行 1(主信息 + 辅助标签):名称截断让位,SourceChip(来源 + 归属账号)紧随其后,
            时间右对齐。全部走文档流,不再用 pr-20 硬编码避让绝对定位的时间槽。
            unread 时名称加重一档强化未读感。 */}
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className={cn(
              // min-w-[3em] 保底:长账号名挤压时名称至少保留约两字+省略号,不被压没。
              "min-w-[3em] truncate text-wb-xs text-workbench-text",
              showUnread ? "font-semibold" : "font-medium",
            )}
          >
            {name}
          </span>
          <SourceChip account={account} />
          <span className="ml-auto shrink-0 pl-2 text-wb-4xs text-workbench-text-disabled">
            <span className="wb-time">{time}</span>
          </span>
        </div>
        {/* 行 2(次信息):消息预览 + 未读徽标。预览 normal 字重拉开与名称的层级;
            unread 时提一档颜色(secondary)与已读(muted)区分。 */}
        {hasSecondLine ? (
          <div
            className={cn(
              "text-wb-3xs mt-1 flex min-w-0 items-center gap-2",
              showUnread ? "text-workbench-text-secondary" : "text-workbench-text-muted",
            )}
          >
            <div className="min-w-0 flex-1 truncate">
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
                    // 与 preview 同色,仅作语义标签。普通会话 [未读](量级由右侧红数字承担);
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
            {showUnread && <UnreadBadge count={unread} dotOnly={isMuted} />}
          </div>
        ) : (
          // 等高占位:与真实第二行同字号同间距,保证名称不下移、行高与有概要的行一致。
          // 用不折叠空格撑出一行高度(普通空格会被浏览器折叠成零高)。
          <div aria-hidden className="text-wb-3xs mt-1">
            {"\u00A0"}
          </div>
        )}
      </div>
    </button>
  );

  // 没有任何菜单操作可用时退化为纯 button,避免 mock/占位环境下闪一个空菜单。
  if (!onTogglePin && !onToggleMute && !onRemove) return row;

  const itemClassName = cn(
    "cursor-default rounded px-2.5 py-1 text-wb-2xs text-workbench-text outline-none transition-colors",
    "data-[highlighted]:bg-workbench-surface-subtle",
  );

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{row}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className="z-30 min-w-[96px] overflow-hidden rounded-md border border-workbench-line bg-workbench-surface p-1 shadow-wb-popover"
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

/** 未读徽标:普通会话显示数字胶囊(1-2 位圆形,99+ 自动撑出胶囊形),免打扰会话只显示
 *  一枚小红点(条数信息由 preview 前缀 [N 条] 承担)。挂在 preview 行右端的文档流内,
 *  不再绝对定位,长预览文本由 flex 自然让位。 */
function UnreadBadge({ count, dotOnly }: { count: number; dotOnly: boolean }) {
  if (dotOnly) {
    return (
      <span
        aria-label={STRINGS.conversationList.unreadCount(count)}
        className="size-2 shrink-0 rounded-full bg-workbench-unread"
      />
    );
  }
  return (
    <span
      aria-label={STRINGS.conversationList.unreadCount(count)}
      className="wb-num grid h-3 min-w-[12px] shrink-0 place-items-center rounded-full bg-workbench-unread px-[2px] text-[8px] font-semibold leading-none text-white"
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

/** 归属账号标签:企业微信 logo + 所属企微账号名,浅底胶囊。表达"该外部联系人由哪个
 *  企微账号接待";客户本身的微信来源标识已移到头像左下角角标,两个语义不再混淆
 *  (此前 chip 用微信绿图标,容易被误读成"账号名是微信号")。
 *  max-w 封顶 + 低权重收缩(shrink-[0.3])+ 内部 truncate:长账号名先截到 110px;
 *  行内仍挤时主要由名称让步(名称留 min-w 保底),chip 只小幅收缩,尽量保住账号名
 *  尾部的区分字符(如"乐乐"/"牛牛");时间(shrink-0)永不被挤。完整内容走 title。
 *  不用 shrink-0:否则名称压到保底后行宽不够会把时间顶出可视区。 */
function SourceChip({ account }: { account: string }) {
  return (
    <span
      title={`${STRINGS.header.fromAccountLabel}${account}`}
      className="flex h-[18px] min-w-0 max-w-[110px] shrink-[0.3] items-center gap-1 rounded-full bg-workbench-surface-subtle px-1.5"
    >
      <img
        src={WECOM_SOURCE_LOGO}
        alt=""
        aria-hidden
        className="size-3 shrink-0 rounded-[2px] object-contain"
      />
      <span className="min-w-0 truncate text-wb-4xs text-workbench-text-muted">{account}</span>
    </span>
  );
}
