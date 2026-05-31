import { memo, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Loader2 } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";

import type { SendMessageResp } from "@/lib/api/messageHistory";
import type { Account } from "@/lib/types/account";
import { cn } from "@/lib/utils";

import { ChatEmptyState, ChatErrorState, ChatLoadingState } from "./ChatStates";
import { ChatHeader } from "./ChatHeader";
import { COMPOSER_DEFAULT_HEIGHT } from "./constants";
import type { Conversation, Message, QuickReply } from "./data";
import { useChatActions, type SendMessageOptions } from "./hooks/useChatActions";
import { useChatTimeline, type TimelineItem } from "./hooks/useChatTimeline";
import { useScrollController } from "./hooks/useScrollController";
import { DateDivider, MessageBubble, type ReplyTarget, UnreadDivider } from "./MessageBubble";
import { MessageComposer } from "./MessageComposer";
import { RangePill } from "./RangePill";
import { STRINGS } from "./strings";
import { estimateTimelineRowHeight, getVirtualOverscan } from "./virtualListSizing";
import { WorkbenchScrollArea } from "./WorkbenchScrollArea";

const VIRTUALIZE_THRESHOLD = 60;

function rowHeightCacheKey(conversationId: string, itemId: string): string {
  return `${conversationId}:${itemId}`;
}

// 虚拟分支每行的顶部间距(px),与下方渲染用的 pt-6(24)/pt-7(28) 严格同源:首行无间距;
// 同发送者连续消息 24;首条/分隔等 28。estimateSize 与渲染必须用同一份口径——否则估算缺这段
// 间距,而 measureElement 实测把它计入,虚拟器据差值逐行校正,首屏表现为「整列上抖」。
function rowTopSpacingPx(item: TimelineItem, index: number): number {
  if (index === 0) return 0;
  return item.type === "message" && !item.isFirstInBurst ? 24 : 28;
}

interface ChatAreaProps {
  conversation: Conversation;
  messages: Message[];
  accounts: readonly Account[];
  selectedAccountId: string | null;
  onAccountChange: (accountId: string | null) => void;
  detailsOpen: boolean;
  onToggleDetails: () => void;
  /**
   * 来自外部 history store 的"任意 fetch 进行中"信号。同时承担两个语义:
   *   - 初次加载: `loading && localMessages.length === 0` → 渲染 ChatLoadingState
   *   - 翻页加载: maybeLoadOlderHistory 用它做"重入 guard"
   * (旧 API 用 `loading` + `loading` 双 flag 表达同一份数据,合并后语义更清晰。)
   */
  loading?: boolean;
  /** Set when an external store reports a fetch error. */
  error?: Error | null;
  /** Called when the user clicks "retry" inside the error state. */
  onRetry?: () => void;
  /** Whether older history exists above the currently loaded timeline. */
  hasMoreHistory?: boolean;
  /** Called when the user scrolls near the top and older messages should be loaded. */
  onLoadMoreHistory?: () => Promise<void> | void;
  /** Quick-reply templates surfaced in the composer popover. */
  quickReplies?: QuickReply[];
  /** 快捷回复增删改回调:透传给 composer popover 内的管理 UI。 */
  onCreateQuickReply?: (title: string, content: string) => void;
  onUpdateQuickReply?: (id: string, title: string, content: string) => void;
  onDeleteQuickReply?: (id: string) => void;
  /** Conversations available as @mention candidates in the composer. */
  mentionCandidates?: Conversation[];
  /**
   * 真发送回调。成功后后端落库 + 发 conversation-messages ChangeNotice,整窗 REPLACE 把这条
   * 收敛进权威列表(乐观气泡随之被替换)。失败则把该气泡标 failed。
   * options:附件类透传 messageType + 上传后的 objectName 等;纯文本不传。
   */
  onSendMessage?: (
    text: string,
    clientMsgId: string,
    options?: SendMessageOptions,
  ) => Promise<SendMessageResp | void>;
  /** 切走/卸载该会话时回调,补一次 markRead(只在 leave 同步服务端,不按消息打)。 */
  onLeaveMarkRead?: (conversationId: string) => void | Promise<void>;
}

export const ChatArea = memo(function ChatArea({
  conversation,
  messages,
  accounts,
  selectedAccountId,
  onAccountChange,
  detailsOpen,
  onToggleDetails,
  loading,
  error,
  onRetry,
  hasMoreHistory = false,
  onLoadMoreHistory,
  quickReplies,
  onCreateQuickReply,
  onUpdateQuickReply,
  onDeleteQuickReply,
  mentionCandidates,
  onSendMessage,
  onLeaveMarkRead,
}: ChatAreaProps) {
  const [composerHeight, setComposerHeight] = useState(COMPOSER_DEFAULT_HEIGHT);
  const [replyDraft, setReplyDraft] = useState<
    (ReplyTarget & { id: string; conversationId: string }) | null
  >(null);
  // Stage 4b:消息真相在 chatStore(由 useMessageHistory 写入、按 conversationId 分片),
  // `messages` prop 即本会话 store 切片的投影,不再维护 localMessages 本地副本(双真相消除)。
  // 仍按 conversation.id 过滤一道:防 messages prop 在切会话瞬间短暂落后于 conversation.id 时,
  // 把旧会话内容渲染到新标题下("气泡李四、标题张三"的闪帧)。
  const localMessages = useMemo(
    () => messages.filter((m) => m.conversationId === conversation.id),
    [messages, conversation.id],
  );
  const measuredRowHeightsRef = useRef(new Map<string, number>());
  const measuredRowsConversationRef = useRef(conversation.id);
  if (measuredRowsConversationRef.current !== conversation.id) {
    measuredRowsConversationRef.current = conversation.id;
    measuredRowHeightsRef.current.clear();
  }

  // 时间线派生(日期/未读分隔 + 气泡 + 未读锚点冻结)抽到 useChatTimeline(Stage 4d),纯派生。
  const timelineItems = useChatTimeline({ localMessages, conversation });

  // 滚动控制器(置底跟随/翻页锚点/未读 pill/切会话 snap/离开 markRead)抽到 useScrollController
  // (Stage 4d)。滚动位置行为依赖真实布局,需真机手测;此处仅做结构接线。
  const {
    setScrollNode,
    setUnreadDividerNode,
    handleScrollMetrics,
    handleUserScroll,
    scrollToBottom,
    scrollToUnread,
    atBottom,
    unreadBelow,
    unreadAbove,
    wasAtBottomRef,
    scrollElementRef,
  } = useScrollController({
    conversation,
    localMessages,
    loading,
    error,
    hasMoreHistory,
    onLoadMoreHistory,
    onLeaveMarkRead,
  });
  // Stale drafts from a prior conversation are ignored at render time rather
  // than cleared via effect — keeps state mutations off the conversation-switch
  // path and out of React's "setState in effect" lint surface.
  const activeReplyDraft = replyDraft?.conversationId === conversation.id ? replyDraft : null;

  // 消息动作(发送/重发/删除/撤回/引用)抽到 useChatActions(Stage 4d),走 chatStore。
  const { handleSend, handleAction } = useChatActions({
    conversation,
    onSendMessage,
    wasAtBottomRef,
    setReplyDraft,
  });

  // Stage 3.2 消息区虚拟化:仅超长会话(>阈值)启用,中短会话走全量渲染(零虚拟化抖动)。
  // 阈值 20→60:此前下调到 20 是为压低图片解码内存,但代价是几十条的常见会话也被虚拟化 ——
  // 可变高度气泡(多行文本/多图/文本+图)的 estimateSize 必然与 measureElement 实测不符,
  // 滚动时虚拟器据实测重算偏移 → 内容"一抖一抖"。几十条全量渲染内存可控(图片走固定 192
  // 缩略图盒,解码量有限),换取常见会话零抖动;只有真正超长(>60)会话才虚拟化,把同时存活的
  // <img> 压到可视窗口量级。现有测试用例消息数都 <20,仍走全量渲染分支,保持绿。
  const shouldVirtualize = timelineItems.length > VIRTUALIZE_THRESHOLD;
  const virtualOverscan = useMemo(() => getVirtualOverscan(timelineItems), [timelineItems]);
  // 虚拟器与滚动视口(WorkbenchScrollArea)都常驻、跨会话持久(消息区不再按会话重挂),
  // 故无「实例持久 vs 视口重挂」错配。getItemKey 按消息 id 缓存测量,杜绝跨会话按 index 串台。
  const rowVirtualizer = useVirtualizer({
    count: timelineItems.length,
    // 仅虚拟模式才把滚动元素交给虚拟器:否则虚拟器挂载时会 scrollTo initialOffset=0,
    // 覆盖 useScrollController 的 snap 置底(短会话/测试都会被波及)。返回 null 时虚拟器惰性。
    getScrollElement: () => (shouldVirtualize ? scrollElementRef.current : null),
    // 按内容类型估高:打开会话置底时,虚拟器先按估算值算总高、据此置底,首帧后再
    // measureElement 量真实高度并校正——估算与真实差得越多,这次校正越大,表现为
    // "整列跳一下"。图片气泡用固定 192 缩略图盒(整行≈250),与旧的统一 76 差近 175px,
    // 跳动最明显;纯文字行≈66,与 76 也差约 10px,长会话累计到可视区十几行同样可见。
    // 按 kind 给出接近真实的估算,使可视区底部那批行首帧误差趋零,基本消除开场跳动。
    estimateSize: (index) => {
      const item = timelineItems[index];
      const cacheKey = rowHeightCacheKey(conversation.id, item.id);
      const measured = measuredRowHeightsRef.current.get(cacheKey);
      if (measured !== undefined) return measured;
      // 补上与渲染同源的顶部间距:measureElement 实测含它,估算不补则系统性偏矮 → 开场抖动。
      return estimateTimelineRowHeight(item) + rowTopSpacingPx(item, index);
    },
    // 图片密集历史降低屏外预渲染量,减少同时挂载/解码的 <img>;文本历史保留 5 行缓冲,
    // 快速滚动仍有足够预渲染空间。
    overscan: virtualOverscan,
    getItemKey: (index) => timelineItems[index].id,
  });

  const measureVirtualRow = (node: HTMLDivElement | null) => {
    if (!node) return;
    rowVirtualizer.measureElement(node);
    const indexAttr = node.dataset.index;
    if (!indexAttr) return;
    const index = Number(indexAttr);
    const item = timelineItems[index];
    if (!item) return;
    const height = node.getBoundingClientRect().height;
    if (height > 0) {
      measuredRowHeightsRef.current.set(rowHeightCacheKey(conversation.id, item.id), height);
    }
  };

  // 单条 timeline 行的内容(不含间距/包裹):虚拟分支用。
  const renderRowContent = (item: TimelineItem) => {
    if (item.type === "date-divider") return <DateDivider label={item.label} />;
    if (item.type === "unread-divider") return <UnreadDivider count={item.count} />;
    return (
      <MessageBubble
        message={item.message}
        avatarName={conversation.name}
        avatarColor={conversation.avatarColor}
        avatarUrl={conversation.avatar}
        account={conversation.account}
        replyTarget={item.replyTarget}
        onAction={handleAction}
      />
    );
  };

  // 切会话即时切换(无 crossfade):标题与消息区随 conversation 直接重渲,同步硬切,
  // 无淡入淡出延迟、无双倍 DOM —— 跟手丝滑(IM 桌面端标准)。
  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-workbench-surface">
      <ChatHeader conversation={conversation} />
      <RangePill
        accounts={accounts}
        selectedAccountId={selectedAccountId}
        onAccountChange={onAccountChange}
      />
      {/* 消息区与下方 MessageComposer 都不加 key:整块重挂没有必要,反而会重建编辑器/视口。
          切会话由 useScrollController(常驻 ChatArea、按 conversation.id 依赖重跑 snap)、内层列表
          (按 item.id 重渲)、WorkbenchScrollArea(视口持久、MutationObserver 检测内容变更重绑)
          各自处理;MessageComposer 改为持久化编辑器,切会话载入新草稿而非重建(见下)。 */}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {loading && localMessages.length === 0 ? (
          <ChatLoadingState />
        ) : error ? (
          <ChatErrorState error={error} onRetry={onRetry ?? (() => undefined)} />
        ) : localMessages.length === 0 ? (
          <ChatEmptyState />
        ) : (
          <WorkbenchScrollArea
            scrollRef={setScrollNode}
            onScrollMetrics={handleScrollMetrics}
            onUserScroll={handleUserScroll}
            className="flex-1 bg-workbench-surface"
            viewportClassName="overscroll-contain bg-workbench-surface px-4 pt-5 pb-10 pr-6"
            contentClassName="flex w-full flex-col"
          >
            {shouldVirtualize ? (
              <div
                role="log"
                aria-live="polite"
                aria-atomic="false"
                style={{
                  position: "relative",
                  width: "100%",
                  height: rowVirtualizer.getTotalSize(),
                }}
              >
                {rowVirtualizer.getVirtualItems().map((vi) => {
                  const item = timelineItems[vi.index];
                  const idx = vi.index;
                  // 间距用 padding(而非 margin)以并入 measureElement 量到的高度;
                  // margin 在盒外不计入 getBoundingClientRect。值与 estimateSize 同源
                  // (rowTopSpacingPx):0→无、24→pt-6、28→pt-7。
                  const spacingPx = rowTopSpacingPx(item, idx);
                  const spacing = spacingPx === 0 ? "" : spacingPx === 24 ? "pt-6" : "pt-7";
                  return (
                    <div
                      key={item.id}
                      data-index={idx}
                      ref={measureVirtualRow}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        transform: `translateY(${vi.start}px)`,
                      }}
                    >
                      <div
                        ref={item.type === "unread-divider" ? setUnreadDividerNode : undefined}
                        className={spacing}
                      >
                        {renderRowContent(item)}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div role="log" aria-live="polite" aria-atomic="false" className="flex flex-col">
                {timelineItems.map((item, idx) => {
                  if (item.type === "date-divider") {
                    return (
                      <div key={item.id} className={idx === 0 ? "" : "mt-7"}>
                        <DateDivider label={item.label} />
                      </div>
                    );
                  }
                  if (item.type === "unread-divider") {
                    return (
                      <div
                        key={item.id}
                        ref={setUnreadDividerNode}
                        className={idx === 0 ? "" : "mt-7"}
                      >
                        <UnreadDivider count={item.count} />
                      </div>
                    );
                  }
                  const spacing = idx === 0 ? "" : item.isFirstInBurst ? "mt-7" : "mt-6";
                  return (
                    <div key={item.id} className={spacing}>
                      <MessageBubble
                        message={item.message}
                        avatarName={conversation.name}
                        avatarColor={conversation.avatarColor}
                        avatarUrl={conversation.avatar}
                        account={conversation.account}
                        replyTarget={item.replyTarget}
                        onAction={handleAction}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </WorkbenchScrollArea>
        )}
      </div>
      {/* 翻历史 spinner:length>0 时的 loading 必是翻页加载(初次加载 length===0 走
          ChatLoadingState 分支)。绝对定位顶部居中,不挤压消息流、不引发回弹位移。 */}
      {!error && localMessages.length > 0 && loading && hasMoreHistory && (
        <HistoryLoadingSkeleton />
      )}
      {!loading && !error && localMessages.length > 0 && !atBottom && (
        <ScrollToBottomButton
          count={unreadBelow}
          bottomOffset={composerHeight + 12}
          onClick={() => scrollToBottom("smooth")}
        />
      )}
      {!loading && !error && localMessages.length > 0 && unreadAbove > 0 && (
        <UnreadAbovePill count={unreadAbove} onClick={scrollToUnread} />
      )}
      {/* 不加 key:原先 key={conversation.id} 会在每次切会话整块重挂 MessageComposer →
          重建整个 TipTap/ProseMirror 编辑器(本 UI 单次开销最大的对象),是频繁切换接待列表时
          JS 堆锯齿上涨与切换卡顿的主因。改为持久化:编辑器跨会话常驻,切会话由 MessageComposer
          内部 layout effect 载入新会话草稿 + 重聚焦,行为等价但零编辑器重建。 */}
      <MessageComposer
        conversationId={conversation.id}
        height={composerHeight}
        onHeightChange={setComposerHeight}
        detailsOpen={detailsOpen}
        onToggleDetails={onToggleDetails}
        onSend={handleSend}
        quickReplies={quickReplies}
        onCreateQuickReply={onCreateQuickReply}
        onUpdateQuickReply={onUpdateQuickReply}
        onDeleteQuickReply={onDeleteQuickReply}
        mentionCandidates={mentionCandidates}
        replyDraft={activeReplyDraft}
        onCancelReply={() => setReplyDraft(null)}
      />
    </div>
  );
});

// ─── Floating scroll-to-bottom pill ─────────────────────────────────────────

const ScrollToBottomButton = memo(function ScrollToBottomButton({
  count,
  bottomOffset,
  onClick,
}: {
  count: number;
  bottomOffset: number;
  onClick: () => void;
}) {
  const hasUnread = count > 0;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={
        hasUnread
          ? `${STRINGS.status.scrollToBottom},${STRINGS.status.newMessagesBelow(count)}`
          : STRINGS.status.scrollToBottom
      }
      style={{ bottom: bottomOffset }}
      className={cn(
        "focus-ring absolute right-4 z-20 inline-flex items-center gap-1.5 rounded-full border border-workbench-line bg-workbench-surface px-2.5 py-1 text-wb-2xs font-medium text-workbench-text-secondary shadow-wb-popover transition-all hover:bg-workbench-surface-subtle hover:text-workbench-accent",
        "animate-in fade-in slide-in-from-bottom-2",
      )}
    >
      <ArrowDown size={14} className="shrink-0" aria-hidden />
      {hasUnread ? (
        <>
          <span className="wb-num font-medium text-workbench-accent">
            {count > 99 ? "99+" : count}
          </span>
          <span>{STRINGS.status.newMessagesBelow(count).replace(/^\d+\+?\s*/, "")}</span>
        </>
      ) : (
        <span>{STRINGS.status.scrollToBottom}</span>
      )}
    </button>
  );
});

// ─── Floating unread-above pill ─────────────────────────────────────────────
// 视觉镜像 ScrollToBottomButton:位置在消息区域右上角(top-3),箭头朝上,文案
// "↑ N 条未读"。点击 → scrollIntoView UnreadDivider。IntersectionObserver
// 检测到分隔条进入视口后由父组件清零 count,本 pill 跟着卸载。
const UnreadAbovePill = memo(function UnreadAbovePill({
  count,
  onClick,
}: {
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={STRINGS.status.unreadAbove(count)}
      className={cn(
        "focus-ring absolute right-4 top-3 z-20 inline-flex items-center gap-1.5 rounded-full border border-workbench-line bg-workbench-surface px-2.5 py-1 text-wb-2xs font-medium text-workbench-text-secondary shadow-wb-popover transition-all hover:bg-workbench-surface-subtle hover:text-workbench-accent",
        "animate-in fade-in slide-in-from-top-2",
      )}
    >
      <ArrowUp size={14} className="shrink-0" aria-hidden />
      <span className="wb-num font-medium text-workbench-accent">{count > 99 ? "99+" : count}</span>
      <span>{STRINGS.status.unreadAbove(count).replace(/^↑\s*\d+\+?\s*/, "")}</span>
    </button>
  );
});

// ─── Floating history-loading pill ──────────────────────────────────────────
// 翻历史"加载更早消息"骨架浮层。只在向上翻页拉取时出现,非交互(role=status)。
// 关键:绝对定位 + pointer-events-none + 渐变淡出,纯覆盖在视口顶部,**不改 scrollHeight/
// scrollTop**——不参与消息流布局、不与翻历史 prepend 锚点相互作用,故不引入滚动跳动。
// 用骨架气泡(而非纯 spinner 药丸)呈现"上方还有内容在来"的预期,落地后被真实更旧页顶替。
const HistoryLoadingSkeleton = memo(function HistoryLoadingSkeleton() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={STRINGS.status.loadingHistory}
      className={cn(
        "pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-col gap-3 px-4 pb-8 pt-5",
        // 向下渐隐,与下方真实消息平滑衔接,避免骨架与内容的硬边界。
        "bg-gradient-to-b from-workbench-surface via-workbench-surface/95 to-transparent",
        "animate-in fade-in",
      )}
    >
      <HistorySkeletonRow />
      <HistorySkeletonRow wide />
      <div className="flex items-center justify-center gap-1.5 pt-0.5 text-wb-2xs font-medium text-workbench-text-secondary">
        <Loader2
          size={13}
          className="shrink-0 animate-spin motion-reduce:animate-none"
          aria-hidden
        />
        <span>{STRINGS.status.loadingHistory}</span>
      </div>
    </div>
  );
});

// 单行骨架气泡(头像块 + 气泡块),自包含、不依赖 ChatStates 的 framer-motion stagger 容器。
function HistorySkeletonRow({ wide }: { wide?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <div className="size-9 shrink-0 animate-pulse rounded-lg bg-workbench-line-subtle" />
      <div
        className={cn(
          "h-9 animate-pulse rounded-md bg-workbench-line-subtle",
          wide ? "w-[55%]" : "w-[38%]",
        )}
      />
    </div>
  );
}
