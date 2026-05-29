// 账号是客户的归属主体（一个微信号 / 企微账号 / 客服坐席）。
// 与 Conversation/Customer 中按字符串名引用的旧字段并存——新代码用 Account.id 关联。

export type AvatarColorToken = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** 账号实时连接状态。对接企微前由 mock 提供，未来由心跳/会话同步派生。 */
export type AccountStatus = "online" | "offline" | "abnormal";

export interface Account {
  id: string;
  /** 显示名，例如 "杭州企微·小美"。 */
  name: string;
  /** 索引到 --wb-avatar-N 的颜色变量；在 chips/列表徽章里用作品牌色点。 */
  colorToken: AvatarColorToken;
  /** 跟进人/坐席名，可选；目前仅在 chips 副标题展示。 */
  ownerName?: string;
  /** 账号实时状态；账号页卡片头像右下角的小点与文案颜色据此映射。 */
  status?: AccountStatus;
  /** 最近一次活跃 ISO 时间；账号页卡片右下角的"X 分钟前"。 */
  lastActiveAt?: string;

  // ── 账号管理页扩展字段（全部 optional，customers 页不依赖） ───────────
  /** 企微别名/备注名（真后端 wecomAlias）；账号卡片第二行展示。 */
  wecomAlias?: string;
  /** 职位（真后端 position）；账号卡片第三行展示。 */
  position?: string;
  /** 方形头像里展示的两字城市标签，如"北京"、"杭州"。 */
  city?: string;
  /** 所属企业全称，如"北京科技有限公司"。 */
  enterprise?: string;
  /** 是否企业认证，true 时名字旁边显示蓝色对勾。 */
  verified?: boolean;
  /** 创建时间（"YYYY-MM-DD HH:mm"）。 */
  createdAt?: string;
  /** 客户总数。 */
  customerCount?: number;
  /** 会话总数。 */
  sessionCount?: number;
  /** 长度 7 的近 7 日活跃趋势：[6天前 … 今天]。 */
  trend7d?: readonly number[];
}
