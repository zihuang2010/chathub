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

export interface Customer {
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
}
