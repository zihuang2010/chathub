import { motion } from "framer-motion";

import { TRANSITION_DURATIONS } from "@/lib/theme";
import { cn } from "@/lib/utils";

import { STRINGS } from "./strings";

// A9: skeleton 入场 cascading —— 父级 staggerChildren=60ms,逐行淡入而非整块闪现,
// 让"等待数据"的感知更柔和。整体仍保留 animate-pulse 表示"loading"。
const SKELETON_CONTAINER_VARIANTS = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06 } },
};
const SKELETON_ROW_VARIANTS = {
  hidden: { opacity: 0, y: 4 },
  show: { opacity: 1, y: 0, transition: { duration: TRANSITION_DURATIONS.normal / 1000 } },
};

export function ChatLoadingState() {
  return (
    <motion.div
      initial="hidden"
      animate="show"
      variants={SKELETON_CONTAINER_VARIANTS}
      role="status"
      aria-busy="true"
      aria-label={STRINGS.empty.loading}
      className="flex flex-1 flex-col justify-end gap-4 bg-workbench-surface px-4 py-5 pr-6"
    >
      <SkeletonRow side="right" compact />
      <SkeletonRow side="right" wide />
      <SkeletonRow side="right" />
      <SkeletonRow side="right" compact />
      <span className="sr-only">{STRINGS.empty.loading}</span>
    </motion.div>
  );
}

function SkeletonRow({
  side,
  compact,
  wide,
}: {
  side: "left" | "right";
  compact?: boolean;
  wide?: boolean;
}) {
  return (
    <motion.div
      variants={SKELETON_ROW_VARIANTS}
      className={cn("flex items-center gap-2", side === "right" && "flex-row-reverse")}
    >
      <div className="size-8 shrink-0 animate-pulse rounded-lg bg-workbench-line-subtle" />
      <div
        className={cn(
          "h-9 animate-pulse rounded-md bg-workbench-line-subtle",
          compact ? "w-[15%]" : wide ? "w-[32%]" : "w-[22%]",
        )}
      />
    </motion.div>
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
