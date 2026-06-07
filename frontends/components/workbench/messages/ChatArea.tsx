import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import {
  Virtuoso,
  type Components,
  type ListProps,
  type ListRange,
  type ScrollerProps,
  type VirtuosoHandle,
} from "react-virtuoso";

import type { SendMessageResp } from "@/lib/api/messageHistory";
import { useHubSyncStatus } from "@/lib/data/useHubSyncStatus";
import type { Account } from "@/lib/types/account";
import { showToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

import { ChatEmptyState, ChatErrorState, ChatLoadingState } from "./ChatStates";
import { ChatHeader } from "./ChatHeader";
import { buildPolishContext } from "./composer/polishContext";
import { COMPOSER_DEFAULT_HEIGHT } from "./constants";
import type { Conversation, Message, QuickReply } from "./data";
import { resolvePrependShift, type FirstItemIndexAnchor } from "./hooks/firstItemIndexAnchor";
import {
  initialRevealGateState,
  REVEAL_AT_BOTTOM_EPSILON,
  stepRevealGate,
} from "./hooks/scrollRevealGate";
import { useChatActions, type SendMessageOptions } from "./hooks/useChatActions";
import { useChatTimeline } from "./hooks/useChatTimeline";
import { EnlargeReader } from "./EnlargeReader";
import { ForwardDialog, type ForwardTarget } from "./ForwardDialog";
import { DateDivider, MessageBubble, type ReplyTarget, UnreadDivider } from "./MessageBubble";
import { MessageComposer } from "./MessageComposer";
import type { MessageActionType } from "./MessageContextMenu";
import { nextOfflineSticky } from "./offlineState";
import { RangePill } from "./RangePill";
import type { ChatMessageEntity } from "./store/chatStore";
import { STRINGS } from "./strings";

type MessageTimelineItem = ReturnType<typeof useChatTimeline>[number];

// 切会话重挂 Virtuoso 后,firstItemIndex 重置回此基值(留足下探空间给 prepend)。
const INITIAL_FIRST_ITEM_INDEX = 1_000_000;

// 行 key:乐观→权威收敛时 clientMsgId 由 replaceAuthoritative 带到权威条目,key 不变 →
// 整行不 remount、MessageImage 实例存活、首帧不闪。历史消息无 clientMsgId 回退 id。
// 供 Virtuoso 的 computeItemKey 复用,保证按稳定 key 复用已测高、收敛零 remount。
function timelineRowKey(item: MessageTimelineItem): string {
  return item.type === "message"
    ? ((item.message as ChatMessageEntity).clientMsgId ?? item.id)
    : item.id;
}

// Virtuoso 自定义滚动容器:只承载竖向滚动 + 背景 + wb-thumb 滚动条样式(wb-thumb 由 index.css
// 全局 *::-webkit-scrollbar 命中,不必特殊处理)。Virtuoso 自管 overflow/scrollTop,这里只透传
// ref + props + 套 className。[overflow-anchor:none] 关掉浏览器原生锚定,避免与 Virtuoso 的
// firstItemIndex prepend 锚定打架。
// ⚠️ 横向 padding 必须放 List(下方),不能放这里:Virtuoso 的 viewport 是 position:absolute +
// width:100%;绝对定位元素的 width:100% 按「包含块的 padding box」算、静态左缘又落在内容盒原点 →
// 给 Scroller 加横向 padding 会把整个 viewport 右移 padding-left,右侧(出站头像)随之溢出被裁。
// overflow-x-hidden 保留作安全网:Scroller 内联只设 overflow-y:auto,CSS 会把另一轴 visible 提升为
// auto,内容稍超宽(亚像素/绝对定位浮出元素)就冒横条;竖向聊天不需横滚,显式 hidden 关掉。
const Scroller = forwardRef<HTMLDivElement, ScrollerProps>(function Scroller(props, ref) {
  return (
    <div
      ref={ref}
      {...props}
      className="overflow-x-hidden overscroll-contain bg-workbench-surface [overflow-anchor:none]"
    />
  );
});

// Virtuoso 承载所有 item 的常规流容器:横向内边距放这里(padding 行为正常),而非 Scroller
// (其内 viewport 为 position:absolute+width:100%,横向 padding 会令内容右移并裁切出站头像)。
// 左 16 / 右 24:右侧多留是给竖向滚动条让位。List 的纵向 paddingTop/Bottom 由 Virtuoso 内联写入,
// 与此处横向 padding 是不同 longhand,二者共存不冲突。
const List = forwardRef<HTMLDivElement, ListProps>(function List(props, ref) {
  return <div ref={ref} {...props} className="px-4 pr-6" />;
});

// 顶/底留白用 Header/Footer 占位盒(替原 viewport 的 pt-5 / pb-10):Header 撑出列表顶部留白,
// Footer 撑出底部留白(短列表时也保证最后一条与 composer 间有余量)。
const ListHeader = () => <div className="h-5" />;
const ListFooter = () => <div className="h-10" />;

// 模块级常量:components 对象引用稳定,避免每次 render 让 Virtuoso 重建内部组件。
const VIRTUOSO_COMPONENTS: Components<MessageTimelineItem> = {
  Scroller,
  List,
  Header: ListHeader,
  Footer: ListFooter,
};

// increaseViewportBy 替原 overscan:视口上下额外渲染的像素带(上方多给些,翻历史更稳)。
const INCREASE_VIEWPORT_BY = { top: 600, bottom: 400 } as const;

// 未测量行的初始高度估值:让 Virtuoso 首帧就把 LAST 定位到接近底部、缩短首屏定位窗口(官方防
// 首屏抖动手段)。真实高度测出后即用真实值,不影响 prepend 的 firstItemIndex 锚定(按下标不按高度)。
const DEFAULT_ROW_HEIGHT = 84;

interface MessageTimelineRowProps {
  item: MessageTimelineItem;
  index: number;
  avatarName: string;
  avatarColor?: string;
  avatarUrl?: string;
  account: string;
  onAction: (action: MessageActionType, message: Message) => void;
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
   *   - 翻页加载: 触顶 startReached 用它做"重入 guard"
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
  /** Stage C:贴底实时 ref(MessagesPage 持有);readCache 据它判塌缩/缝合,本组件镜像写入。 */
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

  // 未读分隔条在 timelineItems 里的下标(无未读为 -1)。供 scrollToUnread / 上方未读 pill 判定用。
  const unreadDividerIndex = useMemo(
    () => timelineItems.findIndex((item) => item.type === "unread-divider"),
    [timelineItems],
  );

  // Virtuoso 命令式句柄(scrollToIndex):scrollToUnread / 滚到底按钮 / 发送贴底用。
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);

  // ── 贴底状态 ───────────────────────────────────────────────────────────────
  // atBottom 驱动「滚到底」按钮显隐;wasAtBottomRef 镜像给 useChatActions(发送后置 true)+
  // 外部 atBottomRef(MessagesPage 持有,readCache 据它判塌缩/缝合)。三者经 setAtBottomState 同步。
  const [atBottom, setAtBottom] = useState(true);
  const wasAtBottomRef = useRef(true);
  const [unreadBelow, setUnreadBelow] = useState(0);
  const setAtBottomState = useCallback(
    (v: boolean) => {
      wasAtBottomRef.current = v;
      if (atBottomRef) atBottomRef.current = v;
      setAtBottom((prev) => (prev === v ? prev : v));
      if (v) setUnreadBelow(0);
    },
    [atBottomRef],
  );

  // ── 切会话首屏定位遮罩 ────────────────────────────────────────────────────────
  // Virtuoso 重挂后用 initialTopMostItemIndex 定位到底:这期间内容由其自带 visibility 遮罩盖住,但
  // Scroller 的滚动条不被盖 → 能看到「空白 + 滚动条从上滑到下」再出内容的闪。用一层 opacity 门把整个
  // 滚动区(连同滚动条)在「落到底」前藏掉,atBottomStateChange(true)(落到底)再揭开 → 直接呈现贴底
  // 内容、无滚动条行程。按 chatStoreKey(Virtuoso 重挂键)重置(渲染期存上一帧 key,收敛不死循环)。
  const [reveal, setReveal] = useState({ key: chatStoreKey, shown: false });
  if (reveal.key !== chatStoreKey) setReveal({ key: chatStoreKey, shown: false });
  // 揭开时机:必须等 Virtuoso 的「测量收敛」后再揭开。重挂后 Virtuoso 按扁平 DEFAULT_ROW_HEIGHT 估高把
  // 列表定位到「估算的底部」,真实行高测出后列表撑大、再向下滚一段贴底 —— 这段「滚轮从上滑到下」正是要
  // 遮住的闪。若按估高那帧就判「已贴底」揭开,修正滚动就暴露。故 gate 据 totalListHeightChanged 版本号判
  // 收敛(估高→真实高度的修正会刷新版本),版本连续 N 帧不变且真实 scrollTop 贴底(或内容不足一屏)才揭开;
  // 不用 Virtuoso 的 atBottom 回调(实测它在真正落位前就报 true)。仅 Scroller 已挂且有高度的帧计入兜底额度,
  // 冷加载等数据期间不空耗。真实贴底是所有揭开路径(含兜底)的硬前提 —— 否则会露出 react-virtuoso 在
  // scrollTop:0 渲染周期里「行浮在底部、视口空白」的那一帧(MAX_FRAMES 放宽收敛但仍要求贴底,HARD_MAX
  // 仅防极端卡死永久隐藏)。判定逻辑见纯函数 stepRevealGate(带单测)。
  const scrollerElRef = useRef<HTMLElement | null>(null);
  // totalListHeightChanged 版本号:Virtuoso 每测得新总高 +1。ref 跨会话常驻,gate 以「与上一帧比对」工作,
  // 绝对值无所谓(切会话重挂后 Virtuoso 重新 emit、gate 也随 effect 重置)。
  const heightVersionRef = useRef(0);
  const handleTotalListHeightChanged = useCallback(() => {
    heightVersionRef.current += 1;
  }, []);
  useEffect(() => {
    let raf = 0;
    let gate = initialRevealGateState();
    const tick = () => {
      const el = scrollerElRef.current;
      const scrollHeight = el?.scrollHeight ?? 0;
      const clientHeight = el?.clientHeight ?? 0;
      const scrollTop = el?.scrollTop ?? 0;
      const stepped = stepRevealGate(gate, {
        heightVersion: heightVersionRef.current,
        measured: scrollHeight > 0,
        atBottom: scrollHeight - clientHeight - scrollTop <= REVEAL_AT_BOTTOM_EPSILON,
        fitsNoScroll: scrollHeight <= clientHeight + REVEAL_AT_BOTTOM_EPSILON,
      });
      gate = stepped.state;
      if (stepped.reveal) {
        setReveal((r) => (r.shown ? r : { ...r, shown: true }));
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [chatStoreKey]);

  // ── 上方未读 pill ──────────────────────────────────────────────────────────
  // 用户从底部上滚、未读分隔条仍在视口上方(未看到)时点亮。看到(rangeChanged 越过分隔条)即清。
  const [unreadAbove, setUnreadAbove] = useState(0);
  const hasSeenDividerRef = useRef(false);

  // ── firstItemIndex 派生(渲染期,锚最旧「消息」行)────────────────────────────
  // 窗口只增不减:prepend 更旧消息后,据「旧锚消息在新表的下标 − 旧下标 = 锚上方净新增行数」
  // 把 firstItemIndex 下移,使 Virtuoso 据 firstItemIndex 锚定、当前可见内容保持稳定。
  // 锚必须取「消息」行而非首行:首行恒是日期分隔条,其 key 含当日首条 id,同日 prepend 会令其
  // 变更且旧 key 从列表消失 → findIndex 得 -1 漏锚 → 视口跳。消息 id 稳定、更旧消息恒插其上方。
  // 增量算法抽到纯函数 resolvePrependShift(带单测),此处只接线 + 渲染期条件 setState;切会话
  // (conv 变)重置回基值并随 key={chatStoreKey} 重挂。React 官方「渲染期存上一帧信息」(useState)
  // 模式:渲染期条件 setState,React 丢弃当前渲染并立即重渲,条件收敛不死循环。
  const rowKeys = useMemo(() => timelineItems.map(timelineRowKey), [timelineItems]);
  const oldestMessageIndex = useMemo(
    () => timelineItems.findIndex((item) => item.type === "message"),
    [timelineItems],
  );
  const [firstIndexState, setFirstIndexState] = useState<FirstItemIndexAnchor & { convId: string }>(
    {
      convId: conversation.id,
      anchorKey: oldestMessageIndex >= 0 ? rowKeys[oldestMessageIndex] : "",
      anchorIndex: oldestMessageIndex,
      firstItemIndex: INITIAL_FIRST_ITEM_INDEX,
    },
  );
  let firstItemIndex = firstIndexState.firstItemIndex;
  if (firstIndexState.convId !== conversation.id) {
    // 切会话:重置 firstItemIndex 基值 + 锚 + 贴底/未读 pill 本地态(随 key={chatStoreKey} 重挂回
    // 首屏贴底)。这些渲染期 setState 被 React 丢弃当前渲染并立即重渲,条件收敛(convId 已更新)
    // 不死循环。配套 ref 重置(wasAtBottomRef / hasSeenDividerRef / 外部 atBottomRef)在下方 layout
    // effect 做——渲染期禁写 ref(react-hooks/refs)。
    firstItemIndex = INITIAL_FIRST_ITEM_INDEX;
    setFirstIndexState({
      convId: conversation.id,
      anchorKey: oldestMessageIndex >= 0 ? rowKeys[oldestMessageIndex] : "",
      anchorIndex: oldestMessageIndex,
      firstItemIndex,
    });
    setAtBottom(true);
    setUnreadBelow(0);
    setUnreadAbove(0);
  } else {
    const next = resolvePrependShift(firstIndexState, rowKeys, oldestMessageIndex);
    firstItemIndex = next.firstItemIndex;
    if (next.changed) {
      setFirstIndexState({
        convId: conversation.id,
        anchorKey: next.anchorKey,
        anchorIndex: next.anchorIndex,
        firstItemIndex: next.firstItemIndex,
      });
    }
  }

  // 切会话:重置贴底/已看分隔条相关的 ref(渲染期禁写 ref,故放 layout effect)。外部 atBottomRef
  // 同步置 true → 新会话首屏 readCache 走整窗塌缩。只写 ref、不 setState,故无 set-state-in-effect。
  useLayoutEffect(() => {
    wasAtBottomRef.current = true;
    hasSeenDividerRef.current = false;
    if (atBottomRef) atBottomRef.current = true;
  }, [conversation.id, atBottomRef]);

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

  // ── 切走/卸载该会话补一次 markRead ──────────────────────────────────────────
  // 打开期间客户消息已读靠列表红标抑制(view-only),服务端只在离开时同步一次。
  // 用 ref 读实时 unread,不入 deps,避免每来一条消息就重跑 cleanup。
  const leaveUnreadRef = useRef(conversation.unread ?? 0);
  useEffect(() => {
    leaveUnreadRef.current = conversation.unread ?? 0;
  }, [conversation.unread]);
  const onLeaveMarkReadRef = useRef(onLeaveMarkRead);
  useEffect(() => {
    onLeaveMarkReadRef.current = onLeaveMarkRead;
  }, [onLeaveMarkRead]);
  useEffect(() => {
    const leavingId = conversation.id;
    return () => {
      if (leavingId && leaveUnreadRef.current > 0) void onLeaveMarkReadRef.current?.(leavingId);
    };
    // 仅在会话切换/卸载触发;实时 unread / 回调走 ref(已各自入 deps 镜像),故 deps 仅会话 id。
  }, [conversation.id]);

  // ── 发送贴底(仅同会话内追加;切会话/首挂的贴底交给 initialTopMostItemIndex)──────────
  // useChatActions 发送后置 wasAtBottomRef.current=true;同会话 timelineItems 变化时若仍贴底 → 显式
  // 滚到底(followOutput 兜常规「贴底+新到达」,这里兜「发送瞬间内容增多」)。
  // ⚠️ 切会话/首挂这一帧(chatStoreKey 变 → Virtuoso 重挂)绝不可命令式 scrollToIndex:重挂实例的
  // 首屏贴底由 <Virtuoso initialTopMostItemIndex> 负责,它落位前自带 visibility 遮罩、不绘制(无闪);
  // 此时再命令式滚动会提前掀开遮罩、露出尚未落位的首帧 → 切会话「从上往下滑一下」的闪。故跟踪
  // chatStoreKey,重挂后的「首个有数据帧」只标记就绪、不滚,之后的同会话追加才接管。
  const stickRef = useRef({ key: chatStoreKey, ready: false });
  useLayoutEffect(() => {
    const stick = stickRef.current;
    if (stick.key !== chatStoreKey) {
      stick.key = chatStoreKey;
      stick.ready = false;
    }
    if (!stick.ready) {
      if (timelineItems.length > 0) stick.ready = true; // 首个有数据帧:贴底归 initialTopMostItemIndex
      return;
    }
    if (wasAtBottomRef.current) {
      virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end" });
    }
  }, [timelineItems, chatStoreKey]);

  // ── 未读 below 计数 ────────────────────────────────────────────────────────
  // 非贴底时尾部新增 INCOMING 消息累计 below 计数(给「N 条新消息」滚到底按钮用)。头部 prepend
  // 更旧页时尾 key 不变 → 不触发。用末尾 key 比对识别「尾部新增」,避免把翻历史误当新消息。
  const lastTailKeyRef = useRef<string>("");
  useEffect(() => {
    const tailKey =
      timelineItems.length > 0 ? timelineRowKey(timelineItems[timelineItems.length - 1]) : "";
    const prevTailKey = lastTailKeyRef.current;
    lastTailKeyRef.current = tailKey;
    if (!prevTailKey || tailKey === prevTailKey) return; // 首帧 / 尾未变(prepend) → 不计
    if (wasAtBottomRef.current) return; // 贴底由 followOutput 跟随,不计未读
    // 末尾新增条目里数 INCOMING:从旧尾 key 之后的新行里筛 direction==="in"。
    const prevTailIdx = timelineItems.findIndex((item) => timelineRowKey(item) === prevTailKey);
    if (prevTailIdx < 0) return; // 旧尾不在新列表(整窗替换/切会话)→ 不计
    let incoming = 0;
    for (let i = prevTailIdx + 1; i < timelineItems.length; i++) {
      const item = timelineItems[i];
      if (item.type === "message" && item.message.direction === "in") incoming++;
    }
    // 数据到达(timelineItems 这一外部源更新)驱动的未读计数同步,非渲染期自激;与原
    // useScrollController 的等价 new-message-follow 计数同源,显式豁免 set-state-in-effect。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (incoming > 0) setUnreadBelow((c) => c + incoming);
  }, [timelineItems]);

  // ── 翻更旧页(触顶)─────────────────────────────────────────────────────────
  // Virtuoso 进顶区自带「触发一次」语义,无需边沿门。in-flight / loading / 无更多由下方守卫挡。
  const historyLoadInFlightRef = useRef(false);
  const handleStartReached = useCallback(() => {
    if (historyLoadInFlightRef.current || loading || !hasMoreHistory || !onLoadMoreHistory) return;
    historyLoadInFlightRef.current = true;
    Promise.resolve(onLoadMoreHistory())
      .catch(() => showToast(STRINGS.errors.loadFailed, { type: "error" }))
      .finally(() => {
        historyLoadInFlightRef.current = false;
      });
  }, [loading, hasMoreHistory, onLoadMoreHistory]);

  // ── 上方未读 pill:rangeChanged 判定 ────────────────────────────────────────
  // 绝对 dividerIndex = firstItemIndex + unreadDividerIndex(Virtuoso 的 range 用绝对下标)。
  //   - range.startIndex > 绝对dividerIndex → 已滚过分隔条(看到)→ 清 pill + 标 seen;
  //   - range.startIndex < 绝对dividerIndex 且未 seen 且有未读 → 点亮 pill。
  const handleRangeChanged = useCallback(
    (range: ListRange) => {
      if (unreadDividerIndex < 0) return;
      const absDivider = firstItemIndex + unreadDividerIndex;
      if (range.startIndex > absDivider) {
        hasSeenDividerRef.current = true;
        setUnreadAbove((prev) => (prev === 0 ? prev : 0));
        return;
      }
      if (hasSeenDividerRef.current) return;
      const unread = conversation.unread ?? 0;
      if (unread <= 0) return;
      setUnreadAbove((prev) => (prev === unread ? prev : unread));
    },
    [unreadDividerIndex, firstItemIndex, conversation.unread],
  );

  const scrollToUnread = useCallback(() => {
    if (unreadDividerIndex < 0) return;
    // 传 data 相对 index,Virtuoso 内部加 firstItemIndex。
    virtuosoRef.current?.scrollToIndex({
      index: unreadDividerIndex,
      align: "center",
      behavior: "smooth",
    });
  }, [unreadDividerIndex]);

  const scrollToBottom = useCallback(() => {
    virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "smooth" });
  }, []);

  // Scroller DOM 节点(react-virtuoso 经 scrollerRef 回填):首屏遮罩据其真实 scrollTop 判到底。
  const handleScrollerRef = useCallback((el: HTMLElement | Window | null) => {
    scrollerElRef.current = el instanceof HTMLElement ? el : null;
  }, []);

  const handleAtBottomStateChange = useCallback(
    (next: boolean) => {
      setAtBottomState(next);
    },
    [setAtBottomState],
  );

  const followOutput = useCallback(
    (isAtBottom: boolean): "auto" | false => (isAtBottom ? "auto" : false),
    [],
  );

  const itemContent = useCallback(
    (index: number, item: MessageTimelineItem) => (
      <MessageTimelineRow
        item={item}
        index={index}
        avatarName={conversation.name}
        avatarColor={conversation.avatarColor}
        avatarUrl={conversation.avatar}
        account={conversation.account}
        onAction={handleMessageAction}
      />
    ),
    [
      conversation.name,
      conversation.avatarColor,
      conversation.avatar,
      conversation.account,
      handleMessageAction,
    ],
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
    // connectionState(外部连接态)更新驱动的离线态同步,从依赖派生、非渲染期自激(本就是 effect
    // 的正当用途)。本组件含渲染期 setState(firstIndexState 按会话/prepend 调整),React Compiler
    // 的整组件分析会保守地把此处也标 set-state-in-effect;逻辑与原实现一字不差,显式豁免。
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {loading && localMessages.length === 0 ? (
          <ChatLoadingState />
        ) : error ? (
          <ChatErrorState error={error} onRetry={onRetry ?? (() => undefined)} />
        ) : localMessages.length === 0 ? (
          <ChatEmptyState />
        ) : (
          // 首屏定位遮罩:落到底前 opacity-0 藏掉整个滚动区(连滚动条),揭开后呈现贴底内容、无滚动条行程。
          <div
            className={cn(
              "flex min-h-0 flex-1 flex-col",
              reveal.shown ? "opacity-100" : "opacity-0",
            )}
          >
            <Virtuoso<MessageTimelineItem>
              // 切会话重挂 → initialTopMostItemIndex 重新生效贴底、firstItemIndex 基值重置。
              key={chatStoreKey}
              ref={virtuosoRef}
              scrollerRef={handleScrollerRef}
              data={timelineItems}
              computeItemKey={(_index, item) => timelineRowKey(item)}
              itemContent={itemContent}
              firstItemIndex={firstItemIndex}
              initialTopMostItemIndex={{ index: "LAST", align: "end" }}
              defaultItemHeight={DEFAULT_ROW_HEIGHT}
              totalListHeightChanged={handleTotalListHeightChanged}
              increaseViewportBy={INCREASE_VIEWPORT_BY}
              components={VIRTUOSO_COMPONENTS}
              startReached={handleStartReached}
              followOutput={followOutput}
              atBottomStateChange={handleAtBottomStateChange}
              rangeChanged={handleRangeChanged}
              className="flex-1"
              // a11y:消息流容器,与原 role=log 一致。
              role="log"
              aria-live="polite"
              aria-atomic="false"
            />
          </div>
        )}
      </div>
      {!loading && !error && localMessages.length > 0 && !atBottom && (
        <ScrollToBottomButton
          count={unreadBelow}
          bottomOffset={composerHeight + 12}
          onClick={scrollToBottom}
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
}: MessageTimelineRowProps) {
  // 行间距用 padding(pt-*):Virtuoso 自己包 Item 测高,行内 padding 计入 getBoundingClientRect
  // → 间距被精确量、布局对齐。续条 44px / 换发送者 48px;首行 index 0 无顶间距。
  if (item.type === "date-divider") {
    return (
      <div className={index === 0 ? "" : "pt-7"}>
        <DateDivider label={item.label} />
      </div>
    );
  }
  if (item.type === "unread-divider") {
    return (
      <div className={index === 0 ? "" : "pt-7"}>
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
    return prev.item.count === next.item.count;
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
// "↑ N 条未读"。点击 → scrollToIndex 到未读分隔条。rangeChanged 检测到分隔条进入视口后
// 由 handleRangeChanged 清零 count,本 pill 跟着卸载。
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
