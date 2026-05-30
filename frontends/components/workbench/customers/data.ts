// 客户管理页静态字典数据 ——
//
// 接入真接口后,Customer 列表数据来自 listFriends → adaptFriendToCustomer。
// 本文件只保留 TAG_PRESETS:标签编辑器的快捷预设,本地体验用。
//
// 旧 MOCK_CUSTOMERS / MOCK_ACCOUNTS / SEED / BIZ_BY_NAME / EXTRA_BY_NAME / MOCK_FOLLOWERS 已删,
// 客户列表数据请走 useFriends + adaptFriendToCustomer;移交跟进人候选待真后台字典上线再接。

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
