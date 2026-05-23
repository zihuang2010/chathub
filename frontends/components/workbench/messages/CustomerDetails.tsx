import { memo, useState } from "react";
import { Plus } from "lucide-react";

import { cn } from "@/lib/utils";

import type { Customer, QuickReply } from "./data";
import { QuickRepliesPanel } from "./QuickRepliesPanel";
import { STRINGS } from "./strings";
import { pickAvatarColor, pickCustomerAvatarImage } from "./utils";

type DetailsTab = "profile" | "replies" | "trace";

const TABS: { value: DetailsTab; label: string }[] = [
  { value: "profile", label: STRINGS.customerDetails.tabProfile },
  { value: "replies", label: STRINGS.customerDetails.tabReplies },
  { value: "trace", label: STRINGS.customerDetails.tabTrace },
];

interface CustomerDetailsProps {
  /** 客户档案数据;真实接口对接前传 null,profile tab 走"未对接"空态。 */
  customer: Customer | null;
  quickReplies: QuickReply[];
}

export const CustomerDetails = memo(function CustomerDetails({
  customer,
  quickReplies,
}: CustomerDetailsProps) {
  const [tab, setTab] = useState<DetailsTab>("profile");

  return (
    <aside className="flex h-full w-[324px] shrink-0 flex-col border-l border-workbench-line bg-workbench-surface">
      <Tabs value={tab} onChange={setTab} />
      <div
        role="tabpanel"
        id={`customer-details-panel-${tab}`}
        aria-labelledby={`customer-details-tab-${tab}`}
        className="flex-1 overflow-y-auto"
      >
        {tab === "profile" &&
          (customer ? (
            <ProfileTab customer={customer} quickReplies={quickReplies} />
          ) : (
            <EmptyTab text={STRINGS.empty.loading} />
          ))}
        {tab === "replies" && <EmptyTab text={STRINGS.customerDetails.emptyReplies} />}
        {tab === "trace" && <EmptyTab text={STRINGS.customerDetails.emptyTrace} />}
      </div>
    </aside>
  );
});

// ─── Tabs ───────────────────────────────────────────────────────────────────

function Tabs({ value, onChange }: { value: DetailsTab; onChange: (t: DetailsTab) => void }) {
  return (
    <div
      role="tablist"
      aria-label={STRINGS.customerDetails.tabsLabel}
      className="grid grid-cols-3 border-b border-workbench-line px-2 pt-2"
    >
      {TABS.map((t) => {
        const active = t.value === value;
        return (
          <button
            key={t.value}
            id={`customer-details-tab-${t.value}`}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={`customer-details-panel-${t.value}`}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(t.value)}
            className={cn(
              "focus-ring-inset relative flex h-10 items-center justify-center rounded-t-md text-wb-2xs font-medium transition-colors",
              active
                ? "text-workbench-text"
                : "text-workbench-text-muted hover:text-workbench-text",
            )}
          >
            {t.label}
            {active && (
              <span
                aria-hidden
                className="absolute bottom-0 left-1/2 h-[2px] w-5 -translate-x-1/2 rounded-full bg-workbench-accent"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

// ─── Profile body ───────────────────────────────────────────────────────────

function ProfileTab({
  customer,
  quickReplies,
}: {
  customer: Customer;
  quickReplies: QuickReply[];
}) {
  return (
    <div className="flex flex-col gap-4 p-4 pb-6">
      <ProfileHeader customer={customer} />
      <TagsRow tags={customer.tags} />
      <DetailList customer={customer} />
      <button type="button" className="self-start text-wb-2xs font-medium text-workbench-accent">
        {STRINGS.customerDetails.expandMore}
      </button>
      <hr className="border-workbench-line" />
      <QuickRepliesPanel items={quickReplies} />
    </div>
  );
}

function ProfileHeader({ customer }: { customer: Customer }) {
  return (
    <div className="flex items-center gap-2.5">
      <div
        role="img"
        aria-label={customer.name}
        className="size-10 shrink-0 rounded-lg bg-cover bg-center"
        style={{
          backgroundColor: pickAvatarColor(customer.id),
          backgroundImage: `url(${pickCustomerAvatarImage(customer.name)})`,
        }}
      />
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-1.5">
          <span className="text-wb-sm font-semibold text-workbench-text">{customer.name}</span>
          <span className="text-wb-2xs text-workbench-text-muted">@ {customer.channel}</span>
        </div>
        <div className="flex items-center gap-1.5 text-wb-3xs text-workbench-text-secondary">
          <span className="truncate">{customer.account}</span>
          <span className="rounded-sm bg-workbench-surface-active px-1.5 py-0.5 text-wb-3xs font-medium text-workbench-accent">
            {STRINGS.customerDetails.fromAccountBadge}
          </span>
        </div>
      </div>
    </div>
  );
}

function TagsRow({ tags }: { tags: string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-wb-2xs text-workbench-text-secondary">
        {STRINGS.customerDetails.addTag}
      </span>
      {tags.map((t) => (
        <span
          key={t}
          className="rounded-full bg-workbench-surface-active px-1.5 py-0.5 text-wb-3xs font-medium text-workbench-accent"
        >
          {t}
        </span>
      ))}
      <button
        type="button"
        aria-label={STRINGS.customerDetails.addTag}
        className="hit-area-expand focus-ring grid size-[18px] place-items-center rounded-full border border-dashed border-workbench-line text-workbench-text-muted transition-colors hover:border-workbench-accent hover:text-workbench-accent"
      >
        <Plus size={10} />
      </button>
    </div>
  );
}

function DetailList({ customer }: { customer: Customer }) {
  const f = STRINGS.customerDetails.fields;
  // `numeric` flag toggles font-numeric on values that are predominantly digits
  // / IDs (phone, WeChat, timestamps). Chinese-text fields (remark, company,
  // source, follower) keep the default sans for natural reading rhythm.
  const rows: { label: string; value: string; numeric?: boolean }[] = [
    { label: f.remark, value: customer.remark },
    { label: f.phone, value: customer.phone, numeric: true },
    { label: f.weChat, value: customer.weChat, numeric: true },
    { label: f.company, value: customer.company },
    { label: f.source, value: customer.source },
    { label: f.addedAt, value: customer.addedAt, numeric: true },
    { label: f.follower, value: customer.follower },
  ];
  return (
    <dl className="flex flex-col gap-2 text-wb-2xs">
      {rows.map((r) => (
        <div key={r.label} className="grid grid-cols-[68px_1fr] items-baseline gap-2.5">
          <dt className="text-workbench-text-muted">{r.label}</dt>
          <dd className={cn("text-workbench-text", r.numeric && "wb-num")}>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

// ─── Empty state ────────────────────────────────────────────────────────────

function EmptyTab({ text }: { text: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2.5 px-6 py-10 text-center">
      <div className="grid size-12 place-items-center rounded-full bg-workbench-surface-subtle">
        <span className="text-[22px] text-workbench-text-muted">·</span>
      </div>
      <p className="text-wb-2xs text-workbench-text-muted">{text}</p>
    </div>
  );
}
