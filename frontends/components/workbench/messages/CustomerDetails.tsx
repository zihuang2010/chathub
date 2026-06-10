import { memo, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";

import { cn } from "@/lib/utils";

import type { Customer, QuickReply } from "./data";
import { AvatarTile } from "./Avatar";
import { QuickRepliesPanel } from "./QuickRepliesPanel";
import { STRINGS } from "./strings";
import { pickAvatarGradient } from "./utils";
import { CUSTOMER_DETAILS_WIDTH } from "./constants";

type DetailsTab = "profile" | "trace";

const TABS: { value: DetailsTab; label: string }[] = [
  { value: "profile", label: STRINGS.customerDetails.tabProfile },
  { value: "trace", label: STRINGS.customerDetails.tabTrace },
];

interface CustomerDetailsProps {
  /** 客户档案数据;为 null 时 profile tab 走加载/空态。 */
  customer: Customer | null;
  quickReplies: QuickReply[];
  /** 强制刷新客户详情(isForceRefresh=true)。 */
  onRefresh?: () => void;
  /** 详情拉取中:刷新按钮禁用 + 图标旋转。 */
  refreshing?: boolean;
}

export const CustomerDetails = memo(function CustomerDetails({
  customer,
  quickReplies,
  onRefresh,
  refreshing,
}: CustomerDetailsProps) {
  const [tab, setTab] = useState<DetailsTab>("profile");

  return (
    <aside
      className="flex h-full shrink-0 flex-col border-l border-workbench-line bg-workbench-surface"
      style={{ width: CUSTOMER_DETAILS_WIDTH }}
    >
      <Tabs value={tab} onChange={setTab} />
      <div
        role="tabpanel"
        id={`customer-details-panel-${tab}`}
        aria-labelledby={`customer-details-tab-${tab}`}
        className="flex-1 overflow-y-auto"
      >
        {tab === "profile" &&
          (customer ? (
            <ProfileTab
              customer={customer}
              quickReplies={quickReplies}
              onRefresh={onRefresh}
              refreshing={refreshing}
            />
          ) : (
            <EmptyTab text={STRINGS.empty.loading} />
          ))}
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
      className="grid grid-cols-2 border-b border-workbench-line px-2 pt-2"
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
  onRefresh,
  refreshing,
}: {
  customer: Customer;
  quickReplies: QuickReply[];
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  return (
    <div className="flex flex-col gap-4 p-4 pb-6">
      <ProfileHeader customer={customer} onRefresh={onRefresh} refreshing={refreshing} />
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

function ProfileHeader({
  customer,
  onRefresh,
  refreshing,
}: {
  customer: Customer;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <AvatarTile
        name={customer.name}
        avatarUrl={customer.avatarUrl}
        color={pickAvatarGradient(customer.id)}
        size={40}
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex items-center gap-1.5">
          <span className="text-wb-sm font-semibold text-workbench-text">{customer.name}</span>
          <span className="text-wb-2xs text-workbench-wechat-text">@ {customer.channel}</span>
        </div>
        <div className="text-wb-3xs flex items-center gap-1.5 text-workbench-text-secondary">
          <span className="truncate">{customer.account}</span>
          <span className="text-wb-3xs rounded-sm bg-workbench-surface-active px-1.5 py-0.5 font-medium text-workbench-accent">
            {STRINGS.customerDetails.fromAccountBadge}
          </span>
        </div>
      </div>
      {onRefresh && (
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          aria-label={STRINGS.customerDetails.refresh}
          title={STRINGS.customerDetails.refresh}
          className="focus-ring ml-auto grid size-7 shrink-0 place-items-center rounded-md text-workbench-text-muted transition-colors hover:bg-workbench-surface-active hover:text-workbench-text disabled:opacity-50"
        >
          <RefreshCw size={14} className={cn(refreshing && "animate-spin")} />
        </button>
      )}
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
          className="text-wb-3xs rounded-full bg-workbench-surface-active px-1.5 py-0.5 font-medium text-workbench-accent"
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
