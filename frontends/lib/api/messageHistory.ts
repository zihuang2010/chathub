// message/history API 层 —— 桥接 Tauri `fetch_message_history` 命令到前端 Message 类型。
//
// 链路:
//   UI → invoke("fetch_message_history", req)
//        → Tauri:HubClient.fetch_message_history → relay → 业务后台 → records 透传
//        → UI 适配扁平 records[] 成 Message[] 喂给现有渲染逻辑

import { buildMessageParts } from "@/components/workbench/messages/data";
import type { Message, MessageAttachment } from "@/components/workbench/messages/data";

import { invokeWithTimeout } from "./invokeClient";

// 网络命令(经 relay 到业务后台)给较宽超时;send_message 后端已自带最多 ~25s 的重试,
// 故前端超时设更长,避免前端先超时诱发用户重复发送。
const HISTORY_TIMEOUT_MS = 20_000;
const SEND_TIMEOUT_MS = 30_000;

/** Tauri `fetch_message_history` 命令入参(对齐 Rust `FetchMessageHistoryRequest`)。 */
export interface FetchMessageHistoryRequest {
  size: number;
  wecomAccountId: string;
  externalUserId: string;
  /** 首页 "";续页 = 上轮 nextCursor。语义固定 earlier-only(往更早翻)。 */
  cursor: string;
}

/** 单条历史消息记录(对齐 Rust `HistoryMessage`)。 */
export interface HistoryMessage {
  localMessageId: string;
  /** 1=入(对方发来) / 2=出(自己发出) */
  messageDirection: number;
  /** 1=文本 / 2=图片 */
  messageType: number;
  contentText: string;
  /** 1=已发送 / 2=已送达 / 3=已读 / 4=失败 */
  sendStatus: number;
  /** "yyyy-MM-dd HH:mm:ss",服务端本地时区 */
  messageTime: string;
  sortKey: string;
  attachments: HistoryAttachment[];
  /** 记录最后修改时间 "yyyy-MM-dd HH:mm:ss";客户端暂不消费。 */
  gmtModifiedTime: string;
}

export interface HistoryAttachment {
  mediaId: string;
  fileName: string;
  fileSize: number;
  fileType: string;
}

export interface FetchMessageHistoryResp {
  /** 扁平消息列表,按 sortKey 升序(早→晚)。 */
  records: HistoryMessage[];
  size: number;
  hasMore: boolean;
  nextCursor: string;
  /** 服务端不维护时 -1 */
  total: number;
  current: number;
  pages: number;
}

export async function fetchMessageHistory(
  req: FetchMessageHistoryRequest,
): Promise<FetchMessageHistoryResp> {
  return invokeWithTimeout<FetchMessageHistoryResp>(
    "fetch_message_history",
    { req },
    HISTORY_TIMEOUT_MS,
  );
}

/** 缓存优先读命令返回(对齐 Rust `CachedMessagesResp`)。records 升序(早→晚)。 */
export interface CachedMessagesResp {
  records: HistoryMessage[];
  hasMoreOlder: boolean;
}

/**
 * 缓存优先读会话首屏:立即返回本地缓存升序 records;后端会话水位门判定落后时
 * 后台 reconcile(经 `conversation-messages` ChangeNotice 通知前端重读)。零网络命中即秒开。
 */
export async function loadConversationMessages(params: {
  conversationId: string;
  wecomAccountId: string;
  externalUserId: string;
  limit?: number;
}): Promise<CachedMessagesResp> {
  return invokeWithTimeout<CachedMessagesResp>(
    "load_conversation_messages",
    {
      conversationId: params.conversationId,
      wecomAccountId: params.wecomAccountId,
      externalUserId: params.externalUserId,
      limit: params.limit,
    },
    HISTORY_TIMEOUT_MS,
  );
}

/** 往更老翻一页:网络拉更旧页 → 落库 → 返回升序新增 records + 是否还有更老。 */
export async function loadOlderMessages(params: {
  conversationId: string;
  pageSize?: number;
}): Promise<CachedMessagesResp> {
  return invokeWithTimeout<CachedMessagesResp>(
    "load_older_messages",
    {
      conversationId: params.conversationId,
      pageSize: params.pageSize,
    },
    HISTORY_TIMEOUT_MS,
  );
}

/** `send_message` 命令返回(对齐 Rust `SendMessageResp`)。 */
export interface SendMessageResp {
  localMessageId: string;
  /** 1=已发送 / 2=已送达 / 3=已读 / 4=失败 */
  sendStatus: number;
  /** "yyyy-MM-dd HH:mm:ss",服务端本地时区 */
  messageTime: string;
}

/**
 * 发送一条文本消息(`messageType=1`)。后端发送成功后落库出站气泡 + 发
 * `conversation-messages` ChangeNotice → 打开着的会话重读缓存稳定追加(不再依赖乐观气泡)。
 */
export async function sendMessage(params: {
  conversationId: string;
  wecomAccountId: string;
  externalUserId: string;
  contentText: string;
  /** 幂等键:重复点击 / 重试复用同一值,后端按 request_message_id 去重。 */
  clientMsgId: string;
}): Promise<SendMessageResp> {
  return invokeWithTimeout<SendMessageResp>(
    "send_message",
    {
      conversationId: params.conversationId,
      wecomAccountId: params.wecomAccountId,
      externalUserId: params.externalUserId,
      contentText: params.contentText,
      clientMsgId: params.clientMsgId,
    },
    SEND_TIMEOUT_MS,
  );
}

// ─── 形态转换:HistoryMessage → Message ─────────────────────────────────────
//
// 服务端 records 已按 sortKey **升序**(早→晚)扁平返回,UI 也期望升序
// (新消息在底部),直接顺序 map 即可,无需 reverse。

export function adaptHistoryRecords(records: HistoryMessage[], conversationId: string): Message[] {
  return records.map((r) => historyToMessage(r, conversationId));
}

function historyToMessage(h: HistoryMessage, conversationId: string): Message {
  // messageType=2(图片)的 contentText 是服务端给"不支持富文本的客户端"的占位
  // "[图片]"。本前端能直接渲染 image attachment,留这段文本会在气泡上方多一行
  // 冗余"[图片]" + 下面再叠图,体验冗余。把占位剥掉,只让附件出图。
  const text = h.messageType === 2 ? "" : h.contentText;
  const attachments =
    h.attachments.length > 0 ? h.attachments.map(historyAttachmentToMessage) : undefined;
  return {
    id: h.localMessageId,
    conversationId,
    direction: h.messageDirection === 2 ? "out" : "in",
    text,
    sentAt: parseServerTimeToIso(h.messageTime),
    status: h.messageDirection === 2 ? mapSendStatus(h.sendStatus) : undefined,
    parts: buildMessageParts(text, undefined, attachments),
  };
}

function historyAttachmentToMessage(a: HistoryAttachment): MessageAttachment {
  const lower = a.fileType.toLowerCase();
  const kind: MessageAttachment["type"] = ["jpg", "jpeg", "png", "gif", "webp"].includes(lower)
    ? "image"
    : lower === "mp3" || lower === "wav" || lower === "amr"
      ? "voice"
      : lower === "mp4" || lower === "mov"
        ? "video"
        : "file";
  return {
    type: kind,
    url: `mediaproxy://${a.mediaId}`, // 占位,后续接资源代理
    name: a.fileName,
    sizeBytes: a.fileSize,
  };
}

function mapSendStatus(s: number): Message["status"] {
  if (s === 4) return "failed";
  // 1/2/3 都视为 sent;细分(送达/已读)留下次扩展 Message.status enum
  return "sent";
}

// 企业微信服务端统一以北京时间(UTC+8)输出 "yyyy-MM-dd HH:mm:ss",字符串本身不带
// 时区。这是固定的服务端契约(非 mock/猜测),解析时按此补全偏移再转 ISO UTC。
const WECOM_SERVER_TZ_OFFSET = "+08:00";

/** "yyyy-MM-dd HH:mm:ss"(企业微信服务端北京时间) → ISO 8601 UTC */
function parseServerTimeToIso(s: string): string {
  // Date.parse 在 mac/chrome 上接受 "yyyy-MM-ddTHH:mm:ss+08:00"。
  const isoLike = s.replace(" ", "T") + WECOM_SERVER_TZ_OFFSET;
  const t = Date.parse(isoLike);
  if (!Number.isFinite(t)) {
    // 服务端时间格式异常极少见;退化为当前时间以保证 UI 有可显示的标签,但记录告警以便
    // 发现契约漂移(不静默吞)。注意:消息列表顺序由后端 sortKey 决定,此处仅影响时间
    // 标签/日期分隔,不影响排序。
    console.warn(`[messageHistory] 无法解析服务端时间 "${s}",已退化为当前时间`);
    return new Date().toISOString();
  }
  return new Date(t).toISOString();
}
