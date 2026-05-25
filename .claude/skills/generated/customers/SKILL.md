---
name: customers
description: "Skill for the Customers area of chathub. 132 symbols across 40 files."
---

# Customers

132 symbols | 40 files | Cohesion: 72%

## When to Use

- Working with code in `frontends/`
- Understanding how isKeyCustomer, tagColorClass, useDetailsWindow work
- Modifying customers-related functionality

## Key Files

| File                                                               | Symbols                                                                                  |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `frontends/components/workbench/customers/CustomerDetailPanel.tsx` | DetailBody, DetailHeaderBar, QuickActions, QuickAction, CustomerInfoSection (+12)        |
| `frontends/components/workbench/customers/utils.ts`                | pick, escapeCsv, toCsv, downloadCsv, parseDate (+10)                                     |
| `frontends/components/workbench/customers/CustomersPage.tsx`       | CustomersPage, handleToggleStar, handleOpenChat, handleCall, handleBulkApplyTagDiff (+6) |
| `frontends/components/workbench/customers/CustomerCard.tsx`        | CustomerCard, GenderIcon, RowIconButton, CardActionButton, Checkbox (+3)                 |
| `frontends/components/workbench/customers/AccountPicker.tsx`       | AccountPicker, SearchBox, Group, Row, Footer (+3)                                        |
| `frontends/components/workbench/customers/BulkActionsBar.tsx`      | BulkActionsBar, ActionButton, TagPickerPopover, reset, togglePick (+2)                   |
| `frontends/components/ui/toast.tsx`                                | useToasts, ToastViewport, ToastItem, emit, dismiss (+1)                                  |
| `frontends/components/workbench/messages/CustomerDetails.tsx`      | CustomerDetails, Tabs, ProfileTab, TagsRow, DetailList (+1)                              |
| `frontends/components/workbench/accounts/AccountsToolbar.tsx`      | AccountsToolbar, SearchInput, ViewToggle, ViewToggleButton                               |
| `frontends/components/workbench/messages/ConversationList.tsx`     | ConversationList, VirtualizedList, FilterToolbar, ConversationItem                       |

## Entry Points

Start here when exploring this area:

- **`isKeyCustomer`** (Function) — `frontends/components/workbench/customers/customerLabels.ts:13`
- **`tagColorClass`** (Function) — `frontends/components/workbench/customers/tagColor.ts:17`
- **`useDetailsWindow`** (Function) — `frontends/components/workbench/messages/useDetailsWindow.ts:76`
- **`extractAccountOperator`** (Function) — `frontends/components/workbench/messages/utils.ts:2`
- **`useMessagesReady`** (Function) — `frontends/lib/data/appReady.ts:57`

## Key Symbols

| Symbol                   | Type     | File                                                               | Line |
| ------------------------ | -------- | ------------------------------------------------------------------ | ---- |
| `isKeyCustomer`          | Function | `frontends/components/workbench/customers/customerLabels.ts`       | 13   |
| `tagColorClass`          | Function | `frontends/components/workbench/customers/tagColor.ts`             | 17   |
| `useDetailsWindow`       | Function | `frontends/components/workbench/messages/useDetailsWindow.ts`      | 76   |
| `extractAccountOperator` | Function | `frontends/components/workbench/messages/utils.ts`                 | 2    |
| `useMessagesReady`       | Function | `frontends/lib/data/appReady.ts`                                   | 57   |
| `checkForAppUpdates`     | Function | `frontends/lib/updater.ts`                                         | 3    |
| `cn`                     | Function | `frontends/lib/utils.ts`                                           | 11   |
| `Workbench`              | Function | `frontends/components/Workbench.tsx`                               | 14   |
| `ToastViewport`          | Function | `frontends/components/ui/toast.tsx`                                | 64   |
| `PlaceholderPage`        | Function | `frontends/components/workbench/PlaceholderPage.tsx`               | 13   |
| `WorkbenchPanel`         | Function | `frontends/components/workbench/WorkbenchPanel.tsx`                | 10   |
| `AccountsToolbar`        | Function | `frontends/components/workbench/accounts/AccountsToolbar.tsx`      | 52   |
| `DateRangePicker`        | Function | `frontends/components/workbench/accounts/DateRangePicker.tsx`      | 20   |
| `CustomerAvatar`         | Function | `frontends/components/workbench/customers/CustomerAvatar.tsx`      | 20   |
| `CustomerCard`           | Function | `frontends/components/workbench/customers/CustomerCard.tsx`        | 40   |
| `CustomersPagination`    | Function | `frontends/components/workbench/customers/CustomersPagination.tsx` | 29   |
| `ConversationList`       | Function | `frontends/components/workbench/messages/ConversationList.tsx`     | 46   |
| `CustomerDetails`        | Function | `frontends/components/workbench/messages/CustomerDetails.tsx`      | 28   |
| `MessagesPage`           | Function | `frontends/components/workbench/messages/MessagesPage.tsx`         | 153  |
| `MessagesSkeleton`       | Function | `frontends/components/workbench/messages/MessagesSkeleton.tsx`     | 17   |

## Execution Flows

| Flow                           | Type            | Steps |
| ------------------------------ | --------------- | ----- |
| `CustomersPage → ScopeMatches` | cross_community | 6     |
| `HandleExport → StartOfDay`    | cross_community | 6     |
| `HandleExport → ParseStamp`    | cross_community | 6     |
| `RenderRowContent → Cn`        | cross_community | 6     |
| `MessagesPage → ErrorMessage`  | cross_community | 5     |
| `CustomersPage → ErrorMessage` | cross_community | 5     |
| `HandleExport → Pad`           | cross_community | 5     |
| `Workbench → ErrorMessage`     | cross_community | 5     |
| `ConversationList → Subscribe` | cross_community | 5     |
| `CustomerDetails → Cn`         | intra_community | 5     |

## Connected Areas

| Area        | Connections |
| ----------- | ----------- |
| Messages    | 11 calls    |
| Components  | 4 calls     |
| Accounts    | 3 calls     |
| Api         | 2 calls     |
| Data        | 1 calls     |
| Cluster_189 | 1 calls     |
| Workbench   | 1 calls     |
| Store       | 1 calls     |

## How to Explore

1. `gitnexus_context({name: "isKeyCustomer"})` — see callers and callees
2. `gitnexus_query({query: "customers"})` — find related execution flows
3. Read key files listed above for implementation details
