import { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from "react";

import type { Conversation } from "./data";
import { STRINGS } from "./strings";
import { pickAvatarColor } from "./utils";

export interface MentionListProps {
  query: string;
  candidates: Conversation[];
  onSelect: (name: string) => void;
}

export interface MentionListHandle {
  /** Returns true when the list consumed the key (so the editor should swallow it). */
  onKeyDown: (event: KeyboardEvent) => boolean;
}

export const MentionList = forwardRef<MentionListHandle, MentionListProps>(function MentionList(
  { query, candidates, onSelect },
  ref,
) {
  // Filter on the substring after `@`. Match name OR account so a typist
  // can find by either; case-insensitive for the rare ASCII alias.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return candidates.slice(0, 8);
    return candidates
      .filter((c) => c.name.toLowerCase().includes(q) || c.account.toLowerCase().includes(q))
      .slice(0, 8);
  }, [candidates, query]);

  const [selectedIndex, setSelectedIndex] = useState(0);

  // Reset highlight whenever the candidate list shape changes (query typed,
  // upstream candidates swap). Keeps the keyboard-driven selection in bounds.
  useEffect(() => {
    setSelectedIndex(0);
  }, [query, filtered.length]);

  // Shared commit path so click and keyboard pick the same row identically.
  const commit = (index: number) => {
    const target = filtered[index];
    if (!target) return;
    onSelect(target.name);
  };

  useImperativeHandle(
    ref,
    () => ({
      onKeyDown: (event) => {
        if (filtered.length === 0) return false;
        if (event.key === "ArrowDown") {
          setSelectedIndex((prev) => (prev + 1) % filtered.length);
          return true;
        }
        if (event.key === "ArrowUp") {
          setSelectedIndex((prev) => (prev - 1 + filtered.length) % filtered.length);
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          // Inline commit so this hook's dep list is exhaustive without
          // pulling `commit` (recreated each render) into the deps.
          const target = filtered[selectedIndex];
          if (target) onSelect(target.name);
          return true;
        }
        return false;
      },
    }),
    [filtered, selectedIndex, onSelect],
  );

  if (filtered.length === 0) {
    return (
      <p className="px-2 py-3 text-center text-wb-2xs text-workbench-text-muted">
        {STRINGS.conversationList.noConversation}
      </p>
    );
  }

  return (
    <ul
      role="listbox"
      aria-label={STRINGS.composer.mentionListLabel}
      aria-activedescendant={`mention-opt-${selectedIndex}`}
      tabIndex={-1}
      className="flex flex-col gap-0.5"
    >
      {filtered.map((c, i) => {
        const selected = i === selectedIndex;
        return (
          <li key={c.id}>
            <button
              type="button"
              role="option"
              id={`mention-opt-${i}`}
              aria-selected={selected}
              onClick={() => commit(i)}
              onMouseEnter={() => setSelectedIndex(i)}
              className={`focus-ring flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors hover:bg-workbench-surface-subtle ${
                selected ? "bg-workbench-surface-subtle" : ""
              }`}
            >
              <span
                aria-hidden
                className="grid size-7 shrink-0 place-items-center rounded-full text-wb-2xs font-medium text-workbench-text"
                style={{ background: pickAvatarColor(c.id) }}
              >
                {c.name.slice(0, 1)}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-wb-2xs font-medium text-workbench-text">
                  {c.name}
                </span>
                <span className="truncate text-wb-3xs text-workbench-text-muted">{c.account}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
});
