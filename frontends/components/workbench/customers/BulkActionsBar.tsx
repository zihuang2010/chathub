import { memo, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { CheckCheck, Download, Star, Tag, UserCheck, X } from "lucide-react";

import { cn } from "@/lib/utils";

import { TAG_PRESETS } from "./data";
import { STRINGS } from "./strings";

interface BulkActionsBarProps {
  selectedCount: number;
  /** 当前选中客户中已被关注的占比，决定按钮的语义。 */
  allStarred: boolean;
  /** 本页是否已全部选中，决定「全选本页 / 取消全选」语义。 */
  allSelectedInView: boolean;
  knownTags: readonly string[];
  /** 切换「全选本页」。卡片视图没有列头主 checkbox，全选入口收在批量栏里。 */
  onToggleSelectAll: () => void;
  onApplyTagDiff: (diff: { addTags?: string[]; removeTags?: string[] }) => void;
  onReassign: (follower: string) => void;
  onToggleStar: () => void;
  onExport: () => void;
  onCancel: () => void;
}

type TagMode = "add" | "remove";

export const BulkActionsBar = memo(function BulkActionsBar({
  selectedCount,
  allStarred,
  allSelectedInView,
  knownTags,
  onToggleSelectAll,
  onApplyTagDiff,
  onReassign,
  onToggleStar,
  onExport,
  onCancel,
}: BulkActionsBarProps) {
  return (
    <div
      role="toolbar"
      aria-label="批量操作"
      className="flex items-center gap-2 border-b border-workbench-line bg-workbench-surface-active px-4 py-2 text-[12px]"
    >
      <span className="font-medium text-workbench-text">
        {STRINGS.bulk.barTitle(selectedCount)}
      </span>
      <span aria-hidden className="h-4 w-px bg-workbench-line-strong" />

      <ActionButton onClick={onToggleSelectAll} icon={<CheckCheck size={13} />}>
        {allSelectedInView ? STRINGS.bulk.clearSelectionInView : STRINGS.bulk.selectAllInView}
      </ActionButton>

      <TagPickerPopover knownTags={knownTags} onSubmit={(diff) => onApplyTagDiff(diff)} />

      <ReassignPopover onSubmit={onReassign} />

      <ActionButton onClick={onToggleStar} icon={<Star size={13} />}>
        {STRINGS.bulk.starToggle(allStarred)}
      </ActionButton>

      <ActionButton onClick={onExport} icon={<Download size={13} />}>
        {STRINGS.bulk.exportCsv}
      </ActionButton>

      <button
        type="button"
        onClick={onCancel}
        className="focus-ring ml-auto inline-flex h-7 items-center gap-1 rounded-md px-2 text-workbench-text-muted hover:bg-workbench-surface hover:text-workbench-text"
      >
        <X size={12} />
        {STRINGS.bulk.cancel}
      </button>
    </div>
  );
});

function ActionButton({
  children,
  onClick,
  icon,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="focus-ring inline-flex h-7 items-center gap-1.5 rounded-md border border-workbench-line bg-workbench-surface px-2.5 text-workbench-text transition-colors hover:bg-workbench-surface-subtle"
    >
      {icon}
      {children}
    </button>
  );
}

function TagPickerPopover({
  knownTags,
  onSubmit,
}: {
  knownTags: readonly string[];
  onSubmit: (diff: { addTags?: string[]; removeTags?: string[] }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<TagMode>("add");
  const [picked, setPicked] = useState<string[]>([]);

  const allOptions = Array.from(new Set([...knownTags, ...TAG_PRESETS]));

  const reset = () => {
    setMode("add");
    setPicked([]);
  };

  const togglePick = (tag: string) => {
    setPicked((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
  };

  const submit = () => {
    if (picked.length === 0) return;
    onSubmit(mode === "add" ? { addTags: picked } : { removeTags: picked });
    setOpen(false);
    reset();
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          className="focus-ring inline-flex h-7 items-center gap-1.5 rounded-md border border-workbench-line bg-workbench-surface px-2.5 text-workbench-text transition-colors hover:bg-workbench-surface-subtle"
        >
          <Tag size={13} />
          {STRINGS.bulk.addRemoveTag}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="z-30 w-[280px] rounded-lg border border-workbench-line bg-workbench-surface p-2.5 shadow-wb-popover-strong outline-none"
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[12px] font-semibold text-workbench-text">
              {STRINGS.bulk.addRemoveTagDialog.title}
            </span>
          </div>
          <div className="mb-2 grid grid-cols-2 gap-1 rounded-md bg-workbench-surface-subtle p-0.5">
            {(["add", "remove"] as TagMode[]).map((m) => {
              const active = mode === m;
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={cn(
                    "h-7 rounded text-wb-2xs font-medium transition-colors",
                    active
                      ? "bg-workbench-surface text-workbench-text shadow-wb-card-soft"
                      : "text-workbench-text-secondary hover:text-workbench-text",
                  )}
                >
                  {m === "add"
                    ? STRINGS.bulk.addRemoveTagDialog.add
                    : STRINGS.bulk.addRemoveTagDialog.remove}
                </button>
              );
            })}
          </div>
          {allOptions.length === 0 ? (
            <p className="px-1 py-3 text-center text-wb-2xs text-workbench-text-muted">
              {STRINGS.bulk.addRemoveTagDialog.empty}
            </p>
          ) : (
            <div className="flex max-h-[220px] flex-wrap gap-1 overflow-y-auto">
              {allOptions.map((tag) => {
                const active = picked.includes(tag);
                return (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => togglePick(tag)}
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-wb-2xs transition-colors",
                      active
                        ? "border-workbench-accent bg-workbench-accent text-workbench-surface"
                        : "border-workbench-line bg-workbench-surface text-workbench-text-secondary hover:border-workbench-line-strong",
                    )}
                  >
                    {tag}
                  </button>
                );
              })}
            </div>
          )}
          <button
            type="button"
            onClick={submit}
            disabled={picked.length === 0}
            className="mt-2 inline-flex h-8 w-full items-center justify-center rounded-md bg-workbench-accent text-[12px] font-medium text-workbench-surface transition-colors hover:bg-workbench-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {STRINGS.bulk.addRemoveTagDialog.submit}
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// 移交跟进人候选待真后台字典上线;当前仅占位空态,onSubmit 暂不触发。
function ReassignPopover({ onSubmit: _onSubmit }: { onSubmit: (follower: string) => void }) {
  const [open, setOpen] = useState(false);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="focus-ring inline-flex h-7 items-center gap-1.5 rounded-md border border-workbench-line bg-workbench-surface px-2.5 text-workbench-text transition-colors hover:bg-workbench-surface-subtle"
        >
          <UserCheck size={13} />
          {STRINGS.bulk.reassign}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="z-30 min-w-[180px] rounded-lg border border-workbench-line bg-workbench-surface p-1.5 shadow-wb-popover-strong outline-none"
        >
          <div className="px-2 pb-1 text-[12px] font-semibold text-workbench-text">
            {STRINGS.bulk.reassignDialog.title}
          </div>
          <p className="px-2 py-3 text-center text-wb-2xs text-workbench-text-muted">
            {STRINGS.bulk.reassignDialog.empty}
          </p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
