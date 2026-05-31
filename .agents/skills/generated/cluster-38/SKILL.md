---
name: cluster-38
description: "Skill for the Cluster_38 area of chathub. 13 symbols across 2 files."
---

# Cluster_38

13 symbols | 2 files | Cohesion: 74%

## When to Use

- Working with code in `backends/`
- Understanding how new, apply_push_batch, upsert_window work
- Modifying cluster_38-related functionality

## Key Files

| File                                               | Symbols                                                                                       |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `backends/crates/chathub-net/src/message_event.rs` | new, apply_push_batch, applier_with_store, batch, seed_window (+4)                            |
| `backends/crates/chathub-state/src/messages.rs`    | upsert_window, get_window, window_upsert_get_round_trip, touch_accessed_updates_only_existing |

## Entry Points

Start here when exploring this area:

- **`new`** (Function) — `backends/crates/chathub-net/src/message_event.rs:113`
- **`apply_push_batch`** (Function) — `backends/crates/chathub-net/src/message_event.rs:128`
- **`upsert_window`** (Function) — `backends/crates/chathub-state/src/messages.rs:281`
- **`get_window`** (Function) — `backends/crates/chathub-state/src/messages.rs:324`

## Key Symbols

| Symbol                                             | Type     | File                                               | Line |
| -------------------------------------------------- | -------- | -------------------------------------------------- | ---- |
| `new`                                              | Function | `backends/crates/chathub-net/src/message_event.rs` | 113  |
| `apply_push_batch`                                 | Function | `backends/crates/chathub-net/src/message_event.rs` | 128  |
| `upsert_window`                                    | Function | `backends/crates/chathub-state/src/messages.rs`    | 281  |
| `get_window`                                       | Function | `backends/crates/chathub-state/src/messages.rs`    | 324  |
| `applier_with_store`                               | Function | `backends/crates/chathub-net/src/message_event.rs` | 374  |
| `batch`                                            | Function | `backends/crates/chathub-net/src/message_event.rs` | 396  |
| `seed_window`                                      | Function | `backends/crates/chathub-net/src/message_event.rs` | 408  |
| `hot_conversation_inserts_bubble_and_emits_notice` | Function | `backends/crates/chathub-net/src/message_event.rs` | 426  |
| `cold_conversation_skips_no_orphan`                | Function | `backends/crates/chathub-net/src/message_event.rs` | 456  |
| `send_confirmed_updates_same_bubble_not_duplicate` | Function | `backends/crates/chathub-net/src/message_event.rs` | 474  |
| `non_message_event_is_noop`                        | Function | `backends/crates/chathub-net/src/message_event.rs` | 501  |
| `window_upsert_get_round_trip`                     | Function | `backends/crates/chathub-state/src/messages.rs`    | 612  |
| `touch_accessed_updates_only_existing`             | Function | `backends/crates/chathub-state/src/messages.rs`    | 678  |

## Execution Flows

| Flow                                                                | Type            | Steps |
| ------------------------------------------------------------------- | --------------- | ----- |
| `Hot_conversation_inserts_bubble_and_emits_notice → In_memory`      | cross_community | 3     |
| `Hot_conversation_inserts_bubble_and_emits_notice → Build_endpoint` | cross_community | 3     |
| `Hot_conversation_inserts_bubble_and_emits_notice → New`            | intra_community | 3     |
| `Hot_conversation_inserts_bubble_and_emits_notice → MessageWindow`  | intra_community | 3     |
| `Send_confirmed_updates_same_bubble_not_duplicate → In_memory`      | cross_community | 3     |
| `Send_confirmed_updates_same_bubble_not_duplicate → Build_endpoint` | cross_community | 3     |
| `Send_confirmed_updates_same_bubble_not_duplicate → New`            | intra_community | 3     |
| `Send_confirmed_updates_same_bubble_not_duplicate → MessageWindow`  | intra_community | 3     |
| `Non_message_event_is_noop → In_memory`                             | cross_community | 3     |
| `Non_message_event_is_noop → Build_endpoint`                        | cross_community | 3     |

## Connected Areas

| Area        | Connections |
| ----------- | ----------- |
| Cluster_119 | 6 calls     |
| Cluster_51  | 3 calls     |
| Build\_     | 1 calls     |
| Cluster_36  | 1 calls     |
| Cluster_46  | 1 calls     |

## How to Explore

1. `gitnexus_context({name: "new"})` — see callers and callees
2. `gitnexus_query({query: "cluster_38"})` — find related execution flows
3. Read key files listed above for implementation details
