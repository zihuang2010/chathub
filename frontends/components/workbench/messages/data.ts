// Mock data for the Messages page. Pure types + literals — no JSX, no React imports,
// safe for any consumer. Replace with real backend payloads when the API is wired.

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
  /** Optional explicit link to the Customer record; falls back to id-based lookup. */
  customerId?: string;
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
      /** true=随文本内联(composer 富文本);否则按附件大卡渲染。 */
      inline?: boolean;
    }
  | { kind: "file"; url: string; name?: string; sizeBytes?: number }
  | { kind: "voice"; url: string; durationSec?: number }
  | { kind: "video"; url: string; name?: string };

function attachmentToPart(a: MessageAttachment): MessagePart {
  switch (a.type) {
    case "image":
      return { kind: "image", url: a.url, name: a.name, sizeBytes: a.sizeBytes };
    case "file":
      return { kind: "file", url: a.url, name: a.name, sizeBytes: a.sizeBytes };
    case "voice":
      return { kind: "voice", url: a.url, durationSec: a.durationSec };
    case "video":
      return { kind: "video", url: a.url, name: a.name };
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

export const MOCK_CONVERSATIONS: Conversation[] = [
  {
    id: "c1",
    name: "王女士",
    avatarColor: "#FCA5A5",
    preview: "好的，我明白了",
    account: "杭州企微-小美",
    time: "11:24",
    unread: 0,
    online: true,
    pinned: true,
    draftText: "刚才那个方案我想再确认一下时间安排…",
  },
  {
    id: "c2",
    name: "李先生",
    avatarColor: "#DBEAFE",
    preview: "我们大概 20 人团队使用",
    account: "广州企微-小贝",
    time: "11:01",
    unread: 5,
    online: false,
  },
  {
    id: "c3",
    name: "张总",
    avatarColor: "#E0E7FF",
    preview: "好的，谢谢",
    account: "北京企微-小林",
    time: "10:48",
    unread: 0,
    online: false,
  },
  {
    id: "c4",
    name: "刘小姐",
    avatarColor: "#FFE4E6",
    preview: "收到，我再看看",
    account: "上海企微-小雨",
    time: "09:32",
    unread: 0,
    online: true,
    pinned: true,
  },
  {
    id: "c5",
    name: "黄先生",
    avatarColor: "#DCFCE7",
    preview: "好的，那我等下联系您",
    account: "深圳企微-小陈",
    time: "昨天",
    unread: 0,
    online: false,
  },
  {
    id: "c6",
    name: "陈女士",
    avatarColor: "#FEF3C7",
    preview: "ok，没问题",
    account: "杭州企微-小美",
    time: "昨天",
    unread: 0,
    online: false,
  },
  {
    id: "c7",
    name: "吴先生",
    avatarColor: "#E9D5FF",
    preview: "谢谢",
    account: "广州企微-小贝",
    time: "昨天",
    unread: 0,
    online: false,
  },
  {
    id: "c8",
    name: "赵经理",
    avatarColor: "#CCFBF1",
    preview: "我们想先看一下演示环境",
    account: "成都企微-小周",
    time: "昨天",
    unread: 3,
    online: true,
  },
  {
    id: "c9",
    name: "孙女士",
    avatarColor: "#FDE68A",
    preview: "合同能不能今天发我？",
    account: "杭州企微-小美",
    time: "昨天",
    unread: 1,
    online: false,
  },
  {
    id: "c10",
    name: "周老师",
    avatarColor: "#BAE6FD",
    preview: "学生账号可以批量导入吗？",
    account: "南京企微-小唐",
    time: "周二",
    unread: 0,
    online: false,
  },
  {
    id: "c11",
    name: "郑总",
    avatarColor: "#FED7AA",
    preview: "我们下周一内部评审",
    account: "北京企微-小林",
    time: "周二",
    unread: 0,
    online: true,
  },
  {
    id: "c12",
    name: "何小姐",
    avatarColor: "#FBCFE8",
    preview: "可以安排一次线上会议吗？",
    account: "上海企微-小雨",
    time: "周一",
    unread: 2,
    online: true,
  },
  {
    id: "c13",
    name: "林先生",
    avatarColor: "#D9F99D",
    preview: "报价单我已经收到了",
    account: "深圳企微-小陈",
    time: "周一",
    unread: 0,
    online: false,
  },
  {
    id: "c14",
    name: "郭女士",
    avatarColor: "#DDD6FE",
    preview: "这个版本支持私有化部署吗？",
    account: "广州企微-小贝",
    time: "4/28",
    unread: 4,
    online: false,
  },
  {
    id: "c15",
    name: "马总",
    avatarColor: "#FDA4AF",
    preview: "先给我开一个测试账号",
    account: "成都企微-小周",
    time: "4/28",
    unread: 0,
    online: true,
  },
  {
    id: "c16",
    name: "罗先生",
    avatarColor: "#FECACA",
    preview: "接口文档在哪里下载？",
    account: "南京企微-小唐",
    time: "4/27",
    unread: 1,
    online: false,
  },
  {
    id: "c17",
    name: "高女士",
    avatarColor: "#BBF7D0",
    preview: "我们财务需要发票信息",
    account: "杭州企微-小美",
    time: "4/27",
    unread: 0,
    online: false,
  },
  {
    id: "c18",
    name: "唐先生",
    avatarColor: "#FDE2F3",
    preview: "后续培训怎么安排？",
    account: "北京企微-小林",
    time: "4/26",
    unread: 0,
    online: true,
  },
  {
    id: "c19",
    name: "许经理",
    avatarColor: "#C7D2FE",
    preview: "我们先走采购流程",
    account: "上海企微-小雨",
    time: "4/26",
    unread: 0,
    online: false,
  },
  {
    id: "c20",
    name: "冯女士",
    avatarColor: "#F5D0FE",
    preview: "可以把案例资料再发一份吗？",
    account: "广州企微-小贝",
    time: "4/25",
    unread: 0,
    online: false,
  },
];

const RAW_MOCK_MESSAGES: Record<string, Omit<Message, "parts">[]> = {
  c1: [
    {
      id: "m1",
      conversationId: "c1",
      direction: "in",
      text: "您好，我想了解一下你们的产品。",
      sentAt: "2026-05-01T10:20:00+08:00",
    },
    {
      id: "m2",
      conversationId: "c1",
      direction: "out",
      text: "您好，王女士，很高兴为您服务！",
      sentAt: "2026-05-01T10:20:00+08:00",
      status: "sent",
    },
    {
      id: "m3",
      conversationId: "c1",
      direction: "in",
      text: "你们的产品支持试用吗？",
      sentAt: "2026-05-01T10:21:00+08:00",
    },
    {
      id: "m4",
      conversationId: "c1",
      direction: "out",
      text: "支持的，我们可以为您申请 14 天的免费试用，您看可以吗？",
      sentAt: "2026-05-01T10:21:00+08:00",
      status: "sent",
    },
    {
      id: "m5",
      conversationId: "c1",
      direction: "in",
      text: "试用的话需要满足什么条件？",
      sentAt: "2026-05-01T10:22:00+08:00",
    },
    {
      id: "m6",
      conversationId: "c1",
      direction: "out",
      text: "只需要您提供企业信息，我们这边为您开通试用权限即可。",
      sentAt: "2026-05-01T10:22:00+08:00",
      status: "sent",
    },
    {
      id: "m7",
      conversationId: "c1",
      direction: "in",
      text: "好的，那我要试用一下。",
      sentAt: "2026-05-01T10:24:00+08:00",
    },
    {
      id: "m8",
      conversationId: "c1",
      direction: "out",
      text: "好的，我这边为您安排试用申请。",
      sentAt: "2026-05-01T10:25:00+08:00",
      status: "sending",
    },
  ],
  c2: [
    {
      id: "m1",
      conversationId: "c2",
      direction: "in",
      text: "你们的产品价格是多少？",
      sentAt: "2026-05-01T10:55:00+08:00",
    },
    {
      id: "m2",
      conversationId: "c2",
      direction: "out",
      text: "您好，李先生，我们提供多种套餐，可以根据您的需求来推荐。",
      sentAt: "2026-05-01T10:56:00+08:00",
      status: "sent",
    },
    {
      id: "m3",
      conversationId: "c2",
      direction: "in",
      text: "我们大概 20 人团队使用",
      sentAt: "2026-05-01T11:01:00+08:00",
    },
    {
      id: "m4",
      conversationId: "c2",
      direction: "out",
      text: "20 人团队推荐用专业版，每月 ¥199/账号。",
      sentAt: "2026-05-01T11:02:00+08:00",
      status: "failed",
    },
    {
      id: "m5",
      conversationId: "c2",
      direction: "in",
      text: "刚才那条消息我这边没收到回复，方便重发一下吗？",
      sentAt: "2026-05-01T11:08:00+08:00",
    },
    {
      id: "m6",
      conversationId: "c2",
      direction: "out",
      text: "抱歉刚才网络不稳定，这是详细的报价单：标准版 ¥99/账号、专业版 ¥199/账号、企业版面议。",
      sentAt: "2026-05-01T11:09:00+08:00",
      status: "sent",
    },
    {
      id: "m7",
      conversationId: "c2",
      direction: "in",
      text: "了解了，我们再讨论一下。",
      sentAt: "2026-05-01T11:12:00+08:00",
    },
    {
      id: "m8",
      conversationId: "c2",
      direction: "in",
      text: "另外问一下，是否支持私有化部署？",
      sentAt: "2026-05-01T11:15:00+08:00",
    },
    {
      id: "m9",
      conversationId: "c2",
      direction: "in",
      text: "如果支持的话，价格怎么算？",
      sentAt: "2026-05-01T11:15:00+08:00",
    },
    {
      id: "m10",
      conversationId: "c2",
      direction: "in",
      text: "急，最好今天能回复一下，谢谢！",
      sentAt: "2026-05-01T11:18:00+08:00",
    },
  ],
  c3: [
    {
      id: "m1",
      conversationId: "c3",
      direction: "out",
      text: "张总您好，资料已发您邮箱，请查收。",
      sentAt: "2026-05-01T10:30:00+08:00",
      status: "sent",
    },
    {
      id: "m2",
      conversationId: "c3",
      direction: "in",
      text: "好的，谢谢",
      sentAt: "2026-05-01T10:48:00+08:00",
    },
    {
      id: "m3",
      conversationId: "c3",
      direction: "out",
      text: "另外补充一份案例文档，方便您内部评审。",
      sentAt: "2026-05-01T10:50:00+08:00",
      status: "sent",
      replyTo: "m2",
    },
  ],
  c4: [
    {
      id: "m1",
      conversationId: "c4",
      direction: "in",
      text: "刚才看了一下方案，挺有意思的。",
      sentAt: "2026-05-01T09:30:00+08:00",
    },
    {
      id: "m2",
      conversationId: "c4",
      direction: "out",
      text: "感谢您的反馈，有任何问题随时联系我。",
      sentAt: "2026-05-01T09:31:00+08:00",
      status: "sent",
    },
    {
      id: "m3",
      conversationId: "c4",
      direction: "in",
      text: "收到，我再看看",
      sentAt: "2026-05-01T09:32:00+08:00",
    },
    {
      id: "m4",
      conversationId: "c4",
      direction: "out",
      text: "方便的话直接戳 https://chat.example.com/demo @小雨 帮您打开演示 :rocket:",
      sentAt: "2026-05-01T09:33:00+08:00",
      status: "sent",
      mentions: ["小雨"],
    },
  ],
  c5: [
    {
      id: "m1",
      conversationId: "c5",
      direction: "out",
      text: "黄先生您好，方便加个微信吗？",
      sentAt: "2026-04-30T16:20:00+08:00",
      status: "sent",
    },
    {
      id: "m2",
      conversationId: "c5",
      direction: "in",
      text: "好的，那我等下联系您",
      sentAt: "2026-04-30T16:25:00+08:00",
    },
  ],
  c6: [
    {
      id: "m1",
      conversationId: "c6",
      direction: "out",
      text: "陈女士，您看下这份合同条款是否清晰？",
      sentAt: "2026-04-30T14:00:00+08:00",
      status: "sent",
    },
    {
      id: "m2",
      conversationId: "c6",
      direction: "in",
      text: "ok，没问题",
      sentAt: "2026-04-30T14:30:00+08:00",
    },
  ],
  c7: [
    {
      id: "m1",
      conversationId: "c7",
      direction: "out",
      text: "吴先生，资料已经发您邮箱了。",
      sentAt: "2026-04-30T11:00:00+08:00",
      status: "sent",
    },
    {
      id: "m2",
      conversationId: "c7",
      direction: "in",
      text: "谢谢",
      sentAt: "2026-04-30T11:05:00+08:00",
    },
  ],
  c8: [
    {
      id: "m1",
      conversationId: "c8",
      direction: "in",
      text: "我们想先看一下演示环境，方便今天开通吗？",
      sentAt: "2026-04-30T17:05:00+08:00",
    },
    {
      id: "m2",
      conversationId: "c8",
      direction: "out",
      text: "可以的，赵经理，我这边先为您创建演示账号。",
      sentAt: "2026-04-30T17:08:00+08:00",
      status: "sent",
    },
    {
      id: "m3",
      conversationId: "c8",
      direction: "in",
      text: "好的，最好能带一些示例数据。",
      sentAt: "2026-04-30T17:12:00+08:00",
    },
  ],
  c9: [
    {
      id: "m1",
      conversationId: "c9",
      direction: "in",
      text: "合同能不能今天发我？我们法务想先看一下。",
      sentAt: "2026-04-30T15:40:00+08:00",
    },
    {
      id: "m2",
      conversationId: "c9",
      direction: "out",
      text: "没问题，我整理好版本后发您邮箱。",
      sentAt: "2026-04-30T15:44:00+08:00",
      status: "sent",
    },
  ],
  c10: [
    {
      id: "m1",
      conversationId: "c10",
      direction: "in",
      text: "学生账号可以批量导入吗？",
      sentAt: "2026-04-28T18:10:00+08:00",
    },
    {
      id: "m2",
      conversationId: "c10",
      direction: "out",
      text: "支持批量导入，也可以通过模板校验字段。",
      sentAt: "2026-04-28T18:15:00+08:00",
      status: "sent",
    },
  ],
  c11: [
    {
      id: "m1",
      conversationId: "c11",
      direction: "out",
      text: "郑总，评审材料我已同步到群里。",
      sentAt: "2026-04-28T16:30:00+08:00",
      status: "sent",
    },
    {
      id: "m2",
      conversationId: "c11",
      direction: "in",
      text: "我们下周一内部评审。",
      sentAt: "2026-04-28T16:42:00+08:00",
    },
  ],
  c12: [
    {
      id: "m1",
      conversationId: "c12",
      direction: "in",
      text: "可以安排一次线上会议吗？我想让同事一起听。",
      sentAt: "2026-04-27T14:20:00+08:00",
    },
    {
      id: "m2",
      conversationId: "c12",
      direction: "out",
      text: "可以，您看明天下午三点是否方便？",
      sentAt: "2026-04-27T14:22:00+08:00",
      status: "sent",
    },
  ],
  c13: [
    {
      id: "m1",
      conversationId: "c13",
      direction: "out",
      text: "报价单已发送，请您查收。",
      sentAt: "2026-04-27T11:00:00+08:00",
      status: "sent",
    },
    {
      id: "m2",
      conversationId: "c13",
      direction: "in",
      text: "报价单我已经收到了。",
      sentAt: "2026-04-27T11:18:00+08:00",
    },
  ],
  c14: [
    {
      id: "m1",
      conversationId: "c14",
      direction: "in",
      text: "这个版本支持私有化部署吗？",
      sentAt: "2026-04-28T19:01:00+08:00",
    },
    {
      id: "m2",
      conversationId: "c14",
      direction: "out",
      text: "支持，我们可以根据服务器环境提供部署方案。",
      sentAt: "2026-04-28T19:06:00+08:00",
      status: "sent",
    },
  ],
  c15: [
    {
      id: "m1",
      conversationId: "c15",
      direction: "in",
      text: "先给我开一个测试账号。",
      sentAt: "2026-04-28T10:12:00+08:00",
    },
    {
      id: "m2",
      conversationId: "c15",
      direction: "out",
      text: "好的，马总，我这边马上处理。",
      sentAt: "2026-04-28T10:14:00+08:00",
      status: "sent",
    },
  ],
  c16: [
    {
      id: "m1",
      conversationId: "c16",
      direction: "in",
      text: "接口文档在哪里下载？",
      sentAt: "2026-04-27T20:30:00+08:00",
    },
    {
      id: "m2",
      conversationId: "c16",
      direction: "out",
      text: "我发您一份最新版文档链接，里面包含鉴权和回调说明。",
      sentAt: "2026-04-27T20:35:00+08:00",
      status: "sent",
    },
  ],
  c17: [
    {
      id: "m1",
      conversationId: "c17",
      direction: "in",
      text: "我们财务需要发票信息。",
      sentAt: "2026-04-27T13:22:00+08:00",
    },
    {
      id: "m2",
      conversationId: "c17",
      direction: "out",
      text: "可以，我稍后把开票资料清单发给您。",
      sentAt: "2026-04-27T13:25:00+08:00",
      status: "sent",
    },
  ],
  c18: [
    {
      id: "m1",
      conversationId: "c18",
      direction: "in",
      text: "后续培训怎么安排？",
      sentAt: "2026-04-26T17:45:00+08:00",
    },
    {
      id: "m2",
      conversationId: "c18",
      direction: "out",
      text: "上线前我们会安排一次管理员培训和一次业务培训。",
      sentAt: "2026-04-26T17:52:00+08:00",
      status: "sent",
    },
  ],
  c19: [
    {
      id: "m1",
      conversationId: "c19",
      direction: "out",
      text: "采购流程中如果需要资质文件，我可以一起提供。",
      sentAt: "2026-04-26T09:18:00+08:00",
      status: "sent",
    },
    {
      id: "m2",
      conversationId: "c19",
      direction: "in",
      text: "我们先走采购流程。",
      sentAt: "2026-04-26T09:25:00+08:00",
    },
  ],
  c20: [
    {
      id: "m1",
      conversationId: "c20",
      direction: "in",
      text: "可以把案例资料再发一份吗？",
      sentAt: "2026-04-25T16:08:00+08:00",
    },
    {
      id: "m2",
      conversationId: "c20",
      direction: "out",
      text: "可以，我会补充几份同行业案例给您参考。",
      sentAt: "2026-04-25T16:12:00+08:00",
      status: "sent",
    },
  ],
};

// RAW_MOCK_MESSAGES 为纯文本演示数据(当前无消费者,见 useChatMessages 注释);统一补
// parts 以满足 Message 类型。可在后续清理中整体删除。
export const MOCK_MESSAGES_BY_CONVERSATION: Record<string, Message[]> = Object.fromEntries(
  Object.entries(RAW_MOCK_MESSAGES).map(([id, msgs]) => [
    id,
    msgs.map((m) => ({ ...m, parts: buildMessageParts(m.text) })),
  ]),
);

export const MOCK_CUSTOMERS_BY_CONVERSATION: Record<string, Customer> = {
  c1: {
    id: "cu1",
    name: "王女士",
    channel: "微信",
    account: "杭州企微-小美（企微）",
    tags: [],
    remark: "王女士",
    phone: "138 **** 1234",
    weChat: "wangs1234",
    company: "杭州某某科技有限公司",
    source: "微信搜索",
    addedAt: "2024-05-20 10:15",
    follower: "张小明",
  },
  c2: {
    id: "cu2",
    name: "李先生",
    channel: "微信",
    account: "广州企微-小贝（企微）",
    tags: ["重点客户"],
    remark: "20 人团队",
    phone: "139 **** 5678",
    weChat: "li_xiansheng",
    company: "广州贝壳信息有限公司",
    source: "公司官网",
    addedAt: "2024-05-18 09:42",
    follower: "李小红",
  },
  c3: {
    id: "cu3",
    name: "张总",
    channel: "微信",
    account: "北京企微-小林（企微）",
    tags: ["VIP"],
    remark: "对接人 张总",
    phone: "186 **** 7777",
    weChat: "zhangzong",
    company: "北京云途科技",
    source: "客户介绍",
    addedAt: "2024-04-30 15:01",
    follower: "张小明",
  },
  c4: {
    id: "cu4",
    name: "刘小姐",
    channel: "微信",
    account: "上海企微-小雨（企微）",
    tags: [],
    remark: "看了方案，待跟进",
    phone: "133 **** 2024",
    weChat: "liu_x",
    company: "上海星河文化",
    source: "线下活动",
    addedAt: "2024-05-22 09:00",
    follower: "周小川",
  },
  c5: {
    id: "cu5",
    name: "黄先生",
    channel: "微信",
    account: "深圳企微-小陈（企微）",
    tags: [],
    remark: "联系电话沟通",
    phone: "188 **** 0001",
    weChat: "huang_sir",
    company: "深圳鹏程信息",
    source: "电话拓客",
    addedAt: "2024-05-19 16:18",
    follower: "陈大力",
  },
  c6: {
    id: "cu6",
    name: "陈女士",
    channel: "微信",
    account: "杭州企微-小美（企微）",
    tags: ["合同已签"],
    remark: "合同条款已确认",
    phone: "150 **** 0202",
    weChat: "chenms",
    company: "杭州友创科技",
    source: "客户介绍",
    addedAt: "2024-05-16 14:00",
    follower: "张小明",
  },
  c7: {
    id: "cu7",
    name: "吴先生",
    channel: "微信",
    account: "广州企微-小贝（企微）",
    tags: [],
    remark: "已发资料",
    phone: "189 **** 6363",
    weChat: "wu_x",
    company: "广州海舟科技",
    source: "公司官网",
    addedAt: "2024-05-12 11:00",
    follower: "李小红",
  },
  c8: {
    id: "cu8",
    name: "赵经理",
    channel: "微信",
    account: "成都企微-小周（企微）",
    tags: ["演示中"],
    remark: "需要演示环境",
    phone: "181 **** 4520",
    weChat: "zhao_manager",
    company: "成都云栈科技",
    source: "渠道推荐",
    addedAt: "2024-05-21 17:05",
    follower: "周小舟",
  },
  c9: {
    id: "cu9",
    name: "孙女士",
    channel: "微信",
    account: "杭州企微-小美（企微）",
    tags: ["合同中"],
    remark: "法务审核合同",
    phone: "137 **** 9081",
    weChat: "sun_ms",
    company: "杭州星图贸易",
    source: "官网咨询",
    addedAt: "2024-05-21 15:40",
    follower: "张小明",
  },
  c10: {
    id: "cu10",
    name: "周老师",
    channel: "微信",
    account: "南京企微-小唐（企微）",
    tags: ["教育行业"],
    remark: "关注账号批量导入",
    phone: "136 **** 1100",
    weChat: "zhou_teacher",
    company: "南京明德培训学校",
    source: "线下活动",
    addedAt: "2024-05-20 18:10",
    follower: "唐小北",
  },
  c11: {
    id: "cu11",
    name: "郑总",
    channel: "微信",
    account: "北京企微-小林（企微）",
    tags: ["待评审"],
    remark: "下周一内部评审",
    phone: "185 **** 2211",
    weChat: "zheng_ceo",
    company: "北京启明数科",
    source: "客户介绍",
    addedAt: "2024-05-20 16:30",
    follower: "林小凡",
  },
  c12: {
    id: "cu12",
    name: "何小姐",
    channel: "微信",
    account: "上海企微-小雨（企微）",
    tags: ["待会议"],
    remark: "希望多人参加线上会议",
    phone: "132 **** 7721",
    weChat: "he_miss",
    company: "上海橙禾传媒",
    source: "广告投放",
    addedAt: "2024-05-19 14:20",
    follower: "周小川",
  },
  c13: {
    id: "cu13",
    name: "林先生",
    channel: "微信",
    account: "深圳企微-小陈（企微）",
    tags: [],
    remark: "已收报价单",
    phone: "188 **** 2431",
    weChat: "lin_sir",
    company: "深圳海棠科技",
    source: "电话拓客",
    addedAt: "2024-05-19 11:00",
    follower: "陈大力",
  },
  c14: {
    id: "cu14",
    name: "郭女士",
    channel: "微信",
    account: "广州企微-小贝（企微）",
    tags: ["私有化"],
    remark: "关注私有化部署",
    phone: "135 **** 6688",
    weChat: "guo_ms",
    company: "广州南岭制造",
    source: "行业展会",
    addedAt: "2024-05-18 19:01",
    follower: "李小红",
  },
  c15: {
    id: "cu15",
    name: "马总",
    channel: "微信",
    account: "成都企微-小周（企微）",
    tags: ["测试账号"],
    remark: "需要测试账号",
    phone: "139 **** 3309",
    weChat: "ma_ceo",
    company: "成都万象商业",
    source: "渠道推荐",
    addedAt: "2024-05-18 10:12",
    follower: "周小舟",
  },
  c16: {
    id: "cu16",
    name: "罗先生",
    channel: "微信",
    account: "南京企微-小唐（企微）",
    tags: ["技术对接"],
    remark: "需要接口文档",
    phone: "177 **** 8890",
    weChat: "luo_dev",
    company: "南京云帆软件",
    source: "开发者社区",
    addedAt: "2024-05-17 20:30",
    follower: "唐小北",
  },
  c17: {
    id: "cu17",
    name: "高女士",
    channel: "微信",
    account: "杭州企微-小美（企微）",
    tags: ["财务对接"],
    remark: "需要发票资料",
    phone: "151 **** 8032",
    weChat: "gao_finance",
    company: "杭州启航服务",
    source: "客户介绍",
    addedAt: "2024-05-17 13:22",
    follower: "张小明",
  },
  c18: {
    id: "cu18",
    name: "唐先生",
    channel: "微信",
    account: "北京企微-小林（企微）",
    tags: ["培训咨询"],
    remark: "关注上线培训",
    phone: "180 **** 4301",
    weChat: "tang_ops",
    company: "北京智联运营",
    source: "官网咨询",
    addedAt: "2024-05-16 17:45",
    follower: "林小凡",
  },
  c19: {
    id: "cu19",
    name: "许经理",
    channel: "微信",
    account: "上海企微-小雨（企微）",
    tags: ["采购流程"],
    remark: "客户内部采购中",
    phone: "152 **** 1130",
    weChat: "xu_manager",
    company: "上海诚汇供应链",
    source: "行业社群",
    addedAt: "2024-05-16 09:18",
    follower: "周小川",
  },
  c20: {
    id: "cu20",
    name: "冯女士",
    channel: "微信",
    account: "广州企微-小贝（企微）",
    tags: ["案例资料"],
    remark: "需要同行业案例",
    phone: "156 **** 2198",
    weChat: "feng_ms",
    company: "广州青木设计",
    source: "朋友圈广告",
    addedAt: "2024-05-15 16:08",
    follower: "李小红",
  },
};

export const MOCK_QUICK_REPLIES: QuickReply[] = [
  {
    id: "q1",
    title: "产品介绍",
    preview: "您好，我们的产品是一款帮助企业...",
  },
  {
    id: "q2",
    title: "价格相关",
    preview: "我们的产品提供多种版本，具体价格...",
  },
  {
    id: "q3",
    title: "试用说明",
    preview: "我们支持 14 天免费试用，您只需...",
  },
  {
    id: "q4",
    title: "结束语",
    preview: "如果您还有其他问题，随时联系我...",
  },
];
