// message/history API 层 —— 桥接 Tauri `fetch_message_history` 命令到前端 Message 类型。
//
// 链路:
//   UI → invoke("fetch_message_history", req)
//        → Tauri:HubClient.fetch_message_history → relay → 业务后台 → records 透传
//        → UI 适配扁平 records[] 成 Message[] 喂给现有渲染逻辑

import { attachmentTypeFromExt, buildMessageParts } from "@/components/workbench/messages/data";
import type { Message, MessageAttachment } from "@/components/workbench/messages/data";

import { invokeWithTimeout } from "./invokeClient";

// 网络命令(经 relay 到业务后台)给较宽超时;send_message 后端已自带最多 ~25s 的重试,
// 故前端超时设更长,避免前端先超时诱发用户重复发送。
const HISTORY_TIMEOUT_MS = 20_000;
const SEND_TIMEOUT_MS = 30_000;
// 上传走 OSS(读字节 + 上传),耗时较长,单独给更宽松的超时。
const UPLOAD_TIMEOUT_MS = 60_000;

// 附件预览域名前缀:落库的 objectName 拼此前缀得到可访问 URL。
// 构建期由 CI 注入(VITE_CHATHUB_ATTACHMENT_BASE_URL,与 Rust 侧 CHATHUB_ATTACHMENT_BASE_URL 同源);
// dev/test 无注入时回落 filet.jdd51.com。
const ATTACHMENT_BASE_URL =
  import.meta.env.VITE_CHATHUB_ATTACHMENT_BASE_URL ?? "https://filet.jdd51.com";

/**
 * 把后端返回的相对 objectName 拼成完整预览 URL;已是完整 http(s) URL 则原样返回。
 * 拼接前去掉 objectName 开头的 "/"。
 */
export function attachmentPreviewUrl(objectName: string): string {
  if (!objectName) return objectName;
  if (/^https?:\/\//i.test(objectName)) return objectName;
  return `${ATTACHMENT_BASE_URL}/${objectName.replace(/^\//, "")}`;
}

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
  /** 图片原始宽度（像素），由后端 image_meta 注入；非图片附件为空。 */
  width?: number;
  /** 图片原始高度（像素），由后端 image_meta 注入；非图片附件为空。 */
  height?: number;
  /** 本地缩略图绝对路径，由后端 image_meta 注入；前端走 Tauri asset 协议读取。 */
  localPath?: string;
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
 * 发送一条消息。messageType:1=文本 / 2=图片 / 3=文件 / 4=语音,默认 1=文本。
 * 附件类(2/3/4)contentText 传 ""、并带上传后的 objectName(filePath)+ fileName + fileSize。
 * 后端发送成功后落库出站气泡 + 发 `conversation-messages` ChangeNotice → 打开着的会话
 * 重读缓存稳定追加(不再依赖乐观气泡)。纯文本旧调用(不传 messageType / file 字段)向后兼容。
 */
export async function sendMessage(params: {
  conversationId: string;
  wecomAccountId: string;
  externalUserId: string;
  contentText: string;
  /** 幂等键:重复点击 / 重试复用同一值,后端按 request_message_id 去重。 */
  clientMsgId: string;
  /** 1=文本 / 2=图片 / 3=文件 / 4=语音,默认 1。 */
  messageType?: number;
  /** 附件 OSS objectName(由 uploadAttachment 返回);非附件消息不传。 */
  filePath?: string;
  fileName?: string;
  fileSize?: number;
  /** 语音时长(秒,整数);仅语音(messageType=4)传。 */
  durationSeconds?: number;
}): Promise<SendMessageResp> {
  // 纯文本旧调用向后兼容:不传 file 字段时不下发对应键。
  const args: Record<string, unknown> = {
    conversationId: params.conversationId,
    wecomAccountId: params.wecomAccountId,
    externalUserId: params.externalUserId,
    messageType: params.messageType ?? 1,
    contentText: params.contentText,
    clientMsgId: params.clientMsgId,
  };
  if (params.filePath !== undefined) args.filePath = params.filePath;
  if (params.fileName !== undefined) args.fileName = params.fileName;
  if (params.fileSize !== undefined) args.fileSize = params.fileSize;
  if (params.durationSeconds !== undefined) args.durationSeconds = params.durationSeconds;
  return invokeWithTimeout<SendMessageResp>("send_message", args, SEND_TIMEOUT_MS);
}

/** `upload_attachment` 命令返回(对齐 Rust)。 */
export interface UploadAttachmentResp {
  objectName: string;
  fileName: string;
  fileSize: number;
}

/**
 * 上传一份附件字节到 OSS,返回 objectName 供 sendMessage 作 filePath 使用。
 * Tauri v2 invoke 直接把 Uint8Array 作为 bytes 透传给后端 Vec<u8>。
 */
export async function uploadAttachment(params: {
  bytes: Uint8Array;
  fileName: string;
  /** 文件后缀(不含点),如 jpg/png/amr/pdf。 */
  fileSuf: string;
  /** MIME 类型,如 image/png;可缺省。 */
  contentType?: string;
}): Promise<UploadAttachmentResp> {
  const args: Record<string, unknown> = {
    bytes: params.bytes,
    fileName: params.fileName,
    fileSuf: params.fileSuf,
  };
  if (params.contentType !== undefined) args.contentType = params.contentType;
  return invokeWithTimeout<UploadAttachmentResp>("upload_attachment", args, UPLOAD_TIMEOUT_MS);
}

// ─── 形态转换:HistoryMessage → Message ─────────────────────────────────────
//
// UI 期望升序(早→晚,新消息在底部)。后端正常也返回升序,这里仍做一次
// 防御性排序,避免冷启动/翻页遇到上游新→旧页时首帧顺序反转。

export function adaptHistoryRecords(records: HistoryMessage[], conversationId: string): Message[] {
  return [...records].sort(compareHistoryRecords).map((r) => historyToMessage(r, conversationId));
}

function historyToMessage(h: HistoryMessage, conversationId: string): Message {
  // messageType=2(图片)的 contentText 是服务端给"不支持富文本的客户端"的占位
  // "[图片]"。本前端能直接渲染 image attachment,留这段文本会在气泡上方多一行
  // 冗余"[图片]" + 下面再叠图,体验冗余。把占位剥掉,只让附件出图。
  const text = h.messageType === 2 ? "" : h.contentText;
  const attachments =
    h.attachments.length > 0 ? h.attachments.map(historyAttachmentToMessage) : undefined;
  const direction = normalizeLocalDirection(h.messageDirection);
  return {
    id: h.localMessageId,
    conversationId,
    direction: direction === 2 ? "out" : "in",
    text,
    sentAt: parseServerTimeToIso(h.messageTime),
    status: direction === 2 ? mapSendStatus(h.sendStatus) : undefined,
    parts: buildMessageParts(text, undefined, attachments),
  };
}

function normalizeLocalDirection(messageDirection: number): number {
  return messageDirection === 2 ? 2 : 1;
}

function compareHistoryRecords(a: HistoryMessage, b: HistoryMessage): number {
  const bySortKey = a.sortKey.localeCompare(b.sortKey);
  if (bySortKey !== 0) return bySortKey;
  const byTime = parseServerTimeToIso(a.messageTime).localeCompare(
    parseServerTimeToIso(b.messageTime),
  );
  if (byTime !== 0) return byTime;
  return a.localMessageId.localeCompare(b.localMessageId);
}

function historyAttachmentToMessage(a: HistoryAttachment): MessageAttachment {
  const kind = attachmentTypeFromExt(a.fileType);
  return {
    type: kind,
    // 媒体走 OSS 链接:mediaId 若是完整 https 原样用;若是相对 objectName 则拼预览域名。
    // 图片渲染侧再经 cachedImageSrc 走磁盘缓存。
    url: attachmentPreviewUrl(a.mediaId),
    name: a.fileName,
    sizeBytes: a.fileSize,
    // 后端 image_meta 注入的派生字段（非图片附件为 undefined）
    width: a.width,
    height: a.height,
    localPath: a.localPath,
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
