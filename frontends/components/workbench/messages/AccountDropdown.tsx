import type { ReactNode, Ref } from "react";
import { useCallback, useMemo, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Search } from "lucide-react";

import type { Account } from "@/lib/types/account";
import { accountDisplayName } from "@/lib/types/account";
import { cn } from "@/lib/utils";

import { STRINGS } from "./strings";

interface AccountDropdownProps {
  accounts: readonly Account[];
  /** 单选语义。值是 `account.id`(= wecomAccountId,唯一) — `null` 表示"全部"。
   *  用 id 而非 name 做选中标识:同名账号也能各自区分,不会一选多高亮。 */
  selectedAccountId: string | null;
  onSelect: (accountId: string | null) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
  title?: string;
}

/**
 * 消息页"按账号筛选"下拉。视觉/交互对齐客户页 `AccountPicker`(头像、搜索、滚动、分组),
 * 但保持**单选**语义(message 域是单选过滤,而客户页是多选)。
 *
 * 与 AccountPicker 的差异:
 *   - 单选(无 checkbox/Star/recent/footer)
 *   - 顶部固定"全部账号"选项
 *   - 滚动区 max-h 控制 30+ 条不溢出弹层
 */
export function AccountDropdown({
  accounts,
  selectedAccountId,
  onSelect,
  open,
  onOpenChange,
  children,
  title,
}: AccountDropdownProps) {
  const [query, setQuery] = useState("");

  // 弹层打开时把当前选中行滚到可见区(block:"nearest")。回调 ref 在选中行挂载时
  // 触发——弹层 portal 仅在 open 时挂载,故等价于"开则定位",30+ 账号也不必手动翻找。
  const scrollActiveIntoView = useCallback((node: HTMLButtonElement | null) => {
    node?.scrollIntoView({ block: "nearest" });
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return accounts;
    return accounts.filter((a) =>
      [a.name, a.wecomAlias, a.ownerName, a.city].some((v) => v?.toLowerCase().includes(q)),
    );
  }, [accounts, query]);

  const handleSelect = (accountId: string | null) => {
    onSelect(accountId);
    onOpenChange?.(false);
    setQuery("");
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        onOpenChange?.(o);
        if (!o) setQuery("");
      }}
    >
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          side="bottom"
          sideOffset={4}
          role="dialog"
          aria-label={title ?? STRINGS.conversationList.accountListLabel}
          className={cn(
            // 布局与 AccountPicker 对齐(最大高 + flex 列 + overflow-hidden);宽度收窄:
            // 本下拉是单选短账号名场景,280px 会留出大片空白,240px 更贴合内容密度。
            "z-20 flex max-h-[480px] w-[240px] flex-col overflow-hidden rounded-xl border border-workbench-line bg-workbench-surface shadow-wb-popover-strong outline-none",
            // 开/合补间:fade + zoom + 贴边滑入,150ms;reduced-motion 直接跳过。
            "duration-150 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1 motion-reduce:animate-none",
          )}
        >
          {title && (
            <div className="border-b border-workbench-line px-3 py-2 text-wb-2xs font-medium text-workbench-text">
              {title}
            </div>
          )}
          <SearchBox value={query} onChange={setQuery} />
          <div className="flex-1 overflow-y-auto px-1 py-1">
            {/* "全部账号" — 固定置顶,搜索不参与过滤 */}
            <AllAccountsRow
              active={!selectedAccountId}
              total={accounts.length}
              onClick={() => handleSelect(null)}
              innerRef={!selectedAccountId ? scrollActiveIntoView : undefined}
            />
            <Group title={`全部账号 (${formatTotalCount(accounts.length)})`}>
              {filtered.length === 0 ? (
                <Empty>未找到匹配的账号</Empty>
              ) : (
                filtered.map((a) => (
                  <AccountRow
                    key={a.id}
                    account={a}
                    active={selectedAccountId === a.id}
                    onClick={() => handleSelect(a.id)}
                    innerRef={selectedAccountId === a.id ? scrollActiveIntoView : undefined}
                  />
                ))
              )}
            </Group>
          </div>
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

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-1.5">
      <div className="px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wider text-workbench-text-muted">
        {title}
      </div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

function AllAccountsRow({
  active,
  total,
  onClick,
  innerRef,
}: {
  active: boolean;
  total: number;
  onClick: () => void;
  innerRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={innerRef}
      type="button"
      role="option"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "focus-ring flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] transition-colors",
        active ? "bg-workbench-surface-soft" : "hover:bg-workbench-surface-subtle",
      )}
    >
      <span
        aria-hidden
        className="grid size-6 shrink-0 place-items-center rounded-md bg-workbench-surface-soft text-[10px] font-medium text-[#5B7C99]"
      >
        全
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate font-medium",
          active ? "text-[#5B7C99]" : "text-workbench-text",
        )}
      >
        {STRINGS.rangePill.allAccountsBare}
      </span>
      <span className="shrink-0 rounded-full bg-workbench-surface-subtle px-1.5 py-0.5 font-numeric text-[11px] tabular-nums text-workbench-text-muted">
        {formatTotalCount(total)}
      </span>
      {active && <span className="ml-1 size-1.5 shrink-0 rounded-full bg-[#5B7C99]" />}
    </button>
  );
}

function AccountRow({
  account,
  active,
  onClick,
  innerRef,
}: {
  account: Account;
  active: boolean;
  onClick: () => void;
  innerRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={innerRef}
      type="button"
      role="option"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "focus-ring flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] transition-colors",
        active ? "bg-workbench-surface-soft" : "hover:bg-workbench-surface-subtle",
      )}
    >
      <Avatar account={account} />
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          active ? "font-medium text-[#5B7C99]" : "text-workbench-text",
        )}
      >
        {accountDisplayName(account)}
      </span>
      {active && <span className="size-1.5 shrink-0 rounded-full bg-[#5B7C99]" />}
    </button>
  );
}

function Avatar({ account }: { account: Account }) {
  return (
    <span
      aria-hidden
      className="grid size-6 shrink-0 place-items-center rounded-md text-[10.5px] font-medium text-workbench-text"
      style={{ background: `hsl(var(--wb-avatar-${account.colorToken}))` }}
    >
      {accountDisplayName(account).slice(0, 1)}
    </span>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 py-3 text-center text-wb-2xs text-workbench-text-muted">{children}</div>
  );
}

function formatTotalCount(n: number): string {
  return n > 99 ? "100+" : `${n}`;
}
