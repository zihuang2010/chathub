---
name: customers
description: "Skill for the Customers area of chathub. 93 symbols across 20 files."
---

# Customers

93 symbols | 20 files | Cohesion: 75%

## When to Use

- Working with code in `frontends/`
- Understanding how useCustomerStore, showToast, ToastViewport work
- Modifying customers-related functionality

## Key Files

| File                                                               | Symbols                                                                                          |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `frontends/components/workbench/customers/CustomerDetailPanel.tsx` | handleCopy, CustomerDetailPanel, EmptyDetail, DetailBody, DetailHeaderBar (+10)                  |
| `frontends/components/workbench/customers/utils.ts`                | pick, escapeCsv, toCsv, downloadCsv, parseDate (+10)                                             |
| `frontends/components/workbench/customers/CustomersPage.tsx`       | CustomersPage, handleToggleStar, handleOpenChat, handleBulkApplyTagDiff, handleBulkReassign (+6) |
| `frontends/components/workbench/customers/AccountPicker.tsx`       | AccountPicker, SearchBox, Group, Row, Footer (+3)                                                |
| `frontends/components/workbench/customers/BulkActionsBar.tsx`      | BulkActionsBar, ActionButton, TagPickerPopover, reset, togglePick (+2)                           |
| `frontends/components/ui/toast.tsx`                                | emit, dismiss, showToast, useToasts, ToastViewport (+1)                                          |
| `frontends/components/workbench/customers/CustomerListRow.tsx`     | CustomerListRow, formatLastContact, pad, GenderIcon, RowIconButton (+1)                          |
| `frontends/components/workbench/customers/CustomerList.tsx`        | CustomerList, ListStatus, EmptyList, FilteredEmpty                                               |
| `frontends/components/workbench/accounts/AccountsPage.tsx`         | handleRefresh, handleBind, handleExport                                                          |
| `frontends/components/workbench/accounts/utils.ts`                 | pick, escapeCsvField, toAccountsCsv                                                              |

## Entry Points

Start here when exploring this area:

- **`useCustomerStore`** (Function) — `frontends/components/workbench/customers/useCustomerStore.ts:23`
- **`showToast`** (Function) — `frontends/components/ui/toast.tsx:33`
- **`ToastViewport`** (Function) — `frontends/components/ui/toast.tsx:64`
- **`handleRefresh`** (Function) — `frontends/components/workbench/accounts/AccountsPage.tsx:39`
- **`CustomersPage`** (Function) — `frontends/components/workbench/customers/CustomersPage.tsx:34`

## Key Symbols

| Symbol                   | Type     | File                                                               | Line |
| ------------------------ | -------- | ------------------------------------------------------------------ | ---- |
| `useCustomerStore`       | Function | `frontends/components/workbench/customers/useCustomerStore.ts`     | 23   |
| `showToast`              | Function | `frontends/components/ui/toast.tsx`                                | 33   |
| `ToastViewport`          | Function | `frontends/components/ui/toast.tsx`                                | 64   |
| `handleRefresh`          | Function | `frontends/components/workbench/accounts/AccountsPage.tsx`         | 39   |
| `CustomersPage`          | Function | `frontends/components/workbench/customers/CustomersPage.tsx`       | 34   |
| `handleToggleStar`       | Function | `frontends/components/workbench/customers/CustomersPage.tsx`       | 180  |
| `handleOpenChat`         | Function | `frontends/components/workbench/customers/CustomersPage.tsx`       | 221  |
| `handleBulkApplyTagDiff` | Function | `frontends/components/workbench/customers/CustomersPage.tsx`       | 236  |
| `handleBulkReassign`     | Function | `frontends/components/workbench/customers/CustomersPage.tsx`       | 244  |
| `handleBulkToggleStar`   | Function | `frontends/components/workbench/customers/CustomersPage.tsx`       | 252  |
| `handleToggleView`       | Function | `frontends/components/workbench/customers/CustomersPage.tsx`       | 278  |
| `handleRefresh`          | Function | `frontends/components/workbench/customers/CustomersPage.tsx`       | 281  |
| `handleEditCustomer`     | Function | `frontends/components/workbench/customers/CustomersPage.tsx`       | 286  |
| `handleRowMore`          | Function | `frontends/components/workbench/customers/CustomersPage.tsx`       | 289  |
| `maybeLoadOlderHistory`  | Function | `frontends/components/workbench/messages/ChatArea.tsx`             | 301  |
| `handleUserScroll`       | Function | `frontends/components/workbench/messages/ChatArea.tsx`             | 342  |
| `handleCopy`             | Function | `frontends/components/workbench/messages/MessageContextMenu.tsx`   | 29   |
| `CustomerDetailPanel`    | Function | `frontends/components/workbench/customers/CustomerDetailPanel.tsx` | 35   |
| `CustomerTimeline`       | Function | `frontends/components/workbench/customers/CustomerTimeline.tsx`    | 10   |
| `toAccountsCsv`          | Function | `frontends/components/workbench/accounts/utils.ts`                 | 149  |

## Execution Flows

| Flow                           | Type            | Steps |
| ------------------------------ | --------------- | ----- |
| `CustomersPage → ScopeMatches` | cross_community | 6     |
| `HandleExport → StartOfDay`    | cross_community | 6     |
| `HandleExport → ParseStamp`    | cross_community | 6     |
| `CustomersPage → ErrorMessage` | cross_community | 5     |
| `HandleExport → Pad`           | cross_community | 5     |
| `HandleUserScroll → Emit`      | intra_community | 5     |
| `CustomersPage → Subscribe`    | cross_community | 4     |
| `CustomersPage → ScopeKey`     | cross_community | 4     |
| `CustomersPage → Emit`         | intra_community | 4     |
| `HandleExport → Emit`          | cross_community | 4     |

## Connected Areas

| Area     | Connections |
| -------- | ----------- |
| Accounts | 19 calls    |
| Messages | 5 calls     |

## How to Explore

1. `gitnexus_context({name: "useCustomerStore"})` — see callers and callees
2. `gitnexus_query({query: "customers"})` — find related execution flows
3. Read key files listed above for implementation details
