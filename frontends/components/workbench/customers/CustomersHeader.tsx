import { memo } from "react";

import type { Account } from "@/lib/types/account";
import type { CustomerStage, FollowUpStatus } from "@/lib/types/customer";

import type { CustomerTab, SortKey } from "./constants";
import { CustomersFilterBar } from "./CustomersFilterBar";
import { CustomersTabsStrip } from "./CustomersTabsStrip";
import { STRINGS } from "./strings";

interface CustomersHeaderProps {
  // Tabs
  activeTab: CustomerTab;
  onTabChange: (tab: CustomerTab) => void;
  tabCounts: Record<CustomerTab, number>;

  // Search + filters
  searchTerm: string;
  onSearchChange: (term: string) => void;

  accounts: readonly Account[];
  selectedAccountIds: ReadonlySet<string>;
  accountCounts: Record<string, number>;
  onToggleAccount: (id: string) => void;
  onClearAccounts: () => void;

  stageFilter: ReadonlySet<CustomerStage>;
  onToggleStage: (stage: CustomerStage) => void;
  onClearStages: () => void;

  knownTags: readonly string[];
  tagFilters: readonly string[];
  onToggleTag: (tag: string) => void;
  onClearTags: () => void;

  followUpFilter: ReadonlySet<FollowUpStatus>;
  onToggleFollowUp: (status: FollowUpStatus) => void;
  onClearFollowUps: () => void;

  sortKey: SortKey;
  onSortChange: (key: SortKey) => void;

  hasActiveFilters: boolean;
  onReset: () => void;

  onCreateCustomer: () => void;
  onToggleView: () => void;
  onExport: () => void;
}

/**
 * 客户管理页头部外壳：顶部 KPI Tab 条 + 主筛选栏。结构简单，主要职责是
 * 把外层一份大 props 拆成两个子组件，使 CustomersPage 仍只 wire 一个 Header。
 */
export const CustomersHeader = memo(function CustomersHeader(props: CustomersHeaderProps) {
  return (
    <header className="flex flex-col border-b border-workbench-line bg-workbench-surface">
      <div className="flex h-12 items-center border-b border-workbench-line-subtle px-4">
        <h1 className="text-[15px] font-semibold text-workbench-text">{STRINGS.page.title}</h1>
      </div>
      <CustomersTabsStrip
        activeTab={props.activeTab}
        onTabChange={props.onTabChange}
        tabCounts={props.tabCounts}
      />
      <div className="border-t border-workbench-line-subtle">
        <CustomersFilterBar
          searchTerm={props.searchTerm}
          onSearchChange={props.onSearchChange}
          accounts={props.accounts}
          selectedAccountIds={props.selectedAccountIds}
          accountCounts={props.accountCounts}
          onToggleAccount={props.onToggleAccount}
          onClearAccounts={props.onClearAccounts}
          stageFilter={props.stageFilter}
          onToggleStage={props.onToggleStage}
          onClearStages={props.onClearStages}
          knownTags={props.knownTags}
          tagFilters={props.tagFilters}
          onToggleTag={props.onToggleTag}
          onClearTags={props.onClearTags}
          followUpFilter={props.followUpFilter}
          onToggleFollowUp={props.onToggleFollowUp}
          onClearFollowUps={props.onClearFollowUps}
          sortKey={props.sortKey}
          onSortChange={props.onSortChange}
          hasActiveFilters={props.hasActiveFilters}
          onReset={props.onReset}
          onCreateCustomer={props.onCreateCustomer}
          onToggleView={props.onToggleView}
          onExport={props.onExport}
        />
      </div>
    </header>
  );
});
