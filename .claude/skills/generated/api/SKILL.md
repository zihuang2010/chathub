---
name: api
description: "Skill for the Api area of chathub. 57 symbols across 12 files."
---

# Api

57 symbols | 12 files | Cohesion: 95%

## When to Use

- Working with code in `frontends/`
- Understanding how fetchRecentFriendsPage, pinConversation, setConversationRemoved work
- Modifying api-related functionality

## Key Files

| File                                                         | Symbols                                                                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `frontends/lib/api/useRecentFriends.ts`                      | errorMessage, refreshFirstPage, loadMore, refresh, searchRemote (+12)                                        |
| `frontends/lib/api/recentFriends.ts`                         | fetchRecentFriendsPage, pinConversation, setConversationRemoved, muteConversation, markConversationRead (+1) |
| `frontends/lib/api/accounts.ts`                              | hashSeed, lcg, deriveAccount, formatDateTime, p (+1)                                                         |
| `frontends/lib/api/messageHistory.ts`                        | fetchMessageHistory, loadConversationMessages, loadOlderMessages, sendMessage, adaptHistoryRecords           |
| `frontends/lib/api/useMessageHistory.ts`                     | errorMessage, readCache, unsubscribe, loadMore, retry                                                        |
| `frontends/lib/api/customers.ts`                             | adaptFriendToCustomer, addWayToSource, adaptFriendDetailToCustomer, fetchFriendDetail, fetchFriends          |
| `frontends/lib/api/invokeClient.ts`                          | invokeWithTimeout, InvokeTimeoutError, timer                                                                 |
| `frontends/lib/api/useFriendDetail.ts`                       | useFriendDetail, fetchDetail, refresh                                                                        |
| `frontends/components/workbench/messages/MessagesPage.tsx`   | handleSendMessage, customer                                                                                  |
| `frontends/components/workbench/customers/CustomersPage.tsx` | adapted, panelCustomer                                                                                       |

## Entry Points

Start here when exploring this area:

- **`fetchRecentFriendsPage`** (Function) — `frontends/lib/api/recentFriends.ts:133`
- **`pinConversation`** (Function) — `frontends/lib/api/recentFriends.ts:144`
- **`setConversationRemoved`** (Function) — `frontends/lib/api/recentFriends.ts:158`
- **`muteConversation`** (Function) — `frontends/lib/api/recentFriends.ts:170`
- **`markConversationRead`** (Function) — `frontends/lib/api/recentFriends.ts:179`

## Key Symbols

| Symbol                     | Type     | File                                    | Line |
| -------------------------- | -------- | --------------------------------------- | ---- |
| `InvokeTimeoutError`       | Class    | `frontends/lib/api/invokeClient.ts`     | 11   |
| `fetchRecentFriendsPage`   | Function | `frontends/lib/api/recentFriends.ts`    | 133  |
| `pinConversation`          | Function | `frontends/lib/api/recentFriends.ts`    | 144  |
| `setConversationRemoved`   | Function | `frontends/lib/api/recentFriends.ts`    | 158  |
| `muteConversation`         | Function | `frontends/lib/api/recentFriends.ts`    | 170  |
| `markConversationRead`     | Function | `frontends/lib/api/recentFriends.ts`    | 179  |
| `refreshFirstPage`         | Function | `frontends/lib/api/useRecentFriends.ts` | 281  |
| `loadMore`                 | Function | `frontends/lib/api/useRecentFriends.ts` | 376  |
| `refresh`                  | Function | `frontends/lib/api/useRecentFriends.ts` | 419  |
| `searchRemote`             | Function | `frontends/lib/api/useRecentFriends.ts` | 468  |
| `loadMoreFiltered`         | Function | `frontends/lib/api/useRecentFriends.ts` | 497  |
| `exitFilter`               | Function | `frontends/lib/api/useRecentFriends.ts` | 525  |
| `pin`                      | Function | `frontends/lib/api/useRecentFriends.ts` | 533  |
| `remove`                   | Function | `frontends/lib/api/useRecentFriends.ts` | 550  |
| `mute`                     | Function | `frontends/lib/api/useRecentFriends.ts` | 559  |
| `markRead`                 | Function | `frontends/lib/api/useRecentFriends.ts` | 568  |
| `invokeWithTimeout`        | Function | `frontends/lib/api/invokeClient.ts`     | 24   |
| `fetchMessageHistory`      | Function | `frontends/lib/api/messageHistory.ts`   | 63   |
| `loadConversationMessages` | Function | `frontends/lib/api/messageHistory.ts`   | 83   |
| `loadOlderMessages`        | Function | `frontends/lib/api/messageHistory.ts`   | 102  |

## Execution Flows

| Flow                                    | Type            | Steps |
| --------------------------------------- | --------------- | ----- |
| `LoadMore → AttachmentToPart`           | cross_community | 5     |
| `MessagesPage → FetchRecentFriendsPage` | cross_community | 4     |
| `MessagesPage → ErrorMessage`           | cross_community | 4     |
| `MessagesPage → Refresh`                | cross_community | 4     |
| `MessagesPage → FetchFriendDetail`      | cross_community | 4     |
| `LoadMore → ParseServerTimeToIso`       | cross_community | 4     |
| `LoadMore → MapSendStatus`              | cross_community | 4     |
| `LoadMore → InvokeWithTimeout`          | intra_community | 3     |
| `LoadMore → FetchRecentFriendsPage`     | intra_community | 3     |
| `LoadMore → ErrorMessage`               | intra_community | 3     |

## Connected Areas

| Area     | Connections |
| -------- | ----------- |
| Messages | 1 calls     |

## How to Explore

1. `gitnexus_context({name: "fetchRecentFriendsPage"})` — see callers and callees
2. `gitnexus_query({query: "api"})` — find related execution flows
3. Read key files listed above for implementation details
