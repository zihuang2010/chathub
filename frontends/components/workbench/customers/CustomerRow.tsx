import { memo } from "react";
import { Mars, MessageCircle, MoreHorizontal, Phone, Venus } from "lucide-react";

import type { Account } from "@/lib/types/account";
import type { Customer } from "@/lib/types/customer";
import { cn } from "@/lib/utils";

import { CustomerAvatar } from "./CustomerAvatar";
import { STRINGS } from "./strings";
import { parseDate } from "./utils";

interface CustomerRowProps {
  customer: Customer;
  account: Account | undefined;
  avatarColorToken?: number;
  /** 单选高亮（详情面板正在展示该客户）。 */
  selected: boolean;
  multiSelectActive: boolean;
  multiSelected: boolean;
  onSelect: (id: string) => void;
  onToggleMultiSelect: (id: string) => void;
  onOpenChat: (id: string) => void;
  onMore: (id: string) => void;
}

/**
 * 客户列表行（列表视图）。横向排布：
 *   [多选框] 头像 + 姓名/性别·公司 …… 手机号 · 归属账号 · 添加时间 …… 会话 / 更多
 * 与卡片视图共用一份 Customer 数据，仅展示形态不同；操作按钮按设计只保留「会话」。
 */
export const CustomerRow = memo(function CustomerRow({
  customer,
  account,
  avatarColorToken,
  selected,
  multiSelectActive,
  multiSelected,
  onSelect,
  onToggleMultiSelect,
  onOpenChat,
  onMore,
}: CustomerRowProps) {
  const subtitle = [customer.company, account?.ownerName || customer.follower]
    .filter((v) => v && v !== "—")
    .join(" · ");
  const addedAt = formatDateTime(customer.addedAt);
  const checkboxShown = multiSelectActive || multiSelected;

  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={0}
      onClick={() => onSelect(customer.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(customer.id);
        }
      }}
      className={cn(
        "group flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 transition-all",
        "hover:shadow-wb-card focus-visible:outline-none",
        selected
          ? "border-workbench-accent bg-workbench-surface ring-1 ring-workbench-accent"
          : multiSelected
            ? "border-workbench-accent/60 bg-workbench-surface"
            : "border-workbench-line bg-workbench-surface hover:border-workbench-line-strong",
      )}
    >
      {/* 多选框：多选态常显；否则 hover 才显，让位给头像 */}
      <div
        className={cn(
          "shrink-0 transition-opacity",
          checkboxShown
            ? "opacity-100"
            : "pointer-events-none w-0 overflow-hidden opacity-0 group-hover:pointer-events-auto group-hover:w-[18px] group-hover:opacity-100",
        )}
      >
        <Checkbox
          checked={multiSelected}
          onChange={() => onToggleMultiSelect(customer.id)}
          aria-label={STRINGS.card.select(customer.name)}
        />
      </div>

      <CustomerAvatar
        customerId={customer.id}
        name={customer.name}
        photoUrl={customer.avatarUrl}
        colorToken={avatarColorToken}
        size={36}
        online={account?.status === "online"}
      />

      {/* 姓名 / 性别 + 公司·负责人 */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <span className="truncate text-[13.5px] font-semibold text-workbench-text">
            {customer.name}
          </span>
          <GenderIcon gender={customer.gender} />
        </div>
        {subtitle && (
          <div className="mt-0.5 truncate text-[12px] text-workbench-text-muted">{subtitle}</div>
        )}
      </div>

      {/* 手机号 */}
      <div className="hidden w-[120px] shrink-0 items-center gap-1.5 text-[12.5px] text-workbench-text-secondary sm:flex">
        {customer.phone && (
          <>
            <Phone size={13} className="shrink-0 text-workbench-text-muted" />
            <span className="wb-num truncate tabular-nums">{customer.phone}</span>
          </>
        )}
      </div>

      {/* 归属账号 */}
      <div className="hidden w-[120px] shrink-0 truncate text-[12px] text-workbench-text-muted lg:block">
        {customer.account && customer.account !== "—" ? customer.account : ""}
      </div>

      {/* 添加时间 */}
      <div className="hidden w-[120px] shrink-0 text-[11px] text-workbench-text-muted xl:block">
        {addedAt ? (
          <span className="wb-num tabular-nums">
            {STRINGS.card.addedAt} {addedAt}
          </span>
        ) : null}
      </div>

      {/* 操作：仅会话 + 更多 */}
      <div className="flex shrink-0 items-center gap-1.5">
        <RowActionButton
          ariaLabel={STRINGS.card.chat}
          onClick={(e) => {
            e.stopPropagation();
            onOpenChat(customer.id);
          }}
        >
          <MessageCircle size={15} />
        </RowActionButton>
        <RowIconButton
          ariaLabel={STRINGS.card.more}
          onClick={(e) => {
            e.stopPropagation();
            onMore(customer.id);
          }}
        >
          <MoreHorizontal size={16} />
        </RowIconButton>
      </div>
    </div>
  );
});

function formatDateTime(value: string | null | undefined): string | null {
  const d = parseDate(value ?? null);
  if (!d) return null;
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function GenderIcon({ gender }: { gender?: "male" | "female" }) {
  if (gender === "male")
    return <Mars size={12} className="shrink-0 text-blue-500" aria-label="男" />;
  if (gender === "female")
    return <Venus size={12} className="shrink-0 text-pink-500" aria-label="女" />;
  return null;
}

function RowIconButton({
  ariaLabel,
  onClick,
  children,
}: {
  ariaLabel: string;
  onClick: (e: React.MouseEvent) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      title={ariaLabel}
      onClick={onClick}
      className={cn(
        "focus-ring grid size-7 shrink-0 place-items-center rounded-md text-workbench-text-muted transition-colors",
        "hover:bg-workbench-surface-subtle hover:text-workbench-text",
      )}
    >
      {children}
    </button>
  );
}

function RowActionButton({
  ariaLabel,
  onClick,
  children,
}: {
  ariaLabel: string;
  onClick: (e: React.MouseEvent) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      title={ariaLabel}
      onClick={onClick}
      className={cn(
        "focus-ring grid size-7 place-items-center rounded-full bg-workbench-surface-active text-workbench-accent transition-colors",
        "hover:bg-workbench-accent hover:text-white",
      )}
    >
      {children}
    </button>
  );
}

function Checkbox({
  checked,
  onChange,
  ...props
}: {
  checked: boolean;
  onChange: () => void;
} & React.AriaAttributes) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={(e) => {
        e.stopPropagation();
        onChange();
      }}
      className={cn(
        "focus-ring grid size-[18px] place-items-center rounded-[5px] border shadow-sm transition-colors",
        checked
          ? "border-workbench-accent bg-workbench-accent text-workbench-surface"
          : "border-workbench-line bg-workbench-surface text-transparent hover:border-workbench-line-strong",
      )}
      {...props}
    >
      <svg viewBox="0 0 12 12" className="size-2.5" aria-hidden>
        <path
          d="M2.5 6.2 5 8.6 9.6 3.4"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
