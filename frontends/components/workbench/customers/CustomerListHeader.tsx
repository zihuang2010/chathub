import { memo } from "react";

import { cn } from "@/lib/utils";

import { ROW_GRID_TEMPLATE } from "./constants";
import { STRINGS } from "./strings";

interface CustomerListHeaderProps {
  /** 当前可见集合的总数；用于 master checkbox 的 indeterminate 与全选语义。 */
  totalVisible: number;
  /** 当前选中数（跨页累计）。 */
  selectedCount: number;
  /** 当前 filtered 集合是否全部选中。 */
  allSelectedInView: boolean;
  /** 切换：未选→全选 filtered；已全选→清空。 */
  onToggleSelectAll: () => void;
}

/**
 * 客户列表的列头行（与 CustomerListRow 共用 ROW_GRID_TEMPLATE）。sticky top-0
 * 让滚动时列头保持可见，避免长列表里失去列指引。
 */
export const CustomerListHeader = memo(function CustomerListHeader({
  totalVisible,
  selectedCount,
  allSelectedInView,
  onToggleSelectAll,
}: CustomerListHeaderProps) {
  const indeterminate = selectedCount > 0 && !allSelectedInView;
  return (
    <div
      style={{ gridTemplateColumns: ROW_GRID_TEMPLATE }}
      className="sticky top-0 z-[1] grid h-8 items-center gap-2 border-b border-workbench-line bg-workbench-surface-subtle px-3 text-[11.5px] font-medium text-workbench-text-muted"
    >
      <MasterCheckbox
        checked={allSelectedInView}
        indeterminate={indeterminate}
        onChange={onToggleSelectAll}
        ariaLabel={STRINGS.list.selectAll(totalVisible)}
      />
      <span>{STRINGS.list.columnCustomer}</span>
      <span>{STRINGS.list.columnAccount}</span>
      <span>{STRINGS.list.columnTags}</span>
      <span>{STRINGS.list.columnSource}</span>
      <span>{STRINGS.list.columnLastContact}</span>
      <span className="pr-1.5 text-right">{STRINGS.list.columnActions}</span>
    </div>
  );
});

function MasterCheckbox({
  checked,
  indeterminate,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  indeterminate: boolean;
  onChange: () => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? "mixed" : checked}
      aria-label={ariaLabel}
      title={ariaLabel}
      onClick={(e) => {
        e.stopPropagation();
        onChange();
      }}
      className={cn(
        "focus-ring grid size-4 place-items-center rounded-[4px] border transition-colors",
        checked || indeterminate
          ? "border-workbench-accent bg-workbench-accent text-workbench-surface"
          : "border-workbench-line bg-workbench-surface text-transparent hover:border-workbench-line-strong",
      )}
    >
      {indeterminate ? (
        <span aria-hidden className="block h-[2px] w-2.5 rounded-sm bg-workbench-surface" />
      ) : checked ? (
        <svg viewBox="0 0 12 12" className="size-2.5" aria-hidden>
          <path
            d="M2.5 6.2 5 8.6 9.6 3.4"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : null}
    </button>
  );
}
