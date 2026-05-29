---
name: api
description: "Skill for the Api area of chathub. 78 symbols across 19 files."
---

# Api

78 symbols | 19 files | Cohesion: 91%

## When to Use

- Working with code in `frontends/`
- Understanding how fetchRecentFriendsPage, pinConversation, setConversationDraft work
- Modifying api-related functionality

## Key Files

| File                                     | Symbols                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `frontends/lib/api/useRecentFriends.ts`  | errorMessage, searchRemote, loadMoreFiltered, pin, setDraft (+12)                                            |
| `frontends/lib/api/recentFriends.ts`     | fetchRecentFriendsPage, pinConversation, setConversationDraft, setConversationRemoved, muteConversation (+4) |
| `frontends/lib/api/useMessageHistory.ts` | errorMessage, readCache, unsubscribe, loadMore, retry (+1)                                                   |
| `frontends/lib/api/useQuickReplies.ts`   | errorMessage, useQuickReplies, refresh, create, update (+1)                                                  |
| `frontends/lib/api/accounts.ts`          | hashSeed, lcg, deriveAccount, formatDateTime, p (+1)                                                         |
| `frontends/lib/api/messageHistory.ts`    | fetchMessageHistory, loadConversationMessages, loadOlderMessages, sendMessage, adaptHistoryRecords           |
| `frontends/lib/api/customers.ts`         | adaptFriendToCustomer, addWayToSource, adaptFriendDetailToCustomer, fetchFriendDetail, fetchFriends          |
| `frontends/lib/api/quickReplies.ts`      | listQuickReplies, createQuickReply, updateQuickReply, deleteQuickReply                                       |
| `frontends/lib/api/invokeClient.ts`      | invokeWithTimeout, InvokeTimeoutError, timer                                                                 |
| `frontends/lib/api/useFriendDetail.ts`   | useFriendDetail, fetchDetail, refresh                                                                        |

## Entry Points

Start here when exploring this area:

- **`fetchRecentFriendsPage`** (Function) — `frontends/lib/api/recentFriends.ts:136`
- **`pinConversation`** (Function) — `frontends/lib/api/recentFriends.ts:172`
- **`setConversationDraft`** (Function) — `frontends/lib/api/recentFriends.ts:177`
- **`setConversationRemoved`** (Function) — `frontends/lib/api/recentFriends.ts:186`
- **`muteConversation`** (Function) — `frontends/lib/api/recentFriends.ts:198`

## Key Symbols

| Symbol                     | Type     | File                                    | Line |
| -------------------------- | -------- | --------------------------------------- | ---- |
| `InvokeTimeoutError`       | Class    | `frontends/lib/api/invokeClient.ts`     | 11   |
| `fetchRecentFriendsPage`   | Function | `frontends/lib/api/recentFriends.ts`    | 136  |
| `pinConversation`          | Function | `frontends/lib/api/recentFriends.ts`    | 172  |
| `setConversationDraft`     | Function | `frontends/lib/api/recentFriends.ts`    | 177  |
| `setConversationRemoved`   | Function | `frontends/lib/api/recentFriends.ts`    | 186  |
| `muteConversation`         | Function | `frontends/lib/api/recentFriends.ts`    | 198  |
| `markConversationRead`     | Function | `frontends/lib/api/recentFriends.ts`    | 207  |
| `searchRemote`             | Function | `frontends/lib/api/useRecentFriends.ts` | 424  |
| `loadMoreFiltered`         | Function | `frontends/lib/api/useRecentFriends.ts` | 453  |
| `pin`                      | Function | `frontends/lib/api/useRecentFriends.ts` | 496  |
| `setDraft`                 | Function | `frontends/lib/api/useRecentFriends.ts` | 505  |
| `remove`                   | Function | `frontends/lib/api/useRecentFriends.ts` | 513  |
| `mute`                     | Function | `frontends/lib/api/useRecentFriends.ts` | 522  |
| `markRead`                 | Function | `frontends/lib/api/useRecentFriends.ts` | 531  |
| `invokeWithTimeout`        | Function | `frontends/lib/api/invokeClient.ts`     | 24   |
| `fetchMessageHistory`      | Function | `frontends/lib/api/messageHistory.ts`   | 63   |
| `loadConversationMessages` | Function | `frontends/lib/api/messageHistory.ts`   | 83   |
| `loadOlderMessages`        | Function | `frontends/lib/api/messageHistory.ts`   | 102  |
| `sendMessage`              | Function | `frontends/lib/api/messageHistory.ts`   | 129  |
| `adaptHistoryRecords`      | Function | `frontends/lib/api/messageHistory.ts`   | 155  |

## Execution Flows

| Flow                                  | Type            | Steps |
| ------------------------------------- | --------------- | ----- |
| `MessagesPage → ErrorMessage`         | cross_community | 5     |
| `Workbench → ErrorMessage`            | cross_community | 5     |
| `LoadMore → AttachmentToPart`         | cross_community | 5     |
| `ConversationList → Subscribe`        | cross_community | 5     |
| `MessagesPage → Subscribe`            | cross_community | 4     |
| `MessagesPage → ScopeKey`             | cross_community | 4     |
| `MessagesPage → PrefillRecentFriends` | cross_community | 4     |
| `MessagesPage → ErrorMessage`         | cross_community | 4     |
| `MessagesPage → Refresh`              | cross_community | 4     |
| `MessagesPage → UseCurrentEmployeeId` | cross_community | 4     |

## Connected Areas

| Area     | Connections |
| -------- | ----------- |
| Data     | 2 calls     |
| Messages | 1 calls     |

## How to Explore

1. `gitnexus_context({name: "fetchRecentFriendsPage"})` — see callers and callees
2. `gitnexus_query({query: "api"})` — find related execution flows
3. Read key files listed above for implementation details
