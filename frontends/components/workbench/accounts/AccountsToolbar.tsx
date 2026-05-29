import { memo } from "react";
import { Download, LayoutGrid, List, RotateCcw } from "lucide-react";

import type { AccountStatus } from "@/lib/types/account";
import { cn } from "@/lib/utils";

import { type ViewMode } from "./constants";
import { MultiSelectFilter } from "./MultiSelectFilter";

interface AccountsToolbarProps {
  // 账号状态多选（检索栏唯一保留的筛选维度）
  statusSet: ReadonlySet<AccountStatus>;
  toggleStatus: (s: AccountStatus) => void;
  clearStatus: () => void;

  // reset
  hasActiveFilters: boolean;
  onReset: () => void;

  // view + export
  viewMode: ViewMode;
  setViewMode: (v: ViewMode) => void;
  onExport: () => void;
}

const STATUS_OPTIONS: ReadonlyArray<{ value: AccountStatus; label: string }> = [
  { value: "online", label: "在线" },
  { value: "abnormal", label: "异常" },
  { value: "offline", label: "未登录" },
];

export const AccountsToolbar = memo(function AccountsToolbar({
  statusSet,
  toggleStatus,
  clearStatus,
  hasActiveFilters,
  onReset,
  viewMode,
  setViewMode,
  onExport,
}: AccountsToolbarProps) {
  return (
    // 工具栏强制不换行 — 内容超容器时横向滚动(滚动条隐藏,Firefox/Webkit 都兼容)。
    <div className="flex flex-nowrap items-center gap-2 overflow-x-auto px-4 py-3 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <MultiSelectFilter<AccountStatus>
        label="账号状态"
        options={STATUS_OPTIONS}
        selected={statusSet}
        onToggle={toggleStatus}
        onClear={clearStatus}
      />

      <button
        type="button"
        onClick={onReset}
        disabled={!hasActiveFilters}
        className={cn(
          "focus-ring inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-workbench-line bg-workbench-surface px-3 text-[13px] transition-colors",
          hasActiveFilters
            ? "text-workbench-text hover:border-workbench-line-strong"
            : "cursor-not-allowed text-workbench-text-muted opacity-50",
        )}
      >
        <RotateCcw size={14} />
        重置
      </button>

      <div className="ml-auto flex items-center gap-2">
        <ViewToggle value={viewMode} onChange={setViewMode} />
        <button
          type="button"
          onClick={onExport}
          className="focus-ring inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-workbench-accent px-3 text-[13px] font-medium text-white transition-colors hover:opacity-90"
        >
          <Download size={14} />
          导出
        </button>
      </div>
    </div>
  );
});

function ViewToggle({ value, onChange }: { value: ViewMode; onChange: (v: ViewMode) => void }) {
  return (
    <div className="inline-flex h-9 items-center rounded-md border border-workbench-line bg-workbench-surface p-0.5">
      <ViewToggleButton
        active={value === "grid"}
        onClick={() => onChange("grid")}
        ariaLabel="网格视图"
      >
        <LayoutGrid size={14} />
      </ViewToggleButton>
      <ViewToggleButton
        active={value === "list"}
        onClick={() => onChange("list")}
        ariaLabel="列表视图"
      >
        <List size={14} />
      </ViewToggleButton>
    </div>
  );
}

function ViewToggleButton({
  active,
  onClick,
  ariaLabel,
  children,
}: {
  active: boolean;
  onClick: () => void;
  ariaLabel: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "focus-ring grid size-7 place-items-center rounded transition-colors",
        active
          ? "bg-workbench-accent text-white"
          : "text-workbench-text-secondary hover:bg-workbench-surface-active",
      )}
    >
      {children}
    </button>
  );
}
