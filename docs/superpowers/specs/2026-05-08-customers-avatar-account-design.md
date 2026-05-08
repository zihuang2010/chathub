# 客户页头像统一与账号归属展示 — 设计

- 日期：2026-05-08
- 范围：`frontends/components/workbench/customers/`
- 关联文件（只列受改动影响的）：
  - `CustomerListRow.tsx`
  - `CustomerList.tsx`
  - `CustomerDetailPanel.tsx`
  - `constants.ts`
  - 引用方：`messages/Avatar.tsx`（不改，仅复用导出）

## 1. 目标与动机

客户页是 workbench 里与聊天页并列的核心入口。当前客户页有两点不一致：

1. **头像风格不一**：聊天页（`messages/Avatar.tsx`）使用 `size-11 rounded-xl` 的插画头像（`public/avatars/aXX.png`）+ 颜色底色 + 内描边；客户页则是 `size-9/10 rounded-full` 的单字母 + 单色块。同一个"客户"在两个视图下视觉差异过大，破坏了产品一致性。
2. **行内缺账号信息**：客户列表行的 meta 只有 `公司 · 跟进人 X`，没有这个客户归属于哪个企业账号。账号身份只在详情面板里能看到，跨账号筛选和判断时不够直观。

顺带做轻量的视觉密度梳理与一处 memo 修补，**不重构业务逻辑**。

## 2. 设计

### 2.1 头像统一为聊天页风格

**复用** `messages/Avatar.tsx` 中已存在的 `CustomerAvatar`，不新增组件。

替换两处用法：

- **列表行**：`CustomerListRow.tsx` 内联的 `Avatar(name, colorToken)` 函数删除，改为 `<CustomerAvatar name={customer.name} />`。
- **详情面板 Header**：`CustomerDetailPanel.tsx` 的 `Header` 组件中内联的字母头像 `<div className="grid size-10 …">…</div>` 替换为 `<CustomerAvatar name={customer.name} />`。

`CustomerAvatar` 自带：

- `size-11 rounded-xl bg-cover bg-center shadow-[inset_0_0_0_1px_rgba(255,255,255,0.48)]`
- 背景图：`pickCustomerAvatarImage(name)` → `/avatars/a01.png` … `/avatars/a05.png`（按 name 稳定哈希）
- 底色 fallback：`pickAvatarColor(name)` → `--wb-avatar-1..8` 调色板（按 name 稳定哈希）

**语义变化**：原本列表行头像底色 = 账号 `colorToken`（同账号客户共色，用作账号身份提示）。新方案下底色 = 客户名哈希结果（与聊天页一致）。**账号身份改由 meta 行的文本承担**（见 2.2）。详情面板 Header 同样不再使用账号 `colorToken`。

### 2.2 列表行 meta 增加账号

`CustomerListRow.tsx` 中 meta 行从：

```
公司 · 跟进人 X
```

改为：

```
账号 · 公司 · 跟进人 X
```

**Prop 设计**：`CustomerListRow` 新增 `accountName?: string`。由 `CustomerList` 在 `customers.map` 时根据已 memo 的 `accountMap` 查出账号名后传入：

```tsx
const account = customer.accountId ? accountMap.get(customer.accountId) : undefined;
<CustomerListRow accountName={account?.name} … />
```

为什么 prop 而不是在 row 里查表：保持 row 只依赖稳定原始值（字符串），不引入对 `accountMap`/`accounts` 的依赖，行的 `React.memo` 行为不变。

**meta 拼装**（位于 `CustomerListRow.tsx`）：

```ts
const meta = [accountName, customer.company, customer.follower && `跟进人 ${customer.follower}`]
  .filter(Boolean)
  .join(" · ");
```

**移除原 `avatarColorToken` prop**：替换语义后该 prop 不再使用。从 `CustomerListRow` 接口和 `CustomerList` 调用处删除。

### 2.3 视觉与信息密度

- 列表行 grid 头像列：`ROW_GRID_TEMPLATE` 中头像列从 `36px` 调整为 `44px`（适配 `size-11`）。其它列宽不变。
  - 当前：`"28px 36px minmax(0,1fr) 110px 92px"`
  - 调整后：`"28px 44px minmax(0,1fr) 110px 92px"`
- 行高 `ROW_HEIGHT = 60` 保持不变（44px 在 60px 行内仍有充分上下间距）。
- meta 行容器已是 `truncate min-w-0`，自然从右侧截断 → 账号永远可见、公司次之、跟进人最先被截，与信息优先级匹配，无需新增截断规则。
- 详情面板 Header 头像从 `size-10 rounded-full` → `size-11 rounded-xl`，与列表行对齐。Header 中 meta 已经包含 `@${account.name}`，**保留不动**；`ContactList` 中"归属账号"一行也**保留不动**。

### 2.4 性能 / memo 复查（最小增量）

经审视当前代码：

- **`CustomerListRow` memo 持续有效** ✅：替换头像与新增 `accountName` 后，所有 prop 仍是引用稳定的原始值或 store 内逐项替换的对象。父级回调（`onSelect`/`onToggleStar`/`onToggleMultiSelect`）已在 `CustomersPage` 用 `useCallback`。
- **`pruneTo` 早返回** ✅：`useCustomerSelection.ts:76-91` 已检测无需剪除时返回原 `prev`，过滤变化不会无谓触发 row re-render。
- **`useCustomersFilters` 稳定性** ✅：`filteredCustomers` 由 `useMemo` 计算，`source` 内逐项稳定意味着未变化的客户对象引用稳定，memo 链路完整。

**唯一新增 memo**：`CustomerDetailPanel.tsx` 内部的 `Header` 组件用 `memo` 包裹。

- 动机：用户在备注编辑器中打字时，`draftRemark` 状态变化 → `DetailBody` 重渲染 → 当前 `Header` 函数组件每次都跑一遍。其实 `Header` 的 props（`customer`/`account`/`starred`/`onToggleStar`）此时都没变，可跳过。
- 范围：仅给 `Header` 加 `memo`。**不**改 `ActionRow`/`Section`/`ContactList`/`CustomerStatusCard` 等其他子组件，避免无依据的重构。

不动以下区域：

- `CustomersPage` 的 `useEffect` 链
- `useCustomersFilters` 的 selector / 计算结构
- `useCustomerStore` / `useCustomerSelection` 内部
- 其它任何 customers/ 文件中本次未列举的代码

## 3. 实现影响清单（对实施计划的输入）

| 文件                                | 变更                                                                                                                                     |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `customers/CustomerListRow.tsx`     | 删除内联 `Avatar` 函数；改用 `CustomerAvatar`；删除 `avatarColorToken` prop，新增 `accountName?: string` prop；meta 行加入 `accountName` |
| `customers/CustomerList.tsx`        | 调用 `CustomerListRow` 时传 `accountName={account?.name}`，去掉 `avatarColorToken`                                                       |
| `customers/CustomerDetailPanel.tsx` | Header 头像替换为 `CustomerAvatar`；`Header` 用 `memo` 包裹                                                                              |
| `customers/constants.ts`            | `ROW_GRID_TEMPLATE` 头像列 `36px` → `44px`                                                                                               |
| `messages/Avatar.tsx`               | 不改（仅作为依赖被引入到 customers/）                                                                                                    |

## 4. 测试

- 视觉回归：customers 页列表行 + 详情面板头像与聊天页 `MessagesPage` 中的 `CustomerAvatar` 在同一个客户上呈现一致。
- 列表行新增的账号文本：随机抽几条覆盖（有账号 / 无账号 / 长账号名截断）；账号 chips 过滤后行内仍正确显示该账号名。
- memo 行为：在详情面板备注里打字时，`Header` 组件不应重渲染（开发可用 React DevTools profiler 验证；非阻塞验收，仅作 sanity check）。
- 既有用例：`Sidebar.test.tsx` 等无关单元测试保持通过；customers/ 目录下若有现成测试一并跑过。

## 5. 不在范围内（明确排除）

- 不改 `useCustomersFilters` / `useCustomerStore` / `useCustomerSelection`。
- 不动 `CustomersPage` 的 effect 编排。
- 不引入新的头像图片资源；沿用 `public/avatars/a01..a05.png`。
- 不改详情面板 Header 的 meta 文案、`ContactList` 中归属账号行。
- 不引入虚拟滚动 / 列表分页 / 其它结构性性能改造。
