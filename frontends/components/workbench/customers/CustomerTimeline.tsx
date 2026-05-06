import { memo } from "react";

import type { CustomerTimelineEntry } from "@/lib/types/customer";

import { TIMELINE_LIMIT } from "./constants";

interface CustomerTimelineProps {
  entries: readonly CustomerTimelineEntry[] | undefined;
}

export const CustomerTimeline = memo(function CustomerTimeline({ entries }: CustomerTimelineProps) {
  const list = (entries ?? []).slice(0, TIMELINE_LIMIT);

  if (list.length === 0) {
    return <p className="text-wb-2xs text-workbench-text-muted">尚无客户轨迹</p>;
  }

  return (
    <ol className="flex flex-col gap-2">
      {list.map((entry, idx) => (
        <li key={`${entry.at}-${idx}`} className="flex items-start gap-2 text-[11.5px]">
          <span
            aria-hidden
            className="mt-1.5 size-1.5 shrink-0 rounded-full bg-workbench-line-strong"
          />
          <div className="flex flex-col gap-0.5">
            <span className="font-numeric tabular-nums text-workbench-text">{entry.at}</span>
            <span className="text-workbench-text-secondary">{entry.text}</span>
          </div>
        </li>
      ))}
    </ol>
  );
});
