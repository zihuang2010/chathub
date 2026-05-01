import type { ReactNode, Ref } from "react";

import { WORKBENCH_SIDEBAR_BG } from "@/lib/theme";
import { cn } from "@/lib/utils";

interface WorkbenchPanelProps {
  children: ReactNode;
  panelRef?: Ref<HTMLDivElement>;
  className?: string;
}

export function WorkbenchPanel({ children, panelRef, className }: WorkbenchPanelProps) {
  return (
    <main
      className="flex h-full min-w-0 flex-1 py-1 pr-1"
      style={{ background: WORKBENCH_SIDEBAR_BG }}
    >
      <div
        ref={panelRef}
        className={cn(
          "flex h-full min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]",
          className,
        )}
      >
        {children}
      </div>
    </main>
  );
}
