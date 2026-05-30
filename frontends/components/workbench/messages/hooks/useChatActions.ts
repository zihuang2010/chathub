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
import { uploadAttachment, type SendMessageResp } from "@/lib/api/messageHistory";

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
import { STRINGS } from "../strings";
import { messageReplyPreview } from "../utils";

export type ReplyDraft = ReplyTarget & { id: string; conversationId: string };

/** 发送附件时携带的扩展字段:messageType + 上传后的 OSS objectName 等。 */
export interface SendMessageOptions {
  messageType?: number;
  filePath?: string;
  fileName?: string;
  fileSize?: number;
}

export interface UseChatActionsParams {
  conversation: Conversation;
  onSendMessage?: (
    text: string,
    clientMsgId: string,
    options?: SendMessageOptions,
  ) => Promise<SendMessageResp | void>;
  /** 发送后强制贴底跟随(写 ChatArea 的滚动 ref)。 */
  wasAtBottomRef: MutableRefObject<boolean>;
  setReplyDraft: Dispatch<SetStateAction<ReplyDraft | null>>;
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
        if (value) units.push({ kind: "text", text: value });
      } else if (block.type === "image" && block.url) {
        units.push({
          kind: "attachment",
          messageType: MSG_TYPE_IMAGE,
          attachmentType: "image",
          url: block.url,
          name: block.name ?? "image",
          sizeBytes: block.sizeBytes,
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

export function useChatActions({
  conversation,
  onSendMessage,
  wasAtBottomRef,
  setReplyDraft,
}: UseChatActionsParams): UseChatActionsResult {
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
      // store 按 conversationId 分片,故落在 owningConversationId 切片上即可,无需判当前会话。
      const owningConversationId = conversation.id;
      try {
        const resp = options
          ? await onSendMessage?.(text, clientMsgId, options)
          : await onSendMessage?.(text, clientMsgId);
        if (resp) {
          useChatStore.getState().markSent(owningConversationId, clientMsgId, resp.localMessageId);
        }
        return true;
      } catch {
        useChatStore.getState().markFailed(owningConversationId, clientMsgId);
        return false;
      }
    },
    [conversation.id, onSendMessage],
  );

  // 发送一个附件单元:先 fetch 本地预览取字节 → uploadAttachment 拿 objectName →
  // 回写 objectName 到气泡(供重发复用)→ deliverMessage 发送。任一步抛错即视为失败。
  const deliverAttachmentUnit = useCallback(
    async (clientMsgId: string, unit: Extract<SendUnit, { kind: "attachment" }>) => {
      const owningConversationId = conversation.id;
      try {
        const bytes = await fetchBytes(unit.url);
        const uploaded = await uploadAttachment({
          bytes,
          fileName: unit.name,
          fileSuf: inferFileSuf(unit.name, unit.url),
          contentType: inferContentType(unit.name, unit.url),
        });
        // 回写已上传信息到气泡,便于失败重发复用 objectName、不再重传 OSS。
        useChatStore.getState().patchMessage(owningConversationId, clientMsgId, {
          messageType: unit.messageType,
          filePath: uploaded.objectName,
          fileName: uploaded.fileName,
          fileSize: uploaded.fileSize,
        });
        return await deliverMessage(clientMsgId, "", clientMsgId, {
          messageType: unit.messageType,
          filePath: uploaded.objectName,
          fileName: uploaded.fileName,
          fileSize: uploaded.fileSize,
        });
      } catch {
        // 上传阶段抛错(取字节 / OSS 失败)→ 标失败。发送阶段失败已在 deliverMessage 内标过。
        useChatStore.getState().markFailed(owningConversationId, clientMsgId);
        return false;
      }
    },
    [conversation.id, deliverMessage],
  );

  const handleSend = useCallback<UseChatActionsResult["handleSend"]>(
    (text, blocks, attachments, replyTo) => {
      const units = buildSendUnits(blocks, attachments);
      // 无可发内容(全空)直接返回;纯文本无 blocks/attachments 时回退单文本单元。
      if (units.length === 0) {
        const trimmed = text.trim();
        if (!trimmed) return;
        units.push({ kind: "text", text: trimmed });
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
        useChatStore.getState().enqueueOptimistic(conversation.id, entity);
      });
      wasAtBottomRef.current = true;
      setReplyDraft(null);

      // 串行编排:await 上一条成功再发下一条;遇错即停,剩余未发气泡标 failed(可重发)。
      void (async () => {
        for (let i = 0; i < units.length; i += 1) {
          const unit = units[i];
          const clientMsgId = clientMsgIds[i];
          const ok =
            unit.kind === "text"
              ? await deliverMessage(clientMsgId, unit.text)
              : await deliverAttachmentUnit(clientMsgId, unit);
          if (!ok) {
            // 当前条失败,停止后续;把未发的气泡标 failed,供用户逐条重发。
            for (let j = i + 1; j < units.length; j += 1) {
              useChatStore.getState().markFailed(conversation.id, clientMsgIds[j]);
            }
            break;
          }
        }
      })();
    },
    [conversation.id, deliverMessage, deliverAttachmentUnit, wasAtBottomRef, setReplyDraft],
  );

  const handleAction = useCallback<UseChatActionsResult["handleAction"]>(
    (action, message) => {
      switch (action) {
        case "resend": {
          const entity = useChatStore.getState().conversations[conversation.id]?.byId[message.id];
          // 在途守卫:已在发送中则忽略重复点击,避免并发重发把同一条重复投递。
          if (entity?.status === "sending") break;
          // 幂等键:乐观气泡复用已有 clientMsgId;历史来源失败消息(无 clientMsgId)用其 store id
          // 钉一个稳定键并写回实体——既让后端按同键去重,又让 markSent/markFailed 能按 clientMsgId
          // 收敛回这一条,不再每次重发都新增一条失败气泡。
          const clientMsgId = entity?.clientMsgId ?? message.id;
          useChatStore
            .getState()
            .patchMessage(conversation.id, message.id, { status: "sending", clientMsgId });
          // 附件消息(有 filePath):已上传过 OSS,复用 objectName 直接重发,无需重传。
          const filePath = entity?.filePath ?? message.filePath;
          if (filePath) {
            void deliverMessage(message.id, "", clientMsgId, {
              messageType: entity?.messageType ?? message.messageType,
              filePath,
              fileName: entity?.fileName ?? message.fileName,
              fileSize: entity?.fileSize ?? message.fileSize,
            });
            break;
          }
          // 纯文本走原逻辑。
          void deliverMessage(message.id, message.text, clientMsgId);
          break;
        }
        case "delete":
          useChatStore.getState().removeMessage(conversation.id, message.id);
          // 若引用预览正指向被删消息,发送时 replyTo 会指向不存在的 id
          // → buildTimelineItems 解析不到 replyTarget 静默丢失。同步清空。
          setReplyDraft((draft) => (draft?.id === message.id ? null : draft));
          break;
        case "recall":
          useChatStore
            .getState()
            .patchMessage(conversation.id, message.id, { isRecalled: true, status: undefined });
          // 撤回的消息不再适合作为引用对象,同样清空。
          setReplyDraft((draft) => (draft?.id === message.id ? null : draft));
          showToast(STRINGS.toast.recallSuccess, { type: "success" });
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
    [deliverMessage, conversation.id, conversation.name, setReplyDraft],
  );

  return { handleSend, handleAction };
}
