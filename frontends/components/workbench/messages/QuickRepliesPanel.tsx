import { useMemo, useState } from "react";
import { Pencil, Plus, Search, Trash2 } from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import type { QuickReply } from "./data";
import { STRINGS } from "./strings";

interface QuickRepliesPanelProps {
  items: QuickReply[];
  /** When provided, list rows become clickable and emit the chosen reply text.
   *  Used by the composer popover; the customer-details sidebar omits this
   *  prop and the panel renders as display-only. */
  onSelect?: (reply: QuickReply) => void;
  /** 增删改回调:任一存在即开启管理态(新增按钮 + 行内编辑/删除)。
   *  display-only 场景(CustomerDetails)三者都不传,面板保持纯展示。 */
  onCreate?: (title: string, content: string) => void;
  onUpdate?: (id: string, title: string, content: string) => void;
  onDelete?: (id: string) => void;
}

/** 编辑态:null=不在编辑;"new"=新建;字符串=编辑该 id。 */
type EditingState = "new" | string | null;

export function QuickRepliesPanel({
  items,
  onSelect,
  onCreate,
  onUpdate,
  onDelete,
}: QuickRepliesPanelProps) {
  const t = STRINGS.customerDetails.quickReplies;
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<EditingState>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [contentDraft, setContentDraft] = useState("");

  const canManage = Boolean(onCreate || onUpdate || onDelete);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (item) => item.title.toLowerCase().includes(q) || item.preview.toLowerCase().includes(q),
    );
  }, [items, query]);

  const openCreate = () => {
    setTitleDraft("");
    setContentDraft("");
    setEditing("new");
  };

  const openEdit = (reply: QuickReply) => {
    setTitleDraft(reply.title);
    setContentDraft(reply.preview);
    setEditing(reply.id);
  };

  const closeEditor = () => {
    setEditing(null);
    setTitleDraft("");
    setContentDraft("");
  };

  const handleSave = () => {
    const title = titleDraft.trim();
    const content = contentDraft.trim();
    if (!title || !content) return;
    if (editing === "new") {
      onCreate?.(title, content);
    } else if (editing) {
      onUpdate?.(editing, title, content);
    }
    closeEditor();
  };

  if (editing !== null) {
    return (
      <QuickReplyEditor
        title={titleDraft}
        content={contentDraft}
        onTitleChange={setTitleDraft}
        onContentChange={setContentDraft}
        onSave={handleSave}
        onCancel={closeEditor}
        onDelete={
          editing !== "new" && onDelete
            ? () => {
                onDelete(editing);
                closeEditor();
              }
            : undefined
        }
      />
    );
  }

  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between">
        <span className="text-wb-xs font-semibold text-workbench-text">{t.title}</span>
        {canManage && onCreate && (
          <button
            type="button"
            onClick={openCreate}
            aria-label={t.addAriaLabel}
            className="focus-ring inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-wb-2xs font-medium text-workbench-accent transition-colors hover:bg-workbench-surface-subtle"
          >
            <Plus size={12} />
            {t.add}
          </button>
        )}
      </div>
      <Input
        icon={<Search size={12} />}
        placeholder={t.searchPlaceholder}
        value={query}
        onChange={(e) => setQuery(e.currentTarget.value)}
        className="h-8 rounded border-transparent bg-workbench-surface-soft text-wb-2xs"
      />
      {filtered.length === 0 ? (
        <p className="px-1.5 py-3 text-center text-wb-2xs text-workbench-text-muted">{t.empty}</p>
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
                    <div className="text-wb-2xs font-medium text-workbench-text">{q.title}</div>
                    <p className="text-wb-3xs mt-0.5 truncate text-workbench-text-muted">
                      {q.preview}
                    </p>
                  </div>
                </Row>
                {onUpdate && (
                  <RowIconButton ariaLabel={t.editAriaLabel(q.title)} onClick={() => openEdit(q)}>
                    <Pencil size={11} />
                  </RowIconButton>
                )}
                {onDelete && (
                  <RowIconButton
                    ariaLabel={t.deleteAriaLabel(q.title)}
                    danger
                    onClick={() => onDelete(q.id)}
                  >
                    <Trash2 size={11} />
                  </RowIconButton>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function RowIconButton({
  ariaLabel,
  onClick,
  danger,
  children,
}: {
  ariaLabel: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      title={ariaLabel}
      onClick={onClick}
      className={cn(
        "hit-area-expand focus-ring mr-1.5 mt-1.5 grid size-6 shrink-0 place-items-center rounded text-workbench-text-muted opacity-0 transition-opacity hover:bg-workbench-surface focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100",
        danger ? "hover:text-red-500" : "hover:text-workbench-accent",
      )}
    >
      {children}
    </button>
  );
}

function QuickReplyEditor({
  title,
  content,
  onTitleChange,
  onContentChange,
  onSave,
  onCancel,
  onDelete,
}: {
  title: string;
  content: string;
  onTitleChange: (v: string) => void;
  onContentChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const t = STRINGS.customerDetails.quickReplies;
  const canSave = title.trim().length > 0 && content.trim().length > 0;
  return (
    <section className="flex flex-col gap-2">
      <span className="text-wb-xs font-semibold text-workbench-text">{t.title}</span>
      <Input
        placeholder={t.titlePlaceholder}
        value={title}
        onChange={(e) => onTitleChange(e.currentTarget.value)}
        className="h-8 rounded border-workbench-line bg-workbench-surface-soft text-wb-2xs"
      />
      <textarea
        placeholder={t.contentPlaceholder}
        value={content}
        onChange={(e) => onContentChange(e.currentTarget.value)}
        rows={4}
        className="focus-ring w-full resize-none rounded border border-workbench-line bg-workbench-surface-soft px-2 py-1.5 text-wb-2xs text-workbench-text placeholder:text-workbench-text-muted"
      />
      <div className="flex items-center justify-between gap-2">
        {onDelete ? (
          <button
            type="button"
            onClick={onDelete}
            className="focus-ring inline-flex items-center gap-1 rounded px-2 py-1 text-wb-2xs font-medium text-red-500 transition-colors hover:bg-red-50"
          >
            <Trash2 size={12} />
            {t.delete}
          </button>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onCancel}
            className="focus-ring rounded px-2.5 py-1 text-wb-2xs font-medium text-workbench-text-secondary transition-colors hover:bg-workbench-surface-subtle"
          >
            {t.cancel}
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={!canSave}
            className="focus-ring rounded bg-workbench-accent px-2.5 py-1 text-wb-2xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {t.save}
          </button>
        </div>
      </div>
    </section>
  );
}
