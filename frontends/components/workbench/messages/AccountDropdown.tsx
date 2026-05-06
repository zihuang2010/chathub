import type { ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";

import { cn } from "@/lib/utils";

import { STRINGS } from "./strings";

interface AccountDropdownProps {
  accounts: string[];
  selectedAccount: string | null;
  onSelect: (account: string | null) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
  sideOffset?: number;
  contentClassName?: string;
  title?: string;
}

export function AccountDropdown({
  accounts,
  selectedAccount,
  onSelect,
  open,
  onOpenChange,
  children,
  align = "start",
  side = "bottom",
  sideOffset = 4,
  contentClassName,
  title,
}: AccountDropdownProps) {
  const handleSelect = (account: string | null) => {
    onSelect(account);
    onOpenChange?.(false);
  };

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align={align}
          side={side}
          sideOffset={sideOffset}
          role="listbox"
          aria-label={title ?? STRINGS.conversationList.accountListLabel}
          className={cn(
            "z-20 rounded-lg border border-workbench-line bg-workbench-surface p-2 shadow-wb-popover-strong outline-none",
            contentClassName,
          )}
        >
          {title && (
            <div className="mb-1 px-1 text-[12px] font-medium text-workbench-text">{title}</div>
          )}
          <AccountOption
            active={!selectedAccount}
            label={STRINGS.rangePill.allAccountsBare}
            onClick={() => handleSelect(null)}
          />
          {accounts.map((account) => (
            <AccountOption
              key={account}
              active={selectedAccount === account}
              label={account}
              onClick={() => handleSelect(account)}
            />
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function AccountOption({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "focus-ring flex h-9 w-full items-center justify-between gap-2 rounded-md px-2 text-left text-[12px] transition-colors",
        active
          ? "bg-workbench-surface-active text-workbench-accent"
          : "text-workbench-text-secondary hover:bg-workbench-surface-subtle",
      )}
    >
      <span className="truncate">{label}</span>
      {active && <span className="size-1.5 rounded-full bg-workbench-accent" />}
    </button>
  );
}
