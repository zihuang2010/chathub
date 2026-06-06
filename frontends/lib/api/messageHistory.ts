// message/history API 层 —— 桥接 Tauri `fetch_message_history` 命令到前端 Message 类型。
//
// 链路:
//   UI → invoke("fetch_message_history", req)
//        → Tauri:HubClient.fetch_message_history → relay → 业务后台 → records 透传
//        → UI 适配扁平 records[] 成 Message[] 喂给现有渲染逻辑

import {
  attachmentKindFromCode,
  attachmentTypeFromExt,
  buildMessageParts,
} from "@/components/workbench/messages/data";
import type { Message, MessageAttachment, MessagePart } from "@/components/workbench/messages/data";

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
  /** send_status,见 SEND_STATUS:1=待发送 / 2=发送中 / 3=成功 / 4=失败 */
  sendStatus: number;
  /** "yyyy-MM-dd HH:mm:ss",服务端本地时区 */
  messageTime: string;
  sortKey: string;
  attachments: HistoryAttachment[];
  /** 记录最后修改时间 "yyyy-MM-dd HH:mm:ss";客户端暂不消费。 */
  gmtModifiedTime: string;
  /** 服务端撤回标记;true=该消息已被撤回,渲染折叠为"已撤回"系统行。 */
  revoked?: boolean;
  /** 发送失败原因(sendStatus=4 时由服务端下发);可空。 */
  failReason?: string;
  /** 等于前端发送时生成的 clientMsgId(local-<uuid>);用于乐观↔权威确定性配对。 */
  requestMessageId?: string;
  /** 多端同步标记(后端由持久化的 source_direction=3 派生);出站气泡据此渲染「企业微信来源」差异化样式。 */
  syncedFromOtherDevice?: boolean;
}

export interface HistoryAttachment {
  mediaId: string;
  fileName: string;
  fileSize: number;
  /** 权威媒体类型:1=图片 / 2=文件 / 3=语音 / 4=视频(上游 attachmentType)。分类首选此字段,缺省 0=未知。 */
  attachmentType?: number;
  fileType: string;
  /** 图片原始宽度（像素），由后端 image_meta 注入；非图片附件为空。 */
  width?: number;
  /** 图片原始高度（像素），由后端 image_meta 注入；非图片附件为空。 */
  height?: number;
  /** 本地缩略图绝对路径，由后端 image_meta 注入；前端走 Tauri asset 协议读取。 */
  localPath?: string;
  /** 附件转存状态:0=无需转存,1=待转存,2=成功,3=失败。缺省视为就绪。 */
  transferStatus?: number;
  /** 媒体时长(秒);语音/视频由后端下发。 */
  durationSeconds?: number;
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
  /**
   * 本窗最新之后缓存里是否仍有更新行(窗口化往更新翻能力)。仅 `loadCachedWindow` 会返回真;
   * 整窗读 / 往旧翻恒为 false。可选字段:老命令不返回时按 undefined(falsy)处理,向后兼容。
   */
  hasMoreNewer?: boolean;
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
  /** 安全网 #3/#4:resync 对当前打开会话强制绕水位门同步 reconcile;默认 false 走常规水位门。 */
  force?: boolean;
}): Promise<CachedMessagesResp> {
  return invokeWithTimeout<CachedMessagesResp>(
    "load_conversation_messages",
    {
      conversationId: params.conversationId,
      wecomAccountId: params.wecomAccountId,
      externalUserId: params.externalUserId,
      limit: params.limit,
      force: params.force ?? false,
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

/**
 * 窗口化读:围绕锚点 `anchorSortKey` 取一段连续本地缓存(纯本地,不触发 reconcile、不走网络)。
 * `after>0` 取锚点更新方向 N 条;`before>0` 取更旧方向 N 条;`anchorSortKey=""` 取最新尾窗。
 * 返回升序 records + `hasMoreOlder`/`hasMoreNewer` 两端边界标志。
 */
export async function loadCachedWindow(params: {
  conversationId: string;
  anchorSortKey: string;
  before?: number;
  after?: number;
}): Promise<CachedMessagesResp> {
  return invokeWithTimeout<CachedMessagesResp>(
    "load_cached_window",
    {
      conversationId: params.conversationId,
      anchorSortKey: params.anchorSortKey,
      before: params.before,
      after: params.after,
    },
    HISTORY_TIMEOUT_MS,
  );
}

/** 清除当前登录员工的全部本地聊天记录(后端删消息行 + 水位窗;仅清本地缓存)。 */
export async function clearChatMessages(): Promise<void> {
  return invokeWithTimeout<void>("clear_chat_messages", {}, HISTORY_TIMEOUT_MS);
}

/**
 * send_status 枚举(后端权威契约,send_message 同步返回与历史记录 HistoryMessage 共用):
 * 1=待发送 / 2=发送中 / 3=成功 / 4=失败。
 * 仅 3 为成功终态、4 为失败终态;1/2 为未终态(在途),不可当成功——发送/重读两条路径
 * 都据此映射,避免「同步已失败 / 仍在途却显示已发送」的假成功。
 */
export const SEND_STATUS = {
  pending: 1,
  sending: 2,
  success: 3,
  failed: 4,
} as const;

/** `send_message` 命令返回(对齐 Rust `SendMessageResp`)。 */
export interface SendMessageResp {
  localMessageId: string;
  /** send_status,见 SEND_STATUS:1=待发送 / 2=发送中 / 3=成功 / 4=失败 */
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

/** 前端任一发送失败时把失败气泡落本地库(send_status=4)。对齐 Rust `persist_outbox_failure`。 */
export async function persistOutboxFailure(params: {
  conversationId: string;
  wecomAccountId: string;
  externalUserId: string;
  clientMsgId: string;
  /** 乐观气泡 sentAt 的 epoch-ms(同源,供后端 sort_key/message_time_ms)。 */
  sentAtMs: number;
  messageType: number;
  contentText: string;
  failReason: string;
  /** 由前端 parts 序列化的 HistoryAttachment[] JSON 串;纯文本传 "[]"。 */
  attachmentsJson: string;
}): Promise<void> {
  return invokeWithTimeout<void>("persist_outbox_failure", { ...params }, SEND_TIMEOUT_MS);
}

/** 重发前删本地失败行(让气泡回纯乐观 sending)。对齐 Rust `clear_outbox_row`。 */
export async function clearOutboxRow(params: {
  conversationId: string;
  clientMsgId: string;
}): Promise<void> {
  return invokeWithTimeout<void>("clear_outbox_row", { ...params }, SEND_TIMEOUT_MS);
}

// ─── 形态转换:HistoryMessage → Message ─────────────────────────────────────
//
// UI 期望升序(早→晚,新消息在底部)。后端正常也返回升序,这里仍做一次
// 防御性排序,避免冷启动/翻页遇到上游新→旧页时首帧顺序反转。

export function adaptHistoryRecords(records: HistoryMessage[], conversationId: string): Message[] {
  // 时间解析缓存:排序比较器与 historyToMessage 都要把 messageTime 解析成 ISO。
  // 排序是 N·logN 次比较,每次比较原本要解析两条记录的时间 → 同一条记录被重复解析。
  // 这里对每条记录的 messageTime 预解析一次进 Map<原始字符串,ISO> 缓存,排序与映射复用,
  // 仅去重计算、不改语义(同一字符串得到同一 ISO,排序结果与逐次解析逐字节一致)。
  const isoCache = new Map<string, string>();
  const isoOf = (messageTime: string): string => {
    const cached = isoCache.get(messageTime);
    if (cached !== undefined) return cached;
    const iso = parseServerTimeToIso(messageTime);
    isoCache.set(messageTime, iso);
    return iso;
  };
  return [...records]
    .sort((a, b) => compareHistoryRecords(a, b, isoOf))
    .map((r) => historyToMessage(r, conversationId, isoOf));
}

function historyToMessage(
  h: HistoryMessage,
  conversationId: string,
  isoOf: (messageTime: string) => string,
): Message {
  // 纯媒体大类(图片2 / 文件3 / 语音4 / 视频6)的 contentText 是服务端给"不支持富文本的客户端"
  // 的占位/摘要(如"[图片]")。本前端直接渲染附件,留这段占位会在气泡上方多一行冗余文本 + 下面
  // 再叠附件,体验冗余。把占位剥掉,只让附件出内容。文本1 与图文混合5 的 contentText 是真实正文,
  // 保留;未知大类默认保留,不藏内容。
  const text = [2, 3, 4, 6].includes(h.messageType) ? "" : h.contentText;
  const attachments =
    h.attachments.length > 0 ? h.attachments.map(historyAttachmentToMessage) : undefined;
  // 方向:后端 messageDirection===2 为出站,其它一律入站(直接产出 "in"/"out",无中间数值层)。
  const direction = h.messageDirection === 2 ? "out" : "in";
  // 前端不识别的消息类型(如 messageType=99)既无可渲染文本也无可渲染附件 → parts 为空,
  // 否则气泡渲染为空白。统一兜底为「未知消息」占位 part,由 MessageContent 显示「暂不支持」提示。
  const built = buildMessageParts(text, undefined, attachments);
  const parts: MessagePart[] = built.length > 0 ? built : [{ kind: "unknown" }];
  return {
    id: h.localMessageId,
    conversationId,
    direction,
    text,
    sentAt: isoOf(h.messageTime),
    status: direction === "out" ? mapSendStatus(h.sendStatus) : undefined,
    parts,
    // 撤回标记:服务端 revoked=true → 折叠为"已撤回"系统行(MessageBubble 已有渲染)。
    // false/缺省一律收敛为 undefined,与其余可选字段保持"不存在=未撤回"语义。
    isRecalled: h.revoked || undefined,
    // requestMessageId(=发送时 clientMsgId)带到权威条目,供 replaceAuthoritative 确定性配对。
    requestMessageId: h.requestMessageId,
    // 失败原因(sendStatus=4 时);供失败气泡展示具体原因。
    failReason: h.failReason,
    // 多端同步标记:后端据持久化的 source_direction=3 派生;出站气泡据此渲染「企业微信来源」样式。
    syncedFromOtherDevice: h.syncedFromOtherDevice,
  };
}

function compareHistoryRecords(
  a: HistoryMessage,
  b: HistoryMessage,
  isoOf: (messageTime: string) => string,
): number {
  const bySortKey = a.sortKey.localeCompare(b.sortKey);
  if (bySortKey !== 0) return bySortKey;
  const byTime = isoOf(a.messageTime).localeCompare(isoOf(b.messageTime));
  if (byTime !== 0) return byTime;
  return a.localMessageId.localeCompare(b.localMessageId);
}

function historyAttachmentToMessage(a: HistoryAttachment): MessageAttachment {
  // 权威 attachmentType 优先(实时推送只带它、不带 fileSuffix);未知/缺省再回退按扩展名判定。
  const kind = attachmentKindFromCode(a.attachmentType) ?? attachmentTypeFromExt(a.fileType);
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
    // 转存态 + 媒体时长(后端 durationSeconds → 前端 durationSec)
    transferStatus: a.transferStatus,
    durationSec: a.durationSeconds,
  };
}

function mapSendStatus(s: number): Message["status"] {
  if (s === SEND_STATUS.failed) return "failed";
  if (s === SEND_STATUS.success) return "sent";
  // 1 待发送 / 2 发送中(及未知值):未终态 → 显示发送中,等后端推进到 3/4 终态。
  // 不再把 1/2 当 sent,杜绝权威重读路径上「仍在途却显示已发送」的瞬时假成功。
  return "sending";
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
