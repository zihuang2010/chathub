import type { ReactNode } from "react";
import { FolderOpen, MoreHorizontal } from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";

import { CustomerAvatar, WeChatSourceBadge } from "./Avatar";
import type { Conversation } from "./data";
import { STRINGS } from "./strings";

const WECOM_SOURCE_LOGO = "/wecom-logo.png";

export function ChatHeader({ conversation }: { conversation: Conversation }) {
  return (
    <div className="flex min-h-[76px] items-center justify-between gap-4 border-b border-workbench-line bg-workbench-surface px-4 py-3.5">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {/* 客户来源标识与接待列表一致:微信角标贴头像左下角(WeChatSourceBadge 共用),
            不再用「@微信」文字胶囊,避免同一语义两套视觉。 */}
        <CustomerAvatar
          name={conversation.name}
          color={conversation.avatarColor}
          avatarUrl={conversation.avatar}
          size="header"
        >
          <WeChatSourceBadge />
        </CustomerAvatar>
        <div className="flex min-w-0 flex-col gap-1 leading-tight">
          <span className="truncate text-wb-sm font-medium text-workbench-text">
            {conversation.name}
          </span>
          {/* 归属行:企微 logo + 账号名,与列表行 SourceChip 的「归属哪个企微账号接待」
              语义/视觉对齐;不再显示「归属：」文字前缀,语义由 logo 承担,hover 的
              title 仍带前缀以保留完整含义;账号名过长时截断。 */}
          <span
            title={`${STRINGS.header.fromAccountLabel}${conversation.account}`}
            className="flex min-w-0 items-center gap-1.5 text-wb-2xs"
          >
            <img
              src={WECOM_SOURCE_LOGO}
              alt=""
              aria-hidden
              className="size-3.5 shrink-0 rounded-[2px] object-contain"
            />
            <span className="min-w-0 truncate font-medium text-workbench-text-secondary">
              {conversation.account}
            </span>
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1 text-workbench-text-secondary">
        <HeaderOverflowMenu />
      </div>
    </div>
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

function OverflowItem({ icon: Icon, children }: { icon: typeof FolderOpen; children: ReactNode }) {
  return (
    <DropdownMenu.Item className="flex cursor-default items-center gap-2 rounded px-2 py-1.5 text-wb-2xs text-workbench-text outline-none transition-colors data-[highlighted]:bg-workbench-surface-subtle">
      <Icon size={14} />
      {children}
    </DropdownMenu.Item>
  );
}
