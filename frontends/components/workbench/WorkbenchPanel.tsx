import type { ReactNode, Ref } from "react";

import { cn } from "@/lib/utils";

interface WorkbenchPanelProps {
  children: ReactNode;
  panelRef?: Ref<HTMLDivElement>;
  className?: string;
}

export function WorkbenchPanel({ children, panelRef, className }: WorkbenchPanelProps) {
  return (
    <main className="flex h-full min-w-0 flex-1 py-1 pr-1" style={{ background: "#E2EDF8" }}>
      <div
        ref={panelRef}
        className={cn(
          "flex h-full min-h-0 min-w-0 flex-1 overflow-hidden rounded-md bg-white",
          className,
        )}
        style={{
          boxShadow: "0 1px 2px rgba(15, 23, 42, 0.04), 0 8px 24px -16px rgba(15, 23, 42, 0.06)",
        }}
      >
        {children}
      </div>
    </main>
  );
}
