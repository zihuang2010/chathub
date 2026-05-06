import { cn } from "@/lib/utils";

import { STRINGS } from "./strings";

export function ChatLoadingState() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={STRINGS.empty.loading}
      className="flex flex-1 flex-col gap-3 bg-workbench-surface px-4 py-5"
    >
      <SkeletonRow side="left" />
      <SkeletonRow side="right" />
      <SkeletonRow side="left" wide />
      <SkeletonRow side="right" />
      <span className="sr-only">{STRINGS.empty.loading}</span>
    </div>
  );
}

function SkeletonRow({ side, wide }: { side: "left" | "right"; wide?: boolean }) {
  return (
    <div className={cn("flex items-center gap-2", side === "right" && "flex-row-reverse")}>
      <div className="size-9 shrink-0 animate-pulse rounded-xl bg-workbench-line-subtle" />
      <div
        className={cn(
          "h-9 animate-pulse rounded-md bg-workbench-line-subtle",
          wide ? "w-[60%]" : "w-[40%]",
        )}
      />
    </div>
  );
}

export function ChatEmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 bg-workbench-surface px-6 py-10 text-center">
      <p className="text-wb-sm font-medium text-workbench-text">{STRINGS.empty.noMessages}</p>
      <p className="text-wb-2xs text-workbench-text-muted">{STRINGS.empty.startChat}</p>
    </div>
  );
}

export function ChatErrorState({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <div
      role="alert"
      aria-live="assertive"
      className="flex flex-1 flex-col items-center justify-center gap-3 bg-workbench-surface px-6 py-10 text-center"
    >
      <p className="text-wb-sm font-medium text-workbench-text">{STRINGS.errors.loadFailed}</p>
      <p className="max-w-sm text-wb-2xs text-workbench-text-muted">{error.message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="focus-ring inline-flex h-9 items-center rounded-md bg-workbench-accent px-3 text-wb-2xs font-medium text-white transition-colors hover:bg-workbench-accent-hover"
      >
        {STRINGS.errors.retry}
      </button>
    </div>
  );
}
