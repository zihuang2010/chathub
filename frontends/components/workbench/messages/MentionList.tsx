import { useMemo } from "react";

import type { Conversation } from "./data";
import { STRINGS } from "./strings";
import { pickAvatarColor } from "./utils";

interface MentionListProps {
  query: string;
  candidates: Conversation[];
  onSelect: (name: string) => void;
}

export function MentionList({ query, candidates, onSelect }: MentionListProps) {
  // Filter on the substring after `@`. Match name OR account so a typist
  // can find by either; case-insensitive for the rare ASCII alias.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return candidates.slice(0, 8);
    return candidates
      .filter((c) => c.name.toLowerCase().includes(q) || c.account.toLowerCase().includes(q))
      .slice(0, 8);
  }, [candidates, query]);

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
      className="flex flex-col gap-0.5"
    >
      {filtered.map((c) => (
        <li key={c.id}>
          <button
            type="button"
            role="option"
            aria-selected={false}
            onClick={() => onSelect(c.name)}
            className="focus-ring flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors hover:bg-workbench-surface-subtle"
          >
            <span
              aria-hidden
              className="grid size-7 shrink-0 place-items-center rounded-full text-wb-2xs font-medium text-workbench-text"
              style={{ background: pickAvatarColor(c.id) }}
            >
              {c.name.slice(0, 1)}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-wb-2xs font-medium text-workbench-text">{c.name}</span>
              <span className="truncate text-wb-3xs text-workbench-text-muted">{c.account}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
