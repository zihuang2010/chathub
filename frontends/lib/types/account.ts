// 账号是客户的归属主体（一个微信号 / 企微账号 / 客服坐席）。
// 与 Conversation/Customer 中按字符串名引用的旧字段并存——新代码用 Account.id 关联。

export type AvatarColorToken = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** 账号实时连接状态。对接企微前由 mock 提供，未来由心跳/会话同步派生。 */
export type AccountStatus = "online" | "offline" | "abnormal";

/** 账号展示名：优先企微别名（wecomAlias），未设置或空串时回退 wecomName。 */
export function accountDisplayName(account: Pick<Account, "name" | "wecomAlias">): string {
  return account.wecomAlias?.trim() || account.name;
}

/**
 * 会话 / 好友行「归属账号」展示名解析：
 *   注册表别名 > 行内别名 > 注册表账号名 > 行内账号名。
 *
 * 账号别名是**账号级**数据，权威源是账号注册表（listMine，account 参数）。各上游接口
 * （recentFriends / list_friends）携带的行内别名只是快照，可能为空、也可能被污染——例如
 * 「发起会话」合成的本地行曾把账号名误写进别名列。故注册表别名优先于行内别名：账号在
 * 可管理列表内时以注册表为准，污染/缺失的行内别名都被覆盖；注册表无此账号（非可管理）
 * 时才回退行内字段。
 */
export function resolveOwnerAccountName(
  rowAlias: string | undefined,
  rowName: string | undefined,
  account?: Pick<Account, "name" | "wecomAlias">,
): string {
  return (
    account?.wecomAlias?.trim() ||
    rowAlias?.trim() ||
    account?.name?.trim() ||
    rowName?.trim() ||
    ""
  );
}

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
