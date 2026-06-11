import { useState } from "react";
import { ChevronDown, ListFilter, X } from "lucide-react";

import type { Account } from "@/lib/types/account";
import { accountDisplayName } from "@/lib/types/account";
import { cn } from "@/lib/utils";

import { AccountDropdown } from "./AccountDropdown";
import { STRINGS } from "./strings";

interface RangePillProps {
  accounts: readonly Account[];
  /** 选中账号的 `account.id`(= wecomAccountId),`null` = 全部。展示名按 id 反查 accounts。 */
  selectedAccountId: string | null;
  onAccountChange: (accountId: string | null) => void;
}

export function RangePill({ accounts, selectedAccountId, onAccountChange }: RangePillProps) {
  const [open, setOpen] = useState(false);
  const selectedAccount = selectedAccountId
    ? accounts.find((a) => a.id === selectedAccountId)
    : undefined;
  const selectedAccountName = selectedAccount ? accountDisplayName(selectedAccount) : null;
  const label = selectedAccountName ?? STRINGS.rangePill.allAccounts(accounts.length);

  return (
    <div className="bg-workbench-surface px-4 pb-1.5 pt-2">
      <div className="flex items-center justify-between gap-3 text-wb-2xs font-medium">
        <AccountDropdown
          accounts={accounts}
          selectedAccountId={selectedAccountId}
          onSelect={onAccountChange}
          open={open}
          onOpenChange={setOpen}
        >
          <button
            type="button"
            aria-expanded={open}
            aria-label={STRINGS.rangePill.selectAccount}
            className="focus-ring inline-flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-md px-2 text-left text-[#5B7C99] transition-colors hover:bg-workbench-surface-soft data-[state=open]:bg-workbench-surface-soft"
          >
            <ListFilter size={12} className="shrink-0 text-[#6B86A6]" />
            <span className="min-w-0 truncate">
              {STRINGS.rangePill.currentRange}：{label}
            </span>
            <ChevronDown
              size={12}
              className={cn("shrink-0 text-[#6B86A6] transition-transform", open && "rotate-180")}
            />
          </button>
        </AccountDropdown>
        <button
          type="button"
          onClick={() => onAccountChange(null)}
          disabled={!selectedAccountId}
          className="focus-ring inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-1.5 text-workbench-text-muted transition-colors hover:bg-workbench-surface-subtle hover:text-workbench-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-workbench-text-muted"
        >
          <X size={12} />
          <span>{STRINGS.rangePill.clearFilter}</span>
        </button>
      </div>
    </div>
  );
}
