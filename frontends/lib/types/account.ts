// 账号是客户的归属主体（一个微信号 / 企微账号 / 客服坐席）。
// 与 Conversation/Customer 中按字符串名引用的旧字段并存——新代码用 Account.id 关联。

export type AvatarColorToken = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface Account {
  id: string;
  /** 显示名，例如 "杭州企微·小美"。 */
  name: string;
  /** 索引到 --wb-avatar-N 的颜色变量；在 chips/列表徽章里用作品牌色点。 */
  colorToken: AvatarColorToken;
  /** 跟进人/坐席名，可选；目前仅在 chips 副标题展示。 */
  ownerName?: string;
}
