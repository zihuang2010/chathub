// 好友(客户)API 层 —— 桥接 Tauri `list_friends` 命令到前端 WecomFriend 类型。
//
// **阶段 2:行存全量化**
//   链路:UI → invoke("list_friends", { accountIds, force })
//        → Tauri:行存读;失效则 list_all_friends_for_account 循环拉所有页 → 入库 → 行存读
//        → 返 Vec<WecomFriendRow>(camelCase JSON,带 wecomAccountId 归属)
//   分页 / 筛选 / 排序均**前端本地**(useCustomersFilters);
//   推送事件 → friends_changed 事件 → useFriends refetch(走行存,通常零远程往返)。

import { invoke } from "@tauri-apps/api/core";

import type { Customer, CustomerGender } from "@/lib/types/customer";

/**
 * 好友(客户)行存形态(21 字段)。对应 Rust `WecomFriendRow`,字段顺序与序列化对齐。
 * `wecomAccountId` 是行存归属字段,API 响应不下发但 Tauri 写入时带上 —— 修复"多账号
 * 查询时单条 record 无归属"问题。
 */
export interface WecomFriend {
  /** 归属账号 ID(写入时由 Tauri 层填,API 响应不下发)。 */
  wecomAccountId: string;
  externalUserId: string;
  externalName: string;
  externalPosition: string;
  externalAvatar: string;
  externalCorpName: string;
  externalCorpFullName: string;
  /** 1=微信用户,2=企微用户 */
  externalType: number;
  /** 0=未知 1=男 2=女 */
  externalGender: number;
  /** 已脱敏的手机号,如 "138****1234" */
  externalMobile: string;
  followRemark: string;
  followDescription: string;
  remarkCorpName: string;
  /** `yyyy-MM-dd HH:mm:ss`,服务端本地时区 */
  addTime: string;
  addWay: number;
  followState: string;
  wechatChannelsNickname: string;
  wechatChannelsSource: number;
  lastSyncTime: string;
  syncStatus: number;
}

/**
 * 按多账号拉取好友全量列表。Tauri 端:
 *   - 行存 fresh(未过 10min TTL)→ 直接返
 *   - 失效 / `force=true` → 循环拉所有页 → 入库 → 返
 *
 * `accountIds` 为空时不应调用(组件层做短路);全量化后无 size/current/filter 入参。
 */
export async function fetchFriends(opts: {
  accountIds: string[];
  force?: boolean;
}): Promise<WecomFriend[]> {
  return invoke<WecomFriend[]>("list_friends", {
    accountIds: opts.accountIds,
    force: opts.force,
  });
}

/**
 * `WecomFriend` → 客户管理页 `Customer` 形态。
 *
 * 字段对接策略:
 *   - 直映:externalName/externalAvatar/externalMobile/externalCorpName/followRemark/addTime
 *   - 衍生:channel 来自 externalType,source 来自 addWay,gender 来自 externalGender
 *   - **accountId 直接取 `friend.wecomAccountId`**(行存归属字段),多账号场景每条都有归属,
 *     修复 AccountPicker chip 数字消失问题
 *   - 接口不下发的本地态(tags/starred/follower/stage/dealAmount/timeline 等)给安全默认值
 */
export function adaptFriendToCustomer(friend: WecomFriend, ctx: { accountName: string }): Customer {
  const gender: CustomerGender | undefined =
    friend.externalGender === 1 ? "male" : friend.externalGender === 2 ? "female" : undefined;
  return {
    id: friend.externalUserId,
    name: friend.externalName || "(未命名)",
    channel: friend.externalType === 2 ? "企微" : "微信",
    account: ctx.accountName,
    accountId: friend.wecomAccountId,
    tags: [],
    remark: friend.followDescription || "",
    phone: friend.externalMobile,
    weChat: friend.externalUserId,
    company: friend.externalCorpName || friend.remarkCorpName || "—",
    source: addWayToSource(friend.addWay),
    addedAt: friend.addTime,
    follower: "",
    starred: false,
    lastContactAt: null,
    gender,
  };
}

function addWayToSource(way: number): string {
  switch (way) {
    case 1:
      return "扫码添加";
    case 2:
      return "手机号添加";
    case 3:
      return "微信号添加";
    case 4:
      return "联系我添加";
    case 5:
      return "视频号添加";
    case 6:
      return "群聊添加";
    case 7:
      return "他人介绍";
    case 8:
      return "其他";
    default:
      return "未知渠道";
  }
}
