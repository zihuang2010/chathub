import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Search, X } from "lucide-react";

import type { Account } from "@/lib/types/account";
import { resolveOwnerAccountName } from "@/lib/types/account";
import { type WecomFriend } from "@/lib/api/customers";
import { useFriends } from "@/lib/api/useFriends";
import { cn } from "@/lib/utils";

import { ConversationAvatar } from "./Avatar";
import { STRINGS } from "./strings";

const SEARCH_DEBOUNCE_MS = 300;
const WECOM_SOURCE_LOGO = "/wecom-logo.png";
// fullScope 搜索不下发账号集;稳定引用避免每次 render 触发 useFriends 内部 memo 重算。
const EMPTY_ACCOUNT_IDS: string[] = [];

interface MessagesContactSearchProps {
  accounts: readonly Account[];
  /** 点击下拉里的客户:由父级解析「客户 → 会话」并打开。 */
  onOpenCustomer: (friend: WecomFriend) => void;
  /** 搜索框清空:父级据此退出 filtered 态(若有)回到默认列表。 */
  onClear: () => void;
}

/**
 * 消息页「搜索客户」框 + 「联系人」下拉(企业微信风格)。
 * - 只按名字搜客户,**直接打 `list_friends` 接口**(useFriends 的 externalName 服务端模糊匹配)。
 * - **全量搜索**:下发当前可管理的全部账号 id(新接口 wecomAccountIds 必传),不受顶部账号
 *   选择器影响;每条结果按 `wecomAccountId` 反查 `accounts` 显示归属账号徽章。
 * - query 为空时账号集传空 → useFriends 自动 disabled,不请求。
 * - 下拉用相对定位的浮层(非 Radix Popover):搜索框是 live 输入,自管开合 + 外点关闭,
 *   避免 Popover 抢焦点。
 */
export const MessagesContactSearch = memo(function MessagesContactSearch({
  accounts,
  onOpenCustomer,
  onClear,
}: MessagesContactSearchProps) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  // 中文 IME 合成态(拼音未上屏):合成中输入框照常显示拼音,但不拿拼音去搜。
  const [isComposing, setIsComposing] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // 选中某条后程序化把名字写回输入框:此次不重新搜索、不重开下拉。
  const suppressRef = useRef(false);

  // 输入防抖 → debounced(喂给 useFriends 的 externalName)。
  useEffect(() => {
    if (suppressRef.current) return;
    // IME 合成中(拼音未上屏):不拿拼音去搜,等 compositionend 上屏最终文本再搜。
    if (isComposing) return;
    const id = setTimeout(() => setDebounced(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [query, isComposing]);

  // 账号反查表:用结果里的 `wecomAccountId` 取归属账号(显示名 + 配色),展示账号徽章。
  const accountById = useMemo(() => new Map(accounts.map((a) => [a.id, a] as const)), [accounts]);

  // 全量搜索:走 fullScope(请求体省略 wecomAccountIds,业务后台按登录 token 全量),
  // 不再罗列全部账号 id —— 服务端 wecomAccountIds 单次最多 20 个,账号多时罗列会超限。
  // 空关键词 → fullScope=false 且账号集空 → useFriends 自动 disabled,不发请求。
  const { friends, loading } = useFriends(
    EMPTY_ACCOUNT_IDS,
    { externalName: debounced },
    undefined,
    debounced.length > 0,
  );

  // 有 debounced 关键词即展开下拉(展示 搜索中/空/结果)。选中后由 suppressRef 压住不重开。
  useEffect(() => {
    if (suppressRef.current) {
      setOpen(false);
      return;
    }
    setOpen(debounced.length > 0);
  }, [debounced]);

  // 外点关闭。
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const handleChange = (value: string) => {
    suppressRef.current = false;
    setQuery(value);
  };

  const handleClear = () => {
    suppressRef.current = false;
    setQuery("");
    setDebounced("");
    setOpen(false);
    onClear();
  };

  const handlePick = (friend: WecomFriend) => {
    suppressRef.current = true;
    setQuery(friend.externalName || "");
    setOpen(false);
    onOpenCustomer(friend);
  };

  const hasValue = query.length > 0;

  return (
    <div ref={rootRef} className="relative">
      <div
        className={cn(
          // surface-elevated/70:白色半透明,叠在列表底色上比实心 surface 更轻盈;
          // shadow-wb-card 给一层轻浮起;暗色主题下 token 自动跟随,不硬编码白色。
          "flex h-9 items-center gap-2 rounded-lg border border-workbench-line bg-workbench-surface-elevated/70 px-2.5 text-workbench-text-muted shadow-wb-card transition-colors",
          "focus-within:border-workbench-accent/50 focus-within:ring-2 focus-within:ring-workbench-accent/25",
        )}
      >
        <Search size={15} className="shrink-0" />
        <input
          value={query}
          onChange={(e) => handleChange(e.currentTarget.value)}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={(e) => {
            // compositionend 时 value 已是最终上屏文本;显式同步一次,
            // 不依赖浏览器是否再补发 onChange(Chrome/Firefox 顺序不一致)。
            setIsComposing(false);
            handleChange(e.currentTarget.value);
          }}
          onFocus={() => {
            if (!suppressRef.current && debounced.length > 0) setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
          }}
          placeholder={STRINGS.conversationList.contactSearchPlaceholder}
          className="min-w-0 flex-1 bg-transparent text-wb-2xs font-medium text-workbench-text focus:outline-none"
        />
        {hasValue && (
          <button
            type="button"
            onClick={handleClear}
            aria-label={STRINGS.conversationList.clearSearch}
            className="focus-ring grid size-5 shrink-0 place-items-center rounded text-workbench-text-muted transition-colors hover:bg-workbench-surface-subtle hover:text-workbench-text"
          >
            <X size={13} />
          </button>
        )}
      </div>

      {open && (
        <ContactDropdown
          friends={friends}
          loading={loading}
          query={debounced}
          accountById={accountById}
          onPick={handlePick}
        />
      )}
    </div>
  );
});

function ContactDropdown({
  friends,
  loading,
  query,
  accountById,
  onPick,
}: {
  friends: WecomFriend[];
  loading: boolean;
  query: string;
  accountById: Map<string, Account>;
  onPick: (friend: WecomFriend) => void;
}) {
  const showEmpty = !loading && friends.length === 0;
  const showLoading = loading && friends.length === 0;

  return (
    <div
      role="listbox"
      aria-label={STRINGS.conversationList.contactGroup}
      className={cn(
        "absolute left-0 right-0 top-full z-30 mt-1 max-h-[360px] overflow-y-auto rounded-xl border border-workbench-line bg-workbench-surface shadow-wb-popover-strong",
        "duration-150 animate-in fade-in-0 zoom-in-95 slide-in-from-top-1 motion-reduce:animate-none",
      )}
    >
      <div className="px-2 pb-1 pt-1.5 text-[11px] font-medium text-workbench-text-muted">
        {STRINGS.conversationList.contactGroup}
      </div>
      {showLoading && (
        <div className="px-3 py-3 text-center text-wb-2xs text-workbench-text-muted">
          {STRINGS.conversationList.contactSearching}
        </div>
      )}
      {showEmpty && (
        <div className="px-3 py-3 text-center text-wb-2xs text-workbench-text-muted">
          {STRINGS.conversationList.contactEmpty}
        </div>
      )}
      {!showEmpty && (
        <div className="flex flex-col gap-0.5 px-1 pb-1.5">
          {friends.map((friend) => (
            <ContactRow
              key={`${friend.wecomAccountId}:${friend.externalUserId}`}
              friend={friend}
              query={query}
              account={accountById.get(friend.wecomAccountId)}
              onPick={onPick}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ContactRow({
  friend,
  query,
  account,
  onPick,
}: {
  friend: WecomFriend;
  query: string;
  /** 由 `friend.wecomAccountId` 反查到的归属账号;未命中(账号不在列表)则不渲染徽章。 */
  account: Account | undefined;
  onPick: (friend: WecomFriend) => void;
}) {
  const name = friend.externalName || "(未命名)";
  const company = friend.externalCorpName || friend.remarkCorpName || "";
  // 归属账号:优先 list_friends 行内别名(wecomAccountAlias),再用账号注册表别名兜底,回退账号名。
  const ownerName = resolveOwnerAccountName(
    friend.wecomAccountAlias,
    friend.wecomAccountName,
    account,
  );
  return (
    <button
      type="button"
      role="option"
      onClick={() => onPick(friend)}
      className="focus-ring flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-workbench-surface-active"
    >
      <ConversationAvatar
        name={name}
        avatarUrl={friend.externalAvatar || undefined}
        online={false}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="truncate text-wb-xs font-medium text-workbench-text">
          {highlightMatch(name, query)}
        </div>
        {company && (
          <div className="mt-px truncate text-wb-2xs font-medium text-workbench-text-muted">
            {company}
          </div>
        )}
        {ownerName && <AccountLine name={ownerName} />}
      </div>
    </button>
  );
}

/** 结果行第三行的归属账号:企微来源图标 + 账号名(别名优先),样式对齐接待列表(ConversationList)。 */
function AccountLine({ name }: { name: string }) {
  return (
    <div className="mt-px flex min-w-0 items-center gap-1.5 text-wb-4xs">
      <img
        src={WECOM_SOURCE_LOGO}
        alt=""
        aria-hidden
        className="size-3 shrink-0 rounded-[2px] object-contain"
      />
      <span className="min-w-0 truncate font-medium text-workbench-text-muted">{name}</span>
    </div>
  );
}

/** 把命中子串(不区分大小写)包进蓝色 span,对齐截图的高亮效果。 */
function highlightMatch(text: string, query: string): ReactNode {
  const q = query.trim();
  if (!q) return text;
  const lower = text.toLowerCase();
  const lq = q.toLowerCase();
  const out: ReactNode[] = [];
  let cursor = 0;
  let idx = lower.indexOf(lq);
  let key = 0;
  while (idx !== -1) {
    if (idx > cursor) out.push(text.slice(cursor, idx));
    out.push(
      <span key={key++} className="text-workbench-accent">
        {text.slice(idx, idx + q.length)}
      </span>,
    );
    cursor = idx + q.length;
    idx = lower.indexOf(lq, cursor);
  }
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}
