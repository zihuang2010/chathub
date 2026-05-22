---
name: data
description: "Skill for the Data area of chathub. 9 symbols across 3 files."
---

# Data

9 symbols | 3 files | Cohesion: 78%

## When to Use

- Working with code in `frontends/`
- Understanding how doFetch, refresh, unsubscribe work
- Modifying data-related functionality

## Key Files

| File                                | Symbols                                         |
| ----------------------------------- | ----------------------------------------------- |
| `frontends/lib/data/useResource.ts` | errorMessage, doFetch, refresh, unsubscribe, id |
| `frontends/lib/data/changeBus.ts`   | start, \_dispatchForTest, dispatch              |
| `frontends/lib/data/types.ts`       | scopeMatches                                    |

## Entry Points

Start here when exploring this area:

- **`doFetch`** (Function) — `frontends/lib/data/useResource.ts:131`
- **`refresh`** (Function) — `frontends/lib/data/useResource.ts:156`
- **`unsubscribe`** (Function) — `frontends/lib/data/useResource.ts:174`
- **`id`** (Function) — `frontends/lib/data/useResource.ts:199`
- **`scopeMatches`** (Function) — `frontends/lib/data/types.ts:35`

## Key Symbols

| Symbol             | Type     | File                                | Line |
| ------------------ | -------- | ----------------------------------- | ---- |
| `doFetch`          | Function | `frontends/lib/data/useResource.ts` | 131  |
| `refresh`          | Function | `frontends/lib/data/useResource.ts` | 156  |
| `unsubscribe`      | Function | `frontends/lib/data/useResource.ts` | 174  |
| `id`               | Function | `frontends/lib/data/useResource.ts` | 199  |
| `scopeMatches`     | Function | `frontends/lib/data/types.ts`       | 35   |
| `errorMessage`     | Function | `frontends/lib/data/useResource.ts` | 70   |
| `start`            | Method   | `frontends/lib/data/changeBus.ts`   | 48   |
| `_dispatchForTest` | Method   | `frontends/lib/data/changeBus.ts`   | 65   |
| `dispatch`         | Method   | `frontends/lib/data/changeBus.ts`   | 69   |

## Execution Flows

| Flow                              | Type            | Steps |
| --------------------------------- | --------------- | ----- |
| `CustomersPage → ScopeMatches`    | cross_community | 6     |
| `MessagesPage → ErrorMessage`     | cross_community | 5     |
| `CustomersPage → ErrorMessage`    | cross_community | 5     |
| `Workbench → ErrorMessage`        | cross_community | 5     |
| `UseRecentFriends → ScopeMatches` | cross_community | 5     |
| `App → ScopeMatches`              | cross_community | 4     |

## How to Explore

1. `gitnexus_context({name: "doFetch"})` — see callers and callees
2. `gitnexus_query({query: "data"})` — find related execution flows
3. Read key files listed above for implementation details
