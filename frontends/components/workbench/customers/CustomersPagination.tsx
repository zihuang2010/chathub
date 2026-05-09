import { memo, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

import { PAGE_SIZE_OPTIONS } from "./constants";
import { STRINGS } from "./strings";

interface CustomersPaginationProps {
  page: number;
  pageCount: number;
  pageSize: number;
  totalCount: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}

/**
 * 客户列表底部分页器：
 *   共 N 条 + 每页选择 + 上下页 + 数字按钮 + 跳转输入。
 *
 * 仅当 `totalCount > 最小页大小` 时渲染（CustomerList 决定挂载与否）。
 * 数字按钮算法与 accounts 页一致：当前页两侧各 1 个，超出时用省略号。
 */
export const CustomersPagination = memo(function CustomersPagination({
  page,
  pageCount,
  pageSize,
  totalCount,
  onPageChange,
  onPageSizeChange,
}: CustomersPaginationProps) {
  return (
    <div className="flex flex-shrink-0 flex-wrap items-center justify-center gap-3 border-t border-workbench-line bg-workbench-surface px-4 py-3 text-[12px] text-workbench-text-muted">
      <span className="wb-num tabular-nums">{STRINGS.pagination.total(totalCount)}</span>

      <PageSizeSelector value={pageSize} onChange={onPageSizeChange} />

      <div className="inline-flex items-center gap-1">
        <PageNavButton
          ariaLabel={STRINGS.pagination.prev}
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeft size={14} />
        </PageNavButton>
        {generatePages(page, pageCount).map((p, i) =>
          p === "…" ? (
            <span
              key={`ellipsis-${i}`}
              className="grid size-7 place-items-center text-workbench-text-muted"
            >
              …
            </span>
          ) : (
            <PageNumberButton
              key={p}
              page={p}
              active={p === page}
              onClick={() => onPageChange(p)}
            />
          ),
        )}
        <PageNavButton
          ariaLabel={STRINGS.pagination.next}
          disabled={page >= pageCount}
          onClick={() => onPageChange(page + 1)}
        >
          <ChevronRight size={14} />
        </PageNavButton>
      </div>

      <JumpInput pageCount={pageCount} onJump={onPageChange} />
    </div>
  );
});

// ─── 分页数字算法 ───────────────────────────────────────────────────────────
function generatePages(current: number, total: number): (number | "…")[] {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const out: (number | "…")[] = [1];
  const left = Math.max(2, current - 1);
  const right = Math.min(total - 1, current + 1);
  if (left > 2) out.push("…");
  for (let i = left; i <= right; i++) out.push(i);
  if (right < total - 1) out.push("…");
  out.push(total);
  return out;
}

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

function PageNumberButton({
  page,
  active,
  onClick,
}: {
  page: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={cn(
        "focus-ring grid h-7 min-w-[28px] place-items-center rounded-md border px-2 text-[12px] transition-colors",
        active
          ? "border-workbench-accent bg-workbench-accent text-white"
          : "border-workbench-line bg-workbench-surface text-workbench-text hover:border-workbench-line-strong",
      )}
    >
      <span className="wb-num tabular-nums">{page}</span>
    </button>
  );
}

function JumpInput({ pageCount, onJump }: { pageCount: number; onJump: (p: number) => void }) {
  const [value, setValue] = useState("");

  const commit = () => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 1) {
      onJump(1);
    } else if (n > pageCount) {
      onJump(pageCount);
    } else {
      onJump(Math.floor(n));
    }
    setValue("");
  };

  return (
    <span className="inline-flex items-center gap-1">
      <span>{STRINGS.pagination.jumpPrefix}</span>
      <input
        type="text"
        inputMode="numeric"
        value={value}
        onChange={(e) => setValue(e.target.value.replace(/[^0-9]/g, ""))}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
        onBlur={() => {
          if (value) commit();
        }}
        aria-label={STRINGS.pagination.jumpAria}
        className="focus-ring h-7 w-12 rounded-md border border-workbench-line bg-workbench-surface px-2 text-center text-[12px] text-workbench-text"
      />
      <span>{STRINGS.pagination.jumpSuffix}</span>
    </span>
  );
}
