// 客户管理页静态字典数据 ——
//
// 接入真接口后,Customer 列表数据来自 listFriends → adaptFriendToCustomer。
// 本文件只保留三类仍在用的静态常量:
//   - MOCK_FOLLOWERS:批量"移交跟进人"下拉的候选值,等真后台跟进人字典上线再换
//   - TAG_PRESETS:标签编辑器的快捷预设,本地体验用
//   - MOCK_RECENT_MESSAGES:详情侧栏"最近会话"段;接口暂未下发,先沿用本地 mock
//
// 旧 MOCK_CUSTOMERS / MOCK_ACCOUNTS / SEED / BIZ_BY_NAME / EXTRA_BY_NAME 已删,
// 客户列表数据请走 useFriends + adaptFriendToCustomer。

export const MOCK_FOLLOWERS = ["小美", "阿哲", "阿玲", "阿菲", "小贝", "小周", "未分配"] as const;

export const TAG_PRESETS = [
  "重点客户",
  "VIP",
  "高意向",
  "续约",
  "合同已签",
  "新加好友",
  "待回访",
  "黑名单",
] as const;

/** 客户最近会话(最多 N 条),用于详情侧栏的"最近会话"段。接口未下发前先用本地 mock。 */
export interface CustomerRecentMessage {
  customerId: string;
  direction: "in" | "out";
  text: string;
  sentAt: string;
}

export const MOCK_RECENT_MESSAGES: CustomerRecentMessage[] = [];
