import { memo } from "react";
import { Building2, Mars, MessageCircle, MoreHorizontal, Phone, Venus } from "lucide-react";

import type { Account } from "@/lib/types/account";
import type { Customer } from "@/lib/types/customer";
import { cn } from "@/lib/utils";

import { CustomerAvatar } from "./CustomerAvatar";
import { CARD_MAX_TAGS } from "./constants";
import { isKeyCustomer } from "./customerLabels";
import { STRINGS } from "./strings";
import { tagColorClass } from "./tagColor";
import { parseDate } from "./utils";

interface CustomerCardProps {
  customer: Customer;
  account: Account | undefined;
  /** 客户头像配色 token（fallback letter-tile 时使用）。 */
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
 * 客户卡片（替代旧的列表行）。布局自上而下：
 *   头像(在线点) + 姓名/性别  ……  右上「更多」
 *   🏢 企业名称（缺省「暂无企业」）
 *   📞 手机号（缺省「暂无手机号」）            会话圆形按钮
 *   标签 chips(+N)
 *   ── 分隔 ──
 *   负责人 · 最近跟进/添加时间
 *
 * 企业名称 / 手机号 / 负责人 缺失时一律显示灰色默认占位，不留空白。
 * 左上角：重点客户角标（浏览态）与多选 checkbox（hover / 多选态）互斥显示。
 */
export const CustomerCard = memo(function CustomerCard({
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
}: CustomerCardProps) {
  const visibleTags = customer.tags.slice(0, CARD_MAX_TAGS);
  const overflowTags = customer.tags.length - visibleTags.length;
  const isKey = isKeyCustomer(customer);
  // 企业名称 / 手机号 / 负责人 统一兜底：空串、"—" 都视为缺失，回退到默认占位。
  const company = cleanValue(customer.company);
  const phone = cleanValue(customer.phone);
  const owner = cleanValue(customer.follower);
  const addedAt = formatDateTime(customer.addedAt);

  // checkbox：多选态常显；否则 hover 才显。重点角标在 checkbox 出现时让位。
  const checkboxShown = multiSelectActive || multiSelected;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-selected={selected}
      onClick={() => onSelect(customer.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(customer.id);
        }
      }}
      className={cn(
        "group relative flex cursor-pointer flex-col rounded-lg border bg-workbench-surface p-2 transition-all",
        "hover:shadow-wb-card focus-visible:outline-none",
        selected
          ? "border-workbench-accent ring-1 ring-workbench-accent"
          : multiSelected
            ? "border-workbench-accent/60"
            : "border-workbench-line hover:border-workbench-line-strong",
      )}
    >
      {/* 左上角：重点客户角标（与 checkbox 互斥） */}
      {isKey && (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute left-0 top-0 z-[1] inline-flex items-center rounded-br-lg rounded-tl-lg bg-workbench-accent px-2 py-0.5 text-[10.5px] font-medium text-white transition-opacity",
            checkboxShown ? "opacity-0" : "opacity-100 group-hover:opacity-0",
          )}
        >
          {STRINGS.card.keyBadge}
        </span>
      )}

      {/* 左上角：多选 checkbox */}
      <div
        className={cn(
          "absolute left-2 top-2 z-[2] transition-opacity",
          checkboxShown
            ? "opacity-100"
            : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100",
        )}
      >
        <Checkbox
          checked={multiSelected}
          onChange={() => onToggleMultiSelect(customer.id)}
          aria-label={STRINGS.card.select(customer.name)}
        />
      </div>

      {/* 头部：头像 + 姓名/公司 + 更多 */}
      <div className="flex items-start gap-2.5">
        <CustomerAvatar
          customerId={customer.id}
          name={customer.name}
          photoUrl={customer.avatarUrl}
          colorToken={avatarColorToken}
          size={36}
          online={account?.status === "online"}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            <span className="truncate text-[14px] font-semibold text-workbench-text">
              {customer.name}
            </span>
            <GenderIcon gender={customer.gender} />
          </div>
          {/* 负责人（接口字段 wecomAccountName，缺失显示「未填写」） */}
          <div className="mt-0.5 truncate text-[11px] text-workbench-text-secondary">
            {STRINGS.card.owner} {owner ?? STRINGS.card.followerFallback}
          </div>
        </div>
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

      {/* 信息区：企业名称 + 手机号（缺失统一兜底默认占位） */}
      <div className="mt-1 space-y-0.5">
        <InfoRow
          icon={<Building2 size={13} className="shrink-0 text-workbench-text-secondary" />}
          aria={STRINGS.card.companyAria}
          value={company}
          fallback={STRINGS.card.companyFallback}
        />
        <div className="flex items-center gap-1.5">
          <InfoRow
            icon={<Phone size={13} className="shrink-0 text-workbench-text-secondary" />}
            aria={STRINGS.card.phoneAria}
            value={phone}
            fallback={STRINGS.card.phoneFallback}
            numeric
          />
          <CardActionButton
            ariaLabel={STRINGS.card.chat}
            className="ml-auto"
            onClick={(e) => {
              e.stopPropagation();
              onOpenChat(customer.id);
            }}
          >
            <MessageCircle size={13} />
          </CardActionButton>
        </div>
      </div>

      {/* 标签 */}
      {visibleTags.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {visibleTags.map((tag) => (
            <span
              key={tag}
              className={cn(
                "inline-flex max-w-full items-center truncate whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium",
                tagColorClass(tag),
              )}
            >
              {tag}
            </span>
          ))}
          {overflowTags > 0 && (
            <span className="inline-flex shrink-0 items-center whitespace-nowrap rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500 ring-1 ring-inset ring-slate-200/60">
              {STRINGS.list.overflowTagsLabel(overflowTags)}
            </span>
          )}
        </div>
      )}

      {/* 底部：仅添加时间 */}
      {addedAt ? (
        <div className="mt-1 border-t border-workbench-line-subtle pt-1 text-[10px] text-workbench-text-secondary">
          <span className="truncate">
            {STRINGS.card.addedAtTime}{" "}
            <span className="wb-num tabular-nums text-workbench-text-secondary">{addedAt}</span>
          </span>
        </div>
      ) : null}
    </div>
  );
});

function formatDateTime(value: string | null | undefined): string | null {
  const d = parseDate(value ?? null);
  if (!d) return null;
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 归一缺失值：空串 / 纯空白 / 适配层占位 "—" 一律视为「无」，返回 null。 */
function cleanValue(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  return s && s !== "—" ? s : null;
}

/** 单条信息行：图标 + 值；值缺失时用灰色默认占位填充，保持卡片高度稳定。 */
function InfoRow({
  icon,
  aria,
  value,
  fallback,
  numeric,
}: {
  icon: React.ReactNode;
  aria: string;
  value: string | null;
  fallback: string;
  numeric?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-[11px]" aria-label={aria}>
      {icon}
      <span
        className={cn(
          "truncate text-workbench-text-secondary",
          numeric && value && "wb-num tabular-nums",
        )}
      >
        {value ?? fallback}
      </span>
    </div>
  );
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

function CardActionButton({
  ariaLabel,
  onClick,
  className,
  children,
}: {
  ariaLabel: string;
  onClick: (e: React.MouseEvent) => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      title={ariaLabel}
      onClick={onClick}
      className={cn(
        "focus-ring grid size-6 shrink-0 place-items-center rounded-full bg-workbench-surface-active text-workbench-accent transition-colors",
        "hover:bg-workbench-accent hover:text-white",
        className,
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
