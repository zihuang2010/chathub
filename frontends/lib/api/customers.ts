// 好友(客户)API 层 —— 桥接 Tauri `list_friends` 命令到前端 WecomFriend 类型。
//
// **阶段 3:纯 cursor 滚动**
//   链路:UI → invoke("list_friends", { accountIds, cursor, size, externalName, addStartTime, addEndTime })
//        → Tauri:透传单 cursor 跨账号 keyset 请求(不写本地镜像)
//        → 返 { records, hasMore, nextCursor }(每条 record 自带 wecomAccountId 归属)
//   筛选(externalName 按名称模糊匹配 + 加好友时间区间)全部下推服务端;
//   翻页靠 nextCursor;FRIEND_* 推送事件 → ChangeNotice → useFriends 重拉首页。

import { invoke } from "@tauri-apps/api/core";

import type { Customer, CustomerGender } from "@/lib/types/customer";

/**
 * 好友(客户)单条记录(20 字段)。对应 Rust `WecomFriend`,字段顺序与序列化对齐。
 * `wecomAccountId` 是归属字段,单 cursor 跨账号合并时多账号场景每条都能精确对上账号。
 */
export interface WecomFriend {
  /** 归属账号 ID。 */
  wecomAccountId: string;
  /** 归属账号(负责人)显示名。业务后台尚未下发,暂为可选,缺失时 UI 兜底默认值。 */
  wecomAccountName?: string;
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
  /** 视频号来源;业务后台对非视频号好友可能下发 null。 */
  wechatChannelsSource: number | null;
  lastSyncTime: string;
  syncStatus: number;
}

/** listFriends cursor 响应(对应 Rust `ListFriendsResp`,totalMode none)。 */
export interface ListFriendsResponse {
  records: WecomFriend[];
  hasMore: boolean;
  nextCursor: string;
}

export interface FetchFriendsParams {
  /** 跨账号单 cursor keyset:传入需合并的所有账号。空数组时组件层应短路不调用。 */
  accountIds: string[];
  /** 首页 ""(空串);续页填上轮 nextCursor。 */
  cursor?: string;
  /** 每页条数,默认 20,服务端 clamp 到 [1,100]。 */
  size?: number;
  /** 按名称模糊匹配;空 / undefined 不筛选。 */
  externalName?: string;
  /** 加好友时间下界 `yyyy-MM-dd HH:mm:ss`。 */
  addStartTime?: string;
  /** 加好友时间上界 `yyyy-MM-dd HH:mm:ss`。 */
  addEndTime?: string;
}

/**
 * 按多账号 cursor 拉取一页好友。Tauri 端透传单 cursor 跨账号 keyset 请求,不写本地镜像。
 * `accountIds` 为空时不应调用(组件层做短路)。
 */
export async function fetchFriends(params: FetchFriendsParams): Promise<ListFriendsResponse> {
  return invoke<ListFriendsResponse>("list_friends", {
    accountIds: params.accountIds,
    cursor: params.cursor ?? "",
    size: params.size,
    externalName: params.externalName || undefined,
    addStartTime: params.addStartTime || undefined,
    addEndTime: params.addEndTime || undefined,
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
    avatarUrl: friend.externalAvatar || undefined,
    tags: [],
    remark: friend.followDescription || "",
    phone: friend.externalMobile,
    weChat: friend.externalUserId,
    company: friend.externalCorpName || friend.remarkCorpName || "—",
    source: addWayToSource(friend.addWay),
    addedAt: friend.addTime,
    follower: friend.wecomAccountName ?? "",
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

// ─── friend/detail 好友详情 ──────────────────────────────────────────────────

/** 客户标签快照单条(对应 `follow_user.tags`)。 */
export interface FriendTag {
  groupName: string;
  tagName: string;
}

/**
 * 好友详情(对应 Rust `WecomFriendDetail`)。比列表 `WecomFriend` 多出
 * tags / remarkMobiles / syncStatus / operUserid / syncFailReason / gmtModifiedTime 等字段。
 * 注意:详情出参**不含** `wecomAccountId`(入参才有),归属账号由调用方传入。
 */
export interface WecomFriendDetail {
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
  /** 按权限脱敏 */
  externalMobile: string;
  followRemark: string;
  followDescription: string;
  remarkCorpName: string;
  /** `yyyy-MM-dd HH:mm:ss` */
  addTime: string;
  addWay: number;
  followState: string;
  wechatChannelsNickname: string;
  /** 视频号来源;业务后台对非视频号好友可能下发 null。 */
  wechatChannelsSource: number | null;
  lastSyncTime: string;
  /** 0 未同步,1 成功,2 失败 */
  syncStatus: number;
  remarkMobiles: string[];
  tags: FriendTag[];
  operUserid: string;
  syncFailReason: string | null;
  gmtModifiedTime: string;
}

export interface FetchFriendDetailParams {
  wecomAccountId: string;
  externalUserId: string;
  /** 为 true 时打破一天一次的自动刷新限制。 */
  isForceRefresh?: boolean;
}

/** 拉取单个外部联系人的好友详情。Tauri 端透传到业务后台 `/wecomAggregate/friend/detail`。 */
export async function fetchFriendDetail(
  params: FetchFriendDetailParams,
): Promise<WecomFriendDetail> {
  return invoke<WecomFriendDetail>("friend_detail", {
    wecomAccountId: params.wecomAccountId,
    externalUserId: params.externalUserId,
    isForceRefresh: params.isForceRefresh ?? false,
  });
}

/**
 * `WecomFriendDetail` → `Customer`(最小映射,沿用 `adaptFriendToCustomer` 同一套字段策略)。
 * 标签快照取 `tags[].tagName`;备注优先 `followDescription`,回退 `followRemark`。
 * `accountId` 详情不下发,由调用方经 `ctx.accountId` 传入(列表/会话侧已知归属账号)。
 */
export function adaptFriendDetailToCustomer(
  detail: WecomFriendDetail,
  ctx: { accountName: string; accountId?: string },
): Customer {
  const gender: CustomerGender | undefined =
    detail.externalGender === 1 ? "male" : detail.externalGender === 2 ? "female" : undefined;
  return {
    id: detail.externalUserId,
    name: detail.externalName || "(未命名)",
    channel: detail.externalType === 2 ? "企微" : "微信",
    account: ctx.accountName,
    accountId: ctx.accountId,
    avatarUrl: detail.externalAvatar || undefined,
    tags: (detail.tags ?? []).map((t) => t.tagName),
    remark: detail.followDescription || detail.followRemark || "",
    phone: detail.externalMobile,
    weChat: detail.externalUserId,
    company: detail.externalCorpName || detail.remarkCorpName || "—",
    source: addWayToSource(detail.addWay),
    addedAt: detail.addTime,
    follower: "",
    starred: false,
    lastContactAt: null,
    gender,
  };
}
