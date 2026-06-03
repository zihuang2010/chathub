import { memo, useMemo, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";

import type { SendMessageResp } from "@/lib/api/messageHistory";
import { useHubSyncStatus } from "@/lib/data/useHubSyncStatus";
import type { Account } from "@/lib/types/account";
import { cn } from "@/lib/utils";

import { ChatEmptyState, ChatErrorState, ChatLoadingState } from "./ChatStates";
import { ChatHeader } from "./ChatHeader";
import { buildPolishContext } from "./composer/polishContext";
import { COMPOSER_DEFAULT_HEIGHT } from "./constants";
import type { Conversation, Message, QuickReply } from "./data";
import { useChatActions, type SendMessageOptions } from "./hooks/useChatActions";
import { useChatTimeline } from "./hooks/useChatTimeline";
import { useScrollController } from "./hooks/useScrollController";
import { DateDivider, MessageBubble, type ReplyTarget, UnreadDivider } from "./MessageBubble";
import { MessageComposer } from "./MessageComposer";
import type { MessageActionType } from "./MessageContextMenu";
import { RangePill } from "./RangePill";
import type { ChatMessageEntity } from "./store/chatStore";
import { STRINGS } from "./strings";
import { WorkbenchScrollArea } from "./WorkbenchScrollArea";

type MessageTimelineItem = ReturnType<typeof useChatTimeline>[number];

interface MessageTimelineRowProps {
  item: MessageTimelineItem;
  index: number;
  avatarName: string;
  avatarColor?: string;
  avatarUrl?: string;
  account: string;
  onAction: (action: MessageActionType, message: Message) => void;
  setUnreadDividerNode: (node: HTMLDivElement | null) => void;
}

interface ChatAreaProps {
  conversation: Conversation;
  chatStoreKey: string;
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
  chatStoreKey,
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
  // 时间线派生(日期/未读分隔 + 气泡 + 未读锚点冻结)抽到 useChatTimeline(Stage 4d),纯派生。
  const timelineItems = useChatTimeline({ localMessages, conversation });

  // 滚动控制器(置底跟随/翻页锚点/未读 pill/切会话 snap/离开 markRead)抽到 useScrollController
  // (Stage 4d)。滚动位置行为依赖真实布局,需真机手测;此处仅做结构接线。
  const {
    setScrollNode,
    setUnreadDividerNode,
    handleScrollMetrics,
    handleUserScroll,
    handleWheelCapture,
    scrollToBottom,
    scrollToUnread,
    atBottom,
    unreadBelow,
    unreadAbove,
    wasAtBottomRef,
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
    chatStoreKey,
    onSendMessage,
    wasAtBottomRef,
    setReplyDraft,
  });

  // hub 连接断开时禁用发送并在 composer 顶部提示离线(E①)。连接态由 useHubSyncStatus 经
  // hub:connection 事件派生,与 Sidebar 在线圆点同源;disconnected(网络暂断) 与 rejected(鉴权被拒
  // 终态) 都视为离线、禁发。
  const { connectionState } = useHubSyncStatus();
  const offline =
    connectionState?.state === "disconnected" || connectionState?.state === "rejected";

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
            onWheelCapture={handleWheelCapture}
            overscrollBounce
            smoothWheel
            className="flex-1 bg-workbench-surface"
            viewportClassName="overscroll-contain [overflow-anchor:none] bg-workbench-surface px-4 pt-5 pb-10 pr-6"
            contentClassName="flex w-full flex-col"
          >
            <div role="log" aria-live="polite" aria-atomic="false" className="flex flex-col">
              {timelineItems.map((item, idx) => {
                // 消息行 key 用 clientMsgId(收敛后由 replaceAuthoritative 带到权威条目),使
                // 「乐观→权威」收敛时 key 不变、整行不 remount → 发图时 MessageImage 实例存活,
                // 其内建 transition 接管 data:→服务端 src 切换,首帧不闪。历史消息无 clientMsgId 回退 id。
                const rowKey =
                  item.type === "message"
                    ? ((item.message as ChatMessageEntity).clientMsgId ?? item.id)
                    : item.id;
                return (
                  <MessageTimelineRow
                    key={rowKey}
                    item={item}
                    index={idx}
                    avatarName={conversation.name}
                    avatarColor={conversation.avatarColor}
                    avatarUrl={conversation.avatar}
                    account={conversation.account}
                    onAction={handleAction}
                    setUnreadDividerNode={setUnreadDividerNode}
                  />
                );
              })}
            </div>
          </WorkbenchScrollArea>
        )}
      </div>
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
        getPolishContext={() => buildPolishContext(localMessages)}
        offline={offline}
      />
    </div>
  );
});

const MessageTimelineRow = memo(function MessageTimelineRow({
  item,
  index,
  avatarName,
  avatarColor,
  avatarUrl,
  account,
  onAction,
  setUnreadDividerNode,
}: MessageTimelineRowProps) {
  if (item.type === "date-divider") {
    return (
      <div className={index === 0 ? "" : "mt-7"}>
        <DateDivider label={item.label} />
      </div>
    );
  }
  if (item.type === "unread-divider") {
    return (
      <div ref={setUnreadDividerNode} className={index === 0 ? "" : "mt-7"}>
        <UnreadDivider count={item.count} />
      </div>
    );
  }

  // 间距加大:容纳浮在气泡下方间距里的「重发」状态行(见 MessageBubble.StatusLine,单行
  // 约 16px),并让上下两条气泡有充裕留白。续条 44px / 换发送者 48px。
  // containment 去掉 paint(仅留 layout)——失败/重发行与悬停时间戳是浮出行盒的绝对定位
  // 元素,paint 裁剪会把它们切掉。
  const spacing = index === 0 ? "" : item.isFirstInBurst ? "mt-12" : "mt-11";
  return (
    <div data-message-row-id={item.id} className={cn("[contain:layout_style]", spacing)}>
      <MessageBubble
        message={item.message}
        avatarName={avatarName}
        avatarColor={avatarColor}
        avatarUrl={avatarUrl}
        account={account}
        replyTarget={item.replyTarget}
        onAction={onAction}
      />
    </div>
  );
}, areTimelineRowPropsEqual);

function areTimelineRowPropsEqual(
  prev: MessageTimelineRowProps,
  next: MessageTimelineRowProps,
): boolean {
  if (prev.item.type !== next.item.type) return false;
  if ((prev.index === 0) !== (next.index === 0)) return false;

  if (prev.item.type === "date-divider" && next.item.type === "date-divider") {
    return prev.item.label === next.item.label;
  }

  if (prev.item.type === "unread-divider" && next.item.type === "unread-divider") {
    return (
      prev.item.count === next.item.count && prev.setUnreadDividerNode === next.setUnreadDividerNode
    );
  }

  if (prev.item.type !== "message" || next.item.type !== "message") return false;
  // Prepending older history can change whether the old first visible row is
  // considered the first item in a same-sender burst. Keeping the existing
  // spacing avoids a small but visible "nudge" in the already-read viewport.
  return (
    prev.item.message === next.item.message &&
    prev.item.replyTarget?.senderName === next.item.replyTarget?.senderName &&
    prev.item.replyTarget?.text === next.item.replyTarget?.text &&
    prev.avatarName === next.avatarName &&
    prev.avatarColor === next.avatarColor &&
    prev.avatarUrl === next.avatarUrl &&
    prev.account === next.account &&
    prev.onAction === next.onAction
  );
}

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
