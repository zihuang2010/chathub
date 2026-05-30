// 聊天消息动作处理器(Stage 4d:从 ChatArea 抽出,减负 + 隔离测试)。
//
// 发送 / 重发 / 删除 / 撤回 / 引用 全走 chatStore action(单一真相);乐观气泡入 store,
// 发送结果用 serverId 收敛去重。行为与原 ChatArea 内联实现一致,仅做结构抽取。

import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";

import { showToast } from "@/components/ui/toast";
import type { SendMessageResp } from "@/lib/api/messageHistory";

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

export interface UseChatActionsParams {
  conversation: Conversation;
  onSendMessage?: (text: string, clientMsgId: string) => Promise<SendMessageResp | void>;
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

export function useChatActions({
  conversation,
  onSendMessage,
  wasAtBottomRef,
  setReplyDraft,
}: UseChatActionsParams): UseChatActionsResult {
  // 真发送一条出站消息:把发送时所属会话 id 闭包进来。成功 → markSent 钉 serverId(权威列表
  // 回来时按 serverId 去重收敛,不留重影气泡);失败 → markFailed(供 context menu resend)。
  const deliverMessage = useCallback(
    async (messageId: string, text: string) => {
      // store 按 conversationId 分片,故落在 owningConversationId 切片上即可,无需判当前会话。
      const owningConversationId = conversation.id;
      try {
        // 复用乐观气泡 id 作为 clientMsgId(幂等键),重发时同键不重复。
        const resp = await onSendMessage?.(text, messageId);
        if (resp) {
          useChatStore.getState().markSent(owningConversationId, messageId, resp.localMessageId);
        }
      } catch {
        useChatStore.getState().markFailed(owningConversationId, messageId);
      }
    },
    [conversation.id, onSendMessage],
  );

  const handleSend = useCallback<UseChatActionsResult["handleSend"]>(
    (text, blocks, attachments, replyTo) => {
      // 乐观气泡本地 id,同时复用为 clientMsgId / request_message_id(幂等键)。用
      // crypto.randomUUID 保证全局唯一(与 quickReplies 生成 PK 同源做法),替掉旧的
      // `Date.now()-Math.random().slice(5)`:后者同毫秒连发或 random 退化(如 0.5→"0.5")
      // 时后缀仅剩 1~5 字符,可能撞出同一 requestMessageId → 服务端按同键误去重丢消息。
      const id = `local-${crypto.randomUUID()}`;
      const newMessage: Message = {
        id,
        conversationId: conversation.id,
        direction: "out",
        text,
        parts: buildMessageParts(text, blocks, attachments),
        sentAt: new Date().toISOString(),
        status: "sending",
        replyTo,
      };
      // 乐观气泡入 store(clientMsgId = 本地 id);store 更新经 useMessageHistory 投影回 messages prop。
      useChatStore
        .getState()
        .enqueueOptimistic(conversation.id, { ...newMessage, clientMsgId: id });
      wasAtBottomRef.current = true;
      setReplyDraft(null);
      void deliverMessage(id, text);
    },
    [conversation.id, deliverMessage, wasAtBottomRef, setReplyDraft],
  );

  const handleAction = useCallback<UseChatActionsResult["handleAction"]>(
    (action, message) => {
      switch (action) {
        case "resend":
          useChatStore.getState().patchMessage(conversation.id, message.id, { status: "sending" });
          void deliverMessage(message.id, message.text);
          break;
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
