// 时间线派生(Stage 4d:从 ChatArea 抽出,纯派生无副作用)。
//
// 输入本会话消息 + 会话,产出渲染用的 TimelineItem[](日期分隔 / 未读分隔 / 消息气泡)。
// 未读分隔「边界」在进入会话那一刻按 unread 快照冻结一次,会话内不随尾部漂移(主流 IM
// 语义:分隔条标记「上次读到哪」)。全部为渲染期 ref 冻结 + useMemo,无 effect、无 setState。

import { useMemo, useState } from "react";

import { TIME_BURST_GAP_MS } from "../constants";
import type { Conversation, Message } from "../data";
import type { ReplyTarget } from "../MessageBubble";
import { STRINGS } from "../strings";
import { formatMessageDate, getMessageDayKey, messageReplyPreview } from "../utils";

export type TimelineItem =
  | { type: "date-divider"; id: string; label: string }
  | { type: "unread-divider"; id: string; count: number }
  | {
      type: "message";
      id: string;
      message: Message;
      replyTarget?: ReplyTarget;
      /** First message of a same-sender burst — gets extra top margin so
       *  consecutive messages from the same person feel grouped. */
      isFirstInBurst: boolean;
    };

function buildTimelineItems(
  messages: Message[],
  conversation: Conversation,
  unreadAnchorId: string | null,
  unreadCount: number,
): TimelineItem[] {
  const items: TimelineItem[] = [];
  const messagesById = new Map(messages.map((message) => [message.id, message]));
  let previousDayKey: string | null = null;

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];

    const dayKey = getMessageDayKey(message.sentAt);
    if (dayKey !== previousDayKey) {
      items.push({
        type: "date-divider",
        id: `date-${dayKey}-${message.id}`,
        label: formatMessageDate(message.sentAt),
      });
      previousDayKey = dayKey;
    }

    if (unreadCount > 0 && message.id === unreadAnchorId) {
      items.push({ type: "unread-divider", id: "unread-divider", count: unreadCount });
    }

    let replyTarget: ReplyTarget | undefined;
    if (message.replyTo) {
      const replied = messagesById.get(message.replyTo);
      if (replied) {
        replyTarget = {
          senderName:
            replied.direction === "out" ? STRINGS.status.selfSenderName : conversation.name,
          text: messageReplyPreview(replied),
        };
      }
    }

    const prev = messages[i - 1];
    const isFirstInBurst =
      !prev ||
      prev.direction !== message.direction ||
      new Date(message.sentAt).getTime() - new Date(prev.sentAt).getTime() > TIME_BURST_GAP_MS;

    items.push({
      type: "message",
      id: message.id,
      message,
      replyTarget,
      isFirstInBurst,
    });
  }

  return items;
}

export const buildTimelineItemsForTest = buildTimelineItems;

export function useChatTimeline({
  localMessages,
  conversation,
}: {
  localMessages: Message[];
  conversation: Conversation;
}): TimelineItem[] {
  // 未读分隔「边界」按会话冻结:进入会话那一刻的 unread 快照(标已读会异步把 live
  // conversation.unread 清零,故必须在打开时捕获)推出锚点 —— 从消息尾部反数 N 条 in
  // 方向消息,取最早那条。一旦定下会话内不再随尾部漂移(主流 IM:分隔条标记「上次读到哪」)。
  //
  // 后端 records 无逐条 read 状态,消息又异步到达,故:切会话先记快照、锚点待 localMessages
  // 首次非空再定一次。用 React 官方「渲染期存上一帧信息」(useState)模式而非 ref,避免
  // 渲染期读写 ref;setState 在渲染期被 React 丢弃当前渲染并立即重渲染,条件收敛不死循环。
  const [frozen, setFrozen] = useState<{
    convId: string;
    resolved: boolean;
    snapshot: number;
    anchorId: string | null;
    count: number;
  }>({ convId: "", resolved: false, snapshot: 0, anchorId: null, count: 0 });

  if (frozen.convId !== conversation.id) {
    // 切会话:记下打开时的 unread 快照;锚点待本会话消息非空再定。
    setFrozen({
      convId: conversation.id,
      resolved: false,
      snapshot: conversation.unread ?? 0,
      anchorId: null,
      count: 0,
    });
  } else if (!frozen.resolved && localMessages.length > 0) {
    let anchorId: string | null = null;
    let count = 0;
    for (let i = localMessages.length - 1; i >= 0 && count < frozen.snapshot; i--) {
      if (localMessages[i].direction === "in") {
        anchorId = localMessages[i].id;
        count++;
      }
    }
    setFrozen((f) => ({ ...f, resolved: true, anchorId, count }));
  }

  const onConversation = frozen.convId === conversation.id;
  const unreadAnchorId = onConversation ? frozen.anchorId : null;
  const unreadDividerCount = onConversation ? frozen.count : 0;

  return useMemo(
    () => buildTimelineItems(localMessages, conversation, unreadAnchorId, unreadDividerCount),
    [localMessages, conversation, unreadAnchorId, unreadDividerCount],
  );
}
