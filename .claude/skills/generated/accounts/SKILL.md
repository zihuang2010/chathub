---
name: accounts
description: "Skill for the Accounts area of chathub. 68 symbols across 15 files."
---

# Accounts

68 symbols | 15 files | Cohesion: 69%

## When to Use

- Working with code in `frontends/`
- Understanding how filteredRows, filtered, parseStamp work
- Modifying accounts-related functionality

## Key Files

| File                                                               | Symbols                                                                                   |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `frontends/components/workbench/accounts/useAccountsView.ts`       | filteredRows, filtered, startOfDay, endOfDay, compareAccounts (+19)                       |
| `frontends/components/workbench/accounts/utils.ts`                 | parseStamp, pad, startOfDay, calendarDaysAgo, bucketLast7Days (+6)                        |
| `frontends/components/workbench/accounts/AccountsPagination.tsx`   | AccountsPagination, generatePages, PageSizeSelector, PageNavButton, PageNumberButton (+2) |
| `frontends/components/workbench/accounts/AccountsPage.tsx`         | AccountsPage, PageHeader, EmptyState, LoadingState, ErrorState (+1)                       |
| `frontends/components/workbench/accounts/AccountsToolbar.tsx`      | AccountsToolbar, SearchInput, ViewToggle, ViewToggleButton                                |
| `frontends/components/workbench/customers/CustomersPagination.tsx` | CustomersPagination, PageSizeSelector, PageNavButton                                      |
| `frontends/components/workbench/accounts/AccountCard.tsx`          | AccountCard, CityAvatar, Stat                                                             |
| `frontends/components/workbench/accounts/AccountListRow.tsx`       | AccountListRow, NumCell                                                                   |
| `frontends/components/workbench/accounts/AccountsKpiStrip.tsx`     | AccountsKpiStrip, KpiCard                                                                 |
| `frontends/components/workbench/accounts/AccountTrendChart.tsx`    | AccountTrendChart                                                                         |

## Entry Points

Start here when exploring this area:

- **`filteredRows`** (Function) — `frontends/components/workbench/accounts/useAccountsView.ts:205`
- **`filtered`** (Function) — `frontends/components/workbench/accounts/useAccountsView.ts:210`
- **`parseStamp`** (Function) — `frontends/components/workbench/accounts/utils.ts:6`
- **`calendarDaysAgo`** (Function) — `frontends/components/workbench/accounts/utils.ts:16`
- **`bucketLast7Days`** (Function) — `frontends/components/workbench/accounts/utils.ts:23`

## Key Symbols

| Symbol                | Type     | File                                                                 | Line |
| --------------------- | -------- | -------------------------------------------------------------------- | ---- |
| `filteredRows`        | Function | `frontends/components/workbench/accounts/useAccountsView.ts`         | 205  |
| `filtered`            | Function | `frontends/components/workbench/accounts/useAccountsView.ts`         | 210  |
| `parseStamp`          | Function | `frontends/components/workbench/accounts/utils.ts`                   | 6    |
| `calendarDaysAgo`     | Function | `frontends/components/workbench/accounts/utils.ts`                   | 16   |
| `bucketLast7Days`     | Function | `frontends/components/workbench/accounts/utils.ts`                   | 23   |
| `formatRelative`      | Function | `frontends/components/workbench/accounts/utils.ts`                   | 35   |
| `formatMonthDay`      | Function | `frontends/components/workbench/accounts/utils.ts`                   | 57   |
| `AccountTrendChart`   | Function | `frontends/components/workbench/accounts/AccountTrendChart.tsx`      | 22   |
| `cn`                  | Function | `frontends/lib/utils.ts`                                             | 11   |
| `AccountsToolbar`     | Function | `frontends/components/workbench/accounts/AccountsToolbar.tsx`        | 52   |
| `DateRangePicker`     | Function | `frontends/components/workbench/accounts/DateRangePicker.tsx`        | 20   |
| `CustomersPagination` | Function | `frontends/components/workbench/customers/CustomersPagination.tsx`   | 29   |
| `ImageNodeView`       | Function | `frontends/components/workbench/messages/composer/ImageNodeView.tsx` | 7    |
| `resetToPage1`        | Function | `frontends/components/workbench/accounts/useAccountsView.ts`         | 109  |
| `setActiveTab`        | Function | `frontends/components/workbench/accounts/useAccountsView.ts`         | 111  |
| `clearStatus`         | Function | `frontends/components/workbench/accounts/useAccountsView.ts`         | 126  |
| `clearEnterprise`     | Function | `frontends/components/workbench/accounts/useAccountsView.ts`         | 138  |
| `clearOwner`          | Function | `frontends/components/workbench/accounts/useAccountsView.ts`         | 150  |
| `setDateRange`        | Function | `frontends/components/workbench/accounts/useAccountsView.ts`         | 155  |
| `clearDateRange`      | Function | `frontends/components/workbench/accounts/useAccountsView.ts`         | 162  |

## Execution Flows

| Flow                           | Type            | Steps |
| ------------------------------ | --------------- | ----- |
| `HandleExport → StartOfDay`    | cross_community | 6     |
| `HandleExport → ParseStamp`    | cross_community | 6     |
| `RenderRowContent → Cn`        | cross_community | 6     |
| `HandleExport → Pad`           | cross_community | 5     |
| `ConversationList → Cn`        | cross_community | 5     |
| `CustomerDetails → Cn`         | cross_community | 5     |
| `AccountsPage → Cn`            | cross_community | 4     |
| `HandleExport → GetStatusMeta` | cross_community | 4     |
| `CustomerList → Cn`            | cross_community | 4     |
| `Workbench → Cn`               | cross_community | 4     |

## Connected Areas

| Area      | Connections |
| --------- | ----------- |
| Messages  | 1 calls     |
| Customers | 1 calls     |

## How to Explore

1. `gitnexus_context({name: "filteredRows"})` — see callers and callees
2. `gitnexus_query({query: "accounts"})` — find related execution flows
3. Read key files listed above for implementation details
