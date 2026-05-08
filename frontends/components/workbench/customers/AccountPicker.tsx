import { useMemo, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown, Search, Settings, Star } from "lucide-react";

import type { Account } from "@/lib/types/account";
import { cn } from "@/lib/utils";

interface AccountPickerProps {
  accounts: readonly Account[];
  selectedIds: ReadonlySet<string>;
  /** 经账号过滤后命中各账号的客户数，用作每行 badge。 */
  accountCounts: Record<string, number>;
  /** 当前选中范围里"待跟进"的客户数，trigger 上的橙色提示。0 时不展示。 */
  needsFollowUpInScope: number;
  onToggle: (id: string) => void;
  onClearAll: () => void;
  /** 收藏账号 id 集合。当前由前端自行维护（localStorage 后续接入）。 */
  starredIds?: ReadonlySet<string>;
  onToggleStar?: (id: string) => void;
  /** 最近使用账号 id（按使用顺序，最近在前）。 */
  recentIds?: readonly string[];
  /** "管理账号"链接占位回调；未传则不渲染该 footer 项。 */
  onManageAccounts?: () => void;
}

/**
 * 顶部账号选择器：trigger 显示当前账号摘要 + 待跟进徽章，弹层支持搜索 + 多选。
 * 弹层分组：最近使用 / 收藏账号 / 全部账号 (N)，便于在账号很多（>20）时快速定位。
 */
export function AccountPicker({
  accounts,
  selectedIds,
  accountCounts,
  needsFollowUpInScope,
  onToggle,
  onClearAll,
  starredIds,
  onToggleStar,
  recentIds,
  onManageAccounts,
}: AccountPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const triggerLabel = useMemo(() => {
    if (selectedIds.size === 0)
      return { name: "全部账号", account: undefined as Account | undefined };
    if (selectedIds.size === 1) {
      const id = selectedIds.values().next().value as string;
      const a = accounts.find((x) => x.id === id);
      return { name: a?.name ?? "未命名", account: a };
    }
    return { name: `已选 ${selectedIds.size} 个账号`, account: undefined };
  }, [accounts, selectedIds]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return accounts;
    return accounts.filter((a) => [a.name, a.ownerName].some((v) => v?.toLowerCase().includes(q)));
  }, [accounts, query]);

  const recents = useMemo(() => {
    if (!recentIds || recentIds.length === 0) return [];
    const map = new Map(filtered.map((a) => [a.id, a] as const));
    return recentIds
      .map((id) => map.get(id))
      .filter((a): a is Account => Boolean(a))
      .slice(0, 3);
  }, [filtered, recentIds]);

  const starred = useMemo(() => {
    if (!starredIds || starredIds.size === 0) return [];
    return filtered.filter((a) => starredIds.has(a.id));
  }, [filtered, starredIds]);

  const recentIdSet = useMemo(() => new Set(recents.map((a) => a.id)), [recents]);
  const starredIdSet = useMemo(() => starredIds ?? new Set<string>(), [starredIds]);

  // 全部账号展示去掉已经在"最近使用 / 收藏账号"出现的项，避免视觉重复。
  const others = useMemo(
    () => filtered.filter((a) => !recentIdSet.has(a.id) && !starredIdSet.has(a.id)),
    [filtered, recentIdSet, starredIdSet],
  );

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={
            needsFollowUpInScope > 0
              ? `账号筛选：${triggerLabel.name}（${needsFollowUpInScope} 个待跟进）`
              : `账号筛选：${triggerLabel.name}`
          }
          className={cn(
            "focus-ring inline-flex h-9 max-w-[200px] shrink-0 items-center gap-2 rounded-md border border-workbench-line bg-workbench-surface px-2.5 text-[13px] text-workbench-text transition-colors",
            "hover:border-workbench-line-strong",
            open && "border-workbench-accent ring-2 ring-workbench-accent/20",
          )}
        >
          <span className="relative shrink-0">
            {triggerLabel.account ? (
              <Avatar account={triggerLabel.account} />
            ) : (
              <span
                aria-hidden
                className="grid size-6 place-items-center rounded-full bg-workbench-surface-active text-[10px] font-medium text-workbench-accent"
              >
                全
              </span>
            )}
            {needsFollowUpInScope > 0 && (
              <span
                aria-hidden
                title={`${needsFollowUpInScope} 个待跟进`}
                className="absolute -right-1 -top-1 grid h-4 min-w-[16px] place-items-center rounded-full bg-workbench-danger px-1 font-numeric text-[10px] font-medium tabular-nums leading-none text-white ring-2 ring-workbench-surface"
              >
                {needsFollowUpInScope > 99 ? "99+" : needsFollowUpInScope}
              </span>
            )}
          </span>
          <span className="min-w-0 truncate font-medium">{triggerLabel.name}</span>
          <ChevronDown size={14} className="shrink-0 text-workbench-text-muted" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="z-30 flex max-h-[480px] w-[320px] flex-col overflow-hidden rounded-xl border border-workbench-line bg-workbench-surface shadow-wb-popover-strong outline-none"
        >
          <SearchBox value={query} onChange={setQuery} />
          <div className="flex-1 overflow-y-auto px-1 py-1">
            {recents.length > 0 && (
              <Group title="最近使用">
                {recents.map((a) => (
                  <Row
                    key={`recent-${a.id}`}
                    account={a}
                    checked={selectedIds.has(a.id)}
                    count={accountCounts[a.id]}
                    starred={starredIdSet.has(a.id)}
                    onToggle={() => onToggle(a.id)}
                    onToggleStar={onToggleStar ? () => onToggleStar(a.id) : undefined}
                  />
                ))}
              </Group>
            )}
            {starred.length > 0 && (
              <Group title="收藏账号">
                {starred.map((a) => (
                  <Row
                    key={`star-${a.id}`}
                    account={a}
                    checked={selectedIds.has(a.id)}
                    count={accountCounts[a.id]}
                    starred
                    onToggle={() => onToggle(a.id)}
                    onToggleStar={onToggleStar ? () => onToggleStar(a.id) : undefined}
                  />
                ))}
              </Group>
            )}
            <Group title={`全部账号 (${formatTotalCount(accounts.length)})`}>
              {others.length === 0 && filtered.length === 0 ? (
                <Empty>未找到匹配的账号</Empty>
              ) : others.length === 0 ? (
                <Empty>已全部展示在上方分组</Empty>
              ) : (
                others.map((a) => (
                  <Row
                    key={`all-${a.id}`}
                    account={a}
                    checked={selectedIds.has(a.id)}
                    count={accountCounts[a.id]}
                    starred={starredIdSet.has(a.id)}
                    onToggle={() => onToggle(a.id)}
                    onToggleStar={onToggleStar ? () => onToggleStar(a.id) : undefined}
                  />
                ))
              )}
            </Group>
          </div>
          <Footer
            hasSelection={selectedIds.size > 0}
            onClear={() => onClearAll()}
            onManage={onManageAccounts}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="relative border-b border-workbench-line p-2">
      <Search
        size={13}
        className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-workbench-text-muted"
      />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="搜索账号名称或成员"
        className="focus-ring h-8 w-full rounded-lg border border-workbench-line bg-workbench-surface-subtle pl-7 pr-2 text-[12px] text-workbench-text placeholder:text-workbench-text-muted focus:bg-workbench-surface"
      />
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-1.5">
      <div className="px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wider text-workbench-text-muted">
        {title}
      </div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

function Row({
  account,
  checked,
  count,
  starred,
  onToggle,
  onToggleStar,
}: {
  account: Account;
  checked: boolean;
  count?: number;
  starred?: boolean;
  onToggle: () => void;
  onToggleStar?: () => void;
}) {
  return (
    <div
      className={cn(
        "group/row flex h-9 items-center gap-2 rounded-md px-2 transition-colors",
        checked ? "bg-workbench-surface-active" : "hover:bg-workbench-surface-subtle",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        className="focus-ring flex min-w-0 flex-1 items-center gap-2 text-left text-[12px]"
        aria-pressed={checked}
      >
        <Avatar account={account} />
        <span className="min-w-0 flex-1 truncate text-workbench-text">{account.name}</span>
        {typeof count === "number" && (
          <span className="shrink-0 rounded-full bg-workbench-surface-subtle px-1.5 py-0.5 font-numeric text-[11px] tabular-nums text-workbench-text-muted">
            {count}
          </span>
        )}
        {checked && <Check size={13} className="shrink-0 text-workbench-accent" />}
      </button>
      {onToggleStar && (
        <button
          type="button"
          aria-label={starred ? "取消收藏" : "收藏"}
          onClick={onToggleStar}
          className={cn(
            "focus-ring grid size-6 shrink-0 place-items-center rounded transition-all",
            starred
              ? "text-workbench-warning hover:bg-workbench-surface"
              : "text-workbench-text-muted opacity-0 hover:bg-workbench-surface hover:text-workbench-warning group-hover/row:opacity-100",
          )}
        >
          <Star size={12} fill={starred ? "currentColor" : "none"} />
        </button>
      )}
    </div>
  );
}

function Footer({
  hasSelection,
  onClear,
  onManage,
}: {
  hasSelection: boolean;
  onClear: () => void;
  onManage?: () => void;
}) {
  if (!hasSelection && !onManage) return null;
  return (
    <div className="flex items-center justify-between border-t border-workbench-line bg-workbench-surface-subtle/40 px-2 py-1.5 text-[12px]">
      {onManage ? (
        <button
          type="button"
          onClick={onManage}
          className="focus-ring inline-flex items-center gap-1 rounded px-1 py-0.5 text-workbench-accent hover:underline"
        >
          <Settings size={12} />
          管理账号
        </button>
      ) : (
        <span aria-hidden />
      )}
      {hasSelection && (
        <button
          type="button"
          onClick={onClear}
          className="focus-ring rounded px-1 py-0.5 text-workbench-text-muted hover:text-workbench-text"
        >
          清空选择
        </button>
      )}
    </div>
  );
}

function Avatar({ account }: { account: Account }) {
  return (
    <span
      aria-hidden
      className="grid size-6 shrink-0 place-items-center rounded-full text-[10.5px] font-medium text-workbench-text"
      style={{ background: `hsl(var(--wb-avatar-${account.colorToken}))` }}
    >
      {account.name.slice(0, 1)}
    </span>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2 py-3 text-center text-wb-2xs text-workbench-text-muted">{children}</div>
  );
}

function formatTotalCount(n: number): string {
  return n > 99 ? "100+" : `${n}`;
}
