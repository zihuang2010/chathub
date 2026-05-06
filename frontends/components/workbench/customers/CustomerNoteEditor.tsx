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

  if (editing) {
    return (
      <textarea
        ref={taRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={STRINGS.detail.notePlaceholder}
        rows={4}
        className="focus-ring w-full resize-y rounded-lg border border-workbench-line bg-workbench-surface px-3 py-2 text-[12px] leading-relaxed text-workbench-text placeholder:text-workbench-text-muted"
      />
    );
  }

  if (!value) {
    return (
      <p className="rounded-lg bg-workbench-surface px-3 py-2 text-[12px] text-workbench-text-muted">
        {STRINGS.detail.noteEmpty}
      </p>
    );
  }

  // 简单基于换行折叠：超过 NOTE_COLLAPSE_LINES 行时显示"展开"。
  const lines = value.split("\n");
  const overflows = lines.length > NOTE_COLLAPSE_LINES;
  const displayed = !expanded && overflows ? lines.slice(0, NOTE_COLLAPSE_LINES).join("\n") : value;

  return (
    <div className="rounded-lg border border-workbench-line bg-workbench-surface px-3 py-2 text-[12px] leading-relaxed text-workbench-text shadow-wb-card-soft">
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
