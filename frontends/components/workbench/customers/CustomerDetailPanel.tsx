import { memo, useState } from "react";
import { Copy, MessageCircle, MoreHorizontal, Pencil, Star } from "lucide-react";

import type { Account } from "@/lib/types/account";
import type { Customer } from "@/lib/types/customer";
import { showToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

import { WorkbenchScrollArea } from "../messages/WorkbenchScrollArea";
import { CustomerNoteEditor } from "./CustomerNoteEditor";
import { CustomerStatusCard } from "./CustomerStatusCard";
import { CustomerTagsEditor } from "./CustomerTagsEditor";
import { CustomerTimeline } from "./CustomerTimeline";
import { DETAIL_PANEL_WIDTH, RECENT_MESSAGE_LIMIT } from "./constants";
import type { CustomerRecentMessage } from "./data";
import { STRINGS } from "./strings";
import { formatRelativeTime } from "./utils";

interface CustomerDetailPanelProps {
  customer: Customer | null;
  account: Account | undefined;
  recentMessages: readonly CustomerRecentMessage[];
  onPatch: (patch: Partial<Customer>) => void;
  onAddTag: (tag: string) => void;
  onRemoveTag: (tag: string) => void;
  onToggleStar: () => void;
  onOpenChat: (customerId: string) => void;
}

export const CustomerDetailPanel = memo(function CustomerDetailPanel({
  customer,
  account,
  recentMessages,
  onPatch,
  onAddTag,
  onRemoveTag,
  onToggleStar,
  onOpenChat,
}: CustomerDetailPanelProps) {
  if (!customer) {
    return <EmptyDetail />;
  }
  // key 让客户切换时 DetailBody 重新挂载，自然重置编辑态/草稿，避免在 effect 中同步重置 state。
  return (
    <DetailBody
      key={customer.id}
      customer={customer}
      account={account}
      recentMessages={recentMessages}
      onPatch={onPatch}
      onAddTag={onAddTag}
      onRemoveTag={onRemoveTag}
      onToggleStar={onToggleStar}
      onOpenChat={onOpenChat}
    />
  );
});

function EmptyDetail() {
  return (
    <aside
      style={{ width: DETAIL_PANEL_WIDTH }}
      className="flex h-full shrink-0 flex-col items-center justify-center gap-2 border-l border-workbench-line bg-workbench-surface-subtle px-8 text-center"
    >
      <p className="text-[14px] font-medium text-workbench-text">
        {STRINGS.emptyStates.detail.title}
      </p>
      <p className="text-[12px] text-workbench-text-muted">{STRINGS.emptyStates.detail.hint}</p>
    </aside>
  );
}

function DetailBody({
  customer,
  account,
  recentMessages,
  onPatch,
  onAddTag,
  onRemoveTag,
  onToggleStar,
  onOpenChat,
}: {
  customer: Customer;
  account: Account | undefined;
  recentMessages: readonly CustomerRecentMessage[];
  onPatch: (patch: Partial<Customer>) => void;
  onAddTag: (tag: string) => void;
  onRemoveTag: (tag: string) => void;
  onToggleStar: () => void;
  onOpenChat: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draftRemark, setDraftRemark] = useState(customer.remark);

  const hasChat = Boolean(customer.lastContactAt);

  const onCancel = () => {
    setDraftRemark(customer.remark);
    setEditing(false);
  };

  const onSave = () => {
    if (draftRemark !== customer.remark) {
      onPatch({ remark: draftRemark });
    }
    setEditing(false);
  };

  const handleCopy = (label: string, value: string) => {
    if (!navigator?.clipboard) return;
    void navigator.clipboard.writeText(value).then(() => {
      showToast(`${label}已复制`, { type: "success" });
    });
  };

  return (
    <aside
      style={{ width: DETAIL_PANEL_WIDTH }}
      className="flex h-full shrink-0 flex-col border-l border-workbench-line bg-workbench-surface-subtle"
    >
      <WorkbenchScrollArea
        className="flex-1"
        viewportClassName="px-0"
        contentClassName="flex flex-col gap-4 p-5 pb-6"
      >
        <Header customer={customer} account={account} />

        <ActionRow
          customer={customer}
          editing={editing}
          hasChat={hasChat}
          onToggleStar={onToggleStar}
          onEdit={() => setEditing(true)}
          onCancel={onCancel}
          onSave={onSave}
          onOpenChat={() => onOpenChat(customer.id)}
        />

        <CustomerStatusCard customer={customer} />

        <Section label={STRINGS.detail.sectionTags}>
          <CustomerTagsEditor
            tags={customer.tags}
            editing={editing}
            onAdd={onAddTag}
            onRemove={onRemoveTag}
          />
        </Section>

        <Section label={STRINGS.detail.sectionNote}>
          <CustomerNoteEditor
            value={editing ? draftRemark : customer.remark}
            editing={editing}
            onChange={setDraftRemark}
          />
        </Section>

        <Section label={STRINGS.detail.sectionContact}>
          <ContactList customer={customer} account={account} onCopy={handleCopy} />
        </Section>

        {recentMessages.length > 0 && (
          <Section
            label={STRINGS.detail.sectionRecentMessages}
            action={
              <button
                type="button"
                onClick={() => onOpenChat(customer.id)}
                className="text-wb-3xs font-medium text-workbench-accent hover:underline"
              >
                {STRINGS.detail.seeAllMessages}
              </button>
            }
          >
            <RecentMessages messages={recentMessages.slice(0, RECENT_MESSAGE_LIMIT)} />
          </Section>
        )}

        <Section label={STRINGS.detail.sectionTimeline}>
          <CustomerTimeline entries={customer.timeline} />
        </Section>
      </WorkbenchScrollArea>
    </aside>
  );
}

function Header({ customer, account }: { customer: Customer; account: Account | undefined }) {
  const colorToken = account?.colorToken ?? 1;
  const meta = [customer.company, customer.channel, account && `@${account.name}`]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="flex items-center gap-3">
      <div
        className="grid size-12 shrink-0 place-items-center rounded-full text-[18px] font-medium text-workbench-text shadow-[inset_0_0_0_1px_rgba(255,255,255,0.45)]"
        style={{ background: `hsl(var(--wb-avatar-${colorToken}))` }}
      >
        {customer.name.slice(0, 1)}
      </div>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-[16px] font-semibold text-workbench-text">
          {customer.name}
        </span>
        {meta && <span className="truncate text-[11px] text-workbench-text-secondary">{meta}</span>}
      </div>
    </div>
  );
}

function ActionRow({
  customer,
  editing,
  hasChat,
  onToggleStar,
  onEdit,
  onCancel,
  onSave,
  onOpenChat,
}: {
  customer: Customer;
  editing: boolean;
  hasChat: boolean;
  onToggleStar: () => void;
  onEdit: () => void;
  onCancel: () => void;
  onSave: () => void;
  onOpenChat: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <button
        type="button"
        disabled={!hasChat}
        onClick={onOpenChat}
        className={cn(
          "focus-ring inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12px] font-medium transition-colors",
          hasChat
            ? "bg-workbench-accent text-workbench-surface hover:bg-workbench-accent-hover"
            : "cursor-not-allowed bg-workbench-surface-subtle text-workbench-text-muted",
        )}
        aria-label={
          hasChat ? STRINGS.detail.actions.openChat : STRINGS.detail.actions.openChatDisabled
        }
      >
        <MessageCircle size={13} />
        {hasChat ? STRINGS.detail.actions.openChat : STRINGS.detail.actions.openChatDisabled}
      </button>

      {editing ? (
        <>
          <GhostButton onClick={onSave} variant="primary">
            {STRINGS.detail.actions.saveEdit}
          </GhostButton>
          <GhostButton onClick={onCancel}>{STRINGS.detail.actions.cancelEdit}</GhostButton>
        </>
      ) : (
        <GhostButton onClick={onEdit}>
          <Pencil size={12} className="mr-1" />
          {STRINGS.detail.actions.edit}
        </GhostButton>
      )}

      <GhostButton onClick={onToggleStar}>
        <Star
          size={12}
          className={cn("mr-1", customer.starred && "text-workbench-warning")}
          fill={customer.starred ? "currentColor" : "none"}
        />
        {customer.starred ? STRINGS.detail.actions.starOff : STRINGS.detail.actions.starOn}
      </GhostButton>

      <GhostButton aria-label={STRINGS.detail.actions.more} className="ml-auto">
        <MoreHorizontal size={14} />
      </GhostButton>
    </div>
  );
}

function GhostButton({
  children,
  onClick,
  className,
  variant,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" }) {
  return (
    <button
      type="button"
      onClick={onClick}
      {...rest}
      className={cn(
        "focus-ring inline-flex h-8 items-center rounded-md px-2.5 text-[12px] transition-colors",
        variant === "primary"
          ? "bg-workbench-accent text-workbench-surface hover:bg-workbench-accent-hover"
          : "text-workbench-text-secondary hover:bg-workbench-surface-subtle hover:text-workbench-text",
        className,
      )}
    >
      {children}
    </button>
  );
}

function Section({
  label,
  action,
  children,
}: {
  label: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-[12px] font-medium text-workbench-text-secondary">{label}</span>
        {action && <div className="ml-auto">{action}</div>}
      </div>
      <div>{children}</div>
    </section>
  );
}

function ContactList({
  customer,
  account,
  onCopy,
}: {
  customer: Customer;
  account: Account | undefined;
  onCopy: (label: string, value: string) => void;
}) {
  const f = STRINGS.detail.fields;
  const rows: { label: string; value: string; numeric?: boolean; copy?: boolean }[] = [
    { label: f.weChat, value: customer.weChat, numeric: true, copy: true },
    { label: f.phone, value: customer.phone, numeric: true, copy: true },
    { label: f.company, value: customer.company },
    { label: f.source, value: customer.source },
    { label: f.addedAt, value: customer.addedAt, numeric: true },
    { label: f.follower, value: customer.follower },
    ...(account ? [{ label: "归属账号", value: account.name }] : []),
  ];

  return (
    <dl className="flex flex-col gap-1.5 text-[12px]">
      {rows.map((row) => (
        <div
          key={row.label}
          className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3"
        >
          <dt className="whitespace-nowrap text-workbench-text-muted">{row.label}</dt>
          <dd
            className={cn(
              "min-w-0 truncate text-workbench-text",
              row.numeric && "font-numeric tabular-nums",
            )}
          >
            {row.value || "—"}
          </dd>
          {row.copy && row.value && (
            <button
              type="button"
              onClick={() => onCopy(row.label, row.value)}
              aria-label={`复制 ${row.label}`}
              className="focus-ring grid size-6 place-items-center rounded text-workbench-text-muted hover:bg-workbench-surface hover:text-workbench-text"
            >
              <Copy size={12} />
            </button>
          )}
        </div>
      ))}
    </dl>
  );
}

function RecentMessages({ messages }: { messages: readonly CustomerRecentMessage[] }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {messages.map((m, idx) => (
        <li
          key={`${m.sentAt}-${idx}`}
          className="rounded-lg border border-workbench-line bg-workbench-surface px-2.5 py-1.5 text-[11.5px] leading-relaxed text-workbench-text-secondary"
        >
          <span
            className={cn(
              "mr-1 font-medium",
              m.direction === "out" ? "text-workbench-accent" : "text-workbench-text",
            )}
          >
            {m.direction === "out" ? "我" : "对方"}：
          </span>
          <span>{m.text}</span>
          <div className="mt-0.5 text-wb-3xs text-workbench-text-muted">
            {formatRelativeTime(m.sentAt)}
          </div>
        </li>
      ))}
    </ul>
  );
}
