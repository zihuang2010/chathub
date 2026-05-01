import { memo, useState } from "react";
import { Plus } from "lucide-react";

import { cn } from "@/lib/utils";

import type { Customer, QuickReply } from "./data";
import { QuickRepliesPanel } from "./QuickRepliesPanel";

type DetailsTab = "profile" | "replies" | "trace";

const TABS: { value: DetailsTab; label: string }[] = [
  { value: "profile", label: "客户资料" },
  { value: "replies", label: "快捷回复" },
  { value: "trace", label: "客户轨迹" },
];

interface CustomerDetailsProps {
  customer: Customer;
  quickReplies: QuickReply[];
}

export const CustomerDetails = memo(function CustomerDetails({
  customer,
  quickReplies,
}: CustomerDetailsProps) {
  const [tab, setTab] = useState<DetailsTab>("profile");

  return (
    <aside className="flex h-full w-[324px] shrink-0 flex-col border-l border-workbench-line bg-white">
      <Tabs value={tab} onChange={setTab} />
      <div className="flex-1 overflow-y-auto">
        {tab === "profile" && <ProfileTab customer={customer} quickReplies={quickReplies} />}
        {tab === "replies" && <EmptyTab text="暂无快捷回复" />}
        {tab === "trace" && <EmptyTab text="暂无客户轨迹" />}
      </div>
    </aside>
  );
});

// ─── Tabs ───────────────────────────────────────────────────────────────────

function Tabs({ value, onChange }: { value: DetailsTab; onChange: (t: DetailsTab) => void }) {
  return (
    <div className="grid grid-cols-3 border-b border-workbench-line px-2 pt-2">
      {TABS.map((t) => {
        const active = t.value === value;
        return (
          <button
            key={t.value}
            type="button"
            onClick={() => onChange(t.value)}
            className={cn(
              "relative flex h-8 items-center justify-center text-[12.5px] font-medium transition-colors",
              active
                ? "text-workbench-text"
                : "text-workbench-text-muted hover:text-workbench-text",
            )}
          >
            {t.label}
            {active && (
              <span
                aria-hidden
                className="absolute bottom-0 left-1/2 h-[2px] w-5 -translate-x-1/2 rounded-full bg-workbench-blue"
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
      <button type="button" className="self-start text-[11.5px] font-medium text-workbench-blue">
        展开更多
      </button>
      <hr className="border-workbench-line" />
      <QuickRepliesPanel items={quickReplies} />
    </div>
  );
}

function ProfileHeader({ customer }: { customer: Customer }) {
  return (
    <div className="flex items-center gap-2.5">
      <div className="grid size-10 place-items-center rounded-full bg-[#FCE7B8] text-[15px] font-medium text-workbench-text">
        {customer.name.slice(0, 1)}
      </div>
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-1.5">
          <span className="text-[14px] font-semibold text-workbench-text">{customer.name}</span>
          <span className="text-[11.5px] text-workbench-text-muted">@ {customer.channel}</span>
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-workbench-text-secondary">
          <span className="truncate">{customer.account}</span>
          <span className="rounded-sm bg-workbench-surface-active px-1.5 py-0.5 text-[10px] font-medium text-workbench-blue">
            来自账号
          </span>
        </div>
      </div>
    </div>
  );
}

function TagsRow({ tags }: { tags: string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11.5px] text-workbench-text-secondary">添加标签</span>
      {tags.map((t) => (
        <span
          key={t}
          className="rounded-full bg-workbench-surface-active px-1.5 py-0.5 text-[10.5px] font-medium text-workbench-blue"
        >
          {t}
        </span>
      ))}
      <button
        type="button"
        aria-label="添加标签"
        className="grid size-[18px] place-items-center rounded-full border border-dashed border-workbench-line text-workbench-text-muted transition-colors hover:text-workbench-blue-strong"
      >
        <Plus size={10} />
      </button>
    </div>
  );
}

function DetailList({ customer }: { customer: Customer }) {
  const rows: { label: string; value: string }[] = [
    { label: "备注", value: customer.remark },
    { label: "手机", value: customer.phone },
    { label: "微信号", value: customer.weChat },
    { label: "所属企业", value: customer.company },
    { label: "客户来源", value: customer.source },
    { label: "添加时间", value: customer.addedAt },
    { label: "跟进人", value: customer.follower },
  ];
  return (
    <dl className="flex flex-col gap-2 text-[12px]">
      {rows.map((r) => (
        <div key={r.label} className="grid grid-cols-[68px_1fr] items-baseline gap-2.5">
          <dt className="text-workbench-text-muted">{r.label}</dt>
          <dd className="text-workbench-text">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

// ─── Empty state ────────────────────────────────────────────────────────────

function EmptyTab({ text }: { text: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2.5 px-6 py-10 text-center">
      <div className="grid size-12 place-items-center rounded-full bg-[#F1F5F9]">
        <span className="text-[22px] text-[#CBD5E1]">·</span>
      </div>
      <p className="text-[12px] text-workbench-text-muted">{text}</p>
    </div>
  );
}
