// 消息页的共享类型与 part 组装 helper(纯类型 + 纯函数,无 JSX / 无 React 依赖,任意消费者可用)。
// 历史遗留的 mock 演示数据(MOCK_CONVERSATIONS / MOCK_MESSAGES_BY_CONVERSATION 等)在 API
// 接通后已无消费者,已整体移除;真实数据走 useMessageHistory → chatStore。

export interface Conversation {
  id: string;
  name: string;
  /** Tailwind/CSS bg color used as avatar background. */
  /** Optional explicit avatar color override. When omitted, the renderer
   *  hashes the conversation seed into the wb-avatar-* token palette so all
   *  avatars stay theme-aware (light/dark) by default. Existing inline hex
   *  values are kept for design demos but new records can omit this field. */
  avatarColor?: string;
  /** 客户真实头像 URL(企微外部联系人 externalAvatar)。空表示无,渲染回退占位图。 */
  avatar?: string;
  preview: string;
  /** The account that received/initiated the conversation, e.g. "杭州企微-小美". */
  account: string;
  /** Pre-formatted relative time shown in the conversation row (e.g. "11:24" or "昨天"). */
  time: string;
  unread: number;
  online: boolean;
  /**
   * 用户在该会话有未发送草稿时的预览文本(plain text,UI 截断到约 80 字符)。
   * 非空时 preview 区显示 "[草稿] {draftText}",优先级高于 unread/preview。
   */
  draftText?: string;
  /**
   * 用户对该会话点了"置顶"。true 时头像右上角显示 pin 角标;排序已在后端
   * list_top 多键 ORDER BY(pinned DESC → pinned_at_ms DESC)处理,UI 不再额外排序。
   * pinned 状态仅本地维护(SQLite 列),远端事件不覆盖。
   */
  pinned?: boolean;
  /**
   * 用户对该会话点了"消息免打扰"。true 时未读"安静"展示:右下角红点替代数字徽标、
   * preview 前缀显示 "[N 条]"、time 下方显示 🔕。muted 不改排序(与 pinned 正交),
   * 仅本地维护(SQLite 列),远端事件不覆盖。
   */
  muted?: boolean;
  /**
   * markRead 远端往返进行中、未读数尚未被 refetch 清零的过渡态。true 时按 selected 一样
   * 抑制红标,消除"切走会话时红点先现后灭"的闪烁。来源 useRecentFriends.readingIds,
   * 非持久数据,仅渲染期透传。
   */
  readPending?: boolean;
}

export type MessageStatus = "sending" | "sent" | "failed";

export interface MessageAttachment {
  type: "image" | "file" | "voice" | "video";
  url: string;
  name?: string;
  sizeBytes?: number;
  durationSec?: number;
  /** 图片原始宽度（像素），由后端 image_meta 注入。 */
  width?: number;
  /** 图片原始高度（像素），由后端 image_meta 注入。 */
  height?: number;
  /** 本地缩略图绝对路径，由后端 image_meta 注入；前端走 Tauri asset 协议读取。 */
  localPath?: string;
  /** 附件转存状态:0=无需转存,1=待转存,2=成功,3=失败。缺省视为就绪。 */
  transferStatus?: number;
}

export type MessageBlock =
  | { type: "text"; value: string }
  | {
      type: "image";
      url: string;
      name?: string;
      sizeBytes?: number;
      width?: number;
      height?: number;
    };

// 渲染用的单一内容通道:文本与各类媒体统一为按显示顺序排列的判别联合。取代早先
// `blocks`(composer 富文本) + `attachments`(服务端附件)双通道,渲染端只按 kind 分发。
// `MessageBlock` / `MessageAttachment` 仍保留作 composer 中间类型与转换输入。
export type MessagePart =
  | { kind: "text"; text: string }
  | {
      kind: "image";
      url: string;
      name?: string;
      sizeBytes?: number;
      width?: number;
      height?: number;
      /** 本地缩略图绝对路径，由后端 image_meta 注入；前端走 Tauri asset 协议读取。 */
      localPath?: string;
      /** true=随文本内联(composer 富文本);否则按附件大卡渲染。 */
      inline?: boolean;
      /** 附件转存状态:1=待转存,3=失败;缺省/其余视为就绪。 */
      transferStatus?: number;
    }
  | { kind: "file"; url: string; name?: string; sizeBytes?: number; transferStatus?: number }
  | { kind: "voice"; url: string; durationSec?: number; transferStatus?: number }
  | { kind: "video"; url: string; name?: string; durationSec?: number; transferStatus?: number }
  // 前端不识别的消息类型(如 messageType=99):上游既无可渲染文本也无可渲染附件,
  // 兜底为占位 part,由渲染层显示「暂不支持」提示,避免出现空白气泡。无字段。
  | { kind: "unknown" };

// 收发两侧(历史消息分类 / 本地选文件)与 composer 校验共用的单一真相源:扩展名白名单。
export const IMAGE_EXTS = ["jpg", "jpeg", "png", "gif", "webp"] as const;
export const VOICE_EXTS = ["amr", "mp3", "wav"] as const;
export const DOC_EXTS = [
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "txt",
  "zip",
  "rar",
] as const;

// 按文件后缀(扩展名,不含点;大小写不敏感)判定附件类型,进而决定后端 messageType:
// image=2 / voice=4 / video / file=3。收(历史消息)发(本地选文件)两侧共用此单一规则,
// 避免分类漂移(曾因发送侧硬编码 "file" 导致 amr 语音被按 messageType=3 当文件发出)。
// 其余后缀(pdf/doc/docx/xls/xlsx/ppt/pptx/txt/zip/rar 等)落入 file=3。
export function attachmentTypeFromExt(ext: string): MessageAttachment["type"] {
  const lower = ext.toLowerCase();
  if ((IMAGE_EXTS as readonly string[]).includes(lower)) return "image";
  if ((VOICE_EXTS as readonly string[]).includes(lower)) return "voice";
  // silk/sil 仅收侧出现(企微/微信语音原始格式)。归 voice 走语音气泡 + 应用内解码(见 silk.ts);
  // 刻意不进 VOICE_EXTS —— 发送 picker 白名单只收 amr/mp3/wav(企微语音只接受 AMR-NB),且 silk
  // 进不了任何发送 picker。带权威 attachmentType=3 时本就判 voice,此处兜"只带后缀、无码值"的边界。
  if (lower === "silk" || lower === "sil") return "voice";
  if (lower === "mp4" || lower === "mov") return "video";
  return "file";
}

// 上游权威媒体类型码值(notify/push 与 message/history 同口径的 attachmentType)→ 渲染类型。
// 1=图片 / 2=文件 / 3=语音 / 4=视频。收到附件时**首选**按此码值分类(实时推送只带 attachmentType、
// 不带 fileSuffix,纯靠扩展名会把图片误判成文件);未知/缺省码值返回 undefined,调用方再回退
// attachmentTypeFromExt(按 fileType 扩展名)。文件大类内的具体格式(pdf/doc/xls)仍由扩展名细分。
export function attachmentKindFromCode(
  code: number | undefined,
): MessageAttachment["type"] | undefined {
  switch (code) {
    case 1:
      return "image";
    case 2:
      return "file";
    case 3:
      return "voice";
    case 4:
      return "video";
    default:
      return undefined;
  }
}

// 前端已知/可渲染的消息类型码:1=文本 / 2=图片 / 3=文件 / 4=语音 / 5=图文混合 / 6=视频。
// 其余码值(如 99)是当前版本不识别的类型,UI 兜底为「未知消息」。会话列表预览在
// lastMessageSummary 为空且类型未知时据此回退占位文案,避免出现空白预览行。
const KNOWN_MESSAGE_TYPES = new Set([1, 2, 3, 4, 5, 6]);
export function isKnownMessageType(type: number): boolean {
  return KNOWN_MESSAGE_TYPES.has(type);
}

function attachmentToPart(a: MessageAttachment): MessagePart {
  switch (a.type) {
    case "image":
      return {
        kind: "image",
        url: a.url,
        name: a.name,
        sizeBytes: a.sizeBytes,
        width: a.width,
        height: a.height,
        localPath: a.localPath,
        transferStatus: a.transferStatus,
      };
    case "file":
      return {
        kind: "file",
        url: a.url,
        name: a.name,
        sizeBytes: a.sizeBytes,
        transferStatus: a.transferStatus,
      };
    case "voice":
      return {
        kind: "voice",
        url: a.url,
        durationSec: a.durationSec,
        transferStatus: a.transferStatus,
      };
    case "video":
      return {
        kind: "video",
        url: a.url,
        name: a.name,
        durationSec: a.durationSec,
        transferStatus: a.transferStatus,
      };
  }
}

function blockToPart(b: MessageBlock): MessagePart {
  return b.type === "text"
    ? { kind: "text", text: b.value }
    : {
        kind: "image",
        url: b.url,
        name: b.name,
        sizeBytes: b.sizeBytes,
        width: b.width,
        height: b.height,
        inline: true,
      };
}

/**
 * 组装消息的显示 parts。
 * - 有 blocks(composer 富文本):text/image 内联保持顺序;附件里的**图片丢弃**(已在
 *   blocks 内,避免重复渲染),仅追加文件/语音/视频附件卡片。
 * - 无 blocks:文本 part 在前,附件卡片依序在后(匹配旧"文本 + 附件下方"布局)。
 */
export function buildMessageParts(
  text: string,
  blocks?: MessageBlock[],
  attachments?: MessageAttachment[],
): MessagePart[] {
  if (blocks && blocks.length > 0) {
    const parts = blocks.map(blockToPart);
    if (attachments) {
      for (const a of attachments) {
        if (a.type !== "image") parts.push(attachmentToPart(a));
      }
    }
    return parts;
  }
  const parts: MessagePart[] = [];
  if (text.length > 0) parts.push({ kind: "text", text });
  if (attachments && attachments.length > 0) {
    for (const a of attachments) parts.push(attachmentToPart(a));
  }
  return parts;
}

export interface Message {
  id: string;
  conversationId: string;
  direction: "in" | "out";
  /** 原始纯文本:用于搜索 / 引用预览 / 无障碍回退;实际渲染走 `parts`。 */
  text: string;
  /** ISO 8601 timestamp; UI components derive any display label from this. */
  sentAt: string;
  /** Only meaningful for `out` messages. `in` messages are always treated as read. */
  status?: MessageStatus;
  /** 唯一内容通道:文本 + 媒体,按显示顺序排列。 */
  parts: MessagePart[];
  /** id of the message being replied to. */
  replyTo?: string;
  /** Mentioned user handles parsed from `text` (post-processed by backend). */
  mentions?: string[];
  /** Recalled by sender within the recall window. Renderer collapses the
   *  bubble into a centered system line ("你撤回了一条消息" / "对方撤回了一条消息"). */
  isRecalled?: boolean;
  /**
   * 权威出站条目携带的 requestMessageId(= 前端发送时生成的 clientMsgId,local-<uuid>)。
   * 服务端 push 写库后经历史/缓存读回原样透传;replaceAuthoritative 据此对乐观↔权威做
   * 确定性配对(serverId 兜底之外的精确路径)。入站消息无此字段。
   */
  requestMessageId?: string;
  /** 发送失败原因(status==="failed" 时由服务端下发);供失败气泡展示具体原因。 */
  failReason?: string;
  /**
   * 出站附件气泡专用字段:消息类型(1=文本/2=图片/3=文件/4=语音)与已上传的 OSS objectName。
   * 失败重发时复用 filePath 直接重发,无需重传 OSS。纯文本/入站消息不写。
   */
  messageType?: number;
  filePath?: string;
  fileName?: string;
  fileSize?: number;
  /** 语音时长(秒,整数);仅语音(messageType=4)出站气泡写,供发送/重发携带 durationSeconds。 */
  durationSeconds?: number;
  /**
   * 多端同步标记:true=该出站消息由客服在他端(企业微信手机/电脑端)发出后同步进入本端
   * (后端源方向 3,见 row_to_history)。仅出站消息可能为 true;入站/本端直发为 undefined。
   * 气泡据此渲染「企业微信来源」差异化样式(中性底色 + 来源徽章 + 头像角标)。
   */
  syncedFromOtherDevice?: boolean;
}

// `Customer` is now defined in `@/lib/types/customer` so the customers page and
// the messages page share one shape. Re-exported here to keep existing imports
// (`import type { Customer } from "./data"`) working unchanged.
import type { Customer } from "@/lib/types/customer";
export type { Customer };

export interface QuickReply {
  id: string;
  title: string;
  preview: string;
}
