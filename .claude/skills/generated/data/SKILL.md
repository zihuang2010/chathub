---
name: data
description: "Skill for the Data area of chathub. 16 symbols across 7 files."
---

# Data

16 symbols | 7 files | Cohesion: 72%

## When to Use

- Working with code in `frontends/`
- Understanding how useAccounts, useFriends, useRecentFriends work
- Modifying data-related functionality

## Key Files

| File                                         | Symbols                                               |
| -------------------------------------------- | ----------------------------------------------------- |
| `frontends/lib/data/useResource.ts`          | scopeKey, useResource, un, errorMessage, doFetch (+3) |
| `frontends/lib/data/changeBus.ts`            | start, \_dispatchForTest, dispatch                    |
| `frontends/lib/api/useAccounts.ts`           | useAccounts                                           |
| `frontends/lib/api/useFriends.ts`            | useFriends                                            |
| `frontends/lib/api/useRecentFriends.ts`      | useRecentFriends                                      |
| `frontends/lib/data/useCurrentEmployeeId.ts` | useCurrentEmployeeId                                  |
| `frontends/lib/data/types.ts`                | scopeMatches                                          |

## Entry Points

Start here when exploring this area:

- **`useAccounts`** (Function) — `frontends/lib/api/useAccounts.ts:26`
- **`useFriends`** (Function) — `frontends/lib/api/useFriends.ts:62`
- **`useRecentFriends`** (Function) — `frontends/lib/api/useRecentFriends.ts:221`
- **`useCurrentEmployeeId`** (Function) — `frontends/lib/data/useCurrentEmployeeId.ts:22`
- **`useResource`** (Function) — `frontends/lib/data/useResource.ts:86`

## Key Symbols

| Symbol                 | Type     | File                                         | Line |
| ---------------------- | -------- | -------------------------------------------- | ---- |
| `useAccounts`          | Function | `frontends/lib/api/useAccounts.ts`           | 26   |
| `useFriends`           | Function | `frontends/lib/api/useFriends.ts`            | 62   |
| `useRecentFriends`     | Function | `frontends/lib/api/useRecentFriends.ts`      | 221  |
| `useCurrentEmployeeId` | Function | `frontends/lib/data/useCurrentEmployeeId.ts` | 22   |
| `useResource`          | Function | `frontends/lib/data/useResource.ts`          | 86   |
| `un`                   | Function | `frontends/lib/data/useResource.ts`          | 246  |
| `doFetch`              | Function | `frontends/lib/data/useResource.ts`          | 131  |
| `refresh`              | Function | `frontends/lib/data/useResource.ts`          | 156  |
| `unsubscribe`          | Function | `frontends/lib/data/useResource.ts`          | 174  |
| `id`                   | Function | `frontends/lib/data/useResource.ts`          | 199  |
| `scopeMatches`         | Function | `frontends/lib/data/types.ts`                | 35   |
| `scopeKey`             | Function | `frontends/lib/data/useResource.ts`          | 82   |
| `errorMessage`         | Function | `frontends/lib/data/useResource.ts`          | 70   |
| `start`                | Method   | `frontends/lib/data/changeBus.ts`            | 48   |
| `_dispatchForTest`     | Method   | `frontends/lib/data/changeBus.ts`            | 65   |
| `dispatch`             | Method   | `frontends/lib/data/changeBus.ts`            | 69   |

## Execution Flows

| Flow                                    | Type            | Steps |
| --------------------------------------- | --------------- | ----- |
| `CustomersPage → ScopeMatches`          | cross_community | 6     |
| `MessagesPage → ErrorMessage`           | cross_community | 5     |
| `CustomersPage → ErrorMessage`          | cross_community | 5     |
| `UseRecentFriends → ScopeMatches`       | cross_community | 5     |
| `MessagesPage → Subscribe`              | cross_community | 4     |
| `MessagesPage → ScopeKey`               | cross_community | 4     |
| `MessagesPage → FetchRecentFriendsPage` | cross_community | 4     |
| `MessagesPage → ErrorMessage`           | cross_community | 4     |
| `MessagesPage → Refresh`                | cross_community | 4     |
| `MessagesPage → UseCurrentEmployeeId`   | cross_community | 4     |

## Connected Areas

| Area  | Connections |
| ----- | ----------- |
| Store | 1 calls     |
| Api   | 1 calls     |

## How to Explore

1. `gitnexus_context({name: "useAccounts"})` — see callers and callees
2. `gitnexus_query({query: "data"})` — find related execution flows
3. Read key files listed above for implementation details
