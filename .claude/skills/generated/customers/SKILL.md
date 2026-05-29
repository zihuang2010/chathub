---
name: customers
description: "Skill for the Customers area of chathub. 123 symbols across 32 files."
---

# Customers

123 symbols | 32 files | Cohesion: 69%

## When to Use

- Working with code in `frontends/`
- Understanding how tagColorClass, useMessagesReady, checkForAppUpdates work
- Modifying customers-related functionality

## Key Files

| File                                                               | Symbols                                                                                  |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `frontends/components/workbench/customers/CustomerDetailPanel.tsx` | DetailBody, DetailHeaderBar, QuickActions, QuickAction, CustomerInfoSection (+12)        |
| `frontends/components/workbench/customers/utils.ts`                | pick, escapeCsv, toCsv, downloadCsv, parseDate (+10)                                     |
| `frontends/components/workbench/customers/CustomersPage.tsx`       | CustomersPage, handleToggleStar, handleOpenChat, handleCall, handleBulkApplyTagDiff (+6) |
| `frontends/components/workbench/customers/CustomerCard.tsx`        | formatCardMeta, formatDateTime, pad, CustomerCard, GenderIcon (+3)                       |
| `frontends/components/workbench/customers/AccountPicker.tsx`       | AccountPicker, SearchBox, Group, Row, Footer (+3)                                        |
| `frontends/components/workbench/customers/CustomerRow.tsx`         | CustomerRow, GenderIcon, RowIconButton, RowActionButton, Checkbox (+2)                   |
| `frontends/components/workbench/customers/BulkActionsBar.tsx`      | BulkActionsBar, ActionButton, TagPickerPopover, reset, togglePick (+2)                   |
| `frontends/components/ui/toast.tsx`                                | emit, dismiss, showToast, useToasts, ToastViewport (+1)                                  |
| `frontends/components/workbench/customers/CustomerList.tsx`        | CustomerList, VirtualizedCardGrid, VirtualizedCustomerRows, ListStatus, EmptyList (+1)   |
| `frontends/components/workbench/accounts/AccountsToolbar.tsx`      | AccountsToolbar, SearchInput, ViewToggle, ViewToggleButton                               |

## Entry Points

Start here when exploring this area:

- **`tagColorClass`** (Function) — `frontends/components/workbench/customers/tagColor.ts:17`
- **`useMessagesReady`** (Function) — `frontends/lib/data/appReady.ts:57`
- **`checkForAppUpdates`** (Function) — `frontends/lib/updater.ts:3`
- **`cn`** (Function) — `frontends/lib/utils.ts:11`
- **`Workbench`** (Function) — `frontends/components/Workbench.tsx:14`

## Key Symbols

| Symbol                  | Type     | File                                                                   | Line |
| ----------------------- | -------- | ---------------------------------------------------------------------- | ---- |
| `tagColorClass`         | Function | `frontends/components/workbench/customers/tagColor.ts`                 | 17   |
| `useMessagesReady`      | Function | `frontends/lib/data/appReady.ts`                                       | 57   |
| `checkForAppUpdates`    | Function | `frontends/lib/updater.ts`                                             | 3    |
| `cn`                    | Function | `frontends/lib/utils.ts`                                               | 11   |
| `Workbench`             | Function | `frontends/components/Workbench.tsx`                                   | 14   |
| `AccountsToolbar`       | Function | `frontends/components/workbench/accounts/AccountsToolbar.tsx`          | 52   |
| `DateRangePicker`       | Function | `frontends/components/workbench/accounts/DateRangePicker.tsx`          | 20   |
| `CustomerAvatar`        | Function | `frontends/components/workbench/customers/CustomerAvatar.tsx`          | 24   |
| `CustomerRow`           | Function | `frontends/components/workbench/customers/CustomerRow.tsx`             | 30   |
| `CustomersPagination`   | Function | `frontends/components/workbench/customers/CustomersPagination.tsx`     | 29   |
| `ImageNodeView`         | Function | `frontends/components/workbench/messages/composer/ImageNodeView.tsx`   | 7    |
| `useCustomerStore`      | Function | `frontends/components/workbench/customers/useCustomerStore.ts`         | 23   |
| `maybeLoadOlderHistory` | Function | `frontends/components/workbench/messages/hooks/useScrollController.ts` | 137  |
| `handleUserScroll`      | Function | `frontends/components/workbench/messages/hooks/useScrollController.ts` | 174  |
| `showToast`             | Function | `frontends/components/ui/toast.tsx`                                    | 33   |
| `ToastViewport`         | Function | `frontends/components/ui/toast.tsx`                                    | 64   |
| `handleRefresh`         | Function | `frontends/components/workbench/accounts/AccountsPage.tsx`             | 39   |
| `CustomerDetailPanel`   | Function | `frontends/components/workbench/customers/CustomerDetailPanel.tsx`     | 45   |
| `CustomersPage`         | Function | `frontends/components/workbench/customers/CustomersPage.tsx`           | 34   |
| `handleToggleStar`      | Function | `frontends/components/workbench/customers/CustomersPage.tsx`           | 217  |

## Execution Flows

| Flow                           | Type            | Steps |
| ------------------------------ | --------------- | ----- |
| `CustomersPage → ScopeMatches` | cross_community | 6     |
| `HandleExport → StartOfDay`    | cross_community | 6     |
| `HandleExport → ParseStamp`    | cross_community | 6     |
| `RenderRowContent → Cn`        | cross_community | 6     |
| `CustomerDetails → Cn`         | cross_community | 6     |
| `CustomersPage → ErrorMessage` | cross_community | 5     |
| `HandleExport → Pad`           | cross_community | 5     |
| `Workbench → ErrorMessage`     | cross_community | 5     |
| `AccountsPage → Cn`            | cross_community | 4     |
| `CustomersPage → Subscribe`    | cross_community | 4     |

## Connected Areas

| Area        | Connections |
| ----------- | ----------- |
| Messages    | 7 calls     |
| Components  | 4 calls     |
| Accounts    | 3 calls     |
| Api         | 2 calls     |
| Data        | 1 calls     |
| Cluster_216 | 1 calls     |
| Workbench   | 1 calls     |

## How to Explore

1. `gitnexus_context({name: "tagColorClass"})` — see callers and callees
2. `gitnexus_query({query: "customers"})` — find related execution flows
3. Read key files listed above for implementation details
