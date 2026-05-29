---
name: data
description: "Skill for the Data area of chathub. 12 symbols across 3 files."
---

# Data

12 symbols | 3 files | Cohesion: 76%

## When to Use

- Working with code in `frontends/`
- Understanding how useResource, doFetch, refresh work
- Modifying data-related functionality

## Key Files

| File                                | Symbols                                                    |
| ----------------------------------- | ---------------------------------------------------------- |
| `frontends/lib/data/useResource.ts` | errorMessage, scopeKey, useResource, doFetch, refresh (+3) |
| `frontends/lib/data/changeBus.ts`   | start, \_dispatchForTest, dispatch                         |
| `frontends/lib/data/types.ts`       | scopeMatches                                               |

## Entry Points

Start here when exploring this area:

- **`useResource`** (Function) — `frontends/lib/data/useResource.ts:86`
- **`doFetch`** (Function) — `frontends/lib/data/useResource.ts:131`
- **`refresh`** (Function) — `frontends/lib/data/useResource.ts:156`
- **`unsubscribe`** (Function) — `frontends/lib/data/useResource.ts:174`
- **`id`** (Function) — `frontends/lib/data/useResource.ts:199`

## Key Symbols

| Symbol             | Type     | File                                | Line |
| ------------------ | -------- | ----------------------------------- | ---- |
| `useResource`      | Function | `frontends/lib/data/useResource.ts` | 86   |
| `doFetch`          | Function | `frontends/lib/data/useResource.ts` | 131  |
| `refresh`          | Function | `frontends/lib/data/useResource.ts` | 156  |
| `unsubscribe`      | Function | `frontends/lib/data/useResource.ts` | 174  |
| `id`               | Function | `frontends/lib/data/useResource.ts` | 199  |
| `un`               | Function | `frontends/lib/data/useResource.ts` | 246  |
| `scopeMatches`     | Function | `frontends/lib/data/types.ts`       | 35   |
| `errorMessage`     | Function | `frontends/lib/data/useResource.ts` | 70   |
| `scopeKey`         | Function | `frontends/lib/data/useResource.ts` | 82   |
| `start`            | Method   | `frontends/lib/data/changeBus.ts`   | 48   |
| `_dispatchForTest` | Method   | `frontends/lib/data/changeBus.ts`   | 65   |
| `dispatch`         | Method   | `frontends/lib/data/changeBus.ts`   | 69   |

## Execution Flows

| Flow                                   | Type            | Steps |
| -------------------------------------- | --------------- | ----- |
| `CustomersPage → ScopeMatches`         | cross_community | 6     |
| `MessagesContactSearch → ScopeMatches` | cross_community | 6     |
| `MessagesPage → ErrorMessage`          | cross_community | 5     |
| `CustomersPage → ErrorMessage`         | cross_community | 5     |
| `Workbench → ErrorMessage`             | cross_community | 5     |
| `MessagesContactSearch → ErrorMessage` | cross_community | 5     |
| `ConversationList → Subscribe`         | cross_community | 5     |
| `MessagesPage → Subscribe`             | cross_community | 4     |
| `MessagesPage → ScopeKey`              | cross_community | 4     |
| `CustomersPage → Subscribe`            | cross_community | 4     |

## Connected Areas

| Area | Connections |
| ---- | ----------- |
| Api  | 1 calls     |

## How to Explore

1. `gitnexus_context({name: "useResource"})` — see callers and callees
2. `gitnexus_query({query: "data"})` — find related execution flows
3. Read key files listed above for implementation details
