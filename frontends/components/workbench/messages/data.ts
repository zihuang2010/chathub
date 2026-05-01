// Mock data for the Messages page. Pure types + literals — no JSX, no React imports,
// safe for any consumer. Replace with real backend payloads when the API is wired.

export type ConversationGroup = "today" | "yesterday";

export interface Conversation {
  id: string;
  name: string;
  /** Tailwind/CSS bg color used as avatar background. */
  avatarColor: string;
  preview: string;
  /** The account that received/initiated the conversation, e.g. "杭州企微-小美". */
  account: string;
  /** Display time, e.g. "11:24". */
  time: string;
  unread: number;
  group: ConversationGroup;
  online: boolean;
}

export interface Message {
  id: string;
  conversationId: string;
  direction: "in" | "out";
  text: string;
  /** "10:21" style. */
  time: string;
  /** Only meaningful for outgoing messages. */
  read?: boolean;
}

export interface Customer {
  id: string;
  name: string;
  /** "微信" / "企微" / etc — shown next to the @ in the customer header. */
  channel: string;
  account: string;
  tags: string[];
  remark: string;
  phone: string;
  weChat: string;
  company: string;
  source: string;
  addedAt: string;
  follower: string;
}

export interface QuickReply {
  id: string;
  title: string;
  preview: string;
}

export const MOCK_CONVERSATIONS: Conversation[] = [
  {
    id: "c1",
    name: "王女士",
    avatarColor: "#FCE7B8",
    preview: "好的，我明白了",
    account: "杭州企微-小美",
    time: "11:24",
    unread: 1,
    group: "today",
    online: true,
  },
  {
    id: "c2",
    name: "李先生",
    avatarColor: "#DBEAFE",
    preview: "产品价格是多少？",
    account: "广州企微-小贝",
    time: "11:01",
    unread: 2,
    group: "today",
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
    group: "today",
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
    group: "today",
    online: true,
  },
  {
    id: "c5",
    name: "黄先生",
    avatarColor: "#DCFCE7",
    preview: "好的，那我等下联系您",
    account: "深圳企微-小陈",
    time: "昨天",
    unread: 0,
    group: "yesterday",
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
    group: "yesterday",
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
    group: "yesterday",
    online: false,
  },
];

export const MOCK_MESSAGES_BY_CONVERSATION: Record<string, Message[]> = {
  c1: [
    {
      id: "m1",
      conversationId: "c1",
      direction: "in",
      text: "您好，我想了解一下你们的产品。",
      time: "10:20",
    },
    {
      id: "m2",
      conversationId: "c1",
      direction: "out",
      text: "您好，王女士，很高兴为您服务！",
      time: "10:20",
      read: true,
    },
    {
      id: "m3",
      conversationId: "c1",
      direction: "in",
      text: "你们的产品支持试用吗？",
      time: "10:21",
    },
    {
      id: "m4",
      conversationId: "c1",
      direction: "out",
      text: "支持的，我们可以为您申请 14 天的免费试用，您看可以吗？",
      time: "10:21",
      read: true,
    },
    {
      id: "m5",
      conversationId: "c1",
      direction: "in",
      text: "试用的话需要满足什么条件？",
      time: "10:22",
    },
    {
      id: "m6",
      conversationId: "c1",
      direction: "out",
      text: "只需要您提供企业信息，我们这边为您开通试用权限即可。",
      time: "10:22",
      read: true,
    },
    {
      id: "m7",
      conversationId: "c1",
      direction: "in",
      text: "好的，那我要试用一下。",
      time: "10:24",
    },
  ],
  c2: [
    {
      id: "m1",
      conversationId: "c2",
      direction: "in",
      text: "你们的产品价格是多少？",
      time: "10:55",
    },
    {
      id: "m2",
      conversationId: "c2",
      direction: "out",
      text: "您好，李先生，我们提供多种套餐，可以根据您的需求来推荐。",
      time: "10:56",
      read: true,
    },
    {
      id: "m3",
      conversationId: "c2",
      direction: "in",
      text: "我们大概 20 人团队使用",
      time: "11:01",
    },
  ],
  c3: [
    {
      id: "m1",
      conversationId: "c3",
      direction: "out",
      text: "张总您好，资料已发您邮箱，请查收。",
      time: "10:30",
      read: true,
    },
    {
      id: "m2",
      conversationId: "c3",
      direction: "in",
      text: "好的，谢谢",
      time: "10:48",
    },
  ],
  c4: [
    {
      id: "m1",
      conversationId: "c4",
      direction: "in",
      text: "刚才看了一下方案，挺有意思的。",
      time: "09:30",
    },
    {
      id: "m2",
      conversationId: "c4",
      direction: "out",
      text: "感谢您的反馈，有任何问题随时联系我。",
      time: "09:31",
      read: true,
    },
    {
      id: "m3",
      conversationId: "c4",
      direction: "in",
      text: "收到，我再看看",
      time: "09:32",
    },
  ],
  c5: [
    {
      id: "m1",
      conversationId: "c5",
      direction: "out",
      text: "黄先生您好，方便加个微信吗？",
      time: "昨天 16:20",
      read: true,
    },
    {
      id: "m2",
      conversationId: "c5",
      direction: "in",
      text: "好的，那我等下联系您",
      time: "昨天 16:25",
    },
  ],
  c6: [
    {
      id: "m1",
      conversationId: "c6",
      direction: "out",
      text: "陈女士，您看下这份合同条款是否清晰？",
      time: "昨天 14:00",
      read: true,
    },
    {
      id: "m2",
      conversationId: "c6",
      direction: "in",
      text: "ok，没问题",
      time: "昨天 14:30",
    },
  ],
  c7: [
    {
      id: "m1",
      conversationId: "c7",
      direction: "out",
      text: "吴先生，资料已经发您邮箱了。",
      time: "昨天 11:00",
      read: true,
    },
    {
      id: "m2",
      conversationId: "c7",
      direction: "in",
      text: "谢谢",
      time: "昨天 11:05",
    },
  ],
};

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
