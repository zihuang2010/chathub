import { memo } from "react";

import type { Account } from "@/lib/types/account";

import { CustomersFilterBar } from "./CustomersFilterBar";
import { STRINGS } from "./strings";

interface CustomersHeaderProps {
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

/**
 * 客户管理页头部外壳:标题行 + 主筛选栏。阶段 3 起客户列表为纯 cursor 滚动,
 * 不再有 KPI Tab 条 / 客户端分页 —— 筛选只剩账号选择 + 服务端 externalId 搜索。
 */
export const CustomersHeader = memo(function CustomersHeader(props: CustomersHeaderProps) {
  return (
    <header className="flex flex-col border-b border-workbench-line bg-workbench-surface">
      <div className="border-b border-workbench-line-subtle px-4 py-4">
        <h1 className="text-[16px] font-semibold leading-tight text-workbench-text">
          {STRINGS.page.title}
        </h1>
        <p className="mt-1 text-[12px] text-workbench-text-muted">{STRINGS.page.subtitle}</p>
      </div>
      <CustomersFilterBar
        searchTerm={props.searchTerm}
        onSearchChange={props.onSearchChange}
        accounts={props.accounts}
        selectedAccountIds={props.selectedAccountIds}
        onToggleAccount={props.onToggleAccount}
        onClearAccounts={props.onClearAccounts}
        onReset={props.onReset}
        onToggleView={props.onToggleView}
        onExport={props.onExport}
      />
    </header>
  );
});
