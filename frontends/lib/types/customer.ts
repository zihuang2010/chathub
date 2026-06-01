// 客户类型从 messages/data.ts 提到这里，让客户管理页和 messages 页共享。
// 旧字段维持原样；新增字段全部为可选，messages 现有 mock 不填亦能通过类型检查。

export interface CustomerTimelineEntry {
  /** ISO 时间字符串，UI 自行 format。 */
  at: string;
  text: string;
}

/** 客户业务阶段。空值视为未知/新客户。 */
export type CustomerStage =
  | "lead" // 新客户
  | "contacting" // 跟进中
  | "intent" // 意向
  | "negotiating" // 谈单中
  | "deal-won" // 已成交
  | "deal-lost"; // 已流失

/** 客户当前的跟进状态（与业务阶段解耦：阶段=漏斗位置，状态=跟进节奏）。 */
export type FollowUpStatus =
  | "pending" // 待跟进
  | "in-progress" // 跟进中
  | "done"; // 已跟进

/** 客户级别（A/B/C/D）。A 视为重点客户的子集之一。 */
export type CustomerLevel = "A" | "B" | "C" | "D";

/** 客户性别，仅 UI 角标使用。 */
export type CustomerGender = "male" | "female";

export interface Customer {
  /**
   * 列表行唯一键。客户页行存来自 `adaptFriendToCustomer`，因同一外部联系人可被多个企业微信
   * 账号添加而出现多行，故 id 取 `${wecomAccountId}::${externalUserId}` 复合键保证唯一；
   * messages 页 mock 沿用自有 id。**不要再把 id 当作 externalUserId 使用**，详情 API 改用
   * 下面的 externalUserId 字段。
   */
  id: string;
  name: string;
  /** "微信" / "企微" / 等渠道标记。 */
  channel: string;
  /** 旧：账号显示名，messages 页继续用。客户页应优先使用 accountId 关联。 */
  account: string;
  tags: string[];
  remark: string;
  phone: string;
  weChat: string;
  company: string;
  source: string;
  addedAt: string;
  follower: string;

  // ── 客户管理页新增字段（messages mock 不填也合法）─────────────────────────
  /** 与 Account.id 关联；新代码筛选/分组按这个走。 */
  accountId?: string;
  /** 外部联系人原始 id（external_userid）。与 accountId 成组用于好友详情拉取；messages mock 不填。 */
  externalUserId?: string;
  /** 客户头像远程 URL（生产取自 external_avatar）；经 cachedImageSrc 走磁盘缩略图缓存显示。 */
  avatarUrl?: string;
  /** 是否被当前用户星标关注。 */
  starred?: boolean;
  /** 最近一次往来消息的 ISO 时间；为 null 表示从未会话过。 */
  lastContactAt?: string | null;
  /** 列表中"待跟进" Tab 下展示的原因短语，例如 "未回复 6h" / "新分配"。 */
  followUpReason?: string;
  /** 客户轨迹时间轴；按时间倒序展示。 */
  timeline?: CustomerTimelineEntry[];

  // ── 业务进展（详情侧栏「客户状态」卡片用）────────────────────────────────
  /** 业务阶段。 */
  stage?: CustomerStage;
  /** 成交金额（元，CNY）。仅 deal-won 类客户应有值。 */
  dealAmount?: number;
  /** 合同签约时间。可填 ISO 或 "YYYY-MM-DD" / "YYYY-MM-DD HH:mm"。 */
  contractSignedAt?: string;
  /** 下次跟进的计划时间（ISO 或 "YYYY-MM-DD HH:mm"）。 */
  nextFollowUpAt?: string;

  // ── 客户管理页 v2 新增字段（详情面板「客户信息」+ 列表筛选用）────────────
  /** 客户级别。A 视为「重点客户」的强信号之一。 */
  level?: CustomerLevel;
  /** 客户当前跟进状态；与 stage 解耦，可独立筛选。 */
  followUpStatus?: FollowUpStatus;
  /** 性别，仅 UI 头像旁的角标。 */
  gender?: CustomerGender;
  /** 所属行业，例：互联网 / 云计算。 */
  industry?: string;
  /** 所在地区，例：北京市 海淀区。 */
  region?: string;
  /** 详细地址。 */
  address?: string;
  /** 好友 followRemark（微信备注名）；客户卡片「微信」行展示，手机号取不到时的替代联系字段。 */
  followRemark?: string;
}
