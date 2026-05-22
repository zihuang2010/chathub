import { memo, type ReactNode } from "react";
import { Download, LayoutGrid, Search, X } from "lucide-react";

import type { Account } from "@/lib/types/account";
import { cn } from "@/lib/utils";

import { AccountPicker } from "./AccountPicker";
import { STRINGS } from "./strings";

interface CustomersFilterBarProps {
  searchTerm: string;
  onSearchChange: (term: string) => void;

  accounts: readonly Account[];
  selectedAccountIds: ReadonlySet<string>;
  onToggleAccount: (id: string) => void;
  onClearAccounts: () => void;

  onReset: () => void;
  onToggleView: () => void;
  onExport: () => void;
}

const EMPTY_ACCOUNT_COUNTS: Record<string, number> = {};

/**
 * 客户管理页主筛选栏(阶段 3 纯 cursor 滚动版)。从左到右:
 *   搜索(下推服务端 externalId)+ 账号选择 + 重置 + 视图切换 + 刷新
 *
 * 阶段 2 → 3 退役的:客户阶段 / 跟进状态 / 标签 / 排序 popover、账号 chip 计数。
 * 这些都基于"全量已加载 + 占位字段(tags/stage)"假设,在窗口化 cursor 滚动下失真,
 * 故移除;account chip 计数同理(只反映已加载页)。
 */
export const CustomersFilterBar = memo(function CustomersFilterBar({
  searchTerm,
  onSearchChange,
  accounts,
  selectedAccountIds,
  onToggleAccount,
  onClearAccounts,
  onReset,
  onToggleView,
  onExport,
}: CustomersFilterBarProps) {
  return (
    // 工具栏强制不换行 — 内容超容器时横向滚动(滚动条隐藏,Firefox/Webkit 都兼容)。
    <div className="flex flex-nowrap items-center gap-2 overflow-x-auto px-4 py-3 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <SearchInput value={searchTerm} onChange={onSearchChange} />

      <AccountPicker
        accounts={accounts}
        selectedIds={selectedAccountIds}
        accountCounts={EMPTY_ACCOUNT_COUNTS}
        needsFollowUpInScope={0}
        onToggle={onToggleAccount}
        onClearAll={onClearAccounts}
        recentIds={accounts.slice(0, 3).map((a) => a.id)}
      />

      <button
        type="button"
        onClick={onReset}
        className="focus-ring inline-flex h-9 items-center px-1 text-[13px] text-workbench-text-secondary transition-colors hover:text-workbench-accent hover:underline"
      >
        {STRINGS.toolbar.reset}
      </button>

      <span aria-hidden className="ml-auto" />

      <IconActionButton ariaLabel={STRINGS.toolbar.viewToggle} onClick={onToggleView}>
        <LayoutGrid size={14} />
      </IconActionButton>

      <IconActionButton ariaLabel={STRINGS.toolbar.export} onClick={onExport}>
        <Download size={14} />
      </IconActionButton>
    </div>
  );
});

function SearchInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const hasValue = value.length > 0;
  return (
    <div className="relative w-[280px] min-w-[200px] shrink">
      <Search
        size={14}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-workbench-text-muted"
      />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={STRINGS.toolbar.searchPlaceholder}
        className={cn(
          "focus-ring h-9 w-full rounded-md border border-workbench-line bg-workbench-surface-subtle pl-8 pr-8 text-[13px] text-workbench-text placeholder:text-workbench-text-muted",
          "transition-colors hover:border-workbench-line-strong focus:border-workbench-accent focus:bg-workbench-surface",
        )}
      />
      {hasValue && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="清空搜索"
          className="focus-ring absolute right-2 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-workbench-text-muted hover:bg-workbench-surface hover:text-workbench-text"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}

function IconActionButton({
  ariaLabel,
  onClick,
  children,
}: {
  ariaLabel: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      title={ariaLabel}
      onClick={onClick}
      className={cn(
        "focus-ring grid size-9 shrink-0 place-items-center rounded-md border border-workbench-line bg-workbench-surface text-workbench-text-secondary transition-colors",
        "hover:border-workbench-line-strong hover:bg-workbench-surface-subtle hover:text-workbench-text",
      )}
    >
      {children}
    </button>
  );
}
