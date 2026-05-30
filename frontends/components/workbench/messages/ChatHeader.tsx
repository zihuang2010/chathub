import type { ReactNode } from "react";
import { FolderOpen, MoreHorizontal, Phone, UserPlus, Video } from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";

import { CustomerAvatar } from "./Avatar";
import type { Conversation } from "./data";
import { STRINGS } from "./strings";

export function ChatHeader({ conversation }: { conversation: Conversation }) {
  return (
    <div className="flex min-h-[76px] items-center justify-between gap-4 border-b border-workbench-line bg-workbench-surface px-4 py-3.5">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <CustomerAvatar
          name={conversation.name}
          color={conversation.avatarColor}
          avatarUrl={conversation.avatar}
          size="header"
        />
        <div className="flex min-w-0 flex-col gap-1 leading-tight">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-wb-sm font-medium text-workbench-text">
              {conversation.name}
            </span>
            <span className="text-wb-3xs shrink-0 rounded bg-workbench-wechat-bg px-1.5 py-px font-medium text-workbench-wechat-text">
              {STRINGS.header.fromWeChat}
            </span>
          </div>
          <span className="truncate text-wb-2xs font-medium text-workbench-text-muted">
            {STRINGS.header.fromAccountLabel}
            <span className="font-medium text-workbench-text">{conversation.account}</span>
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1 text-workbench-text-secondary">
        <HeaderIconButton icon={Phone} label={STRINGS.header.voiceCall} />
        <HeaderIconButton icon={Video} label={STRINGS.header.videoCall} />
        <HeaderIconButton icon={UserPlus} label={STRINGS.header.addToGroup} />
        <HeaderOverflowMenu />
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
      className="focus-ring grid size-9 place-items-center rounded-md text-workbench-text-secondary transition-colors hover:bg-workbench-surface-subtle hover:text-workbench-text"
    >
      <Icon size={16} />
    </button>
  );
}

function HeaderOverflowMenu() {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={STRINGS.header.more}
          className="focus-ring grid size-9 place-items-center rounded-md text-workbench-text-secondary transition-colors hover:bg-workbench-surface-subtle hover:text-workbench-text data-[state=open]:bg-workbench-surface-subtle"
        >
          <MoreHorizontal size={16} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="z-30 min-w-[140px] overflow-hidden rounded-md border border-workbench-line bg-workbench-surface p-1 shadow-wb-popover"
        >
          <OverflowItem icon={FolderOpen}>{STRINGS.header.library}</OverflowItem>
          <OverflowItem icon={MoreHorizontal}>{STRINGS.header.more}</OverflowItem>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function OverflowItem({ icon: Icon, children }: { icon: typeof Phone; children: ReactNode }) {
  return (
    <DropdownMenu.Item className="flex cursor-default items-center gap-2 rounded px-2 py-1.5 text-wb-2xs text-workbench-text outline-none transition-colors data-[highlighted]:bg-workbench-surface-subtle">
      <Icon size={14} />
      {children}
    </DropdownMenu.Item>
  );
}
