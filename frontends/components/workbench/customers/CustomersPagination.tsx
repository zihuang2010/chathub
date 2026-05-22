import { memo, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

import { PAGE_SIZE_OPTIONS } from "./constants";
import { STRINGS } from "./strings";

interface CustomersPaginationProps {
  /** 1-based 当前页码。 */
  page: number;
  pageSize: number;
  canPrev: boolean;
  canNext: boolean;
  /** 翻页请求进行中 —— 禁用下一页避免重复触发。 */
  loading: boolean;
  onPrev: () => void;
  onNext: () => void;
  onPageSizeChange: (size: number) => void;
}

/**
 * 客户列表底部分页器(cursor keyset 语义)。
 *
 * cursor 单向、无总数 —— 不提供「跳转到第 N 页」与「共 N 条」,只给:
 *   每页条数 + 上一页 + 第 N 页 + 下一页。
 * 上一页恒命中前端缓存(useFriends 持有已翻页面),下一页未缓存时才打接口。
 */
export const CustomersPagination = memo(function CustomersPagination({
  page,
  pageSize,
  canPrev,
  canNext,
  loading,
  onPrev,
  onNext,
  onPageSizeChange,
}: CustomersPaginationProps) {
  return (
    <div className="flex flex-shrink-0 flex-wrap items-center justify-center gap-3 border-t border-workbench-line bg-workbench-surface px-4 py-3 text-[12px] text-workbench-text-muted">
      <PageSizeSelector value={pageSize} onChange={onPageSizeChange} />

      <div className="inline-flex items-center gap-2">
        <PageNavButton ariaLabel={STRINGS.pagination.prev} disabled={!canPrev} onClick={onPrev}>
          <ChevronLeft size={14} />
        </PageNavButton>
        <span className="wb-num min-w-[48px] text-center tabular-nums text-workbench-text">
          {STRINGS.pagination.pageIndicator(page)}
        </span>
        <PageNavButton
          ariaLabel={STRINGS.pagination.next}
          disabled={!canNext || loading}
          onClick={onNext}
        >
          <ChevronRight size={14} />
        </PageNavButton>
      </div>
    </div>
  );
});

function PageSizeSelector({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="focus-ring inline-flex h-7 items-center gap-1 rounded-md border border-workbench-line bg-workbench-surface px-2 text-[12px] text-workbench-text transition-colors hover:border-workbench-line-strong"
        >
          <span className="wb-num tabular-nums">{STRINGS.pagination.pageSize(value)}</span>
          <ChevronDown size={12} className="text-workbench-text-muted" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className="z-20 min-w-[120px] rounded-md border border-workbench-line bg-workbench-surface p-1 shadow-wb-popover-strong outline-none"
        >
          {PAGE_SIZE_OPTIONS.map((n) => {
            const active = n === value;
            return (
              <button
                key={n}
                type="button"
                onClick={() => {
                  onChange(n);
                  setOpen(false);
                }}
                className={cn(
                  "focus-ring flex h-7 w-full items-center justify-between rounded px-2 text-[12px] transition-colors",
                  active
                    ? "bg-workbench-surface-active text-workbench-accent"
                    : "text-workbench-text-secondary hover:bg-workbench-surface-subtle",
                )}
              >
                <span className="wb-num tabular-nums">{STRINGS.pagination.pageSize(n)}</span>
                {active && <Check size={12} />}
              </button>
            );
          })}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function PageNavButton({
  ariaLabel,
  disabled,
  onClick,
  children,
}: {
  ariaLabel: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "focus-ring grid size-7 place-items-center rounded-md border border-workbench-line bg-workbench-surface text-workbench-text transition-colors hover:border-workbench-line-strong",
        disabled && "cursor-not-allowed opacity-40 hover:border-workbench-line",
      )}
    >
      {children}
    </button>
  );
}
