# 客户页头像统一与账号归属展示 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 客户页列表行 + 详情面板头像复用聊天页 `CustomerAvatar`；列表行 meta 行新增"归属账号"；顺手给详情 `Header` 加 `React.memo`。

**Architecture:** 不引入新组件，复用 `messages/Avatar.tsx` 中已有的 `CustomerAvatar`。`CustomerListRow` 用 `accountName?: string` prop 接收账号名（由 `CustomerList` 在 map 时从 `accountMap` 查表传入），保持 row 仅依赖稳定值，`React.memo` 行为不变。`CustomerListRow` 原本的 `avatarColorToken` prop 被移除（账号身份转交给 meta 文本）。

**Tech Stack:** React 19 / TypeScript / Tailwind / vitest + @testing-library/react

**Spec:** `docs/superpowers/specs/2026-05-08-customers-avatar-account-design.md`

---

## 文件清单

| 文件                                                                | 动作                                                                                                                           |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `frontends/components/workbench/customers/CustomerListRow.tsx`      | 修改：删 `Avatar` 内联组件 + `avatarColorToken` prop；引入 `CustomerAvatar`；新增 `accountName?: string` prop；meta 行加入账号 |
| `frontends/components/workbench/customers/CustomerList.tsx`         | 修改：调用 `CustomerListRow` 时传 `accountName={account?.name}`，去掉 `avatarColorToken`                                       |
| `frontends/components/workbench/customers/constants.ts`             | 修改：`ROW_GRID_TEMPLATE` 第 2 列 `36px` → `44px`                                                                              |
| `frontends/components/workbench/customers/CustomerDetailPanel.tsx`  | 修改：Header 内联字母头像替换为 `CustomerAvatar`；`Header` 用 `memo` 包裹                                                      |
| `frontends/components/workbench/customers/CustomerListRow.test.tsx` | 新建：覆盖账号名渲染 + 头像复用                                                                                                |

---

## Task 1: CustomerListRow 改造（accountName + 头像 + 列宽）

**Files:**

- Create: `frontends/components/workbench/customers/CustomerListRow.test.tsx`
- Modify: `frontends/components/workbench/customers/CustomerListRow.tsx`
- Modify: `frontends/components/workbench/customers/CustomerList.tsx`
- Modify: `frontends/components/workbench/customers/constants.ts`

### Step 1.1 写 failing test

- [ ] 创建测试文件 `CustomerListRow.test.tsx`，断言：
  - 提供 `accountName` 时 meta 行包含账号名 + 公司 + 跟进人
  - 不提供 `accountName` 时 meta 行不出现 `undefined`/空段
  - 头像 div 带 `role="img"` 且 `aria-label` 等于客户名（`CustomerAvatar` 的契约）

```tsx
// frontends/components/workbench/customers/CustomerListRow.test.tsx
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import type { Customer } from "@/lib/types/customer";

import { CustomerListRow } from "./CustomerListRow";

afterEach(() => {
  cleanup();
});

function makeCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: "cust-1",
    name: "林知言",
    channel: "微信",
    account: "杭州企微·小美",
    tags: [],
    remark: "",
    phone: "186****0421",
    weChat: "linzhiyan_wx",
    company: "知言科技",
    source: "公司官网",
    addedAt: "2024-05-20 10:15",
    follower: "阿玲",
    accountId: "a-hz-mei",
    ...overrides,
  };
}

const baseProps = {
  selected: false,
  multiSelectActive: false,
  multiSelected: false,
  showFollowUpReason: false,
  onSelect: () => {},
  onToggleStar: () => {},
  onToggleMultiSelect: () => {},
} as const;

describe("CustomerListRow", () => {
  it("提供 accountName 时 meta 行展示 账号 · 公司 · 跟进人", () => {
    render(
      <CustomerListRow customer={makeCustomer()} accountName="杭州企微·小美" {...baseProps} />,
    );
    const meta = screen.getByText(/杭州企微·小美/);
    expect(meta.textContent).toContain("杭州企微·小美");
    expect(meta.textContent).toContain("知言科技");
    expect(meta.textContent).toContain("跟进人 阿玲");
  });

  it("未提供 accountName 时 meta 行不渲染 undefined / 残留分隔符", () => {
    render(<CustomerListRow customer={makeCustomer()} {...baseProps} />);
    // meta 是包含「公司」的最近一个 span
    const company = screen.getByText(/知言科技/);
    expect(company.textContent).not.toContain("undefined");
    // 不会出现 leading "·"（"· 知言科技…"）
    expect(company.textContent?.trimStart().startsWith("·")).toBe(false);
  });

  it("头像复用 CustomerAvatar：role=img 且 aria-label=客户名", () => {
    const { container } = render(
      <CustomerListRow customer={makeCustomer()} accountName="X" {...baseProps} />,
    );
    const avatar = container.querySelector('[role="img"]');
    expect(avatar).not.toBeNull();
    expect(avatar!.getAttribute("aria-label")).toBe("林知言");
    // chat 风格：rounded-xl + bg-cover
    expect(avatar!.className).toContain("rounded-xl");
    expect(avatar!.className).toContain("bg-cover");
  });
});
```

### Step 1.2 运行测试确认 fail

- [ ] 运行：

```bash
pnpm test frontends/components/workbench/customers/CustomerListRow.test.tsx
```

预期：3 个用例全部 FAIL（meta 不含账号名 / 头像没有 `role="img"`）。

### Step 1.3 改 `CustomerListRow.tsx`

- [ ] 用下述完整内容替换 `frontends/components/workbench/customers/CustomerListRow.tsx`：

```tsx
import { memo } from "react";
import { Star } from "lucide-react";

import type { Customer } from "@/lib/types/customer";
import { cn } from "@/lib/utils";

import { CustomerAvatar } from "../messages/Avatar";

import { ROW_GRID_TEMPLATE } from "./constants";
import { STAGE_BADGE_CLASS, resolveStageBadge } from "./stageBadge";
import { STRINGS } from "./strings";
import { formatNextFollowUp, formatRelativeTime, type FollowUpTone } from "./utils";

const FOLLOW_UP_TONE_CLASS: Record<FollowUpTone, string> = {
  overdue: "text-workbench-danger font-semibold",
  today: "text-workbench-danger font-semibold",
  tomorrow: "text-workbench-warning font-semibold",
  soon: "text-workbench-text font-medium",
  later: "text-workbench-text-secondary font-medium",
};

interface CustomerListRowProps {
  customer: Customer;
  selected: boolean;
  multiSelectActive: boolean;
  multiSelected: boolean;
  showFollowUpReason: boolean;
  /** 客户归属账号名。出现在 meta 行最前段，让用户在跨账号视图下一眼分辨。 */
  accountName?: string;
  onSelect: (id: string) => void;
  onToggleStar: (id: string) => void;
  onToggleMultiSelect: (id: string) => void;
}

export const CustomerListRow = memo(function CustomerListRow({
  customer,
  selected,
  multiSelectActive,
  multiSelected,
  showFollowUpReason,
  accountName,
  onSelect,
  onToggleStar,
  onToggleMultiSelect,
}: CustomerListRowProps) {
  const followUp = formatNextFollowUp(customer.nextFollowUpAt);
  const stageBadge = resolveStageBadge(customer);
  const meta = [accountName, customer.company, customer.follower && `跟进人 ${customer.follower}`]
    .filter(Boolean)
    .join(" · ");

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
      style={{ gridTemplateColumns: ROW_GRID_TEMPLATE }}
      className={cn(
        "group relative grid h-[60px] cursor-pointer items-center gap-3 px-4 transition-colors",
        "hover:bg-workbench-surface-subtle focus-visible:bg-workbench-surface-subtle focus-visible:outline-none",
        selected && !multiSelectActive && "bg-workbench-surface-active",
        multiSelected && "bg-workbench-surface-active/70",
      )}
    >
      {selected && !multiSelectActive && (
        <span
          aria-hidden
          className="absolute inset-y-2 left-0 w-[2px] rounded-full bg-workbench-accent"
        />
      )}

      {multiSelectActive ? (
        <Checkbox
          checked={multiSelected}
          onChange={() => onToggleMultiSelect(customer.id)}
          aria-label={`选择 ${customer.name}`}
        />
      ) : (
        <StarToggle
          starred={Boolean(customer.starred)}
          onClick={(e) => {
            e.stopPropagation();
            onToggleStar(customer.id);
          }}
        />
      )}

      <CustomerAvatar name={customer.name} />

      <div className="min-w-0">
        <div className="truncate text-[13px] font-semibold text-workbench-text">
          {customer.name}
        </div>
        <div className="flex items-center gap-1 truncate text-[11px] text-workbench-text-secondary">
          <span className="truncate">{meta}</span>
          {showFollowUpReason && customer.followUpReason && (
            <span className="ml-1 inline-flex items-center gap-1 whitespace-nowrap text-workbench-danger">
              <span aria-hidden className="size-1.5 rounded-full bg-workbench-danger" />
              {customer.followUpReason}
            </span>
          )}
        </div>
      </div>

      <div className="min-w-0">
        {stageBadge && (
          <span
            className={cn(
              "inline-flex max-w-full items-center truncate rounded-full px-2 py-0.5 text-[11.5px] font-medium ring-1",
              STAGE_BADGE_CLASS[stageBadge.tone],
            )}
          >
            {stageBadge.label}
          </span>
        )}
      </div>

      <FollowUpCell followUp={followUp} fallbackTime={customer.lastContactAt ?? customer.addedAt} />
    </div>
  );
});

function FollowUpCell({
  followUp,
  fallbackTime,
}: {
  followUp: { label: string; tone: FollowUpTone } | null;
  fallbackTime: string | null | undefined;
}) {
  if (followUp) {
    const caption = STRINGS.list.columnNextFollowUp;
    return (
      <div
        aria-label={`${caption} ${followUp.label}`}
        className="flex flex-col items-end gap-2.5 text-right leading-tight"
      >
        <span className="text-[10.5px] text-workbench-text-muted">{caption}</span>
        <span
          className={cn(
            "wb-num truncate text-[10.5px] tabular-nums",
            FOLLOW_UP_TONE_CLASS[followUp.tone],
          )}
        >
          {followUp.label}
        </span>
      </div>
    );
  }
  const lastTimeLabel = formatRelativeTime(fallbackTime);
  const caption = STRINGS.list.columnLastContact;
  return (
    <div
      aria-label={`${caption} ${lastTimeLabel}`}
      className="flex flex-col items-end gap-2.5 text-right leading-tight"
    >
      <span className="text-[10.5px] text-workbench-text-muted">{caption}</span>
      <span className="wb-num truncate text-[10.5px] font-medium tabular-nums text-workbench-text-secondary">
        {lastTimeLabel}
      </span>
    </div>
  );
}

function StarToggle({
  starred,
  onClick,
}: {
  starred: boolean;
  onClick: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      aria-label={starred ? "取消关注" : "关注"}
      onClick={onClick}
      className={cn(
        "focus-ring grid size-7 place-items-center rounded-md transition-all",
        starred
          ? "text-workbench-warning hover:bg-workbench-surface-subtle"
          : cn(
              "text-workbench-text-muted hover:bg-workbench-surface-subtle hover:text-workbench-warning",
              "opacity-0 focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100",
            ),
      )}
    >
      <Star size={15} fill={starred ? "currentColor" : "none"} strokeWidth={1.6} />
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
        "focus-ring grid size-5 place-items-center rounded-[5px] border transition-colors",
        checked
          ? "border-workbench-accent bg-workbench-accent text-workbench-surface"
          : "border-workbench-line bg-workbench-surface text-transparent hover:border-workbench-line-strong",
      )}
      {...props}
    >
      <svg viewBox="0 0 12 12" className="size-3" aria-hidden>
        <path
          d="M2.5 6.2 5 8.6 9.6 3.4"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
```

变化点（相对原文件）：

- 顶部 import 增加 `import { CustomerAvatar } from "../messages/Avatar";`
- `CustomerListRowProps` 删 `avatarColorToken?: number`，加 `accountName?: string`
- 函数体 `meta` 拼装将 `accountName` 放在最前
- `<Avatar name={customer.name} colorToken={avatarColorToken} />` 替换为 `<CustomerAvatar name={customer.name} />`
- 文件底部移除原内联 `function Avatar({ name, colorToken }) { … }`

### Step 1.4 改 `CustomerList.tsx`

- [ ] 在 `frontends/components/workbench/customers/CustomerList.tsx` 中找到 row 渲染处（约 118 行附近），把 `avatarColorToken={account?.colorToken}` 改为 `accountName={account?.name}`：

```tsx
<CustomerListRow
  customer={customer}
  accountName={account?.name}
  selected={!multiSelectActive && customer.id === activeCustomerId}
  multiSelectActive={multiSelectActive}
  multiSelected={selectedIds.has(customer.id)}
  showFollowUpReason={activeTab === "needs-followup"}
  onSelect={onSelectCustomer}
  onToggleStar={onToggleStar}
  onToggleMultiSelect={onToggleMultiSelect}
/>
```

仅替换 `avatarColorToken` → `accountName` 这一行；其他不动。`accountMap` 的 `useMemo` 计算保持原样。

### Step 1.5 改 `constants.ts`

- [ ] 把 `ROW_GRID_TEMPLATE` 的第 2 列 `36px` 改为 `44px`：

```ts
export const ROW_GRID_TEMPLATE = "28px 44px minmax(0,1fr) 110px 92px";
```

注释里"36px avatar"也同步改为"44px avatar"，让注释与值一致：

```ts
/**
 * 列表行 grid 模板。从左至右：
 * 1) 28px star/checkbox
 * 2) 44px avatar
 * 3) flex 客户信息（姓名 + meta：账号 · 公司 · 跟进人 名）
 * 4) 110px 客户阶段（pill 含 +N 溢出）
 * 5) 92px 下次跟进（"下次跟进" + 状态 双行；或仅相对时间单行）
 */
export const ROW_GRID_TEMPLATE = "28px 44px minmax(0,1fr) 110px 92px";
```

### Step 1.6 跑测试 + lint + typecheck

- [ ] 运行：

```bash
pnpm test frontends/components/workbench/customers/CustomerListRow.test.tsx
```

预期：3 个用例全部 PASS。

- [ ] 运行全量测试确保未破坏其它：

```bash
pnpm test
```

预期：所有现有测试 PASS。

- [ ] 运行 lint：

```bash
pnpm lint
```

预期：无错误。

- [ ] 运行 typecheck（vite build 同时做 tsc）：

```bash
pnpm exec tsc --noEmit
```

预期：无错误。

### Step 1.7 提交

- [ ] 提交：

```bash
git add frontends/components/workbench/customers/CustomerListRow.tsx \
        frontends/components/workbench/customers/CustomerListRow.test.tsx \
        frontends/components/workbench/customers/CustomerList.tsx \
        frontends/components/workbench/customers/constants.ts
git commit -m "$(cat <<'EOF'
feat(customers): 列表行复用聊天页头像并展示归属账号

- 头像替换为 messages/Avatar 中的 CustomerAvatar，统一插画风格
- meta 行新增账号名（账号 · 公司 · 跟进人），精简跨账号识别成本
- ROW_GRID_TEMPLATE 头像列 36px → 44px 适配 size-11
- 新增 CustomerListRow 测试覆盖 meta 与头像

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

注意：husky pre-commit 会跑 prettier + eslint，让其自动格式化即可。

---

## Task 2: 详情面板 Header 头像替换 + memo

**Files:**

- Modify: `frontends/components/workbench/customers/CustomerDetailPanel.tsx`

### Step 2.1 替换 Header 头像 + memo 包裹

- [ ] 在 `CustomerDetailPanel.tsx` 顶部 import 区追加（与已有 import 同区组织，按字母顺序）：

```tsx
import { CustomerAvatar } from "../messages/Avatar";
```

- [ ] 把 `Header` 组件的函数声明改为 `memo` 包裹的常量声明，并把内部内联字母头像替换为 `CustomerAvatar`：

原代码（约 201–248 行附近）：

```tsx
function Header({
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
  const meta = [customer.company, customer.channel, account && `@${account.name}`]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="flex items-start gap-2.5">
      <div
        className="grid size-10 shrink-0 place-items-center rounded-full text-[16px] font-medium text-workbench-text shadow-[inset_0_0_0_1px_rgba(255,255,255,0.45)]"
        style={{ background: `hsl(var(--wb-avatar-${colorToken}))` }}
      >
        {customer.name.slice(0, 1)}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        ...
```

替换为：

```tsx
const Header = memo(function Header({
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
  const meta = [customer.company, customer.channel, account && `@${account.name}`]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="flex items-start gap-2.5">
      <CustomerAvatar name={customer.name} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[15px] font-semibold text-workbench-text">
          {customer.name}
        </span>
        {meta && <span className="truncate text-[11px] text-workbench-text-secondary">{meta}</span>}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <IconButton
          aria-label={starred ? STRINGS.rowMore.unstar : STRINGS.rowMore.star}
          onClick={onToggleStar}
          active={starred}
        >
          <Star
            size={14}
            fill={starred ? "currentColor" : "none"}
            className={starred ? "text-workbench-warning" : undefined}
          />
        </IconButton>
        <IconButton aria-label={STRINGS.detail.actions.more}>
          <MoreHorizontal size={14} />
        </IconButton>
      </div>
    </div>
  );
});
```

变化点：

- `function Header(...) { ... }` → `const Header = memo(function Header(...) { ... });`
- 删 `const colorToken = account?.colorToken ?? 1;`
- 删 `<div className="grid size-10 …" style={{ background: ... }}>{customer.name.slice(0,1)}</div>`
- 增 `<CustomerAvatar name={customer.name} />`
- `customer.company / channel / @account.name` 拼装的 meta 文案保持不动

确保 `memo` 已经在 React import 列表里。原文件第 1 行：`import { memo, useRef, useState } from "react";` —— `memo` 已经在了，无需再加。

### Step 2.2 跑测试 + lint + typecheck

- [ ] 运行测试：

```bash
pnpm test
```

预期：所有 PASS（含 Task 1 的新测试）。

- [ ] 运行 lint：

```bash
pnpm lint
```

预期：无错误。

- [ ] 运行 typecheck：

```bash
pnpm exec tsc --noEmit
```

预期：无错误。

### Step 2.3 提交

- [ ] 提交：

```bash
git add frontends/components/workbench/customers/CustomerDetailPanel.tsx
git commit -m "$(cat <<'EOF'
feat(customers): 详情面板头像统一聊天风格并 memo 化 Header

- Header 内联字母头像替换为 messages/Avatar 中的 CustomerAvatar
- 用 React.memo 包裹 Header；备注编辑期 draftRemark 变化不再触发头部重渲染

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: 全量回归 + 视觉 sanity check

**Files:** 无修改

### Step 3.1 全量测试

- [ ] 运行：

```bash
pnpm test
```

预期：全部 PASS。

### Step 3.2 完整 build（typecheck + 资产打包）

- [ ] 运行：

```bash
pnpm build
```

预期：成功。

### Step 3.3 视觉 sanity check（手动）

- [ ] 启动 dev：

```bash
pnpm dev
```

- [ ] 切到客户页（左侧"客户"入口），逐项验证：
  - 列表行头像与聊天页 CustomerAvatar 风格一致（圆角矩形 + 插画 + 内描边）
  - meta 行格式：`账号 · 公司 · 跟进人 名`，长账号名下其它字段被右侧截断
  - 选择某个客户 → 详情面板头像同样为聊天风格 size-11
  - 进入详情备注编辑态后打字，观察 React DevTools profiler：`Header` 不应在每次输入时 re-render（非阻塞验证；若没装 profiler 跳过）
- [ ] 切到聊天页，对比同一名客户头像图样是否一致（应一致：都用 `pickCustomerAvatarImage(name)`）

如发现视觉问题（如 grid 列宽偏移），单独 fix + commit，不要在本计划任务里夹带。

---

## Self-Review Notes

- Spec §2.1 头像统一 → Task 1（列表行）+ Task 2（详情）✅
- Spec §2.2 meta 加账号 → Task 1 Step 1.3 + 1.4 ✅
- Spec §2.3 grid 列宽 → Task 1 Step 1.5 ✅
- Spec §2.4 Header memo → Task 2 Step 2.1 ✅
- Spec §3 实现影响清单 → 文件清单逐项对齐 ✅
- Spec §4 测试 → Task 1 单测 + Task 3 视觉 sanity ✅
- Spec §5 排除项（不动 useCustomersFilters / store / selection / page effects）→ 计划任务无任何相关改动 ✅
