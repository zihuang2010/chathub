import {
  BarChart3,
  Calendar,
  LayoutGrid,
  type LucideProps,
  MessageSquare,
  MessagesSquare,
  Settings,
  UserRound,
  Users,
} from "lucide-react";
import type { ComponentType } from "react";

export type Section =
  | "messages"
  | "customers"
  | "accounts"
  | "groups"
  | "schedule"
  | "stats"
  | "apps"
  | "settings";

export interface NavItem {
  value: Section;
  label: string;
  Icon: ComponentType<LucideProps>;
  badge?: number;
}

/**
 * 跨页「发起会话」一次性意图:客户页点「发起会话」→ Workbench 暂存 + 切到消息页 →
 * 消息页消费后调 open_friend_conversation 取/建会话并选中(新旧会话同一路径,判断交给后端)。
 * 字段即 openFriendConversation 所需的客户身份;wecomName/wecomAlias 由消息页按
 * wecomAccountId 反查 accounts(与搜索框打开会话一致),故不在此。
 */
export interface PendingOpenConversation {
  wecomAccountId: string;
  externalUserId: string;
  externalName: string;
  externalAvatar: string;
  externalMobile: string;
}

export const NAV_ITEMS: NavItem[] = [
  { value: "messages", label: "消息", Icon: MessageSquare },
  { value: "customers", label: "客户", Icon: UserRound },
  { value: "accounts", label: "账号", Icon: Users },
  { value: "groups", label: "群聊", Icon: MessagesSquare },
  { value: "schedule", label: "日程", Icon: Calendar },
  { value: "stats", label: "统计", Icon: BarChart3 },
  { value: "apps", label: "应用", Icon: LayoutGrid },
  { value: "settings", label: "设置", Icon: Settings },
];
