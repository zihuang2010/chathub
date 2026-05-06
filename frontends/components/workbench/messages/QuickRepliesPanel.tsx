import { useMemo, useState } from "react";
import { Pencil, Search } from "lucide-react";

import { Input } from "@/components/ui/input";

import type { QuickReply } from "./data";
import { STRINGS } from "./strings";

interface QuickRepliesPanelProps {
  items: QuickReply[];
  /** When provided, list rows become clickable and emit the chosen reply text.
   *  Used by the composer popover; the customer-details sidebar omits this
   *  prop and the panel renders as display-only. */
  onSelect?: (reply: QuickReply) => void;
}

export function QuickRepliesPanel({ items, onSelect }: QuickRepliesPanelProps) {
  const t = STRINGS.customerDetails.quickReplies;
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (item) => item.title.toLowerCase().includes(q) || item.preview.toLowerCase().includes(q),
    );
  }, [items, query]);

  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-semibold text-workbench-text">{t.title}</span>
        <button
          type="button"
          className="focus-ring rounded px-1 py-0.5 text-wb-2xs font-medium text-workbench-accent transition-colors hover:bg-workbench-surface-subtle"
        >
          {t.manage}
        </button>
      </div>
      <Input
        icon={<Search size={12} />}
        placeholder={t.searchPlaceholder}
        value={query}
        onChange={(e) => setQuery(e.currentTarget.value)}
        className="h-8 rounded border-transparent bg-workbench-surface-soft text-[12px]"
      />
      {filtered.length === 0 ? (
        <p className="px-1.5 py-3 text-center text-[12px] text-workbench-text-muted">
          {STRINGS.conversationList.noConversation /* reuse generic empty state */}
        </p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {filtered.map((q) => {
            const Row = onSelect ? "button" : "div";
            return (
              <li key={q.id} className="group flex items-start gap-1.5 rounded">
                <Row
                  type={onSelect ? "button" : undefined}
                  onClick={onSelect ? () => onSelect(q) : undefined}
                  className={
                    onSelect
                      ? "focus-ring flex min-w-0 flex-1 items-start gap-1.5 rounded px-1.5 py-1.5 text-left transition-colors hover:bg-workbench-surface-subtle"
                      : "flex min-w-0 flex-1 items-start gap-1.5 rounded px-1.5 py-1.5 transition-colors hover:bg-workbench-surface-subtle"
                  }
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-[12px] font-medium text-workbench-text">{q.title}</div>
                    <p className="mt-0.5 truncate text-[11px] text-workbench-text-muted">
                      {q.preview}
                    </p>
                  </div>
                </Row>
                <button
                  type="button"
                  aria-label={t.editAriaLabel(q.title)}
                  className="hit-area-expand focus-ring mr-1.5 mt-1.5 grid size-6 shrink-0 place-items-center rounded text-workbench-text-muted opacity-0 transition-opacity hover:bg-workbench-surface hover:text-workbench-accent focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
                >
                  <Pencil size={11} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
