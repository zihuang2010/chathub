import { useState } from "react";
import { ChevronDown, Sparkles, X } from "lucide-react";

import { cn } from "@/lib/utils";

import { AccountDropdown } from "./AccountDropdown";

interface RangePillProps {
  accountOptions: string[];
  selectedAccount: string | null;
  onAccountChange: (account: string | null) => void;
}

export function RangePill({ accountOptions, selectedAccount, onAccountChange }: RangePillProps) {
  const [open, setOpen] = useState(false);
  const label = selectedAccount ?? `全部账号 (${accountOptions.length})`;

  return (
    <div className="bg-white px-4 pb-1.5 pt-2">
      <div className="flex items-center justify-between gap-3 text-[12px]">
        <AccountDropdown
          accounts={accountOptions}
          selectedAccount={selectedAccount}
          onSelect={onAccountChange}
          open={open}
          onOpenChange={setOpen}
          contentClassName="w-[240px]"
          title="选择账号范围"
        >
          <button
            type="button"
            aria-expanded={open}
            className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md bg-workbench-surface-soft px-2 py-1 text-left text-workbench-blue transition-colors hover:bg-workbench-surface-active"
          >
            <Sparkles size={12} className="shrink-0" />
            <span className="min-w-0 truncate">当前范围：{label}</span>
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
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-workbench-text-muted transition-colors hover:bg-workbench-surface-subtle hover:text-workbench-blue-strong disabled:hover:bg-transparent disabled:hover:text-workbench-text-muted"
        >
          <X size={12} />
          <span>清除筛选</span>
        </button>
      </div>
    </div>
  );
}
