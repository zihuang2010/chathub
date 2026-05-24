---
name: storage
description: "Skill for the Storage area of chathub. 21 symbols across 4 files."
---

# Storage

21 symbols | 4 files | Cohesion: 86%

## When to Use

- Working with code in `backends/`
- Understanding how new, insert_batch, query_since work
- Modifying storage-related functionality

## Key Files

| File                                                        | Symbols                                                                        |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `backends/crates/chathub-relay/src/storage/events.rs`       | new, insert_batch, query_since, earliest_for, cleanup_older_than (+9)          |
| `backends/crates/chathub-relay/src/storage/mod.rs`          | open, pool, open_leaves_only_hub_events_after_migrations, reopen_is_idempotent |
| `backends/crates/chathub-state/src/pool.rs`                 | pool, in_memory_pool_applies_all_migrations                                    |
| `frontends/components/workbench/messages/ChatArea.test.tsx` | get                                                                            |

## Entry Points

Start here when exploring this area:

- **`new`** (Function) — `backends/crates/chathub-relay/src/storage/events.rs:33`
- **`insert_batch`** (Function) — `backends/crates/chathub-relay/src/storage/events.rs:39`
- **`query_since`** (Function) — `backends/crates/chathub-relay/src/storage/events.rs:86`
- **`earliest_for`** (Function) — `backends/crates/chathub-relay/src/storage/events.rs:138`
- **`cleanup_older_than`** (Function) — `backends/crates/chathub-relay/src/storage/events.rs:162`

## Key Symbols

| Symbol                                                          | Type     | File                                                  | Line |
| --------------------------------------------------------------- | -------- | ----------------------------------------------------- | ---- |
| `new`                                                           | Function | `backends/crates/chathub-relay/src/storage/events.rs` | 33   |
| `insert_batch`                                                  | Function | `backends/crates/chathub-relay/src/storage/events.rs` | 39   |
| `query_since`                                                   | Function | `backends/crates/chathub-relay/src/storage/events.rs` | 86   |
| `earliest_for`                                                  | Function | `backends/crates/chathub-relay/src/storage/events.rs` | 138  |
| `cleanup_older_than`                                            | Function | `backends/crates/chathub-relay/src/storage/events.rs` | 162  |
| `open`                                                          | Function | `backends/crates/chathub-relay/src/storage/mod.rs`    | 42   |
| `pool`                                                          | Function | `backends/crates/chathub-relay/src/storage/mod.rs`    | 88   |
| `pool`                                                          | Function | `backends/crates/chathub-state/src/pool.rs`           | 36   |
| `make_log`                                                      | Function | `backends/crates/chathub-relay/src/storage/events.rs` | 189  |
| `row`                                                           | Function | `backends/crates/chathub-relay/src/storage/events.rs` | 197  |
| `event_log_insert_batch_returns_inserted_count`                 | Function | `backends/crates/chathub-relay/src/storage/events.rs` | 217  |
| `event_log_insert_batch_is_idempotent_on_duplicate_primary_key` | Function | `backends/crates/chathub-relay/src/storage/events.rs` | 230  |
| `event_log_query_since_returns_ordered_events`                  | Function | `backends/crates/chathub-relay/src/storage/events.rs` | 251  |
| `event_log_query_since_includes_batch_internal_order`           | Function | `backends/crates/chathub-relay/src/storage/events.rs` | 269  |
| `event_log_isolates_per_employee`                               | Function | `backends/crates/chathub-relay/src/storage/events.rs` | 284  |
| `event_log_earliest_for_returns_min_notify_seq`                 | Function | `backends/crates/chathub-relay/src/storage/events.rs` | 298  |
| `event_log_cleanup_deletes_old_rows_up_to_limit`                | Function | `backends/crates/chathub-relay/src/storage/events.rs` | 314  |
| `open_leaves_only_hub_events_after_migrations`                  | Function | `backends/crates/chathub-relay/src/storage/mod.rs`    | 98   |
| `reopen_is_idempotent`                                          | Function | `backends/crates/chathub-relay/src/storage/mod.rs`    | 130  |
| `in_memory_pool_applies_all_migrations`                         | Function | `backends/crates/chathub-state/src/pool.rs`           | 84   |

## Execution Flows

| Flow                                                        | Type            | Steps |
| ----------------------------------------------------------- | --------------- | ----- |
| `Event_log_cleanup_deletes_old_rows_up_to_limit → New`      | intra_community | 3     |
| `Event_log_cleanup_deletes_old_rows_up_to_limit → EventRow` | intra_community | 3     |

## Connected Areas

| Area      | Connections |
| --------- | ----------- |
| Cluster_6 | 1 calls     |

## How to Explore

1. `gitnexus_context({name: "new"})` — see callers and callees
2. `gitnexus_query({query: "storage"})` — find related execution flows
3. Read key files listed above for implementation details
