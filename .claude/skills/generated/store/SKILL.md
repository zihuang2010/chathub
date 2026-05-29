---
name: store
description: "Skill for the Store area of chathub. 17 symbols across 2 files."
---

# Store

17 symbols | 2 files | Cohesion: 100%

## When to Use

- Working with code in `frontends/`
- Understanding how emptySlice, replaceAuthoritative, prependOlder work
- Modifying store-related functionality

## Key Files

| File                                                              | Symbols                                                                                     |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `frontends/components/workbench/messages/store/chatStore.ts`      | emptySlice, findIdByClientMsgId, replaceAuthoritative, prependOlder, enqueueOptimistic (+9) |
| `frontends/components/workbench/messages/store/chatStore.test.ts` | sliceWith, msg, optimistic                                                                  |

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
| `sliceWith`            | Function | `frontends/components/workbench/messages/store/chatStore.test.ts` | 41   |
| `findIdByClientMsgId`  | Function | `frontends/components/workbench/messages/store/chatStore.ts`      | 36   |
| `msg`                  | Function | `frontends/components/workbench/messages/store/chatStore.test.ts` | 18   |
| `optimistic`           | Function | `frontends/components/workbench/messages/store/chatStore.test.ts` | 30   |

## How to Explore

1. `gitnexus_context({name: "emptySlice"})` — see callers and callees
2. `gitnexus_query({query: "store"})` — find related execution flows
3. Read key files listed above for implementation details
