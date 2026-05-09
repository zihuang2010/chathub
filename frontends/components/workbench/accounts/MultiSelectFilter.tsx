import { memo, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

interface MultiSelectFilterProps<T extends string> {
  /** Trigger 上展示的标签，比如"账号状态"。 */
  label: string;
  options: ReadonlyArray<{ value: T; label: string; count?: number }>;
  selected: ReadonlySet<T>;
  onToggle: (value: T) => void;
  onClear: () => void;
  /** 触发器最小宽度。下拉里项太长时撑大；默认按 label 宽度。 */
  triggerMinWidth?: number;
  /** 列表为空时显示的占位文字。 */
  emptyText?: string;
}

/**
 * 多选筛选 Popover：trigger 是一个带 chevron 的边框按钮，激活态显示选中数 badge。
 * Content 是一份带勾选的列表，点击 toggle，列表顶部显示"清空"。
 */
function MultiSelectFilterImpl<T extends string>({
  label,
  options,
  selected,
  onToggle,
  onClear,
  triggerMinWidth = 140,
  emptyText = "无可选项",
}: MultiSelectFilterProps<T>) {
  const [open, setOpen] = useState(false);
  const count = selected.size;
  const hasSelection = count > 0;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={cn(
            "focus-ring inline-flex h-9 shrink-0 items-center justify-between gap-2 rounded-md border bg-workbench-surface px-3 text-[13px] transition-colors",
            hasSelection
              ? "border-workbench-accent text-workbench-accent"
              : "border-workbench-line text-workbench-text hover:border-workbench-line-strong",
          )}
          style={{ minWidth: triggerMinWidth }}
        >
          <span className="truncate">
            {label}
            {hasSelection && <span className="wb-num ml-1 tabular-nums">({count})</span>}
          </span>
          <ChevronDown
            size={14}
            className={cn(
              "shrink-0 transition-transform",
              open && "rotate-180",
              hasSelection ? "text-workbench-accent" : "text-workbench-text-muted",
            )}
          />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="z-20 w-[240px] rounded-lg border border-workbench-line bg-workbench-surface p-2 shadow-wb-popover-strong outline-none"
        >
          <div className="flex items-center justify-between px-1 pb-1">
            <span className="text-[11px] font-medium uppercase tracking-wider text-workbench-text-muted">
              {label}
            </span>
            {hasSelection && (
              <button
                type="button"
                onClick={onClear}
                className="text-[11px] text-workbench-accent hover:underline"
              >
                清空
              </button>
            )}
          </div>
          {options.length === 0 ? (
            <div className="px-2 py-3 text-center text-[12px] text-workbench-text-muted">
              {emptyText}
            </div>
          ) : (
            <ul className="flex max-h-[280px] flex-col gap-0.5 overflow-y-auto">
              {options.map((opt) => {
                const checked = selected.has(opt.value);
                return (
                  <li key={opt.value}>
                    <button
                      type="button"
                      onClick={() => onToggle(opt.value)}
                      className={cn(
                        "focus-ring flex h-8 w-full items-center justify-between gap-2 rounded-md px-2 text-left text-[12px] transition-colors",
                        checked
                          ? "bg-workbench-surface-active text-workbench-accent"
                          : "text-workbench-text-secondary hover:bg-workbench-surface-subtle",
                      )}
                    >
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        <span
                          aria-hidden
                          className={cn(
                            "grid size-4 shrink-0 place-items-center rounded-[4px] border",
                            checked
                              ? "border-workbench-accent bg-workbench-accent text-workbench-surface"
                              : "border-workbench-line",
                          )}
                        >
                          {checked && <Check size={10} strokeWidth={3} />}
                        </span>
                        <span className="truncate">{opt.label}</span>
                      </span>
                      {typeof opt.count === "number" && (
                        <span className="wb-num text-[11px] tabular-nums text-workbench-text-muted">
                          {opt.count}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export const MultiSelectFilter = memo(MultiSelectFilterImpl) as typeof MultiSelectFilterImpl;
