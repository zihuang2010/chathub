import { memo, useState } from "react";
import { Copy, Mars, MoreHorizontal, Phone, Star, Venus } from "lucide-react";

import type { Account } from "@/lib/types/account";
import type { Customer } from "@/lib/types/customer";
import { showToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

import { WorkbenchScrollArea } from "../messages/WorkbenchScrollArea";
import { CustomerAvatar } from "./CustomerAvatar";
import { CustomerDetailStatsCards } from "./CustomerDetailStatsCards";
import {
  DETAIL_PANEL_WIDTH,
  DETAIL_TAB_OPTIONS,
  RECENT_MESSAGE_LIMIT,
  type DetailTab,
} from "./constants";
import type { CustomerRecentMessage } from "./data";
import { isKeyCustomer } from "./customerLabels";
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
  onEditCustomer: (customerId: string) => void;
  onFollowUpHistory: (customerId: string) => void;
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
  onEditCustomer,
  onFollowUpHistory,
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
      onEditCustomer={onEditCustomer}
      onFollowUpHistory={onFollowUpHistory}
    />
  );
});

function EmptyDetail() {
  return (
    <aside
      style={{ width: DETAIL_PANEL_WIDTH }}
      className="flex h-full shrink-0 flex-col items-center justify-center gap-2 border-l border-workbench-line bg-workbench-surface px-8 text-center"
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
  onAddTag,
  onRemoveTag,
  onToggleStar,
  onOpenChat,
  onEditCustomer,
  onFollowUpHistory,
}: {
  customer: Customer;
  account: Account | undefined;
  recentMessages: readonly CustomerRecentMessage[];
  onPatch: (patch: Partial<Customer>) => void;
  onAddTag: (tag: string) => void;
  onRemoveTag: (tag: string) => void;
  onToggleStar: () => void;
  onOpenChat: (id: string) => void;
  onEditCustomer: (id: string) => void;
  onFollowUpHistory: (id: string) => void;
}) {
  const [activeSubTab, setActiveSubTab] = useState<DetailTab>("info");
  const starred = Boolean(customer.starred);
  const handleCopy = (label: string, value: string) => {
    if (!navigator?.clipboard) return;
    void navigator.clipboard.writeText(value).then(() => {
      showToast(`${label}已复制`, { type: "success" });
    });
  };
  // 引用 onAddTag/onRemoveTag 让 lint 满意；客户标签编辑入口将在「编辑客户」弹窗中实现。
  void onAddTag;
  void onRemoveTag;

  return (
    <aside
      style={{ width: DETAIL_PANEL_WIDTH }}
      className="flex h-full shrink-0 flex-col border-l border-workbench-line bg-workbench-surface"
    >
      <DetailHeaderBar />

      <WorkbenchScrollArea
        className="flex-1"
        viewportClassName="px-0"
        contentClassName="flex flex-col gap-3 p-4 pb-4"
      >
        <ProfileHeader
          customer={customer}
          account={account}
          starred={starred}
          onToggleStar={onToggleStar}
        />

        <CustomerDetailStatsCards customer={customer} />

        <DetailSubTabs active={activeSubTab} onChange={setActiveSubTab} />

        {activeSubTab === "info" ? (
          <InfoTabContent customer={customer} onCopy={handleCopy} />
        ) : (
          <PlaceholderTab />
        )}

        {activeSubTab === "info" && (
          <>
            <ContactInfoSection customer={customer} account={account} />

            {recentMessages.length > 0 && (
              <RecentMessagesSection
                messages={recentMessages.slice(0, RECENT_MESSAGE_LIMIT)}
                onSeeAll={() => onOpenChat(customer.id)}
              />
            )}
          </>
        )}
      </WorkbenchScrollArea>

      <FooterActions
        onStartChat={() => onOpenChat(customer.id)}
        onEdit={() => onEditCustomer(customer.id)}
        onFollowUpHistory={() => onFollowUpHistory(customer.id)}
      />
    </aside>
  );
}

function DetailHeaderBar() {
  return (
    <div className="flex h-12 shrink-0 items-center justify-between border-b border-workbench-line px-4">
      <span className="text-[14px] font-semibold text-workbench-text">{STRINGS.detail.title}</span>
    </div>
  );
}

function ProfileHeader({
  customer,
  account,
  starred,
  onToggleStar,
}: {
  customer: Customer;
  account: Account | undefined;
  starred: boolean;
  onToggleStar: () => void;
}) {
  const colorToken = account?.colorToken ?? 1;
  const isKey = isKeyCustomer(customer);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-3">
        <CustomerAvatar
          customerId={customer.id}
          name={customer.name}
          colorToken={colorToken}
          size={48}
          online={account?.status === "online"}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[16px] font-semibold text-workbench-text">
              {customer.name}
            </span>
            <GenderIcon gender={customer.gender} />
          </div>
          {customer.company && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="truncate text-[12px] text-workbench-text-secondary">
                {customer.company}
              </span>
              {isKey && (
                <span className="inline-flex items-center rounded bg-blue-50 px-1.5 py-0.5 text-[11px] font-medium text-blue-700 ring-1 ring-blue-100">
                  {STRINGS.detail.keyCustomerChip}
                </span>
              )}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <HeaderIconButton
            ariaLabel={starred ? STRINGS.rowMore.unstar : STRINGS.rowMore.star}
            onClick={onToggleStar}
            active={starred}
          >
            <Star
              size={14}
              fill={starred ? "currentColor" : "none"}
              className={starred ? "text-workbench-warning" : undefined}
            />
          </HeaderIconButton>
          <HeaderIconButton ariaLabel={STRINGS.detail.actions.more}>
            <MoreHorizontal size={14} />
          </HeaderIconButton>
        </div>
      </div>

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12px]">
        {customer.source && (
          <>
            <dt className="text-workbench-text-muted">{STRINGS.detail.fields.source}：</dt>
            <dd className="min-w-0 truncate text-workbench-text">{customer.source}</dd>
          </>
        )}
        {account && (
          <>
            <dt className="text-workbench-text-muted">{STRINGS.detail.fields.account}：</dt>
            <dd className="min-w-0 truncate text-workbench-text">
              {account.name}
              {account.ownerName ? ` · ${account.ownerName}` : ""}
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}

function GenderIcon({ gender }: { gender?: "male" | "female" }) {
  if (gender === "male") return <Mars size={13} className="shrink-0 text-blue-500" />;
  if (gender === "female") return <Venus size={13} className="shrink-0 text-pink-500" />;
  return null;
}

function HeaderIconButton({
  children,
  active,
  ariaLabel,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean; ariaLabel: string }) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      title={ariaLabel}
      {...rest}
      className={cn(
        "focus-ring grid size-7 place-items-center rounded-md transition-colors",
        active
          ? "text-workbench-warning hover:bg-workbench-surface-subtle"
          : "text-workbench-text-secondary hover:bg-workbench-surface-subtle hover:text-workbench-text",
      )}
    >
      {children}
    </button>
  );
}

function DetailSubTabs({
  active,
  onChange,
}: {
  active: DetailTab;
  onChange: (tab: DetailTab) => void;
}) {
  return (
    <nav
      role="tablist"
      aria-label="客户详情视图"
      className="-mx-4 flex min-w-0 gap-3 overflow-x-auto border-b border-workbench-line px-4"
    >
      {DETAIL_TAB_OPTIONS.map((tab) => {
        const selected = tab.value === active;
        return (
          <button
            key={tab.value}
            role="tab"
            type="button"
            aria-selected={selected}
            onClick={() => onChange(tab.value)}
            className={cn(
              "focus-ring relative inline-flex h-9 shrink-0 items-center text-[12.5px] transition-colors",
              selected
                ? "font-semibold text-workbench-text"
                : "text-workbench-text-secondary hover:text-workbench-text",
            )}
          >
            <span>{tab.label}</span>
            {selected && (
              <span
                aria-hidden
                className="absolute inset-x-0 bottom-0 h-[2px] rounded-t bg-workbench-accent"
              />
            )}
          </button>
        );
      })}
    </nav>
  );
}

function InfoTabContent({
  customer,
  onCopy,
}: {
  customer: Customer;
  onCopy: (label: string, value: string) => void;
}) {
  const f = STRINGS.detail.fields;
  return (
    <dl className="flex flex-col gap-2 text-[12px]">
      <FieldRow
        label={f.phone}
        value={customer.phone}
        numeric
        leadingIcon={<Phone size={12} className="text-workbench-text-muted" />}
      />
      <FieldRow
        label={f.weChat}
        value={customer.weChat}
        copyable
        onCopy={() => onCopy(f.weChat, customer.weChat)}
      />
      {customer.industry && <FieldRow label={f.industry} value={customer.industry} />}
      <FieldRow label={f.company} value={customer.company} />
      {customer.region && <FieldRow label={f.region} value={customer.region} />}
      {customer.address && <FieldRow label={f.address} value={customer.address} />}
      <FieldRow
        label={f.tags}
        value={
          customer.tags.length > 0 ? (
            <TagChipGroup tags={customer.tags} />
          ) : (
            <span className="text-workbench-text-muted">—</span>
          )
        }
      />
      {customer.remark && (
        <FieldRow label={STRINGS.detail.sectionNote} value={customer.remark} multiline />
      )}
    </dl>
  );
}

function FieldRow({
  label,
  value,
  numeric,
  copyable,
  multiline,
  leadingIcon,
  onCopy,
}: {
  label: string;
  value: React.ReactNode;
  numeric?: boolean;
  copyable?: boolean;
  multiline?: boolean;
  leadingIcon?: React.ReactNode;
  onCopy?: () => void;
}) {
  return (
    <div className="grid grid-cols-[80px_minmax(0,1fr)_auto] items-start gap-x-3">
      <dt className="whitespace-nowrap pt-0.5 text-workbench-text-muted">{label}</dt>
      <dd
        className={cn(
          "flex min-w-0 items-start gap-1.5 text-workbench-text",
          multiline ? "leading-relaxed" : "truncate",
        )}
      >
        {leadingIcon}
        <span
          className={cn(
            "min-w-0",
            multiline ? "whitespace-pre-wrap break-words" : "truncate",
            numeric && "wb-num font-numeric tabular-nums",
          )}
        >
          {value || "—"}
        </span>
      </dd>
      {copyable && onCopy ? (
        <button
          type="button"
          onClick={onCopy}
          aria-label={`复制 ${label}`}
          className="focus-ring grid size-6 place-items-center rounded text-workbench-text-muted hover:bg-workbench-surface-subtle hover:text-workbench-text"
        >
          <Copy size={12} />
        </button>
      ) : (
        <span aria-hidden />
      )}
    </div>
  );
}

function TagChipGroup({ tags }: { tags: readonly string[] }) {
  const visible = tags.slice(0, 3);
  const overflow = tags.length - visible.length;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {visible.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center rounded bg-workbench-surface-subtle px-1.5 py-0.5 text-[11.5px] text-workbench-text-secondary"
        >
          {tag}
        </span>
      ))}
      {overflow > 0 && (
        <span className="inline-flex items-center rounded bg-workbench-surface-subtle px-1.5 py-0.5 text-[11.5px] text-workbench-text-muted">
          +{overflow}
        </span>
      )}
    </div>
  );
}

function ContactInfoSection({
  customer,
  account,
}: {
  customer: Customer;
  account: Account | undefined;
}) {
  return (
    <section className="flex flex-col gap-2 border-t border-workbench-line-subtle pt-3">
      <h3 className="text-[12px] font-semibold text-workbench-text">
        {STRINGS.detail.sectionContactInfo}
      </h3>
      <dl className="flex flex-col gap-2 text-[12px]">
        <FieldRow label={STRINGS.detail.fields.follower} value={customer.follower} />
        <FieldRow label={STRINGS.detail.fields.addedAt} value={customer.addedAt} numeric />
        {account && <FieldRow label={STRINGS.detail.fields.account} value={account.name} />}
      </dl>
    </section>
  );
}

function RecentMessagesSection({
  messages,
  onSeeAll,
}: {
  messages: readonly CustomerRecentMessage[];
  onSeeAll: () => void;
}) {
  return (
    <section className="flex flex-col gap-2 border-t border-workbench-line-subtle pt-3">
      <div className="flex items-center justify-between">
        <h3 className="text-[12px] font-semibold text-workbench-text">
          {STRINGS.detail.sectionRecentMessages}
        </h3>
        <button
          type="button"
          onClick={onSeeAll}
          className="text-wb-3xs font-medium text-workbench-accent hover:underline"
        >
          {STRINGS.detail.seeAllMessages}
        </button>
      </div>
      <ul className="flex flex-col gap-1.5">
        {messages.map((m, idx) => (
          <li
            key={`${m.sentAt}-${idx}`}
            className="rounded-lg border border-workbench-line bg-workbench-surface-subtle px-2.5 py-1.5 text-[11.5px] leading-relaxed text-workbench-text-secondary"
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
    </section>
  );
}

function PlaceholderTab() {
  return (
    <div className="flex flex-1 items-center justify-center py-12 text-[12px] text-workbench-text-muted">
      {STRINGS.emptyStates.detailTabPlaceholder}
    </div>
  );
}

function FooterActions({
  onStartChat,
  onEdit,
  onFollowUpHistory,
}: {
  onStartChat: () => void;
  onEdit: () => void;
  onFollowUpHistory: () => void;
}) {
  // v3：3 按钮，primary 角色由「跟进记录」承担（参考稿设计），与 v2 的 startChat
  // primary 不同 — 这是日常最高频操作的视觉强调。
  return (
    <div className="flex flex-shrink-0 gap-2 border-t border-workbench-line px-4 py-3">
      <button
        type="button"
        onClick={onStartChat}
        className="focus-ring inline-flex h-9 flex-1 items-center justify-center rounded-md border border-workbench-line bg-workbench-surface px-2 text-[12.5px] text-workbench-text transition-colors hover:border-workbench-line-strong hover:bg-workbench-surface-subtle"
      >
        {STRINGS.detail.actions.startChat}
      </button>
      <button
        type="button"
        onClick={onEdit}
        className="focus-ring inline-flex h-9 flex-1 items-center justify-center rounded-md border border-workbench-line bg-workbench-surface px-2 text-[12.5px] text-workbench-text transition-colors hover:border-workbench-line-strong hover:bg-workbench-surface-subtle"
      >
        {STRINGS.detail.actions.editCustomer}
      </button>
      <button
        type="button"
        onClick={onFollowUpHistory}
        className="focus-ring inline-flex h-9 flex-1 items-center justify-center rounded-md bg-workbench-accent px-2 text-[12.5px] font-medium text-workbench-surface transition-colors hover:bg-workbench-accent-hover"
      >
        {STRINGS.detail.actions.followUpHistory}
      </button>
    </div>
  );
}
