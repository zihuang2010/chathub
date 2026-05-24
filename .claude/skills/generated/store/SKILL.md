---
name: store
description: "Skill for the Store area of chathub. 21 symbols across 5 files."
---

# Store

21 symbols | 5 files | Cohesion: 92%

## When to Use

- Working with code in `frontends/`
- Understanding how emptySlice, replaceAuthoritative, prependOlder work
- Modifying store-related functionality

## Key Files

| File                                                              | Symbols                                                                                      |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `frontends/components/workbench/messages/store/chatStore.ts`      | emptySlice, findIdByClientMsgId, replaceAuthoritative, prependOlder, enqueueOptimistic (+10) |
| `frontends/components/workbench/messages/store/chatStore.test.ts` | sliceWith, msg, optimistic                                                                   |
| `frontends/components/workbench/messages/useChatMessages.ts`      | useChatMessages                                                                              |
| `frontends/lib/api/useMessageHistory.ts`                          | useMessageHistory                                                                            |
| `frontends/lib/data/changeBus.ts`                                 | subscribe                                                                                    |

## Entry Points

Start here when exploring this area:

- **`emptySlice`** (Function) — `frontends/components/workbench/messages/store/chatStore.ts:32`
- **`replaceAuthoritative`** (Function) — `frontends/components/workbench/messages/store/chatStore.ts:50`
- **`prependOlder`** (Function) — `frontends/components/workbench/messages/store/chatStore.ts:79`
- **`enqueueOptimistic`** (Function) — `frontends/components/workbench/messages/store/chatStore.ts:90`
- **`markSent`** (Function) — `frontends/components/workbench/messages/store/chatStore.ts:102`

## Key Symbols

| Symbol                 | Type     | File                                                              | Line |
| ---------------------- | -------- | ----------------------------------------------------------------- | ---- |
| `emptySlice`           | Function | `frontends/components/workbench/messages/store/chatStore.ts`      | 32   |
| `replaceAuthoritative` | Function | `frontends/components/workbench/messages/store/chatStore.ts`      | 50   |
| `prependOlder`         | Function | `frontends/components/workbench/messages/store/chatStore.ts`      | 79   |
| `enqueueOptimistic`    | Function | `frontends/components/workbench/messages/store/chatStore.ts`      | 90   |
| `markSent`             | Function | `frontends/components/workbench/messages/store/chatStore.ts`      | 102  |
| `markFailed`           | Function | `frontends/components/workbench/messages/store/chatStore.ts`      | 118  |
| `patchEntity`          | Function | `frontends/components/workbench/messages/store/chatStore.ts`      | 126  |
| `removeEntity`         | Function | `frontends/components/workbench/messages/store/chatStore.ts`      | 137  |
| `update`               | Function | `frontends/components/workbench/messages/store/chatStore.ts`      | 186  |
| `patchMessage`         | Function | `frontends/components/workbench/messages/store/chatStore.ts`      | 225  |
| `removeMessage`        | Function | `frontends/components/workbench/messages/store/chatStore.ts`      | 227  |
| `setLoading`           | Function | `frontends/components/workbench/messages/store/chatStore.ts`      | 229  |
| `setError`             | Function | `frontends/components/workbench/messages/store/chatStore.ts`      | 231  |
| `useChatStore`         | Function | `frontends/components/workbench/messages/store/chatStore.ts`      | 185  |
| `useChatMessages`      | Function | `frontends/components/workbench/messages/useChatMessages.ts`      | 32   |
| `useMessageHistory`    | Function | `frontends/lib/api/useMessageHistory.ts`                          | 56   |
| `sliceWith`            | Function | `frontends/components/workbench/messages/store/chatStore.test.ts` | 41   |
| `findIdByClientMsgId`  | Function | `frontends/components/workbench/messages/store/chatStore.ts`      | 36   |
| `msg`                  | Function | `frontends/components/workbench/messages/store/chatStore.test.ts` | 18   |
| `optimistic`           | Function | `frontends/components/workbench/messages/store/chatStore.test.ts` | 30   |

## Execution Flows

| Flow                                  | Type            | Steps |
| ------------------------------------- | --------------- | ----- |
| `MessagesPage → Subscribe`            | cross_community | 4     |
| `MessagesPage → UseCurrentEmployeeId` | cross_community | 4     |
| `MessagesPage → UseChatStore`         | cross_community | 4     |
| `CustomersPage → Subscribe`           | cross_community | 4     |
| `Workbench → Subscribe`               | cross_community | 4     |

## Connected Areas

| Area | Connections |
| ---- | ----------- |
| Data | 1 calls     |
| Api  | 1 calls     |

## How to Explore

1. `gitnexus_context({name: "emptySlice"})` — see callers and callees
2. `gitnexus_query({query: "store"})` — find related execution flows
3. Read key files listed above for implementation details
