import { memo, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Calendar, X } from "lucide-react";
import { format } from "date-fns";
import { zhCN } from "date-fns/locale";
import { DayPicker, type DateRange as RdpRange } from "react-day-picker";
import "react-day-picker/style.css";

import { cn } from "@/lib/utils";

import type { DateRange } from "./useAccountsView";

interface DateRangePickerProps {
  value: DateRange;
  onChange: (r: DateRange) => void;
  onClear: () => void;
}

const LABEL_FORMAT = "yyyy-MM-dd";

export const DateRangePicker = memo(function DateRangePicker({
  value,
  onChange,
  onClear,
}: DateRangePickerProps) {
  const [open, setOpen] = useState(false);

  const fromText = value.from ? format(value.from, LABEL_FORMAT) : "开始日期";
  const toText = value.to ? format(value.to, LABEL_FORMAT) : "结束日期";
  const hasValue = Boolean(value.from || value.to);

  const handleSelect = (range: RdpRange | undefined) => {
    onChange({ from: range?.from, to: range?.to });
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="选择日期区间"
          className={cn(
            "focus-ring inline-flex h-9 shrink-0 items-center gap-2 rounded-md border bg-workbench-surface px-3 text-[13px] transition-colors",
            hasValue
              ? "border-workbench-accent text-workbench-text"
              : "border-workbench-line text-workbench-text-secondary hover:border-workbench-line-strong",
          )}
        >
          <span className="text-[12px] text-workbench-text-muted">创建时间</span>
          <span
            className={cn(
              "wb-num tabular-nums",
              value.from ? "text-workbench-text" : "text-workbench-text-muted",
            )}
          >
            {fromText}
          </span>
          <span className="text-workbench-text-muted">→</span>
          <span
            className={cn(
              "wb-num tabular-nums",
              value.to ? "text-workbench-text" : "text-workbench-text-muted",
            )}
          >
            {toText}
          </span>
          {hasValue ? (
            <span
              role="button"
              aria-label="清空日期"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                onClear();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  onClear();
                }
              }}
              className="grid size-4 place-items-center rounded text-workbench-text-muted hover:bg-workbench-surface-active hover:text-workbench-text"
            >
              <X size={12} />
            </span>
          ) : (
            <Calendar size={14} className="text-workbench-text-muted" />
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="z-20 rounded-lg border border-workbench-line bg-workbench-surface p-3 shadow-wb-popover-strong outline-none"
        >
          <DayPicker
            mode="range"
            numberOfMonths={2}
            locale={zhCN}
            selected={value.from || value.to ? { from: value.from, to: value.to } : undefined}
            onSelect={handleSelect}
            showOutsideDays
            // 用页面 accent token 染色
            style={
              {
                "--rdp-accent-color": "hsl(var(--wb-accent))",
                "--rdp-accent-background-color": "hsl(var(--wb-surface-active))",
                "--rdp-day-width": "36px",
                "--rdp-day-height": "36px",
                "--rdp-day_button-width": "34px",
                "--rdp-day_button-height": "34px",
              } as React.CSSProperties
            }
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
});
