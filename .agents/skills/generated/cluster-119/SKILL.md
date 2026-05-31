---
name: cluster-119
description: "Skill for the Cluster_119 area of chathub. 17 symbols across 1 files."
---

# Cluster_119

17 symbols | 1 files | Cohesion: 75%

## When to Use

- Working with code in `backends/`
- Understanding how new, upsert_messages, upsert_message_and_bump_window work
- Modifying cluster_119-related functionality

## Key Files

| File                                            | Symbols                                                                                        |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `backends/crates/chathub-state/src/messages.rs` | new, upsert_messages, upsert_message_and_bump_window, list_recent, list_conversation_asc (+12) |

## Entry Points

Start here when exploring this area:

- **`new`** (Function) — `backends/crates/chathub-state/src/messages.rs:64`
- **`upsert_messages`** (Function) — `backends/crates/chathub-state/src/messages.rs:71`
- **`upsert_message_and_bump_window`** (Function) — `backends/crates/chathub-state/src/messages.rs:124`
- **`list_recent`** (Function) — `backends/crates/chathub-state/src/messages.rs:220`
- **`list_conversation_asc`** (Function) — `backends/crates/chathub-state/src/messages.rs:253`

## Key Symbols

| Symbol                                              | Type     | File                                            | Line |
| --------------------------------------------------- | -------- | ----------------------------------------------- | ---- |
| `new`                                               | Function | `backends/crates/chathub-state/src/messages.rs` | 64   |
| `upsert_messages`                                   | Function | `backends/crates/chathub-state/src/messages.rs` | 71   |
| `upsert_message_and_bump_window`                    | Function | `backends/crates/chathub-state/src/messages.rs` | 124  |
| `list_recent`                                       | Function | `backends/crates/chathub-state/src/messages.rs` | 220  |
| `list_conversation_asc`                             | Function | `backends/crates/chathub-state/src/messages.rs` | 253  |
| `delete_conversation`                               | Function | `backends/crates/chathub-state/src/messages.rs` | 376  |
| `trim_conversations`                                | Function | `backends/crates/chathub-state/src/messages.rs` | 403  |
| `clear_for_employee`                                | Function | `backends/crates/chathub-state/src/messages.rs` | 442  |
| `sample_row`                                        | Function | `backends/crates/chathub-state/src/messages.rs` | 510  |
| `sample_window`                                     | Function | `backends/crates/chathub-state/src/messages.rs` | 528  |
| `upsert_then_list_recent_desc`                      | Function | `backends/crates/chathub-state/src/messages.rs` | 546  |
| `list_conversation_asc_returns_full_window_ordered` | Function | `backends/crates/chathub-state/src/messages.rs` | 564  |
| `upsert_updates_mutable_keeps_position`             | Function | `backends/crates/chathub-state/src/messages.rs` | 592  |
| `upsert_message_and_bump_window_atomic`             | Function | `backends/crates/chathub-state/src/messages.rs` | 630  |
| `delete_conversation_drops_rows_and_window`         | Function | `backends/crates/chathub-state/src/messages.rs` | 690  |
| `trim_conversations_evicts_coldest_whole`           | Function | `backends/crates/chathub-state/src/messages.rs` | 704  |
| `clear_for_employee_isolates`                       | Function | `backends/crates/chathub-state/src/messages.rs` | 724  |

## Execution Flows

| Flow                                                             | Type            | Steps |
| ---------------------------------------------------------------- | --------------- | ----- |
| `Delete_conversation_drops_rows_and_window → MessageRow`         | intra_community | 3     |
| `Trim_conversations_evicts_coldest_whole → MessageRow`           | intra_community | 3     |
| `Upsert_then_list_recent_desc → MessageRow`                      | intra_community | 3     |
| `List_conversation_asc_returns_full_window_ordered → MessageRow` | intra_community | 3     |
| `Upsert_updates_mutable_keeps_position → MessageRow`             | intra_community | 3     |
| `Window_upsert_get_round_trip → MessageWindow`                   | cross_community | 3     |
| `Upsert_message_and_bump_window_atomic → MessageRow`             | intra_community | 3     |

## Connected Areas

| Area       | Connections |
| ---------- | ----------- |
| Cluster_51 | 7 calls     |
| Cluster_38 | 3 calls     |

## How to Explore

1. `gitnexus_context({name: "new"})` — see callers and callees
2. `gitnexus_query({query: "cluster_119"})` — find related execution flows
3. Read key files listed above for implementation details
