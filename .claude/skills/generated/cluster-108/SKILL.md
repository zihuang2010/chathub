---
name: cluster-108
description: "Skill for the Cluster_108 area of chathub. 15 symbols across 1 files."
---

# Cluster_108

15 symbols | 1 files | Cohesion: 75%

## When to Use

- Working with code in `backends/`
- Understanding how new, upsert_messages, list_recent work
- Modifying cluster_108-related functionality

## Key Files

| File                                            | Symbols                                                                             |
| ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| `backends/crates/chathub-state/src/messages.rs` | new, upsert_messages, list_recent, list_conversation_asc, delete_conversation (+10) |

## Entry Points

Start here when exploring this area:

- **`new`** (Function) — `backends/crates/chathub-state/src/messages.rs:64`
- **`upsert_messages`** (Function) — `backends/crates/chathub-state/src/messages.rs:71`
- **`list_recent`** (Function) — `backends/crates/chathub-state/src/messages.rs:120`
- **`list_conversation_asc`** (Function) — `backends/crates/chathub-state/src/messages.rs:153`
- **`delete_conversation`** (Function) — `backends/crates/chathub-state/src/messages.rs:276`

## Key Symbols

| Symbol                                              | Type     | File                                            | Line |
| --------------------------------------------------- | -------- | ----------------------------------------------- | ---- |
| `new`                                               | Function | `backends/crates/chathub-state/src/messages.rs` | 64   |
| `upsert_messages`                                   | Function | `backends/crates/chathub-state/src/messages.rs` | 71   |
| `list_recent`                                       | Function | `backends/crates/chathub-state/src/messages.rs` | 120  |
| `list_conversation_asc`                             | Function | `backends/crates/chathub-state/src/messages.rs` | 153  |
| `delete_conversation`                               | Function | `backends/crates/chathub-state/src/messages.rs` | 276  |
| `trim_conversations`                                | Function | `backends/crates/chathub-state/src/messages.rs` | 303  |
| `clear_for_employee`                                | Function | `backends/crates/chathub-state/src/messages.rs` | 342  |
| `sample_row`                                        | Function | `backends/crates/chathub-state/src/messages.rs` | 410  |
| `sample_window`                                     | Function | `backends/crates/chathub-state/src/messages.rs` | 428  |
| `upsert_then_list_recent_desc`                      | Function | `backends/crates/chathub-state/src/messages.rs` | 446  |
| `list_conversation_asc_returns_full_window_ordered` | Function | `backends/crates/chathub-state/src/messages.rs` | 464  |
| `upsert_updates_mutable_keeps_position`             | Function | `backends/crates/chathub-state/src/messages.rs` | 488  |
| `delete_conversation_drops_rows_and_window`         | Function | `backends/crates/chathub-state/src/messages.rs` | 534  |
| `trim_conversations_evicts_coldest_whole`           | Function | `backends/crates/chathub-state/src/messages.rs` | 548  |
| `clear_for_employee_isolates`                       | Function | `backends/crates/chathub-state/src/messages.rs` | 568  |

## Execution Flows

| Flow                                                             | Type            | Steps |
| ---------------------------------------------------------------- | --------------- | ----- |
| `Delete_conversation_drops_rows_and_window → MessageRow`         | intra_community | 3     |
| `Trim_conversations_evicts_coldest_whole → MessageRow`           | intra_community | 3     |
| `Upsert_then_list_recent_desc → MessageRow`                      | intra_community | 3     |
| `List_conversation_asc_returns_full_window_ordered → MessageRow` | intra_community | 3     |
| `Upsert_updates_mutable_keeps_position → MessageRow`             | intra_community | 3     |
| `Window_upsert_get_round_trip → MessageWindow`                   | cross_community | 3     |
| `Clear_for_employee_isolates → MessageRow`                       | intra_community | 3     |

## Connected Areas

| Area       | Connections |
| ---------- | ----------- |
| Cluster_6  | 6 calls     |
| Cluster_35 | 2 calls     |

## How to Explore

1. `gitnexus_context({name: "new"})` — see callers and callees
2. `gitnexus_query({query: "cluster_108"})` — find related execution flows
3. Read key files listed above for implementation details
