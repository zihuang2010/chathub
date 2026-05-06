import type { LucideProps } from "lucide-react";
import type { ComponentType } from "react";
import { Star, UserCheck, UserPlus, Users } from "lucide-react";

import { STRINGS } from "./strings";

export type CustomerTab = "all" | "needs-followup" | "new-friend" | "starred";

export interface TabOption {
  value: CustomerTab;
  label: string;
  Icon: ComponentType<LucideProps>;
}

export const TAB_OPTIONS: TabOption[] = [
  { value: "all", label: STRINGS.tabs.all, Icon: Users },
  { value: "needs-followup", label: STRINGS.tabs.needsFollowUp, Icon: UserCheck },
  { value: "new-friend", label: STRINGS.tabs.newFriend, Icon: UserPlus },
  { value: "starred", label: STRINGS.tabs.starred, Icon: Star },
];

export type SortKey = "lastContact" | "addedAt" | "company" | "follower";

export interface SortOption {
  value: SortKey;
  label: string;
}

export const SORT_OPTIONS: SortOption[] = [
  { value: "lastContact", label: STRINGS.sort.lastContact },
  { value: "addedAt", label: STRINGS.sort.addedAt },
  { value: "company", label: STRINGS.sort.company },
  { value: "follower", label: STRINGS.sort.follower },
];

/** 列表行的固定高度（像素）。 */
export const ROW_HEIGHT = 60;

/** 详情侧栏宽度（像素），与 messages 页 CustomerDetails 同档。 */
export const DETAIL_PANEL_WIDTH = 380;

/** 「新加好友」Tab 默认包含最近多少天添加的客户。 */
export const NEW_FRIEND_DAYS = 7;

/** 「待跟进」判定：lastContactAt 超过多少小时未联系。 */
export const FOLLOW_UP_HOURS_THRESHOLD = 72;

/** 列表行最多展示多少个标签，超过显示 +N。 */
export const ROW_MAX_TAGS = 1;

/** 备注未编辑态最多显示多少行后折叠。 */
export const NOTE_COLLAPSE_LINES = 4;

/** 详情中"最近会话"展示的消息条数。 */
export const RECENT_MESSAGE_LIMIT = 2;

/** 详情中"客户轨迹"展示的最多条数。 */
export const TIMELINE_LIMIT = 5;
