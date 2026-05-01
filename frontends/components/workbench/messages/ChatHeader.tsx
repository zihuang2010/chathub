import { CheckCheck, FolderOpen, MoreHorizontal, Phone, UserPlus, Video } from "lucide-react";

import { CustomerAvatar } from "./Avatar";
import type { Conversation } from "./data";

export function ChatHeader({ conversation }: { conversation: Conversation }) {
  return (
    <div className="flex min-h-[76px] items-center justify-between gap-4 border-b border-workbench-line bg-white px-4 py-3.5">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <CustomerAvatar name={conversation.name} color={conversation.avatarColor} size="header" />
        <div className="flex min-w-0 flex-col gap-1 leading-tight">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[14px] font-medium text-workbench-text">
              {conversation.name}
            </span>
            <span className="shrink-0 rounded bg-workbench-wechat-bg px-1.5 py-px text-[10.5px] font-medium text-workbench-wechat-text">
              @微信
            </span>
          </div>
          <span className="truncate text-[12px] leading-[17px] text-workbench-text-muted">
            来自：<span className="text-workbench-blue">{conversation.account}</span>
          </span>
        </div>
      </div>
      <div className="flex max-w-[280px] shrink-0 flex-wrap items-center justify-end gap-1 text-workbench-text-secondary">
        <HeaderIconButton icon={Phone} label="语音通话" />
        <HeaderIconButton icon={Video} label="视频通话" />
        <HeaderIconButton icon={CheckCheck} label="完成跟进" />
        <HeaderIconButton icon={UserPlus} label="加入群聊" />
        <HeaderIconButton icon={FolderOpen} label="资料库" />
        <HeaderIconButton icon={MoreHorizontal} label="更多" />
      </div>
    </div>
  );
}

function HeaderIconButton({ icon: Icon, label }: { icon: typeof Phone; label: string }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className="grid size-8 place-items-center rounded-md text-workbench-text-secondary transition-colors hover:bg-workbench-surface-subtle hover:text-workbench-text"
    >
      <Icon size={15} />
    </button>
  );
}
