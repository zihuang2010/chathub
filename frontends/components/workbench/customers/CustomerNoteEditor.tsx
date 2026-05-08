import { memo, useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

import { NOTE_COLLAPSE_LINES } from "./constants";
import { STRINGS } from "./strings";

interface CustomerNoteEditorProps {
  value: string;
  editing: boolean;
  onChange: (next: string) => void;
}

export const CustomerNoteEditor = memo(function CustomerNoteEditor({
  value,
  editing,
  onChange,
}: CustomerNoteEditorProps) {
  const [expanded, setExpanded] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // 进入编辑态时自动聚焦到末尾，照顾连续编辑场景。
  useEffect(() => {
    if (editing && taRef.current) {
      const el = taRef.current;
      el.focus();
      const len = el.value.length;
      el.setSelectionRange(len, len);
    }
  }, [editing]);

  // 三种状态（编辑/空/已填）共用相同 min-height，避免切换时跳动。
  // 88px ≈ rows={4} + py-2 上下内边距。
  const SHARED_BOX = "min-h-[88px] rounded-lg px-3 py-2 text-[12px] leading-relaxed";

  if (editing) {
    return (
      <textarea
        ref={taRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={STRINGS.detail.notePlaceholder}
        rows={4}
        className={cn(
          "focus-ring w-full resize-y border border-workbench-line bg-workbench-surface text-workbench-text placeholder:text-workbench-text-muted",
          SHARED_BOX,
        )}
      />
    );
  }

  if (!value) {
    return (
      <p
        className={cn(
          "border border-dashed border-workbench-line bg-workbench-surface text-workbench-text-muted",
          SHARED_BOX,
        )}
      >
        {STRINGS.detail.noteEmpty}
      </p>
    );
  }

  // 简单基于换行折叠：超过 NOTE_COLLAPSE_LINES 行时显示"展开"。
  const lines = value.split("\n");
  const overflows = lines.length > NOTE_COLLAPSE_LINES;
  const displayed = !expanded && overflows ? lines.slice(0, NOTE_COLLAPSE_LINES).join("\n") : value;

  return (
    <div
      className={cn(
        "border border-workbench-line bg-workbench-surface text-workbench-text shadow-wb-card-soft",
        SHARED_BOX,
      )}
    >
      <p className={cn("whitespace-pre-wrap", !expanded && overflows && "line-clamp-4")}>
        {displayed}
      </p>
      {overflows && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-wb-3xs font-medium text-workbench-accent hover:underline"
        >
          {expanded ? STRINGS.detail.collapse : STRINGS.detail.expand}
        </button>
      )}
    </div>
  );
});
