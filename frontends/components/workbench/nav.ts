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
