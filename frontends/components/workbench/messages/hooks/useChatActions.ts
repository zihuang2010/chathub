// 聊天消息动作处理器(Stage 4d:从 ChatArea 抽出,减负 + 隔离测试)。
//
// 发送 / 重发 / 删除 / 撤回 / 引用 全走 chatStore action(单一真相);乐观气泡入 store,
// 发送结果用 serverId 收敛去重。
//
// 混合消息发送:把富文本 blocks(文本 + 内联图片)与附件区文件按编辑器内先后顺序拆成
// 多条单消息,串行发送(await 上一条成功再发下一条,保证时序);遇错即停,已发保留,
// 当前 + 后续标失败/待发可重发。

import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";

import { showToast } from "@/components/ui/toast";
import {
  clearOutboxRow,
  persistOutboxFailure,
  SEND_STATUS,
  uploadAttachment,
  type SendMessageResp,
} from "@/lib/api/messageHistory";

import { COMPOSER_MAX_CHARS } from "../constants";
import {
  buildMessageParts,
  type Conversation,
  type Message,
  type MessageAttachment,
  type MessageBlock,
} from "../data";
import type { ReplyTarget } from "../MessageBubble";
import type { MessageActionType } from "../MessageContextMenu";
import { useChatStore } from "../store/chatStore";
import { markMessageDeleted } from "../store/deletedMessages";
import {
  getLaneIntervalMs,
  isRetryableSendError,
  MAX_SEND_RETRY,
  noteSendOutcome,
  runSerialSend,
  sendRetryBackoffMs,
  sleep,
} from "../store/sendPacer";
import { STRINGS } from "../strings";
import { messageReplyPreview } from "../utils";

export type ReplyDraft = ReplyTarget & { id: string; conversationId: string };

/** 发送附件时携带的扩展字段:messageType + 上传后的 OSS objectName 等。 */
export interface SendMessageOptions {
  messageType?: number;
  filePath?: string;
  fileName?: string;
  fileSize?: number;
  /** 语音时长(秒,整数);仅语音(messageType=4)传。 */
  durationSeconds?: number;
}

export interface UseChatActionsParams {
  conversation: Conversation;
  chatStoreKey: string;
  onSendMessage?: (
    text: string,
    clientMsgId: string,
    options?: SendMessageOptions,
  ) => Promise<SendMessageResp | void>;
  /** 发送后强制贴底跟随(写 ChatArea 的滚动 ref)。 */
  wasAtBottomRef: MutableRefObject<boolean>;
  setReplyDraft: Dispatch<SetStateAction<ReplyDraft | null>>;
  /** 当前会话归属账号/客户;失败落库 IPC 需要(缺则降级为仅内存 markFailed)。 */
  wecomAccountId?: string;
  externalUserId?: string;
}

export interface UseChatActionsResult {
  handleSend: (
    text: string,
    blocks?: MessageBlock[],
    attachments?: MessageAttachment[],
    replyTo?: string,
  ) => void;
  handleAction: (action: MessageActionType, message: Message) => void;
}

// messageType 枚举:1=文本 / 2=图片 / 3=文件 / 4=语音。
const MSG_TYPE_TEXT = 1;
const MSG_TYPE_IMAGE = 2;
const MSG_TYPE_FILE = 3;
const MSG_TYPE_VOICE = 4;

// 有序发送单元:混合消息按编辑器内先后顺序拆成的单条消息。
type SendUnit =
  | { kind: "text"; text: string }
  | {
      // 附件单元:image/file/voice 共用,messageType 区分;video 本期当文件发。
      kind: "attachment";
      messageType: number;
      attachmentType: MessageAttachment["type"];
      // 本地预览地址(data: 或 blob:),既用于乐观气泡渲染,也用于 fetch 取字节上传。
      url: string;
      name: string;
      sizeBytes?: number;
      width?: number;
      height?: number;
      // 本函数内临时 createObjectURL 造的、不归任何 store 持有的 blob url(仅超长文本转 .txt 这一处)。
      // 上传消费完即可 revokeObjectURL 释放;归属气泡的图片/语音/文件附件 url 不带此标记,绝不在此释放,
      // 否则会误伤气泡渲染。来源标记比单纯按 blob: 前缀判定更稳妥(气泡附件也可能是 blob:)。
      transientUrl?: boolean;
    };

// 前端附件类型 → 后端 messageType;video 本期按文件(3)发送。
function attachmentMessageType(type: MessageAttachment["type"]): number {
  switch (type) {
    case "image":
      return MSG_TYPE_IMAGE;
    case "voice":
      return MSG_TYPE_VOICE;
    case "file":
    case "video":
    default:
      return MSG_TYPE_FILE;
  }
}

// 超长文本落 txt 文件名的时间戳:长文本_YYYYMMDD-HHMMSS.txt。
function overflowFileStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// 一段文本 → 发送单元:与编辑器同口径(按 code point 计)。未达 COMPOSER_MAX_CHARS 走文本单元;
// 达到则就地改造成 .txt 文件附件单元(text/plain 的 blob 预览),下游 uploadAttachmentUnit 取字节
// 上传 OSS、按文件消息(messageType=3)发出 —— 完全复用现有文件链路,规避对端单条文本长度限制。
function textToSendUnit(text: string): SendUnit {
  if ([...text].length < COMPOSER_MAX_CHARS) return { kind: "text", text };
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  return {
    kind: "attachment",
    messageType: MSG_TYPE_FILE,
    attachmentType: "file",
    url: URL.createObjectURL(blob),
    name: `长文本_${overflowFileStamp()}.txt`,
    sizeBytes: blob.size,
    // 这是本函数临时造的 blob url(不入 draft/composer 生命周期),上传取字节后即可释放。
    transientUrl: true,
  };
}

// 从文件名 / data URL 推断后缀(fileSuf,不含点),失败回退 "bin"。
function inferFileSuf(name: string, url: string): string {
  const dot = name.lastIndexOf(".");
  if (dot >= 0 && dot < name.length - 1) return name.slice(dot + 1).toLowerCase();
  // data:image/png;base64,... → png
  const m = /^data:([^;,]+)/i.exec(url);
  if (m) {
    const sub = m[1].split("/")[1];
    if (sub) return sub.toLowerCase();
  }
  return "bin";
}

// 从 data URL / 后缀推断 contentType(MIME);推断不出返回 undefined。
function inferContentType(name: string, url: string): string | undefined {
  const m = /^data:([^;,]+)/i.exec(url);
  if (m) return m[1];
  const suf = inferFileSuf(name, url);
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    amr: "audio/amr",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    mp4: "video/mp4",
    pdf: "application/pdf",
    txt: "text/plain",
  };
  return map[suf];
}

// 把 blocks(文本 + 内联图片) + attachments(附件区文件)拼成有序发送单元;空文本跳过。
function buildSendUnits(blocks?: MessageBlock[], attachments?: MessageAttachment[]): SendUnit[] {
  const units: SendUnit[] = [];
  if (blocks) {
    for (const block of blocks) {
      if (block.type === "text") {
        const value = block.value.trim();
        if (value) units.push(textToSendUnit(value));
      } else if (block.type === "image" && block.url) {
        units.push({
          kind: "attachment",
          messageType: MSG_TYPE_IMAGE,
          attachmentType: "image",
          url: block.url,
          name: block.name ?? "image",
          sizeBytes: block.sizeBytes,
          width: block.width,
          height: block.height,
        });
      }
    }
  }
  if (attachments) {
    for (const att of attachments) {
      units.push({
        kind: "attachment",
        messageType: attachmentMessageType(att.type),
        attachmentType: att.type,
        url: att.url,
        name: att.name ?? att.type,
        sizeBytes: att.sizeBytes,
      });
    }
  }
  return units;
}

// 取本地预览字节:MessageAttachment / 内联图片块只存了 url(blob: 或 data:)。
async function fetchBytes(url: string): Promise<Uint8Array> {
  const buf = await (await fetch(url)).arrayBuffer();
  return new Uint8Array(buf);
}

// 企微语音消息只接受 AMR-NB(8kHz 单声道),且时长 ≤60s、大小 ≤2MB。
const VOICE_MAX_SEC = 60;
const VOICE_MAX_BYTES = 2 * 1024 * 1024;

// 语音是否超出企微限制(时长 / 大小)。durationSec 缺省(解码取不到)时仅用大小兜底。
export function voiceExceedsLimit(durationSec: number | undefined, byteLength: number): boolean {
  return (durationSec ?? 0) > VOICE_MAX_SEC || byteLength > VOICE_MAX_BYTES;
}

// 把文件名后缀改成 .amr(转码后用);无后缀直接追加。
export function toAmrFileName(name: string): string {
  const dot = name.lastIndexOf(".");
  return `${dot >= 0 ? name.slice(0, dot) : name}.amr`;
}

// 发送前把语音规整成 amr。复用 MessageContent 同款 benz-amr-recorder:
//   - amr:原样,仅解码取时长(整数秒);
//   - 非 amr(mp3/wav 等):benz initWithBlob 内部用 WebAudio 解码 + 重编码成 8kHz AMR-NB,
//     getBlob() 取转码后字节(下游企微只认 amr,原样上传对端放不出)。
// 解码失败 / 超限返回 ok:false,由调用方提示并标失败。
async function prepareVoiceForSend(
  bytes: Uint8Array,
  fileSuf: string,
): Promise<{ ok: true; bytes: Uint8Array; durationSec?: number } | { ok: false; reason: string }> {
  let out = bytes;
  let durationSec: number | undefined;
  try {
    const { default: BenzAMRRecorder } = await import("benz-amr-recorder");
    const amr = new BenzAMRRecorder();
    await amr.initWithBlob(new Blob([new Uint8Array(bytes)]));
    const sec = Math.round(amr.getDuration());
    durationSec = sec > 0 ? sec : undefined;
    if (fileSuf !== "amr") {
      const blob = amr.getBlob();
      if (!blob) throw new Error("benz 未产出 amr blob");
      out = new Uint8Array(await blob.arrayBuffer());
    }
  } catch {
    return { ok: false, reason: STRINGS.toast.voiceTranscodeFailed };
  }
  if (voiceExceedsLimit(durationSec, out.byteLength)) {
    return { ok: false, reason: STRINGS.toast.voiceTooLong };
  }
  return { ok: true, bytes: out, durationSec };
}

// 从发送错误里提取给坐席看的失败原因:业务错误({kind,msg})取 msg,普通 Error 取 message,
// 兜底通用文案。服务端偶尔把 Java 堆栈塞进 msg,截断到 80 字符避免 toast 撑爆。
function sendFailReason(err: unknown): string {
  let raw = "";
  if (err && typeof err === "object") {
    const o = err as { msg?: unknown; message?: unknown };
    if (typeof o.msg === "string") raw = o.msg;
    else if (typeof o.message === "string") raw = o.message;
  } else if (typeof err === "string") {
    raw = err;
  }
  raw = raw.trim();
  if (!raw) return STRINGS.errors.sendFailed;
  return raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
}

// 发送 messageType(2图/3文件/4语音) → 权威 attachmentType(1图/2文件/3语音/4视频);两套编码错位,须显式映射。
function outboxAttachmentType(messageType: number): number {
  switch (messageType) {
    case MSG_TYPE_IMAGE:
      return 1;
    case MSG_TYPE_FILE:
      return 2;
    case MSG_TYPE_VOICE:
      return 3;
    default:
      return 2;
  }
}

// 由失败气泡 entity 构造 HistoryAttachment[] JSON(camelCase,与后端 row_to_history 读回对齐)。
// mediaId 取 filePath(objectName,never-uploaded 为空 → 派生不可重发);纯文本 → "[]"。
function buildOutboxAttachmentsJson(entity: Message): string {
  const mt = entity.messageType ?? MSG_TYPE_TEXT;
  if (mt === MSG_TYPE_TEXT) return "[]";
  const imagePart = entity.parts.find((p) => p.kind === "image");
  const att: Record<string, unknown> = {
    mediaId: entity.filePath ?? "",
    fileName: entity.fileName ?? "",
    fileSize: entity.fileSize ?? 0,
    attachmentType: outboxAttachmentType(mt),
    fileType: inferFileSuf(entity.fileName ?? "", imagePart?.url ?? ""),
  };
  if (imagePart && imagePart.kind === "image") {
    if (imagePart.width !== undefined) att.width = imagePart.width;
    if (imagePart.height !== undefined) att.height = imagePart.height;
  }
  if (entity.durationSeconds !== undefined) att.durationSeconds = entity.durationSeconds;
  return JSON.stringify([att]);
}

export function useChatActions({
  conversation,
  chatStoreKey,
  onSendMessage,
  wasAtBottomRef,
  setReplyDraft,
  wecomAccountId,
  externalUserId,
}: UseChatActionsParams): UseChatActionsResult {
  // 统一失败处理:既 markFailed(内存即时态),又调 IPC 落本地库(重启不丢)。缺会话身份时降级为
  // 仅 markFailed。IPC 失败仅 warn,绝不阻塞。entity 优先按 byId key 取,兜底按 clientMsgId 字段找。
  const failBubble = useCallback(
    (clientMsgId: string, failReason: string) => {
      const owningStoreKey = chatStoreKey;
      useChatStore.getState().markFailed(owningStoreKey, clientMsgId);
      if (!wecomAccountId || !externalUserId) return;
      const slice = useChatStore.getState().conversations[owningStoreKey];
      const entity =
        slice?.byId[clientMsgId] ??
        Object.values(slice?.byId ?? {}).find((e) => e.clientMsgId === clientMsgId);
      if (!entity) return;
      const sentAtMs = Date.parse(entity.sentAt);
      void persistOutboxFailure({
        conversationId: conversation.id,
        wecomAccountId,
        externalUserId,
        clientMsgId,
        sentAtMs: Number.isNaN(sentAtMs) ? Date.now() : sentAtMs,
        messageType: entity.messageType ?? MSG_TYPE_TEXT,
        contentText: entity.text,
        failReason,
        attachmentsJson: buildOutboxAttachmentsJson(entity),
      }).catch((e) => console.warn("[outbox] persist_outbox_failure 失败(不阻塞)", e));
    },
    [chatStoreKey, conversation.id, wecomAccountId, externalUserId],
  );

  // 真发送一条出站消息:把发送时所属会话 id 闭包进来。成功 → markSent 钉 serverId(权威列表
  // 回来时按 serverId 去重收敛,不留重影气泡);失败 → markFailed(供 context menu resend)。
  // options 为附件类透传(messageType/filePath/...);纯文本不传,保持旧 onSendMessage(text, id) 调用形态。
  const deliverMessage = useCallback(
    // clientMsgId = 幂等键:后端按它去重,收敛(markSent/markFailed)也按它定位气泡。默认
    // 等于 messageId(乐观气泡 id 本就 = clientMsgId);历史消息重发时由调用方显式传入稳定键。
    async (
      messageId: string,
      text: string,
      clientMsgId: string = messageId,
      options?: SendMessageOptions,
    ) => {
      const owningStoreKey = chatStoreKey;
      // 串行车道:按企微账号隔离。同账号任意时刻至多一条发送在途、发完再发下一条(FIFO),
      // 一举根治频率限流(不会超频)与「同会话已有发送进行中」会话锁(同会话不并发);缺账号身份退默认车道。
      const lane = wecomAccountId ?? "default";
      // 把「整条发送(含限流重试)」作为一个任务投入串行队列:队列保证一条在途 + AIMD 自适应 gap。
      return runSerialSend(lane, async () => {
        // 命中「发送过快」限流时退避后重试同一 clientMsgId:后端按它幂等去重,绝不重复投递;
        // 重试期间气泡保持「发送中」,仅重试耗尽才标失败。attempt 从 0 计,最多额外重试 MAX_SEND_RETRY 次。
        for (let attempt = 0; ; attempt += 1) {
          try {
            const resp = options
              ? await onSendMessage?.(text, clientMsgId, options)
              : await onSendMessage?.(text, clientMsgId);
            // 同步返回即携带 send_status:不能无脑 markSent。仅 3=成功 才钉 serverId、置 sent;
            // 4=失败 立即 markFailed 并 return false 触发后续 fail-stop(与抛异常路径同构);
            // 1 待发送 / 2 发送中 是未终态 → 保持乐观「发送中」,等回调(权威重读按 requestMessageId)
            // 收敛终态,绝不在此假「已发送」——回调不来时也不会假成功。
            if (resp) {
              if (resp.sendStatus === SEND_STATUS.failed) {
                showToast(STRINGS.errors.sendFailed, { type: "error" });
                failBubble(clientMsgId, STRINGS.errors.sendFailed);
                return false;
              }
              if (resp.sendStatus === SEND_STATUS.success) {
                useChatStore.getState().markSent(owningStoreKey, clientMsgId, resp.localMessageId);
              }
            }
            noteSendOutcome(lane, "ok"); // AIMD:顺畅 → 加性缩小 gap(提速)。
            return true;
          } catch (err) {
            // 限流类错误且未达重试上限 → AIMD 乘性放大 gap、退避后重试(幂等安全,不会重复投递)。
            if (isRetryableSendError(err) && attempt < MAX_SEND_RETRY) {
              noteSendOutcome(lane, "rateLimited");
              // 真机诊断:看清是否在退避重试、第几次、当前 AIMD gap、原始错误(devtools 展开 err 看 kind/msg)。
              console.warn("[send] 命中限流,退避重试", {
                lane,
                attempt,
                backoffMs: sendRetryBackoffMs(attempt),
                aimdGapMs: getLaneIntervalMs(lane),
                reason: sendFailReason(err),
                err,
              });
              await sleep(sendRetryBackoffMs(attempt));
              continue;
            }
            const reason = sendFailReason(err);
            // 真机诊断:终态失败时打印原始错误 + 是否被判定为可重试 —— 用以区分「403 限流」
            // 与「会话锁/其它业务错」等未被重试的失败。
            console.warn("[send] 发送失败(终态)", {
              lane,
              attempt,
              retryable: isRetryableSendError(err),
              reason,
              err,
            });
            showToast(reason, { type: "error" });
            failBubble(clientMsgId, reason);
            return false;
          }
        }
      });
    },
    [chatStoreKey, onSendMessage, failBubble, wecomAccountId],
  );

  // 上传一个附件单元(不发送):fetch 本地预览取字节 →(语音转码)→ uploadAttachment 拿
  // objectName → 回写 objectName 到气泡(供重发复用)。返回发送所需的 options;任一步抛错
  // 即标失败并返回 null。把「上传」从「发送」中拆出,使多附件可并行上传、再按序发送。
  const uploadAttachmentUnit = useCallback(
    async (
      clientMsgId: string,
      unit: Extract<SendUnit, { kind: "attachment" }>,
    ): Promise<SendMessageOptions | null> => {
      const owningStoreKey = chatStoreKey;
      try {
        let bytes = await fetchBytes(unit.url);
        let fileSuf = inferFileSuf(unit.name, unit.url);
        let fileName = unit.name;
        let contentType = inferContentType(unit.name, unit.url);
        let durationSeconds: number | undefined;
        // 语音统一规整成 amr 再发(企微只认 amr):非 amr 转码,amr 仅取时长;超限/失败即停。
        if (unit.attachmentType === "voice") {
          const voice = await prepareVoiceForSend(bytes, fileSuf);
          if (!voice.ok) {
            showToast(voice.reason, { type: "error" });
            failBubble(clientMsgId, voice.reason);
            return null;
          }
          bytes = voice.bytes;
          durationSeconds = voice.durationSec;
          if (fileSuf !== "amr") {
            fileSuf = "amr";
            fileName = toAmrFileName(unit.name);
            contentType = "audio/amr";
          }
        }
        const uploaded = await uploadAttachment({
          bytes,
          fileName,
          fileSuf,
          contentType,
        });
        const options: SendMessageOptions = {
          messageType: unit.messageType,
          filePath: uploaded.objectName,
          fileName: uploaded.fileName,
          fileSize: uploaded.fileSize,
          durationSeconds,
        };
        // 回写已上传信息到气泡,便于失败重发复用 objectName、不再重传 OSS;语音一并存时长供重发携带。
        useChatStore.getState().patchMessage(owningStoreKey, clientMsgId, options);
        return options;
      } catch (err) {
        // 上传阶段抛错(取字节 / OSS 失败)→ 标失败并提示原因。
        const reason = sendFailReason(err);
        showToast(reason, { type: "error" });
        failBubble(clientMsgId, reason);
        return null;
      } finally {
        // 临时 blob url(超长文本转 .txt)只属于本次上传单元;成功、失败、早退都要释放。
        // 归属气泡/草稿的附件 url 不带 transientUrl,绝不在此释放,避免误伤预览。
        if (unit.transientUrl) URL.revokeObjectURL(unit.url);
      }
    },
    [chatStoreKey, failBubble],
  );

  const handleSend = useCallback<UseChatActionsResult["handleSend"]>(
    (text, blocks, attachments, replyTo) => {
      const units = buildSendUnits(blocks, attachments);
      // 无可发内容(全空)直接返回;纯文本无 blocks/attachments 时回退单文本单元。
      if (units.length === 0) {
        const trimmed = text.trim();
        if (!trimmed) return;
        units.push(textToSendUnit(trimmed));
      }

      // 各单元独立 clientMsgId(= 本地 id),复用为 request_message_id 幂等键。
      // crypto.randomUUID 保证全局唯一,避免同毫秒连发撞键被后端误去重。
      const clientMsgIds = units.map(() => `local-${crypto.randomUUID()}`);

      // 先按序为每个单元入队乐观气泡(各自独立气泡,status=sending),让用户看到有序排列的多条气泡。
      units.forEach((unit, i) => {
        const clientMsgId = clientMsgIds[i];
        const isText = unit.kind === "text";
        // 附件单元用本地预览 url(blob/data)渲染;落库重读后走 attachmentPreviewUrl。
        const partAttachments: MessageAttachment[] | undefined = isText
          ? undefined
          : [
              {
                type: unit.attachmentType,
                url: unit.url,
                name: unit.name,
                sizeBytes: unit.sizeBytes,
                width: unit.width,
                height: unit.height,
              },
            ];
        const entity: Message & { clientMsgId: string } = {
          id: clientMsgId,
          conversationId: conversation.id,
          direction: "out",
          text: isText ? unit.text : "",
          parts: buildMessageParts(isText ? unit.text : "", undefined, partAttachments),
          sentAt: new Date().toISOString(),
          status: "sending",
          // 仅第一条携带引用(混合消息整体作为对一条消息的回复)。
          replyTo: i === 0 ? replyTo : undefined,
          clientMsgId,
        };
        entity.messageType = isText ? MSG_TYPE_TEXT : unit.messageType;
        if (!isText) {
          entity.fileName = unit.name;
          entity.fileSize = unit.sizeBytes;
        }
        useChatStore.getState().enqueueOptimistic(chatStoreKey, entity);
      });
      wasAtBottomRef.current = true;
      setReplyDraft(null);

      // 编排:附件**上传**无顺序依赖 → 一次性并行启动(墙钟从 Σ(传+发) 降到 max(传)+Σ(发),
      // 多图收益最大);**发送**仍按编辑器顺序串行(企微对端按发送序展示)。遇错即停,剩余气泡
      // 标 failed(可重发)。并行度由实际单元数兜底(聊天单次附件数很小);如需限流后续再加。
      void (async () => {
        // 阶段一:并行启动所有附件单元的上传(与 units 同序;文本单元占位 null)。
        const uploads = units.map((unit, i) =>
          unit.kind === "attachment" ? uploadAttachmentUnit(clientMsgIds[i], unit) : null,
        );

        // 阶段二:按编辑器顺序串行发送;附件只等自己那条上传完成(已在并行进行中)。
        for (let i = 0; i < units.length; i += 1) {
          const unit = units[i];
          const clientMsgId = clientMsgIds[i];
          let ok: boolean;
          if (unit.kind === "text") {
            ok = await deliverMessage(clientMsgId, unit.text);
          } else {
            const options = await uploads[i];
            // 上传失败(已在 uploadAttachmentUnit 内 markFailed)→ 触发 fail-stop。
            ok = options ? await deliverMessage(clientMsgId, "", clientMsgId, options) : false;
          }
          if (!ok) {
            // 当前条失败,停止后续;把未发的气泡标 failed,供用户逐条重发。
            for (let j = i + 1; j < units.length; j += 1) {
              failBubble(clientMsgIds[j], STRINGS.errors.sendFailed);
            }
            break;
          }
        }
      })();
    },
    [
      conversation.id,
      chatStoreKey,
      deliverMessage,
      uploadAttachmentUnit,
      wasAtBottomRef,
      setReplyDraft,
      failBubble,
    ],
  );

  const handleAction = useCallback<UseChatActionsResult["handleAction"]>(
    (action, message) => {
      switch (action) {
        case "resend": {
          const entity = useChatStore.getState().conversations[chatStoreKey]?.byId[message.id];
          // 在途守卫:已在发送中则忽略重复点击,避免并发重发把同一条重复投递。
          if (entity?.status === "sending") break;
          // 幂等键:乐观气泡复用已有 clientMsgId;历史来源失败消息(无 clientMsgId)用其 store id
          // 钉一个稳定键并写回实体——既让后端按同键去重,又让 markSent/markFailed 能按 clientMsgId
          // 收敛回这一条,不再每次重发都新增一条失败气泡。
          const clientMsgId = entity?.clientMsgId ?? message.id;
          const mtForGuard = entity?.messageType ?? message.messageType;
          const filePathForGuard = entity?.filePath ?? message.filePath;
          if (mtForGuard && mtForGuard !== MSG_TYPE_TEXT && !filePathForGuard) {
            showToast(STRINGS.toast.outboxReselectFile, { type: "error" });
            break;
          }
          // 存量损坏行兜底:无 filePath 且文本为空(历史上附件失败行曾被空文本重发覆盖成
          // type=1 + attachments "[]",渲染为「暂不支持」占位)。正常纯文本不可能为空
          // (handleSend 拒发空文本),放行只会发出空文本必败,故同样拦截提示重新选择文件。
          const textForResend = entity?.text ?? message.text;
          if (!filePathForGuard && !textForResend.trim()) {
            showToast(STRINGS.toast.outboxReselectFile, { type: "error" });
            break;
          }
          if (wecomAccountId && externalUserId) {
            void clearOutboxRow({ conversationId: conversation.id, clientMsgId }).catch((e) =>
              console.warn("[outbox] clear_outbox_row 失败(不阻塞)", e),
            );
          }
          useChatStore
            .getState()
            .patchMessage(chatStoreKey, message.id, { status: "sending", clientMsgId });
          // 附件消息(有 filePath):已上传过 OSS,复用 objectName 直接重发,无需重传。
          const filePath = entity?.filePath ?? message.filePath;
          if (filePath) {
            void deliverMessage(message.id, "", clientMsgId, {
              messageType: entity?.messageType ?? message.messageType,
              filePath,
              fileName: entity?.fileName ?? message.fileName,
              fileSize: entity?.fileSize ?? message.fileSize,
              durationSeconds: entity?.durationSeconds ?? message.durationSeconds,
            });
            break;
          }
          // 纯文本重发:与首发一致,文本达到 COMPOSER_MAX_CHARS(企微 2000 字上限)的改为
          // 转 .txt 文件重发(否则企微返回 WECOM_SEND_CONTENT_TOO_LONG 必失败)。
          const unit = textToSendUnit(message.text);
          if (unit.kind === "attachment") {
            // 把失败的长文本气泡就地改写成 txt 文件气泡(预览 + 类型),再上传发送。
            const fileAtt: MessageAttachment = {
              type: "file",
              url: unit.url,
              name: unit.name,
              sizeBytes: unit.sizeBytes,
            };
            useChatStore.getState().patchMessage(chatStoreKey, message.id, {
              text: "",
              parts: buildMessageParts("", undefined, [fileAtt]),
              messageType: unit.messageType,
              fileName: unit.name,
              fileSize: unit.sizeBytes,
            });
            void (async () => {
              const options = await uploadAttachmentUnit(clientMsgId, unit);
              if (options) await deliverMessage(message.id, "", clientMsgId, options);
            })();
            break;
          }
          void deliverMessage(message.id, message.text, clientMsgId);
          break;
        }
        case "delete": {
          // 右键删除高误触(轨迹板右击、误选回车),删除即整条气泡消失,故加二次确认。
          // window.confirm 在本 Tauri WebView 可用(lib/updater.ts 同款用法)。
          if (!window.confirm(STRINGS.contextMenu.deleteConfirm)) break;
          // 记本地删除墓碑:仅从 store 移除会被权威重读补回(切会话/贴底/新消息触发塌缩重建,
          // 本地消息库仍有该行)。墓碑让所有权威数据入口过滤掉它(以本地为主),实现「删了不再
          // 出现」。纯本地视图,不影响企业微信对端与服务端。记下全部 id 形态(覆盖权威 / 收敛后 /
          // 在途乐观三态:权威回显 id 与原乐观 clientMsgId 不同,故 requestMessageId 也要记)。
          const entity = useChatStore.getState().conversations[chatStoreKey]?.byId[message.id];
          markMessageDeleted(chatStoreKey, [
            message.id,
            entity?.clientMsgId,
            entity?.serverId,
            entity?.requestMessageId,
          ]);
          useChatStore.getState().removeMessage(chatStoreKey, message.id);
          // 若引用预览正指向被删消息,发送时 replyTo 会指向不存在的 id
          // → buildTimelineItems 解析不到 replyTarget 静默丢失。同步清空。
          setReplyDraft((draft) => (draft?.id === message.id ? null : draft));
          break;
        }
        case "recall":
          useChatStore
            .getState()
            .patchMessage(chatStoreKey, message.id, { isRecalled: true, status: undefined });
          // 撤回的消息不再适合作为引用对象,同样清空。
          setReplyDraft((draft) => (draft?.id === message.id ? null : draft));
          // TODO(接后端):撤回应调 recall_message IPC,成功才提示、失败走 recallFailed。
          // 当前仅改本地视图、未同步服务端(ChangeNotice 重读权威列表即复活),故用中性
          // info 文案,不承诺「成功」,避免「假成功」反馈误导坐席。
          showToast(STRINGS.toast.recallLocalOnly, { type: "info" });
          break;
        case "copy":
          // Already handled inside MessageContextMenu; this is just telemetry.
          break;
        case "reply":
          setReplyDraft({
            id: message.id,
            conversationId: conversation.id,
            senderName:
              message.direction === "out" ? STRINGS.status.selfSenderName : conversation.name,
            text: messageReplyPreview(message),
          });
          break;
        case "scroll-to":
          // 由 ChatHeader 的内部跳转处理,此处不需要额外动作。
          break;
      }
    },
    [
      deliverMessage,
      uploadAttachmentUnit,
      chatStoreKey,
      conversation.id,
      conversation.name,
      setReplyDraft,
      wecomAccountId,
      externalUserId,
    ],
  );

  return { handleSend, handleAction };
}
