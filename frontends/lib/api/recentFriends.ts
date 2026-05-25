// 接待好友列表(消息页会话流)API 层 —— 桥接 4 个 Tauri command。
//
// **链路:**
//   - 打开消息页:UI → `fetchRecentFriendsCache(filter)` → 本地行存秒开 + 并发
//     `fetchRecentFriendsPage(cursor="", persist=true)` 拉首页对齐 → emit
//     `recent_friends_changed` → useRecentFriends 重读 cache。
//   - 滚动加载更多:`fetchRecentFriendsPage(cursor=next, persist=false)` 不写库。
//   - 筛选/搜索:`fetchRecentFriendsPage({ onlyUnread / externalName / ... },
//     persist=false)`,UI 维护独立 filteredList state。
//   - 用户操作:`pinConversation` / `markConversationDraft` 透传到本地列。

import { invoke } from "@tauri-apps/api/core";

/**
 * 接待好友列表的本地行存形态。对齐 Rust `RecentSessionRow`,21 字段:
 *   - 远端权威列 17 个 + `updatedAtMs`(列表项时间戳)
 *   - 客户端独占列 3 个(`pinned` / `pinnedAtMs` / `localDraftAtMs`)
 *
 * 写入纪律由后端保证:远端拉取 / 事件 applier 只动远端列,本地列只在
 * `set_conversation_pinned` / `set_conversation_draft_at` 时被动。
 */
export interface RecentFriendItem {
  // ─── 远端权威列 ────────────────────────────────────────────────────────
  conversationId: string;
  wecomAccountId: string;
  wecomName: string;
  wecomAccount: string;
  wecomAlias: string;
  externalUserId: string;
  externalName: string;
  externalAvatar: string;
  externalMobile: string;
  lastLocalMessageId: string;
  /** 1=文本 / 2=图片 / 3=…(具体翻译留给 UI) */
  lastMessageType: number;
  /** 1=入(客户发来) / 2=出(自己发出) */
  lastMessageDirection: number;
  /** 3=已读 / 4=失败 …(具体翻译留给 UI) */
  lastSendStatus: number;
  lastMessageSummary: string;
  /** epoch ms;0 表示后端 ISO 解析失败,行仍可用但排序最末 */
  lastMessageTimeMs: number;
  unreadCount: number;
  hasUnread: boolean;
  updatedAtMs: number;
  // ─── 客户端独占列 ──────────────────────────────────────────────────────
  pinned: boolean;
  pinnedAtMs: number;
  localDraftAtMs: number;
  /** V10:草稿文本。空串表示无草稿。 */
  localDraftText: string;
  /** V11:软移除标记。true 时不会出现在 `fetchRecentFriendsCache` 结果里(后端已 WHERE 过滤)。 */
  removed: boolean;
  removedAtMs: number;
  /** V12:消息免打扰标记。true 时未读"安静"展示(红点替代数字徽标 + 🔕)。不改排序/过滤。 */
  muted: boolean;
  mutedAtMs: number;
}

/**
 * session/recentFriends 远端入参(对齐 Rust `ListRecentFriendsRequest`)。
 *
 * 字段约定:**所有可选筛选都用空字符串表达"未筛选"**,而非 undefined(对齐后端契约)。
 *   - `cursor = ""` → 首页;否则续页
 *   - `wecomAccountId = ""` → 全部账号;否则按账号过滤
 *   - `externalName / externalMobile = ""` → 不筛选
 */
export interface ListRecentFriendsRequest {
  size: number;
  cursor: string;
  externalName: string;
  externalMobile: string;
  wecomAccountId: string;
  onlyUnread: boolean;
}

/** 服务端响应(对齐 Rust `ListRecentFriendsResp`)。 */
export interface ListRecentFriendsResp {
  size: number;
  hasMore: boolean;
  nextCursor: string;
  records: RecentFriendListRecord[];
}

/**
 * 服务端 `records[*]` 单条形态(对齐 Rust `RecentFriendRecord`)。
 * 跟 `RecentFriendItem` 的差异:
 *   - 没有 `updatedAtMs / pinned / pinnedAtMs / localDraftAtMs`(都是本地态)
 *   - `lastMessageTime` 是 ISO 字符串,本地表里转成 `lastMessageTimeMs`
 *
 * 滚动加载 / 搜索路径直接消费这个形态;首页路径(persist=true)走 Tauri 写库后
 * 由前端再 fetchRecentFriendsCache 读出 `RecentFriendItem`。
 */
export interface RecentFriendListRecord {
  conversationId: string;
  wecomAccountId: string;
  wecomName: string;
  wecomAccount: string;
  wecomAlias: string;
  externalUserId: string;
  externalName: string;
  externalAvatar: string;
  externalMobile: string;
  lastLocalMessageId: string;
  lastMessageType: number;
  lastMessageDirection: number;
  lastSendStatus: number;
  lastMessageSummary: string;
  /** ISO 8601 with TZ,例如 "2026-05-18T10:28:36Z" */
  lastMessageTime: string;
  unreadCount: number;
  hasUnread: boolean;
}

/**
 * 仅读本地行存的接待好友列表。默认列表打开瞬间调用 —— 零网络往返。
 * `accountFilter` 为空 / undefined 表示"全部账号"。
 *
 * ORDER BY 由后端多键合成:`pinned DESC, pinned_at_ms DESC, MAX(last, draft) DESC, last DESC`。
 */
export async function fetchRecentFriendsCache(
  accountFilter?: string | null,
): Promise<RecentFriendItem[]> {
  return invoke<RecentFriendItem[]>("list_recent_friends", {
    accountFilter: accountFilter || null,
  });
}

/**
 * 接待列表「本地深读」分页 —— 仅读本地行存的 offset 续页,零网络往返。
 * 头部 top-200 由 `fetchRecentFriendsCache` 秒开;滑过 200 行后从 `offset` 起继续取本地行。
 * 返回行数 < `limit` 即本地到底(上层据此停止下拉)。
 */
export async function fetchRecentFriendsLocalPage(
  accountFilter: string | null | undefined,
  offset: number,
  limit: number,
): Promise<RecentFriendItem[]> {
  return invoke<RecentFriendItem[]>("list_recent_friends_local_page", {
    accountFilter: accountFilter || null,
    offset,
    limit,
  });
}

/**
 * 拉一页远端数据。
 *   - `persist=true`(通常仅首页 cursor="")→ Tauri 端 UPSERT 到本地表 + emit `recent_friends_changed`。
 *   - `persist=false`(带筛选搜索)→ 仅透传响应,不写库不发事件。
 */
export async function fetchRecentFriendsPage(
  req: ListRecentFriendsRequest,
  persist: boolean,
): Promise<ListRecentFriendsResp> {
  return invoke<ListRecentFriendsResp>("list_recent_friends_remote_page", {
    req,
    persist,
  });
}

/** 置顶 / 取消置顶。后端仅更新本地列,emit `recent_friends_changed`。 */
export async function pinConversation(conversationId: string, pinned: boolean): Promise<void> {
  await invoke<void>("set_conversation_pinned", { conversationId, pinned });
}

/** 写草稿(V10)。`text=""` 清空草稿;非空保存为草稿。后端仅更新本地列。 */
export async function setConversationDraft(conversationId: string, text: string): Promise<void> {
  await invoke<void>("set_conversation_draft", { conversationId, text });
}

/**
 * V11:软移除 / 取消移除一条接待会话。
 * 后端 UPDATE removed/removed_at_ms,emit ChangeNotice;前端通过 useResource 自动 refetch。
 * 自动恢复语义:后续远端事件 `lastMessageTimeMs > removedAtMs` 时,UPSERT ON CONFLICT 自动清零。
 */
export async function setConversationRemoved(
  conversationId: string,
  removed: boolean,
): Promise<void> {
  await invoke<void>("set_conversation_removed", { conversationId, removed });
}

/**
 * V12:消息免打扰 / 取消免打扰。
 * 后端 UPDATE muted/muted_at_ms,emit ChangeNotice;前端通过 useResource 自动 refetch。
 * muted 不改排序/过滤,仅影响渲染(红点替代数字徽标 + 🔕)。
 */
export async function muteConversation(conversationId: string, muted: boolean): Promise<void> {
  await invoke<void>("set_conversation_muted", { conversationId, muted });
}

/**
 * 标记会话已读。用户主动点开有未读的会话时调用。
 * 后端远端 markRead 成功后清零本地 unread + emit ChangeNotice;前端通过 useResource 自动 refetch 清红标。
 * readSortKey 由后端恒置 None(= 清零到摘要最后一条),前端不持有完整复合 sortKey。
 */
export async function markConversationRead(conversationId: string): Promise<void> {
  await invoke<void>("mark_conversation_read", { conversationId });
}
