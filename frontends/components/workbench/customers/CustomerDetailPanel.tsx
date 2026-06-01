import { memo, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import {
  Copy,
  Mars,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Phone,
  Plus,
  RefreshCw,
  Star,
  Venus,
  X,
} from "lucide-react";

import type { Account, AccountStatus } from "@/lib/types/account";
import type { Customer, CustomerTimelineEntry } from "@/lib/types/customer";
import { showToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

import { WorkbenchScrollArea } from "../messages/WorkbenchScrollArea";
import { CustomerAvatar } from "./CustomerAvatar";
import { DETAIL_PANEL_WIDTH, TIMELINE_LIMIT } from "./constants";
import { TAG_PRESETS } from "./data";
import { STRINGS } from "./strings";
import { tagColorClass } from "./tagColor";

interface CustomerDetailPanelProps {
  customer: Customer | null;
  account: Account | undefined;
  onToggleStar: () => void;
  onOpenChat: (customerId: string) => void;
  onCall: (customerId: string) => void;
  onEditCustomer: (customerId: string) => void;
  onMore: (customerId: string) => void;
  onAddTag: (tag: string) => void;
  onRemoveTag: (tag: string) => void;
  onSeeMoreRecords: (customerId: string) => void;
  /** 强制刷新客户详情（isForceRefresh=true）。 */
  onRefresh?: () => void;
  /** 详情拉取中：刷新按钮禁用 + 图标旋转。 */
  refreshing?: boolean;
}

export const CustomerDetailPanel = memo(function CustomerDetailPanel({
  customer,
  account,
  onToggleStar,
  onOpenChat,
  onCall,
  onEditCustomer,
  onMore,
  onAddTag,
  onRemoveTag,
  onSeeMoreRecords,
  onRefresh,
  refreshing,
}: CustomerDetailPanelProps) {
  if (!customer) {
    return <EmptyDetail />;
  }
  // key 让客户切换时 DetailBody 重新挂载，自然重置「添加标签」popover 等本地态。
  return (
    <DetailBody
      key={customer.id}
      customer={customer}
      account={account}
      onToggleStar={onToggleStar}
      onOpenChat={onOpenChat}
      onCall={onCall}
      onEditCustomer={onEditCustomer}
      onMore={onMore}
      onAddTag={onAddTag}
      onRemoveTag={onRemoveTag}
      onSeeMoreRecords={onSeeMoreRecords}
      onRefresh={onRefresh}
      refreshing={refreshing}
    />
  );
});

function EmptyDetail() {
  return (
    <aside
      style={{ width: DETAIL_PANEL_WIDTH }}
      className="flex h-full shrink-0 flex-col items-center justify-center gap-2 px-6 text-center"
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
  onToggleStar,
  onOpenChat,
  onCall,
  onEditCustomer,
  onMore,
  onAddTag,
  onRemoveTag,
  onSeeMoreRecords,
  onRefresh,
  refreshing,
}: {
  customer: Customer;
  account: Account | undefined;
  onToggleStar: () => void;
  onOpenChat: (id: string) => void;
  onCall: (id: string) => void;
  onEditCustomer: (id: string) => void;
  onMore: (id: string) => void;
  onAddTag: (tag: string) => void;
  onRemoveTag: (tag: string) => void;
  onSeeMoreRecords: (id: string) => void;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  const starred = Boolean(customer.starred);
  const handleCopy = (label: string, value: string) => {
    if (!value || !navigator?.clipboard) return;
    void navigator.clipboard.writeText(value).then(() => {
      showToast(`${label}已复制`, { type: "success" });
    });
  };

  return (
    <aside style={{ width: DETAIL_PANEL_WIDTH }} className="flex h-full shrink-0 flex-col">
      <DetailHeaderBar onRefresh={onRefresh} refreshing={refreshing} />

      <WorkbenchScrollArea
        className="flex-1"
        viewportClassName="px-0"
        contentClassName="flex flex-col gap-4 p-4"
      >
        <ProfileHeader
          customer={customer}
          account={account}
          starred={starred}
          onToggleStar={onToggleStar}
          onMore={() => onMore(customer.id)}
        />

        <QuickActions
          onStartChat={() => onOpenChat(customer.id)}
          onCall={() => onCall(customer.id)}
          onEdit={() => onEditCustomer(customer.id)}
          onMore={() => onMore(customer.id)}
        />

        <CustomerInfoSection customer={customer} account={account} onCopy={handleCopy} />

        <TagsSection tags={customer.tags} onAddTag={onAddTag} onRemoveTag={onRemoveTag} />

        <FollowUpSection
          entries={customer.timeline}
          follower={customer.follower}
          onSeeMore={() => onSeeMoreRecords(customer.id)}
        />
      </WorkbenchScrollArea>
    </aside>
  );
}

function DetailHeaderBar({
  onRefresh,
  refreshing,
}: {
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  return (
    <div className="flex h-12 shrink-0 items-center justify-between border-b border-workbench-line px-4">
      <span className="text-[14px] font-semibold text-workbench-text">{STRINGS.detail.title}</span>
      {onRefresh && (
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          aria-label={STRINGS.detail.refresh}
          title={STRINGS.detail.refresh}
          className="grid size-7 place-items-center rounded-md text-workbench-text-muted transition-colors hover:bg-workbench-surface-active hover:text-workbench-text disabled:opacity-50"
        >
          <RefreshCw size={15} className={cn(refreshing && "animate-spin")} />
        </button>
      )}
    </div>
  );
}

function ProfileHeader({
  customer,
  account,
  starred,
  onToggleStar,
  onMore,
}: {
  customer: Customer;
  account: Account | undefined;
  starred: boolean;
  onToggleStar: () => void;
  onMore: () => void;
}) {
  const colorToken = account?.colorToken ?? 1;
  const status = statusMeta(account?.status);
  return (
    <div className="flex items-start gap-3">
      <CustomerAvatar
        customerId={customer.id}
        name={customer.name}
        photoUrl={customer.avatarUrl}
        colorToken={colorToken}
        size={52}
        online={account?.status === "online"}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 pt-0.5">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[16px] font-semibold text-workbench-text">
            {customer.name}
          </span>
          <GenderIcon gender={customer.gender} />
        </div>
        <div className="flex items-center gap-1.5">
          <span aria-hidden className={cn("size-1.5 rounded-full", status.dotClass)} />
          <span className="text-[12px] text-workbench-text-secondary">{status.text}</span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <HeaderIconButton
          ariaLabel={starred ? STRINGS.rowMore.unstar : STRINGS.rowMore.star}
          onClick={onToggleStar}
          active={starred}
        >
          <Star
            size={16}
            fill={starred ? "currentColor" : "none"}
            className={starred ? "text-workbench-warning" : undefined}
          />
        </HeaderIconButton>
        <HeaderIconButton ariaLabel={STRINGS.detail.actions.moreActions} onClick={onMore}>
          <MoreHorizontal size={16} />
        </HeaderIconButton>
      </div>
    </div>
  );
}

function QuickActions({
  onStartChat,
  onCall,
  onEdit,
  onMore,
}: {
  onStartChat: () => void;
  onCall: () => void;
  onEdit: () => void;
  onMore: () => void;
}) {
  return (
    <div className="grid grid-cols-4 gap-1">
      <QuickAction
        label={STRINGS.detail.actions.startChat}
        onClick={onStartChat}
        circleClass="bg-blue-50 text-blue-600 group-hover/qa:bg-blue-100"
      >
        <MessageCircle size={18} />
      </QuickAction>
      <QuickAction
        label={STRINGS.detail.actions.callContact}
        onClick={onCall}
        circleClass="bg-emerald-50 text-emerald-600 group-hover/qa:bg-emerald-100"
      >
        <Phone size={18} />
      </QuickAction>
      <QuickAction
        label={STRINGS.detail.actions.editCustomer}
        onClick={onEdit}
        circleClass="bg-amber-50 text-amber-600 group-hover/qa:bg-amber-100"
      >
        <Pencil size={18} />
      </QuickAction>
      <QuickAction
        label={STRINGS.detail.actions.moreActions}
        onClick={onMore}
        circleClass="bg-slate-100 text-slate-500 group-hover/qa:bg-slate-200"
      >
        <MoreHorizontal size={18} />
      </QuickAction>
    </div>
  );
}

function QuickAction({
  label,
  onClick,
  circleClass,
  children,
}: {
  label: string;
  onClick: () => void;
  circleClass: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="focus-ring group/qa flex flex-col items-center gap-1.5 rounded-lg py-1"
    >
      <span
        className={cn(
          "grid size-11 place-items-center rounded-full transition-colors",
          circleClass,
        )}
      >
        {children}
      </span>
      <span className="text-[11px] text-workbench-text-secondary">{label}</span>
    </button>
  );
}

function CustomerInfoSection({
  customer,
  account,
  onCopy,
}: {
  customer: Customer;
  account: Account | undefined;
  onCopy: (label: string, value: string) => void;
}) {
  const f = STRINGS.detail.fields;
  // 归属账号 = 账号显示名 · 负责人名(负责人来自后端 wecomAccountName,经 customer.follower 透传)。
  const accountName = account?.name ?? customer.account;
  const accountValue = customer.follower ? `${accountName} · ${customer.follower}` : accountName;
  return (
    <section className="flex flex-col gap-2.5">
      <h3 className="text-[13px] font-semibold text-workbench-text">
        {STRINGS.detail.sectionCustomerInfo}
      </h3>
      <dl className="flex flex-col gap-2.5 text-[12px]">
        <InfoRow
          label={f.weChat}
          value={customer.followRemark ?? ""}
          onCopy={() => onCopy(f.weChat, customer.followRemark ?? "")}
        />
        <InfoRow
          label={f.phone}
          value={customer.phone}
          numeric
          onCopy={() => onCopy(f.phone, customer.phone)}
        />
        <InfoRow label={f.company} value={customer.company} />
        <InfoRow label={f.source} value={customer.source} />
        <InfoRow label={f.account} value={accountValue} />
      </dl>
    </section>
  );
}

function InfoRow({
  label,
  value,
  numeric,
  onCopy,
}: {
  label: string;
  value: string;
  numeric?: boolean;
  onCopy?: () => void;
}) {
  const hasValue = Boolean(value && value !== "—");
  return (
    <div className="grid grid-cols-[68px_minmax(0,1fr)_auto] items-center gap-x-2">
      <dt className="whitespace-nowrap text-workbench-text-muted">{label}</dt>
      <dd className={cn("min-w-0 truncate text-workbench-text", numeric && "wb-num tabular-nums")}>
        {hasValue ? value : "—"}
      </dd>
      {onCopy && hasValue ? (
        <button
          type="button"
          onClick={onCopy}
          aria-label={`复制 ${label}`}
          title={`复制 ${label}`}
          className="focus-ring grid size-6 place-items-center rounded text-workbench-text-muted hover:bg-workbench-surface-subtle hover:text-workbench-text"
        >
          <Copy size={13} />
        </button>
      ) : (
        <span aria-hidden />
      )}
    </div>
  );
}

function TagsSection({
  tags,
  onAddTag,
  onRemoveTag,
}: {
  tags: readonly string[];
  onAddTag: (tag: string) => void;
  onRemoveTag: (tag: string) => void;
}) {
  return (
    <section className="flex flex-col gap-2.5">
      <h3 className="text-[13px] font-semibold text-workbench-text">
        {STRINGS.detail.sectionCustomerTags}
      </h3>
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.map((tag) => (
          <span
            key={tag}
            className={cn(
              "group/tag inline-flex max-w-full items-center gap-0.5 rounded px-1.5 py-0.5 text-[11.5px] font-medium",
              tagColorClass(tag),
            )}
          >
            <span className="truncate">{tag}</span>
            <button
              type="button"
              onClick={() => onRemoveTag(tag)}
              aria-label={`移除标签 ${tag}`}
              className="focus-ring -mr-0.5 grid size-3.5 place-items-center rounded-full opacity-60 transition-opacity hover:opacity-100"
            >
              <X size={10} />
            </button>
          </span>
        ))}
        <AddTagPopover existing={tags} onAddTag={onAddTag} />
      </div>
    </section>
  );
}

function AddTagPopover({
  existing,
  onAddTag,
}: {
  existing: readonly string[];
  onAddTag: (tag: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const existingFolded = new Set(existing.map((t) => t.toLocaleLowerCase()));
  const presets = TAG_PRESETS.filter((t) => !existingFolded.has(t.toLocaleLowerCase()));

  const commit = (tag: string) => {
    const value = tag.trim();
    if (!value) return;
    if (existingFolded.has(value.toLocaleLowerCase())) return;
    onAddTag(value);
    setDraft("");
    setOpen(false);
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setDraft("");
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={STRINGS.detail.addTagShort}
          title={STRINGS.detail.addTagShort}
          className="focus-ring inline-flex h-[22px] items-center gap-0.5 rounded border border-dashed border-workbench-line px-1.5 text-[11.5px] text-workbench-text-muted transition-colors hover:border-workbench-accent hover:text-workbench-accent"
        >
          <Plus size={12} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="z-30 w-[220px] rounded-lg border border-workbench-line bg-workbench-surface p-2.5 shadow-wb-popover-strong outline-none"
        >
          <div className="mb-2 text-[12px] font-semibold text-workbench-text">
            {STRINGS.detail.addTagShort}
          </div>
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit(draft);
              }
            }}
            placeholder={STRINGS.detail.addTagPlaceholder}
            className="focus-ring h-8 w-full rounded-md border border-workbench-line bg-workbench-surface-subtle px-2 text-[12px] text-workbench-text placeholder:text-workbench-text-muted focus:border-workbench-accent focus:bg-workbench-surface"
          />
          {presets.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {presets.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => commit(tag)}
                  className="rounded-full border border-workbench-line bg-workbench-surface px-2 py-0.5 text-[11px] text-workbench-text-secondary transition-colors hover:border-workbench-accent hover:text-workbench-accent"
                >
                  {tag}
                </button>
              ))}
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function FollowUpSection({
  entries,
  follower,
  onSeeMore,
}: {
  entries: readonly CustomerTimelineEntry[] | undefined;
  follower: string;
  onSeeMore: () => void;
}) {
  const list = (entries ?? []).slice(0, TIMELINE_LIMIT);
  return (
    <section className="flex flex-col gap-2.5">
      <h3 className="text-[13px] font-semibold text-workbench-text">
        {STRINGS.detail.sectionFollowUp}
      </h3>
      {list.length === 0 ? (
        <p className="text-[12px] text-workbench-text-muted">{STRINGS.detail.emptyFollowUp}</p>
      ) : (
        <>
          <ol className="flex flex-col">
            {list.map((entry, idx) => {
              const isLast = idx === list.length - 1;
              return (
                <li key={`${entry.at}-${idx}`} className="flex gap-2.5">
                  <div className="flex flex-col items-center">
                    <span
                      aria-hidden
                      className={cn(
                        "mt-1 size-2 shrink-0 rounded-full",
                        idx === 0 ? "bg-emerald-500" : "bg-workbench-accent",
                      )}
                    />
                    {!isLast && <span aria-hidden className="w-px flex-1 bg-workbench-line" />}
                  </div>
                  <div className={cn("min-w-0 flex-1", isLast ? "pb-0" : "pb-3")}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="wb-num truncate text-[12px] tabular-nums text-workbench-text">
                        {entry.at}
                      </span>
                      {follower && (
                        <span className="shrink-0 text-[11px] text-workbench-text-muted">
                          {follower}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[12px] leading-relaxed text-workbench-text-secondary">
                      {entry.text}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
          <button
            type="button"
            onClick={onSeeMore}
            className="focus-ring self-start text-[12px] font-medium text-workbench-accent hover:underline"
          >
            {STRINGS.detail.seeMoreRecords}
          </button>
        </>
      )}
    </section>
  );
}

function GenderIcon({ gender }: { gender?: "male" | "female" }) {
  if (gender === "male") return <Mars size={14} className="shrink-0 text-blue-500" />;
  if (gender === "female") return <Venus size={14} className="shrink-0 text-pink-500" />;
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

function statusMeta(status?: AccountStatus): { text: string; dotClass: string } {
  if (status === "online")
    return { text: STRINGS.detail.status.online, dotClass: "bg-emerald-500" };
  if (status === "abnormal")
    return { text: STRINGS.detail.status.abnormal, dotClass: "bg-amber-500" };
  return { text: STRINGS.detail.status.offline, dotClass: "bg-slate-300" };
}
