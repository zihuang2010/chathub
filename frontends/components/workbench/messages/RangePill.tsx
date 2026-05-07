import { useState } from "react";
import { ChevronDown, ListFilter, X } from "lucide-react";

import { cn } from "@/lib/utils";

import { AccountDropdown } from "./AccountDropdown";
import { STRINGS } from "./strings";

interface RangePillProps {
  accountOptions: string[];
  selectedAccount: string | null;
  onAccountChange: (account: string | null) => void;
}

export function RangePill({ accountOptions, selectedAccount, onAccountChange }: RangePillProps) {
  const [open, setOpen] = useState(false);
  const label = selectedAccount ?? STRINGS.rangePill.allAccounts(accountOptions.length);

  return (
    <div className="bg-workbench-surface px-4 pb-1.5 pt-2">
      <div className="flex items-center justify-between gap-3 text-wb-2xs font-medium">
        <AccountDropdown
          accounts={accountOptions}
          selectedAccount={selectedAccount}
          onSelect={onAccountChange}
          open={open}
          onOpenChange={setOpen}
          contentClassName="w-[240px]"
          title={STRINGS.rangePill.selectAccount}
        >
          <button
            type="button"
            aria-expanded={open}
            aria-label={STRINGS.rangePill.selectAccount}
            className="focus-ring inline-flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-md px-2 text-left text-workbench-accent transition-colors hover:bg-workbench-surface-soft data-[state=open]:bg-workbench-surface-soft"
          >
            <ListFilter size={12} className="shrink-0" />
            <span className="min-w-0 truncate">
              {STRINGS.rangePill.currentRange}：{label}
            </span>
            <ChevronDown
              size={12}
              className={cn("shrink-0 transition-transform", open && "rotate-180")}
            />
          </button>
        </AccountDropdown>
        <button
          type="button"
          onClick={() => onAccountChange(null)}
          disabled={!selectedAccount}
          className="focus-ring inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-1.5 text-workbench-text-muted transition-colors hover:bg-workbench-surface-subtle hover:text-workbench-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-workbench-text-muted"
        >
          <X size={12} />
          <span>{STRINGS.rangePill.clearFilter}</span>
        </button>
      </div>
    </div>
  );
}
