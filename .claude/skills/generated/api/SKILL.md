---
name: api
description: "Skill for the Api area of chathub. 49 symbols across 10 files."
---

# Api

49 symbols | 10 files | Cohesion: 94%

## When to Use

- Working with code in `frontends/`
- Understanding how fetchRecentFriendsPage, pinConversation, setConversationRemoved work
- Modifying api-related functionality

## Key Files

| File                                                         | Symbols                                                                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `frontends/lib/api/useRecentFriends.ts`                      | errorMessage, refreshFirstPage, loadMore, refresh, searchRemote (+12)                                        |
| `frontends/lib/api/messageHistory.ts`                        | loadOlderMessages, adaptHistoryRecords, historyToMessage, mapSendStatus, parseServerTimeToIso (+2)           |
| `frontends/lib/api/recentFriends.ts`                         | fetchRecentFriendsPage, pinConversation, setConversationRemoved, muteConversation, markConversationRead (+1) |
| `frontends/lib/api/accounts.ts`                              | hashSeed, lcg, deriveAccount, formatDateTime, p (+1)                                                         |
| `frontends/lib/api/useMessageHistory.ts`                     | errorMessage, loadMore, readCache, unsubscribe, retry                                                        |
| `frontends/lib/api/customers.ts`                             | fetchFriends, adaptFriendToCustomer, addWayToSource                                                          |
| `frontends/lib/api/useFriends.ts`                            | queryFn, nextPage                                                                                            |
| `frontends/components/workbench/customers/CustomersPage.tsx` | adapted                                                                                                      |
| `frontends/lib/api/useAccounts.ts`                           | queryFn                                                                                                      |
| `frontends/components/workbench/messages/MessagesPage.tsx`   | handleSendMessage                                                                                            |

## Entry Points

Start here when exploring this area:

- **`fetchRecentFriendsPage`** (Function) — `frontends/lib/api/recentFriends.ts:133`
- **`pinConversation`** (Function) — `frontends/lib/api/recentFriends.ts:144`
- **`setConversationRemoved`** (Function) — `frontends/lib/api/recentFriends.ts:158`
- **`muteConversation`** (Function) — `frontends/lib/api/recentFriends.ts:170`
- **`markConversationRead`** (Function) — `frontends/lib/api/recentFriends.ts:179`

## Key Symbols

| Symbol                     | Type     | File                                     | Line |
| -------------------------- | -------- | ---------------------------------------- | ---- |
| `fetchRecentFriendsPage`   | Function | `frontends/lib/api/recentFriends.ts`     | 133  |
| `pinConversation`          | Function | `frontends/lib/api/recentFriends.ts`     | 144  |
| `setConversationRemoved`   | Function | `frontends/lib/api/recentFriends.ts`     | 158  |
| `muteConversation`         | Function | `frontends/lib/api/recentFriends.ts`     | 170  |
| `markConversationRead`     | Function | `frontends/lib/api/recentFriends.ts`     | 179  |
| `refreshFirstPage`         | Function | `frontends/lib/api/useRecentFriends.ts`  | 264  |
| `loadMore`                 | Function | `frontends/lib/api/useRecentFriends.ts`  | 336  |
| `refresh`                  | Function | `frontends/lib/api/useRecentFriends.ts`  | 370  |
| `searchRemote`             | Function | `frontends/lib/api/useRecentFriends.ts`  | 381  |
| `loadMoreFiltered`         | Function | `frontends/lib/api/useRecentFriends.ts`  | 410  |
| `exitFilter`               | Function | `frontends/lib/api/useRecentFriends.ts`  | 438  |
| `pin`                      | Function | `frontends/lib/api/useRecentFriends.ts`  | 446  |
| `remove`                   | Function | `frontends/lib/api/useRecentFriends.ts`  | 463  |
| `mute`                     | Function | `frontends/lib/api/useRecentFriends.ts`  | 472  |
| `markRead`                 | Function | `frontends/lib/api/useRecentFriends.ts`  | 481  |
| `loadOlderMessages`        | Function | `frontends/lib/api/messageHistory.ts`    | 88   |
| `adaptHistoryRecords`      | Function | `frontends/lib/api/messageHistory.ts`    | 130  |
| `loadMore`                 | Function | `frontends/lib/api/useMessageHistory.ts` | 172  |
| `loadConversationMessages` | Function | `frontends/lib/api/messageHistory.ts`    | 73   |
| `readCache`                | Function | `frontends/lib/api/useMessageHistory.ts` | 98   |

## Execution Flows

| Flow                                       | Type            | Steps |
| ------------------------------------------ | --------------- | ----- |
| `MessagesPage → LoadConversationMessages`  | cross_community | 5     |
| `UseMessageHistory → ParseServerTimeToIso` | cross_community | 5     |
| `UseMessageHistory → MapSendStatus`        | cross_community | 5     |
| `MessagesPage → FetchRecentFriendsPage`    | cross_community | 4     |
| `MessagesPage → ErrorMessage`              | cross_community | 4     |
| `MessagesPage → Refresh`                   | cross_community | 4     |
| `LoadMore → ParseServerTimeToIso`          | intra_community | 4     |
| `LoadMore → MapSendStatus`                 | intra_community | 4     |
| `UseMessageHistory → ErrorMessage`         | cross_community | 3     |
| `LoadMore → FetchRecentFriendsPage`        | intra_community | 3     |

## How to Explore

1. `gitnexus_context({name: "fetchRecentFriendsPage"})` — see callers and callees
2. `gitnexus_query({query: "api"})` — find related execution flows
3. Read key files listed above for implementation details
