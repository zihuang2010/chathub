import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";

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
import { EnlargeReader } from "./EnlargeReader";
import { ForwardDialog, type ForwardTarget } from "./ForwardDialog";
import { DateDivider, MessageBubble, type ReplyTarget, UnreadDivider } from "./MessageBubble";
import { MessageComposer } from "./MessageComposer";
import type { MessageActionType } from "./MessageContextMenu";
import { nextOfflineSticky } from "./offlineState";
import { RangePill } from "./RangePill";
import type { ChatMessageEntity } from "./store/chatStore";
import { STRINGS } from "./strings";
import { estimateTimelineRowHeight, getVirtualOverscan } from "./virtualListSizing";
import { WorkbenchScrollArea } from "./WorkbenchScrollArea";

type MessageTimelineItem = ReturnType<typeof useChatTimeline>[number];

// 行 key:乐观→权威收敛时 clientMsgId 由 replaceAuthoritative 带到权威条目,key 不变 →
// 整行不 remount、MessageImage 实例存活、首帧不闪。历史消息无 clientMsgId 回退 id。
// 同时供 useVirtualizer 的 getItemKey 复用,保证虚拟器按稳定 key 复用已测尺寸。
function timelineRowKey(item: MessageTimelineItem): string {
  return item.type === "message"
    ? ((item.message as ChatMessageEntity).clientMsgId ?? item.id)
    : item.id;
}

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
  /** Stage C:窗口底之下是否仍有更新行(= !slice.atCacheBottom);近底预取 loadNewer 的门控。 */
  hasMoreNewer?: boolean;
  /** Stage C:用户下滚近底时把曾 drop 的较新行重新拉回(对称 onLoadMoreHistory)。 */
  onLoadNewer?: () => Promise<void> | void;
  /** Stage C:贴底实时 ref(MessagesPage 持有);useScrollController 在维护 wasAtBottomRef 处镜像写入。 */
  atBottomRef?: MutableRefObject<boolean>;
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
  /** 当前会话所属企微账号 ID,透传给 useChatActions 供失败消息落库用。 */
  wecomAccountId?: string;
  /** 当前会话外部用户 ID,透传给 useChatActions 供失败消息落库用。 */
  externalUserId?: string;
  /** 可转发到的最近会话(由 MessagesPage 派生);转发弹层的目标列表。 */
  forwardTargets?: ForwardTarget[];
  /** 转发一条消息到多个目标会话(仅文本);由 MessagesPage 调 sendMessage 批量实现。 */
  onForward?: (message: Message, targets: ForwardTarget[]) => void;
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
  hasMoreNewer = false,
  onLoadNewer,
  atBottomRef,
  quickReplies,
  onCreateQuickReply,
  onUpdateQuickReply,
  onDeleteQuickReply,
  mentionCandidates,
  onSendMessage,
  onLeaveMarkRead,
  wecomAccountId,
  externalUserId,
  forwardTargets,
  onForward,
}: ChatAreaProps) {
  const [composerHeight, setComposerHeight] = useState(COMPOSER_DEFAULT_HEIGHT);
  // 放大阅读 / 转发弹层:右键菜单的 enlarge/forward 在 ChatArea 拦截(本地 UI 态),
  // 不进 useChatActions(那里只管发送/重发/删除/撤回/引用等 store 动作)。
  const [enlargeMessage, setEnlargeMessage] = useState<Message | null>(null);
  const [forwardMessage, setForwardMessage] = useState<Message | null>(null);
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

  // 未读分隔条在 timelineItems 里的下标(无未读为 -1)。Stage B 虚拟化后分隔条 DOM 可能
  // 被卸载,scrollToUnread 改用虚拟器 scrollToIndex,需把该 index 注入控制器。
  const unreadDividerIndex = useMemo(
    () => timelineItems.findIndex((item) => item.type === "unread-divider"),
    [timelineItems],
  );

  // 虚拟器实例用 ref 桥接:控制器(scrollToUnread)需要 scrollToIndex,但虚拟器在控制器
  // 之后才创建 → 用稳定回调读 ref,打破"控制器先于虚拟器"的初始化时序环。
  const virtualizerRef = useRef<ReturnType<typeof useVirtualizer<HTMLDivElement, Element>> | null>(
    null,
  );
  const scrollToIndex = useCallback(
    (index: number, options?: { align?: "start" | "center" | "end" }) => {
      virtualizerRef.current?.scrollToIndex(index, options);
    },
    [],
  );
  // 未读分隔条行被虚拟卸载后 DOM 不可用,handleUserScroll 的 pill 判定回退到虚拟器估算的行 offset。
  // getOffsetForIndex(index, "start") 返回 [offset, align] | undefined(react-virtual v3),取 [0]
  // 即该行相对内容顶的 offset(与 viewport.scrollTop 同坐标系,可直接比较"在视口上方")。
  const getOffsetForIndex = useCallback(
    (index: number): number | null =>
      virtualizerRef.current?.getOffsetForIndex(index, "start")?.[0] ?? null,
    [],
  );

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
    scrollElementRef,
  } = useScrollController({
    conversation,
    localMessages,
    loading,
    error,
    hasMoreHistory,
    onLoadMoreHistory,
    hasMoreNewer,
    onLoadNewer,
    atBottomRef,
    onLeaveMarkRead,
    unreadDividerIndex,
    scrollToIndex,
    getOffsetForIndex,
  });

  // Stage B 渲染虚拟化:DOM 节点与离屏图片位图恒定(≈可见 + overscan)。
  //   - getScrollElement 复用控制器持有的 viewport node(WorkbenchScrollArea 的同一 viewport,
  //     经 setScrollNode 写入),不另建容器 → 保留 ScrollMetrics/ResizeObserver/overscroll 通道。
  //   - estimateSize 复用 virtualListSizing.estimateTimelineRowHeight(图片行接 dims 缓存、
  //     与渲染盒对齐),杜绝写死常数引起的首帧大幅校正「整列下沉」(上次回退主因)。
  //   - getItemKey=clientMsgId??id(timelineRowKey),保乐观→权威收敛零 remount、发图不闪。
  //   - 不做阈值门控:统一虚拟化,消除 49→50 跨阈值切换渲染结构的跳变。
  //   - initialOffset=首挂时的 scrollHeight(到底):react-virtual v3 首次发现 scrollElement
  //     (null→node)时 _willUpdate 会 _scrollToOffset(getScrollOffset());首挂 scrollOffset 为 null
  //     → 退回 initialOffset。不传(默认 0)会把 useScrollController snap 的 scrollTop=scrollHeight
  //     打回 0,只靠 snap 的 rAF 二次置底碰巧抢赢、脆弱。把初始 offset 目标本身设成"到底",从根上
  //     消除与 snap 对打。initialOffset 只在虚拟器初始化(首挂)读一次,切会话不重读(实例持久),
  //     故不影响后续切会话 snap(那走 useScrollController 的 layout effect)。
  const virtualizer = useVirtualizer({
    count: timelineItems.length,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: (index) => estimateTimelineRowHeight(timelineItems[index]),
    overscan: getVirtualOverscan(timelineItems),
    getItemKey: (index) => timelineRowKey(timelineItems[index]),
    initialOffset: () => scrollElementRef.current?.scrollHeight ?? 0,
  });
  virtualizerRef.current = virtualizer;
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
    wecomAccountId,
    externalUserId,
  });

  // 在 ChatArea 拦截 enlarge/forward(开本地弹层),其余动作仍交给 useChatActions。
  // useCallback 保持引用稳定:onAction 进 MessageTimelineRow 的 memo 比较,引用变化会整列重渲。
  const handleMessageAction = useCallback(
    (action: MessageActionType, message: Message) => {
      if (action === "enlarge") {
        setEnlargeMessage(message);
        return;
      }
      if (action === "forward") {
        setForwardMessage(message);
        return;
      }
      handleAction(action, message);
    },
    [handleAction],
  );

  // hub 连接断开时禁用发送并在 composer 顶部提示离线(E①)。连接态由 useHubSyncStatus 经
  // hub:connection 事件派生,与 Sidebar 在线圆点同源;disconnected(网络暂断) 与 rejected(鉴权被拒
  // 终态) 都视为离线、禁发。
  //
  // 「粘滞」派生:重连期间后端 run_loop 退避重试会反复 Connecting↔Disconnected 跳变,若直接按
  // disconnected 瞬时派生,离线横幅会随每次重连尝试显隐 → 闪烁。改用 nextOfflineSticky 维持上一
  // 稳定态(connecting 不翻转),整段重连保持稳定,只在真正 subscribed 后才消失。
  const { connectionState } = useHubSyncStatus();
  // 惰性初始化:挂载时即按当前连接态派生。若用 useState(false),在「已离线时首次进入会话」
  // (或 ChatArea 由无会话→有会话重挂)时首帧 offline 恒为 false → 横幅延迟一帧滑入、发送按钮
  // 一帧内误可用,effect 跑完才纠正。惰性初始化让首帧即正确,无延迟、无动画重放。
  const [offline, setOffline] = useState(() => nextOfflineSticky(false, connectionState));
  useEffect(() => {
    setOffline((prev) => nextOfflineSticky(prev, connectionState));
  }, [connectionState]);

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
            {/* Stage B 渲染虚拟化:外层 spacer 高度 = 虚拟器 totalSize(撑出真实可滚高度,
                spacer 高=totalSize 时「scrollTop=scrollHeight」即等价置底,控制器贴底/snap 逻辑
                作用对象不变)。role=log a11y 容器留在 spacer 上;每行绝对定位 + translateY(start),
                ref=measureElement 实测高校正估高(图片行不再据差值整列下沉)。 */}
            <div
              role="log"
              aria-live="polite"
              aria-atomic="false"
              style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}
            >
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const item = timelineItems[virtualRow.index];
                if (!item) return null;
                return (
                  <div
                    key={virtualRow.key}
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
                    <MessageTimelineRow
                      item={item}
                      index={virtualRow.index}
                      avatarName={conversation.name}
                      avatarColor={conversation.avatarColor}
                      avatarUrl={conversation.avatar}
                      account={conversation.account}
                      onAction={handleMessageAction}
                      setUnreadDividerNode={setUnreadDividerNode}
                    />
                  </div>
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
      {enlargeMessage && (
        <EnlargeReader text={enlargeMessage.text} onClose={() => setEnlargeMessage(null)} />
      )}
      {forwardMessage && (
        <ForwardDialog
          targets={forwardTargets ?? []}
          previewText={forwardMessage.text}
          onForward={(targets) => onForward?.(forwardMessage, targets)}
          onClose={() => setForwardMessage(null)}
        />
      )}
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
  // 行间距用 padding(pt-*)而非 margin(mt-*):Stage B 虚拟化后每行包在绝对定位盒里、由
  // measureElement 量 getBoundingClientRect 高度并入 totalSize/offset;margin 在盒外不计入实测
  // → 会让估高与实测错位、整列漂。改 padding(border-box)后间距被实测、虚拟器精确对齐(参 34eca70
  // 与 ConversationList 的 padding-for-spacing)。
  if (item.type === "date-divider") {
    return (
      <div className={index === 0 ? "" : "pt-7"}>
        <DateDivider label={item.label} />
      </div>
    );
  }
  if (item.type === "unread-divider") {
    return (
      <div ref={setUnreadDividerNode} className={index === 0 ? "" : "pt-7"}>
        <UnreadDivider count={item.count} />
      </div>
    );
  }

  // 间距加大:容纳浮在气泡下方间距里的「重发」状态行(见 MessageBubble.StatusLine,单行
  // 约 16px),并让上下两条气泡有充裕留白。续条 44px / 换发送者 48px。
  // containment 去掉 paint(仅留 layout)——失败/重发行与悬停时间戳是浮出行盒的绝对定位
  // 元素,paint 裁剪会把它们切掉。
  const spacing = index === 0 ? "" : item.isFirstInBurst ? "pt-12" : "pt-11";
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
