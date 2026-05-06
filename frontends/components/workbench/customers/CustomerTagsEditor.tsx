import { memo, useState, type KeyboardEvent } from "react";
import { Plus, X } from "lucide-react";

import { cn } from "@/lib/utils";

import { TAG_PRESETS } from "./data";
import { STRINGS } from "./strings";

interface CustomerTagsEditorProps {
  tags: readonly string[];
  editing: boolean;
  onAdd: (tag: string) => void;
  onRemove: (tag: string) => void;
}

export const CustomerTagsEditor = memo(function CustomerTagsEditor({
  tags,
  editing,
  onAdd,
  onRemove,
}: CustomerTagsEditorProps) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tags.map((tag) => (
        <span
          key={tag}
          className={cn(
            "inline-flex items-center gap-1 rounded-full border border-workbench-line bg-workbench-surface-subtle px-2 py-0.5 text-wb-2xs text-workbench-text-secondary",
          )}
        >
          {tag}
          {editing && (
            <button
              type="button"
              onClick={() => onRemove(tag)}
              aria-label={`移除标签 ${tag}`}
              className="focus-ring grid size-3.5 place-items-center rounded-full hover:bg-workbench-line"
            >
              <X size={10} />
            </button>
          )}
        </span>
      ))}
      {editing && <AddTag onAdd={onAdd} existing={tags} />}
      {!editing && tags.length === 0 && (
        <span className="text-wb-2xs text-workbench-text-muted">尚未打标签</span>
      )}
    </div>
  );
});

function AddTag({
  onAdd,
  existing,
}: {
  onAdd: (tag: string) => void;
  existing: readonly string[];
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");

  const close = () => {
    setOpen(false);
    setValue("");
  };

  const submit = (raw: string) => {
    const next = raw.trim();
    if (!next) return;
    if (!existing.includes(next)) onAdd(next);
    close();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit(value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="focus-ring inline-flex items-center gap-1 rounded-full border border-dashed border-workbench-line px-2 py-0.5 text-wb-2xs text-workbench-text-muted transition-colors hover:border-workbench-accent hover:text-workbench-accent"
      >
        <Plus size={10} />
        {STRINGS.detail.addTag}
      </button>
    );
  }

  const presetSuggestions = TAG_PRESETS.filter((t) => !existing.includes(t)).slice(0, 5);

  return (
    <div className="flex flex-wrap items-center gap-1">
      <input
        autoFocus
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => submit(value)}
        onKeyDown={onKeyDown}
        placeholder={STRINGS.detail.addTagPlaceholder}
        className="focus-ring h-6 w-[140px] rounded-full border border-workbench-line bg-workbench-surface px-2 text-wb-2xs text-workbench-text"
      />
      {presetSuggestions.map((tag) => (
        <button
          key={tag}
          type="button"
          onMouseDown={(e) => {
            e.preventDefault();
            submit(tag);
          }}
          className="rounded-full border border-workbench-line bg-workbench-surface px-2 py-0.5 text-wb-3xs text-workbench-text-muted transition-colors hover:border-workbench-accent hover:text-workbench-accent"
        >
          {tag}
        </button>
      ))}
    </div>
  );
}
