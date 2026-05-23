import { memo, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Loader2 } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { useVirtualizer } from "@tanstack/react-virtual";

import type { SendMessageResp } from "@/lib/api/messageHistory";
import type { Account } from "@/lib/types/account";
import { TRANSITION_DURATIONS, TRANSITION_EASE } from "@/lib/theme";
import { cn } from "@/lib/utils";

import { ChatEmptyState, ChatErrorState, ChatLoadingState } from "./ChatStates";
import { ChatHeader } from "./ChatHeader";
import { COMPOSER_DEFAULT_HEIGHT } from "./constants";
import type { Conversation, Message, QuickReply } from "./data";
import { useChatActions } from "./hooks/useChatActions";
import { useChatTimeline, type TimelineItem } from "./hooks/useChatTimeline";
import { useScrollController } from "./hooks/useScrollController";
import { DateDivider, MessageBubble, type ReplyTarget, UnreadDivider } from "./MessageBubble";
import { MessageComposer } from "./MessageComposer";
import { RangePill } from "./RangePill";
import { STRINGS } from "./strings";
import { WorkbenchScrollArea } from "./WorkbenchScrollArea";

interface ChatAreaProps {
  conversation: Conversation;
  messages: Message[];
  accounts: readonly Account[];
  selectedAccount: string | null;
  onAccountChange: (account: string | null) => void;
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
  /** Conversations available as @mention candidates in the composer. */
  mentionCandidates?: Conversation[];
  /**
   * 真发送回调(text-only)。成功后后端落库 + 发 conversation-messages ChangeNotice,
   * 整窗 REPLACE 把这条收敛进权威列表(乐观气泡随之被替换)。失败则把该气泡标 failed。
   */
  onSendMessage?: (text: string, clientMsgId: string) => Promise<SendMessageResp | void>;
  /** 切走/卸载该会话时回调,补一次 markRead(只在 leave 同步服务端,不按消息打)。 */
  onLeaveMarkRead?: (conversationId: string) => void | Promise<void>;
}

export const ChatArea = memo(function ChatArea({
  conversation,
  messages,
  accounts,
  selectedAccount,
  onAccountChange,
  detailsOpen,
  onToggleDetails,
  loading,
  error,
  onRetry,
  hasMoreHistory = false,
  onLoadMoreHistory,
  quickReplies,
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

  // Stage 3.2 消息区虚拟化:仅长会话(>阈值)启用,短会话/测试走原全量渲染(零结构变化、
  // 测试保持绿)。⚠️ 虚拟模式下与命令式滚动(置底/翻页锚点/未读 pill 滚动到分隔条)的整合
  // 依赖真实布局,需真机手测调和;measureElement 处理动态气泡高度。
  const VIRTUALIZE_THRESHOLD = 50;
  const shouldVirtualize = timelineItems.length > VIRTUALIZE_THRESHOLD;
  const rowVirtualizer = useVirtualizer({
    count: timelineItems.length,
    // 仅虚拟模式才把滚动元素交给虚拟器:否则虚拟器会在挂载时把 viewport scrollTo 到
    // initialOffset=0,覆盖 useScrollController 的 snap 置底(短会话/测试都会被波及)。
    // 返回 null 时虚拟器惰性,完全不碰滚动。虚拟模式下虚拟器与命令式滚动的协调需真机调。
    getScrollElement: () => (shouldVirtualize ? scrollElementRef.current : null),
    estimateSize: () => 76,
    overscan: 10,
  });

  // 单条 timeline 行的内容(不含间距/包裹):虚拟与非虚拟分支共用,避免重复。
  const renderRowContent = (item: TimelineItem) => {
    if (item.type === "date-divider") return <DateDivider label={item.label} />;
    if (item.type === "unread-divider") return <UnreadDivider count={item.count} />;
    return (
      <MessageBubble
        message={item.message}
        avatarName={conversation.name}
        avatarColor={conversation.avatarColor}
        account={conversation.account}
        replyTarget={item.replyTarget}
        onAction={handleAction}
      />
    );
  };

  // 会话切换时 ChatHeader 和消息区必须同步 crossfade,不然标题(头像/名字/账号)
  // 瞬间硬切而消息区淡入淡出,视觉上"出一下出两下"。两块都用 conversation.id 作
  // AnimatePresence key + 同样的 duration/ease,触发与时长完全一致 → 像一个动作。
  // RangePill 显示的是 selectedAccount(跨会话不变),保持流式硬切即可,不加 motion。
  const headerHeight = 76;
  const motionAttrs = {
    initial: { opacity: 0, pointerEvents: "none" as const },
    animate: { opacity: 1, pointerEvents: "auto" as const },
    exit: { opacity: 0, pointerEvents: "none" as const },
    transition: {
      duration: TRANSITION_DURATIONS.quick / 1000,
      ease: TRANSITION_EASE,
    },
  };

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-workbench-surface">
      <div className="relative" style={{ height: headerHeight }}>
        <AnimatePresence initial={false}>
          <motion.div key={conversation.id} className="absolute inset-0" {...motionAttrs}>
            <ChatHeader conversation={conversation} />
          </motion.div>
        </AnimatePresence>
      </div>
      <RangePill
        accounts={accounts}
        selectedAccount={selectedAccount}
        onAccountChange={onAccountChange}
      />
      {/* 会话切换:消息区 crossfade(非 mode="wait")—— 两条会话同时 absolute 叠加,
          旧的 opacity:1→0、新的 opacity:0→1 同时跑,中间没有空白瞬间。key 只取
          conversation.id —— 不复合 loading/error/empty/data,避免同一会话内
          loading→data 的状态变化也跑动画(那才是之前"3 段闪"的根因)。
          exit 时把 pointerEvents 切成 'none' —— 旧 motion.div 还在 fade-out 时
          仍占满 inset-0、默认拦截 wheel/pointer 事件,导致用户切完会话立刻滚动
          滑轮没反应(事件落到正在消失的旧层而非新 ScrollArea)。framer-motion 把
          pointerEvents 当作非补间属性,在 exit 触发瞬间直接 snap 到 'none'。 */}
      <div className="relative flex min-h-0 flex-1">
        <AnimatePresence initial={false}>
          <motion.div
            key={conversation.id}
            className="absolute inset-0 flex min-h-0 flex-col overflow-hidden"
            {...motionAttrs}
          >
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
                      // margin 在盒外不计入 getBoundingClientRect。
                      const spacing =
                        idx === 0
                          ? ""
                          : item.type === "message"
                            ? item.isFirstInBurst
                              ? "pt-7"
                              : "pt-6"
                            : "pt-7";
                      return (
                        <div
                          key={item.id}
                          data-index={idx}
                          ref={rowVirtualizer.measureElement}
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
          </motion.div>
        </AnimatePresence>
      </div>
      {/* 翻历史 spinner:length>0 时的 loading 必是翻页加载(初次加载 length===0 走
          ChatLoadingState 分支)。绝对定位顶部居中,不挤压消息流、不引发回弹位移。 */}
      {!error && localMessages.length > 0 && loading && hasMoreHistory && <HistoryLoadingPill />}
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
      <MessageComposer
        key={conversation.id}
        conversationId={conversation.id}
        height={composerHeight}
        onHeightChange={setComposerHeight}
        detailsOpen={detailsOpen}
        onToggleDetails={onToggleDetails}
        onSend={handleSend}
        quickReplies={quickReplies}
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
// 顶部居中的"加载更早消息"指示。非交互(role=status),只在向上翻页拉取时出现。
// 绝对定位 + translate 居中,不参与消息流布局,避免 prepend 时与内容互相挤压。
const HistoryLoadingPill = memo(function HistoryLoadingPill() {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "pointer-events-none absolute left-1/2 top-3 z-20 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-workbench-line bg-workbench-surface px-2.5 py-1 text-wb-2xs font-medium text-workbench-text-secondary shadow-wb-popover",
        "animate-in fade-in slide-in-from-top-2",
      )}
    >
      <Loader2 size={13} className="shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />
      <span>{STRINGS.status.loadingHistory}</span>
    </div>
  );
});
