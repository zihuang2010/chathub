import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { showToast } from "@/components/ui/toast";
import { WorkbenchPanel } from "@/components/workbench/WorkbenchPanel";
import type { PendingOpenConversation } from "@/components/workbench/nav";
import type { Account } from "@/lib/types/account";
import { adaptFriendDetailToCustomer, type WecomFriend } from "@/lib/api/customers";
import { useFriendDetail } from "@/lib/api/useFriendDetail";
import { useQuickReplies } from "@/lib/api/useQuickReplies";
import { useRecentFriends, type RecentFriendListEntry } from "@/lib/api/useRecentFriends";
import { sendMessage, SEND_STATUS } from "@/lib/api/messageHistory";
import { appReady } from "@/lib/data/appReady";
import { cn } from "@/lib/utils";

import { ChatArea } from "./ChatArea";
import type { ForwardTarget } from "./ForwardDialog";
import type { SendMessageOptions } from "./hooks/useChatActions";
import { STRINGS } from "./strings";
import {
  CHAT_AREA_MIN_WIDTH,
  CONVERSATION_LIST_DEFAULT_RATIO,
  CONVERSATION_LIST_DEFAULT_WIDTH,
  CONVERSATION_LIST_MAX_WIDTH,
  CONVERSATION_LIST_MIN_WIDTH,
  RESIZE_HANDLE_WIDTH,
  RESIZE_KEYBOARD_STEP,
} from "./constants";
import { ConversationList, type StatusTab } from "./ConversationList";
import { CustomerDetails } from "./CustomerDetails";
import { EmptyChatPane } from "./EmptyChatPane";
import { isKnownMessageType } from "./data";
import type { Conversation, Message, QuickReply } from "./data";
import { MessagesSkeleton } from "./MessagesSkeleton";
import { useChatMessages } from "./useChatMessages";
import { useDetailsWindow } from "./useDetailsWindow";

// 数据接口尚未对接,先用 module-level 空数组替代 MOCK 假数据。
// 引用稳定(同一模块级变量在 React render 间不变),下游 memo 不因每次 render 失效。
// 类型不用 readonly 以匹配 ChatArea/CustomerDetails 既有 props 形态;
// 通过 module-level 常量 + 不导出避免外部 mutation。
const EMPTY_MENTION_CANDIDATES: Conversation[] = [];
// 静态 props,hoist 到模块级避免每次 render 新建对象(被多个 ErrorBoundary 复用)。
const ERROR_BOUNDARY_PROPS = {
  title: STRINGS.errors.pageUnavailable,
  retryLabel: STRINGS.errors.retry,
};

/**
 * 把后端最近会话条目适配成 ConversationList 现有 `Conversation` 形态。
 *
 * 字段对接策略:
 *   - id / name / preview / unread:直映
 *   - account:用 wecomAlias 作显示名(跟 AccountDropdown 列表里的 `account.name` 对齐契机);
 *     缺失时 fallback wecomName。
 *   - time:lastMessageTimeMs → 相对时间字符串("HH:mm" / "昨天" / "周二" / "MM-dd")
 *   - online / avatarColor:接口未下发,留空(列表渲染按 name hash 上色)
 */
function formatRelativeTime(ms: number): string {
  if (ms <= 0) return "";
  const date = new Date(ms);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate()
  ) {
    return "昨天";
  }
  const diffDays = Math.floor((now.getTime() - date.getTime()) / 86_400_000);
  if (diffDays < 7) {
    const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    return weekdays[date.getDay()];
  }
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// 远端字段(客户可控:昵称 / 消息摘要)进渲染模型前的长度硬顶。行内 CSS truncate
// 只裁"显示",底层字符串原样驻留;一条被构造的超长摘要会按行占内存,这里在源头截断。
const MAX_FIELD_LEN = 256;
function clampField(value: string): string {
  return value.length > MAX_FIELD_LEN ? value.slice(0, MAX_FIELD_LEN) : value;
}

function adaptEntryToConversation(entry: RecentFriendListEntry): Conversation {
  const draftText = extractDraftPreview(entry.localDraftText);
  // 列表行时间用 max(lastMessageTimeMs, localDraftAtMs),与后端 list_top 的多键
  // 排序键一致:有草稿且新于最后消息时显示草稿时间,新消息进来反超
  // 草稿时间后自动切回消息时间。否则会出现"行按草稿时间排到顶部、但右上角
  // 时间字段是旧消息时间"的视觉错位(微信桌面端约定)。
  const effectiveTimeMs = Math.max(entry.lastMessageTimeMs, entry.localDraftAtMs);
  // 未知消息类型(如 lastMessageType=99)上游 lastMessageSummary 为空,直接展示会得到
  // 空白预览行;摘要为空且类型不在已知集合时回退「[未知消息]」占位,与气泡兜底语义一致。
  const summary = clampField(entry.lastMessageSummary);
  const preview =
    summary || (isKnownMessageType(entry.lastMessageType) ? summary : STRINGS.unknown.preview);
  return {
    id: entry.conversationId,
    name: clampField(entry.externalName) || "(未命名)",
    avatar: entry.externalAvatar || undefined,
    preview,
    account: clampField(entry.wecomAlias || entry.wecomName),
    time: formatRelativeTime(effectiveTimeMs),
    unread: entry.unreadCount,
    online: false,
    draftText: draftText || undefined,
    pinned: entry.pinned,
    muted: entry.muted,
  };
}

/**
 * 把 SQLite 存的 TipTap JSON 字符串解析为 plain text 预览。
 * useDraftStore 双写时存的是 JSON.stringify(JSONContent) — 直接展示会显示 JSON 源码。
 * 解析失败时(非 JSON / 文档损坏) fallback 当 raw text 截断。
 *
 * 按 stored 原文做有界内容缓存:每个 hub 事件都会让 useRecentFriends 重读缓存 + 整表
 * 重新 adapt,草稿未变的行不必反复 JSON.parse。键用 stored 原文(内容键),跨 refetch
 * 的对象重建仍命中。超过上限直接清空(简单兜底,避免无界增长)。
 */
const DRAFT_PREVIEW_CACHE_MAX = 200;
const draftPreviewCache = new Map<string, string>();
function extractDraftPreview(stored: string): string {
  if (!stored) return "";
  const cached = draftPreviewCache.get(stored);
  if (cached !== undefined) return cached;
  let result: string;
  try {
    const doc = JSON.parse(stored);
    result = extractTextFromNode(doc).replace(/\s+/g, " ").trim().slice(0, 80);
  } catch {
    result = stored.slice(0, 80);
  }
  if (draftPreviewCache.size >= DRAFT_PREVIEW_CACHE_MAX) draftPreviewCache.clear();
  draftPreviewCache.set(stored, result);
  return result;
}

function extractTextFromNode(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const n = node as { type?: unknown; text?: unknown; content?: unknown };
  if (n.type === "image") return "[图片]";
  // useDraftStore 在合成后端草稿时把待发送文件附件作为 fileAttachment 节点
  // 追加在 doc.content 末尾(TipTap schema 未注册,但本函数只读不渲染)。
  if (n.type === "fileAttachment") return "[文件]";
  if (typeof n.text === "string") return n.text;
  if (Array.isArray(n.content)) {
    return n.content.map((c) => extractTextFromNode(c)).join("");
  }
  return "";
}

interface MessagesPageProps {
  /** 由 Workbench 提供的账号列表(来自 list_accounts)。下拉用 `account.id`(= `wecomAccountId`)
   *  做选项值与筛选状态,直接传给 useRecentFriends;展示名按 id 反查 accounts。 */
  accounts: readonly Account[];
  /** 客户页点「发起会话」跳来的一次性意图:取/建该客户会话并选中。消费后调 onConsumePendingOpen 清空。 */
  pendingOpenConversation?: PendingOpenConversation | null;
  onConsumePendingOpen?: () => void;
}

export function MessagesPage({
  accounts,
  pendingOpenConversation,
  onConsumePendingOpen,
}: MessagesPageProps) {
  const [selectedId, setSelectedId] = useState<string>("");
  // 账号筛选状态直接存 `account.id`(= wecomAccountId,唯一);同名账号互不干扰。
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  // 会话状态标签(全部/未读/@我)由父级持有:从搜索框/客户页打开会话时一并重置回"全部",
  // 否则停在"未读"标签下打开的(已读)会话会被过滤掉看不见(见 openConversationByIdentity)。
  const [statusTab, setStatusTab] = useState<StatusTab>("all");
  const [conversationListWidth, setConversationListWidth] = useState(
    CONVERSATION_LIST_DEFAULT_WIDTH,
  );
  const [isResizing, setIsResizing] = useState(false);
  const pageRef = useRef<HTMLDivElement | null>(null);
  // Stage C:用户贴底实时 ref(单一真相)。useScrollController(ChatArea 内)在维护 wasAtBottomRef
  // 处镜像写入,useMessageHistory(本页内)readCache 经此读判塌缩/缝合 —— 打破跨组件读 ref 的环。
  // 初值 true(冷开首屏贴底)。
  const atBottomRef = useRef(true);
  const dragStartRef = useRef({ x: 0, width: CONVERSATION_LIST_DEFAULT_WIDTH });
  // 列表宽度的「记忆」是比例(列表占窗口宽度 innerWidth 的比),px 由它 × innerWidth 再钳制而来。
  // 窗口缩放时按此比例重算 → 平滑联动;用户拖拽/键盘调宽后回写此比例 → 偏好被记住。
  const listWidthRatioRef = useRef(CONVERSATION_LIST_DEFAULT_RATIO);

  const { detailsOpen, toggleDetails } = useDetailsWindow();

  // 顶部账号选择器直接输出 wecomAccountId(= account.id),原样传给 useRecentFriends;
  // null = 全部账号。展示名在 RangePill/ConversationList 内按 id 反查 accounts。

  const {
    items: recentEntries,
    filtered,
    initialFetched,
    switching,
    pin: pinRecent,
    remove: removeRecent,
    mute: muteRecent,
    markRead: markReadRecent,
    readingIds,
    loadMore,
    loadMoreFiltered,
    defaultLoading,
    filteredLoading,
    openFriend,
  } = useRecentFriends({
    accountFilter: selectedAccountId,
  });

  // openConversationByIdentity 需读"最新"的 recentEntries 做乐观即时打开,但不能把 recentEntries
  // 列进其 deps —— 否则列表每次更新都重建该 callback,连带触发 pendingOpenConversation effect 重跑。
  // 用 ref 镜像最新列表,callback 经 ref 读取,deps 保持稳定。
  const recentEntriesRef = useRef(recentEntries);
  useEffect(() => {
    recentEntriesRef.current = recentEntries;
  }, [recentEntries]);

  // "移除会话"持久化在 SQLite hub_conversation_recents.removed 列(V11);
  // 后端 list_top WHERE removed=0 已经把隐藏行过滤掉,前端不再二次过滤。
  // 自动恢复:远端事件 last_message_time_ms > removed_at_ms 时,UPSERT ON CONFLICT 自动清零。

  // 搜索激活时(filtered 非 null)渲染远端筛选结果,把"已加载窗口之外"的匹配也纳入;
  // 否则渲染默认列表。两者都是 RecentFriendListEntry[],经同一 adapter。
  const displayEntries = filtered ?? recentEntries;

  // 适配成 ConversationList 现有 `Conversation` 形态;源是稳定引用,按 displayEntries 记忆化。
  // readPending 由 useRecentFriends.readingIds 注入:markRead 远端往返期间抑制该行红标。
  const conversations = useMemo(
    () =>
      displayEntries.map((entry) => ({
        ...adaptEntryToConversation(entry),
        readPending: readingIds.has(entry.conversationId),
      })),
    [displayEntries, readingIds],
  );

  // 用户主动点开会话:置选中 + 仅当该会话有未读时调 markRead 清红标。
  // 启动时自动选中第一条走下方 effect(不经此 handler),天然不触发标已读 —— 保留红标供坐席自决是否接待。
  const handleSelectConversation = useCallback(
    (id: string) => {
      setSelectedId(id);
      const entry = displayEntries.find((e) => e.conversationId === id);
      if (entry && (entry.hasUnread || entry.unreadCount > 0)) void markReadRecent(id);
    },
    [displayEntries, markReadRecent],
  );

  // 首次本地 cache 读出后通知 App 的 splash gate;splash 退场前数据已就绪,常规场景
  // 不再出现"splash → Skeleton → 真组件"的二次闪。极慢路径仍由 MessagesSkeleton 兜底。
  useEffect(() => {
    if (initialFetched) appReady.setMessagesReady();
  }, [initialFetched]);

  // 列表非空但 selectedId 不在列表中(初始挂载 / 切账号 / 数据更新后)→ 自动选第一项。
  // 这里就是"外部数据驱动 → 校正本地选中"的同步场景,无法 derive(selectedId 还要响应
  // 用户点击),所以 effect 内 setState 是必要的。lint 标 cascading-renders 是泛报警。
  useEffect(() => {
    if (conversations.length === 0) return;
    if (selectedId && conversations.some((c) => c.id === selectedId)) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedId(conversations[0].id);
  }, [conversations, selectedId]);

  // initialFetched 之前由顶层守卫挡住渲染,这里 conversation 可能 undefined(员工真无会话);
  // 不再 fallback MOCK_CONVERSATIONS[0] —— 避免假数据先画一帧的闪烁。
  const conversation = useMemo<Conversation | undefined>(
    () => conversations.find((c) => c.id === selectedId) ?? conversations[0],
    [conversations, selectedId],
  );
  // 当前选中会话归属的真实 (wecomAccountId, externalUserId);conversation 不存在时为 undefined,
  // useChatMessages 内部走 mock 空数组 fallback(由顶层守卫保证不会进入渲染)。
  // 选中会话归属在 displayEntries 里查:搜索态下用户可能点中"默认缓存之外"的远端结果,
  // 必须用 filtered 那份才能解析出 wecomAccountId / externalUserId 给 useChatMessages。
  const selectedEntry = useMemo(
    () =>
      conversation ? displayEntries.find((e) => e.conversationId === conversation.id) : undefined,
    [displayEntries, conversation],
  );
  const {
    messages,
    loading: messagesLoading,
    error: messagesError,
    hasMore: hasMoreMessages,
    loadMore: loadMoreMessages,
    atCacheTop: messagesAtCacheTop,
    retry: retryMessages,
    storeKey: chatStoreKey,
  } = useChatMessages({
    conversationId: conversation?.id ?? "",
    wecomAccountId: selectedEntry?.wecomAccountId,
    externalUserId: selectedEntry?.externalUserId,
    atBottomRef,
  });
  // 客户资料:按选中会话归属的 (wecomAccountId, externalUserId) 拉好友详情。
  // 两者缺一时 hook 不发请求、detail 为 null,CustomerDetails 渲染空态。
  // 用 detailsOpen 收口 id:面板收起时传 undefined → 不取数,避免切会话时白拉一份不展示的资料;
  // 面板展开才补齐 id 触发拉取(展开期间切会话会重新拉新客户资料)。
  const {
    detail: customerDetail,
    loading: customerLoading,
    refresh: refreshCustomer,
  } = useFriendDetail(
    detailsOpen ? selectedEntry?.wecomAccountId : undefined,
    detailsOpen ? selectedEntry?.externalUserId : undefined,
  );
  const customer = useMemo(
    () =>
      customerDetail
        ? adaptFriendDetailToCustomer(customerDetail, {
            accountName: selectedEntry?.wecomName ?? "—",
            accountId: selectedEntry?.wecomAccountId,
          })
        : null,
    [customerDetail, selectedEntry],
  );

  // 快捷回复(纯客户端本地表,按登录员工隔离):CRUD 全落本地,popover 内可增删改。
  // 行存 content 映射成 UI 的 preview(面板展示 + 选中即插入此文本)。
  const quickReplies = useQuickReplies();
  const quickReplyItems = useMemo<QuickReply[]>(
    () => quickReplies.replies.map((r) => ({ id: r.id, title: r.title, preview: r.content })),
    [quickReplies.replies],
  );

  // 真发送:后端落库出站气泡 + 发 conversation-messages ChangeNotice,useChatMessages 重读
  // 缓存把这条消息收敛进权威列表。缺会话归属(account/user)时静默忽略。
  // options:附件类透传 messageType + 上传后的 objectName(filePath)等;纯文本不传走默认 1=文本。
  const handleSendMessage = useCallback(
    async (text: string, clientMsgId: string, options?: SendMessageOptions) => {
      if (!conversation || !selectedEntry?.wecomAccountId || !selectedEntry?.externalUserId) return;
      // 返回后端响应,供 ChatArea 用 localMessageId 作 serverId 收敛乐观气泡。
      return await sendMessage({
        conversationId: conversation.id,
        wecomAccountId: selectedEntry.wecomAccountId,
        externalUserId: selectedEntry.externalUserId,
        contentText: text,
        clientMsgId,
        messageType: options?.messageType,
        filePath: options?.filePath,
        fileName: options?.fileName,
        fileSize: options?.fileSize,
        durationSeconds: options?.durationSeconds,
      });
    },
    [conversation, selectedEntry],
  );

  // 转发目标:由最近会话列表派生(带发送所需的会话身份)。转发弹层内有自己的本地搜索框。
  const forwardTargets = useMemo<ForwardTarget[]>(
    () =>
      recentEntries.map((e) => ({
        conversationId: e.conversationId,
        wecomAccountId: e.wecomAccountId,
        externalUserId: e.externalUserId,
        name: clampField(e.externalName) || "(未命名)",
        avatar: e.externalAvatar || undefined,
        account: clampField(e.wecomAlias || e.wecomName),
      })),
    [recentEntries],
  );

  // 转发(仅文本):复用 sendMessage 把文本批量发到所有勾选目标(与编辑器发送同一调用)。无乐观气泡——
  // 目标会话经后端落库 + ChangeNotice 重读自然出现(若恰为当前打开会话也会刷新)。
  // 单个目标 sendStatus=4(受控失败)或抛异常视为该条失败;汇总成一条 toast:
  // 全成功→「已转发」、部分失败→「部分转发失败」、全失败→「转发失败」。
  const handleForward = useCallback((message: Message, targets: ForwardTarget[]) => {
    if (!message.text.trim() || targets.length === 0) return;
    void Promise.all(
      targets.map((target) =>
        sendMessage({
          conversationId: target.conversationId,
          wecomAccountId: target.wecomAccountId,
          externalUserId: target.externalUserId,
          contentText: message.text,
          clientMsgId: `local-${crypto.randomUUID()}`,
          messageType: 1,
        })
          .then((resp) => !(resp && resp.sendStatus === SEND_STATUS.failed))
          .catch(() => false),
      ),
    ).then((results) => {
      const ok = results.filter(Boolean).length;
      if (ok === 0) {
        showToast(STRINGS.forward.failed, { type: "error" });
      } else if (ok < results.length) {
        showToast(STRINGS.forward.partial, { type: "error" });
      } else {
        showToast(STRINGS.forward.success, { type: "success" });
      }
    });
  }, []);

  // 列表宽与 detailsOpen 解耦:钳制上界只为「会话列表 + 手柄 + 聊天区最小宽」预留空间,
  // 不再因开/关详情而变动 —— 开详情只让聊天区(flex-1)收窄、接待区(列表)宽度保持不变。
  const clampConversationListWidth = useCallback((nextWidth: number) => {
    const pageWidth = pageRef.current?.clientWidth ?? 0;
    const layoutMaxWidth =
      pageWidth > 0
        ? Math.max(
            CONVERSATION_LIST_MIN_WIDTH,
            pageWidth - CHAT_AREA_MIN_WIDTH - RESIZE_HANDLE_WIDTH,
          )
        : CONVERSATION_LIST_MAX_WIDTH;
    const maxWidth = Math.min(CONVERSATION_LIST_MAX_WIDTH, layoutMaxWidth);
    return Math.min(Math.max(nextWidth, CONVERSATION_LIST_MIN_WIDTH), maxWidth);
  }, []);

  // 把一个(已钳制的)像素宽换算成相对窗口宽的比例回写记忆 —— 用户拖拽/键盘手动调宽后
  // 调用,之后窗口缩放就按这个新比例联动。innerWidth 不可用时不动旧比例。
  const rememberListWidthRatio = useCallback((width: number) => {
    if (typeof window === "undefined" || window.innerWidth <= 0) return;
    listWidthRatioRef.current = width / window.innerWidth;
  }, []);

  // 「丝滑比例联动」核心:窗口缩放时按记忆的比例重算列表宽并钳制 —— 宽度始终 =
  // clamp(ratio × innerWidth, MIN, MAX)。列表宽不依赖 detailsOpen,故开/关详情不会触发
  // 此 effect 重算(接待区稳定)。首次提交即跑一次,把初始 px 校正到当前窗口宽对应的比例宽。
  useEffect(() => {
    const applyRatioWidth = () => {
      if (typeof window === "undefined") return;
      const target = window.innerWidth * listWidthRatioRef.current;
      setConversationListWidth(clampConversationListWidth(target));
    };

    applyRatioWidth();
    window.addEventListener("resize", applyRatioWidth);
    return () => window.removeEventListener("resize", applyRatioWidth);
  }, [clampConversationListWidth]);

  useEffect(() => {
    if (!isResizing) return;

    const handlePointerMove = (event: PointerEvent) => {
      const deltaX = event.clientX - dragStartRef.current.x;
      const next = clampConversationListWidth(dragStartRef.current.width + deltaX);
      setConversationListWidth(next);
      rememberListWidthRatio(next); // 拖动即记住新比例,后续窗口缩放按它联动
    };
    const stopResizing = () => setIsResizing(false);
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResizing);
    window.addEventListener("pointercancel", stopResizing);

    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResizing);
      window.removeEventListener("pointercancel", stopResizing);
    };
  }, [clampConversationListWidth, isResizing, rememberListWidthRatio]);

  const handleResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragStartRef.current = { x: event.clientX, width: conversationListWidth };
    setIsResizing(true);
  };

  const handleResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      event.key !== "ArrowLeft" &&
      event.key !== "ArrowRight" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }
    event.preventDefault();
    let next: number;
    if (event.key === "Home") {
      next = clampConversationListWidth(CONVERSATION_LIST_MIN_WIDTH);
    } else if (event.key === "End") {
      next = clampConversationListWidth(CONVERSATION_LIST_MAX_WIDTH);
    } else {
      const direction = event.key === "ArrowLeft" ? -1 : 1;
      next = clampConversationListWidth(conversationListWidth + direction * RESIZE_KEYBOARD_STEP);
    }
    setConversationListWidth(next);
    rememberListWidthRatio(next); // 键盘调宽同样记住比例
  };

  const handleAccountChange = useCallback(
    (accountId: string | null) => {
      setSelectedAccountId(accountId);
      // 当前会话已属该账号则不跳;account 归属用 entry.wecomAccountId 判定(唯一,不靠展示名)。
      if (!accountId || selectedEntry?.wecomAccountId === accountId) return;
      // 切到该账号下的第一条会话;useRecentFriends 跟随 selectedAccountId 重新拉取后,
      // useEffect 会再校正一次 selectedId。
      const next = displayEntries.find((e) => e.wecomAccountId === accountId);
      if (next) setSelectedId(next.conversationId);
    },
    [selectedEntry?.wecomAccountId, displayEntries],
  );

  // ─── 搜索客户 → 打开会话 ─────────────────────────────────────────────────
  // 顶部搜索框(MessagesContactSearch)直接搜 list_friends(全部客户),点击某客户后由后端
  // open_friend_conversation 一次性:recentFriends(externalUserId+includeFirstHistory)定位/建会话、
  // upsert 接待列表、首屏历史冷写入、set_opened 提到非置顶顶部、emit ChangeNotice。
  // conversationId 取服务端权威 requestConversationId(客户端不自算)。命令落地后行经 useResource
  // 重读进 recentEntries,可能慢于 await 返回,故挂 pendingOpenId,等行出现再选中(见下方 effect)。
  const pendingOpenIdRef = useRef<string | null>(null);
  // 取/建会话核心:open_friend_conversation 一次性定位/建会话并返回服务端权威 conversationId
  // (新旧会话同一路径,判断在后端);落地后挂 pendingOpenIdRef,等行重读出现再选中(见下方 effect)。
  // 搜索框点客户、客户页「发起会话」共用此内核,避免打开编排重复。
  // wecomName/wecomAlias 仅用于"无记录建空白行"时展示归属账号;从 accounts 反查。
  const openConversationByIdentity = useCallback(
    async (identity: PendingOpenConversation) => {
      // 打开会话前先重置接待列表的筛选条件:账号范围回"全部账号" + 状态标签回"全部"。
      // 否则停在"某账号"或"未读"筛选下时,打开的会话(属其他账号 / 已读无未读)会被过滤掉而看不见。
      setSelectedAccountId(null);
      setStatusTab("all");
      // 乐观即时打开:该客户的会话若已在本地接待列表(按 账号 + 客户标识 匹配),立刻选中,
      // 不等后端 openFriend 往返 —— 消除"先跳到列表、再慢慢打开"的迟钝感。后端命令仍在后台跑
      // (set_opened 提顶 + 首屏历史回填 + ChangeNotice),落地后由 pendingOpenIdRef effect 再确认选中
      // (服务端权威 conversationId 与已存在行一致,setSelectedId 为同值不闪)。
      const existing = recentEntriesRef.current.find(
        (e) =>
          e.wecomAccountId === identity.wecomAccountId &&
          e.externalUserId === identity.externalUserId,
      );
      if (existing) {
        setSelectedId(existing.conversationId);
        if (existing.hasUnread || existing.unreadCount > 0) {
          void markReadRecent(existing.conversationId);
        }
      }
      const accountName = accounts.find((a) => a.id === identity.wecomAccountId)?.name ?? "";
      try {
        const conversationId = await openFriend({
          wecomAccountId: identity.wecomAccountId,
          externalUserId: identity.externalUserId,
          externalName: identity.externalName,
          externalAvatar: identity.externalAvatar,
          externalMobile: identity.externalMobile,
          wecomName: accountName,
          wecomAlias: accountName,
        });
        pendingOpenIdRef.current = conversationId;
      } catch (e) {
        // 暴露后端原始错误,便于区分失败点(未登录 / list_recent_friends 网络异常 /
        // 服务端未返回会话 ID / 本地存储异常),通用 toast 看不出具体原因。
        console.error("[open_friend_conversation] 打开会话失败", e, { identity });
        showToast(STRINGS.conversationList.openConversationFailed, { type: "error" });
      }
    },
    [accounts, openFriend, markReadRecent],
  );
  const handleOpenCustomer = useCallback(
    (friend: WecomFriend) =>
      openConversationByIdentity({
        wecomAccountId: friend.wecomAccountId,
        externalUserId: friend.externalUserId,
        externalName: friend.externalName,
        externalAvatar: friend.externalAvatar,
        externalMobile: friend.externalMobile,
      }),
    [openConversationByIdentity],
  );

  // openFriend 落地后,等 recentEntries 重读出该会话行再选中(+ 有未读则标已读)。
  // 不在 await 后直接 setSelectedId:行可能尚未随 ChangeNotice 重读进列表,直接设会被
  // "列表无此 id → 自动选第一项"的 effect 覆盖。行被 set_opened 提到非置顶顶部,出现即选中。
  useEffect(() => {
    const pid = pendingOpenIdRef.current;
    if (!pid) return;
    const entry = recentEntries.find((e) => e.conversationId === pid);
    if (!entry) return;
    pendingOpenIdRef.current = null;
    setSelectedId(pid);
    if (entry.hasUnread || entry.unreadCount > 0) void markReadRecent(pid);
  }, [recentEntries, markReadRecent]);

  // 客户页点「发起会话」跳转过来的一次性意图:走与搜索框打开同一条路径
  // (openConversationByIdentity → pendingOpenIdRef → 上方 effect 选中)。意图非空才跑,
  // 消费后通知 Workbench 置 null,不会重入。本页常驻挂载,切到消息页前 effect 即已触发。
  useEffect(() => {
    if (!pendingOpenConversation) return;
    // openConversationByIdentity 内会同步重置筛选(setSelectedAccountId/setStatusTab):
    // 这是"客户页导航意图 → 校正本页筛选"的一次性同步,cascading-renders 在此可接受。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void openConversationByIdentity(pendingOpenConversation);
    onConsumePendingOpen?.();
  }, [pendingOpenConversation, openConversationByIdentity, onConsumePendingOpen]);

  // 搜索框清空:撤销待选中的打开请求(列表本就是默认态,无需额外处理)。
  const handleClearSearch = useCallback(() => {
    pendingOpenIdRef.current = null;
  }, []);

  // 滚动到底分派:筛选态翻 filtered 续页,否则翻默认列表续页。loading 同源切换防重入;
  // 是否到底由 hook 内部 cursor/hasMore 自守(loadMore/loadMoreFiltered 到底即 no-op)。
  const listLoading = filtered ? filteredLoading : defaultLoading;
  const handleLoadMore = useCallback(() => {
    if (filtered) void loadMoreFiltered();
    else void loadMore();
  }, [filtered, loadMore, loadMoreFiltered]);

  // 首屏数据门:本地 cache 还没读出来时渲染骨架,挡掉 ChatArea/CustomerDetails 拿空数据画一帧的闪烁。
  // initialFetched 单调向前(useResource 保证),后续切账号/refetch 不会再回退到 skeleton。
  if (!initialFetched) {
    return <MessagesSkeleton />;
  }

  return (
    <WorkbenchPanel panelRef={pageRef} className="relative">
      <ErrorBoundary {...ERROR_BOUNDARY_PROPS}>
        <ConversationList
          conversations={conversations}
          selectedId={selectedId}
          onSelect={handleSelectConversation}
          onTogglePin={pinRecent}
          onToggleMute={muteRecent}
          onRemove={removeRecent}
          width={conversationListWidth}
          accounts={accounts}
          selectedAccountId={selectedAccountId}
          statusTab={statusTab}
          onStatusChange={setStatusTab}
          onOpenCustomer={handleOpenCustomer}
          onClearSearch={handleClearSearch}
          onLoadMore={handleLoadMore}
          loading={listLoading}
          switching={switching}
        />
      </ErrorBoundary>
      <div
        role="separator"
        aria-label={STRINGS.resize.listHandle}
        aria-orientation="vertical"
        aria-valuemin={CONVERSATION_LIST_MIN_WIDTH}
        aria-valuemax={CONVERSATION_LIST_MAX_WIDTH}
        aria-valuenow={Math.round(conversationListWidth)}
        tabIndex={0}
        onPointerDown={handleResizePointerDown}
        onKeyDown={handleResizeKeyDown}
        className={cn(
          "group flex h-full w-2 shrink-0 cursor-col-resize justify-center bg-workbench-surface outline-none transition-colors",
          isResizing
            ? "bg-workbench-surface-subtle"
            : "hover:bg-workbench-surface-subtle focus-visible:bg-workbench-surface-subtle",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "h-full w-px transition-colors",
            isResizing
              ? "bg-workbench-accent-soft"
              : "bg-workbench-line group-hover:bg-workbench-accent-soft group-focus-visible:bg-workbench-accent-soft",
          )}
        />
      </div>
      <div
        className="flex h-full min-w-0 flex-1"
        // 聊天区最小宽护栏:开详情面板(右栏)时,聊天列(flex-1)自动收窄让出空间,
        // 只缩到此宽度;再不够由最右内容裁切,而非把聊天压塌成不可用窄条。窗口尺寸/位置不变。
        style={{ minWidth: CHAT_AREA_MIN_WIDTH }}
      >
        {conversation ? (
          <ErrorBoundary {...ERROR_BOUNDARY_PROPS}>
            <ChatArea
              conversation={conversation}
              chatStoreKey={chatStoreKey}
              messages={messages}
              accounts={accounts}
              selectedAccountId={selectedAccountId}
              onAccountChange={handleAccountChange}
              detailsOpen={detailsOpen}
              onToggleDetails={toggleDetails}
              loading={messagesLoading}
              error={messagesError}
              onRetry={retryMessages}
              hasMoreHistory={hasMoreMessages || !messagesAtCacheTop}
              onLoadMoreHistory={loadMoreMessages}
              atBottomRef={atBottomRef}
              onSendMessage={handleSendMessage}
              onLeaveMarkRead={markReadRecent}
              quickReplies={quickReplyItems}
              onCreateQuickReply={quickReplies.create}
              onUpdateQuickReply={quickReplies.update}
              onDeleteQuickReply={quickReplies.remove}
              // TODO(@mention API): 接通 useMentionCandidates(conversationId) 后透传
              mentionCandidates={EMPTY_MENTION_CANDIDATES}
              wecomAccountId={selectedEntry?.wecomAccountId}
              externalUserId={selectedEntry?.externalUserId}
              forwardTargets={forwardTargets}
              onForward={handleForward}
            />
          </ErrorBoundary>
        ) : (
          // 无选中会话(如切到无会话的账号)也保留账号筛选入口,否则用户无法切回其他账号。
          <ErrorBoundary {...ERROR_BOUNDARY_PROPS}>
            <EmptyChatPane
              accounts={accounts}
              selectedAccountId={selectedAccountId}
              onAccountChange={handleAccountChange}
            />
          </ErrorBoundary>
        )}
      </div>
      {detailsOpen && (
        // 面板挂载只看 detailsOpen,不再 && conversation:无选中会话也能展开
        // (CustomerDetails 对 customer=null 渲染空态),避免"会话恰好为空 →
        // 面板挂不上 → React 状态与窗口尺寸不同步"。
        // 详情面板裁切护栏:CustomerDetails 的 <aside> 是 w-[324px] shrink-0,无 min-w-0/
        // overflow-hidden。窗口装不下更宽尺寸(squeeze、canGrow=false)时,父容器(WorkbenchPanel
        // overflow-hidden)会从右侧硬裁掉这 324px 列的边缘。这里套一层可收缩的 flex 子项
        // (min-w-0 让 flex 子项突破默认 min-width:auto 而能收缩,overflow-hidden 在本层内部
        // 裁切),把硬裁边界从整个面板收回到详情列自身边界;宽窗下 flex-1 聊天区吸收所有余量、
        // 本层无收缩压力,仍保持 324px,表现不变。
        <div className="flex min-w-0 overflow-hidden">
          <ErrorBoundary {...ERROR_BOUNDARY_PROPS}>
            <CustomerDetails
              customer={customer}
              quickReplies={quickReplyItems}
              onRefresh={() => void refreshCustomer(true)}
              refreshing={customerLoading}
            />
          </ErrorBoundary>
        </div>
      )}
    </WorkbenchPanel>
  );
}
