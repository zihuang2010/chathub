---
name: storage
description: "Skill for the Storage area of chathub. 32 symbols across 8 files."
---

# Storage

32 symbols | 8 files | Cohesion: 84%

## When to Use

- Working with code in `backends/`
- Understanding how new, insert_batch, query_since work
- Modifying storage-related functionality

## Key Files

| File                                                        | Symbols                                                                             |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `backends/crates/chathub-relay/src/storage/events.rs`       | new, insert_batch, query_since, earliest_for, make_log (+9)                         |
| `backends/crates/chathub-relay/src/downstream.rs`           | new_static, new_nacos, new_with_source, base_url_source_static_trims_trailing_slash |
| `backends/crates/chathub-relay/src/main.rs`                 | main, now_ms, wait_for_shutdown_signal, init_tracing                                |
| `backends/crates/chathub-relay/src/storage/mod.rs`          | open, pool, open_leaves_only_hub_events_after_migrations, reopen_is_idempotent      |
| `backends/crates/chathub-relay/src/nacos.rs`                | register_push, deregister_push                                                      |
| `backends/crates/chathub-state/src/pool.rs`                 | pool, in_memory_pool_applies_all_migrations                                         |
| `backends/crates/chathub-relay/src/hub_service.rs`          | with_capacity                                                                       |
| `frontends/components/workbench/messages/ChatArea.test.tsx` | get                                                                                 |

## Entry Points

Start here when exploring this area:

- **`new`** (Function) — `backends/crates/chathub-relay/src/storage/events.rs:33`
- **`insert_batch`** (Function) — `backends/crates/chathub-relay/src/storage/events.rs:39`
- **`query_since`** (Function) — `backends/crates/chathub-relay/src/storage/events.rs:86`
- **`earliest_for`** (Function) — `backends/crates/chathub-relay/src/storage/events.rs:138`
- **`new_static`** (Function) — `backends/crates/chathub-relay/src/downstream.rs:84`

## Key Symbols

| Symbol                                                          | Type     | File                                                  | Line |
| --------------------------------------------------------------- | -------- | ----------------------------------------------------- | ---- |
| `new`                                                           | Function | `backends/crates/chathub-relay/src/storage/events.rs` | 33   |
| `insert_batch`                                                  | Function | `backends/crates/chathub-relay/src/storage/events.rs` | 39   |
| `query_since`                                                   | Function | `backends/crates/chathub-relay/src/storage/events.rs` | 86   |
| `earliest_for`                                                  | Function | `backends/crates/chathub-relay/src/storage/events.rs` | 138  |
| `new_static`                                                    | Function | `backends/crates/chathub-relay/src/downstream.rs`     | 84   |
| `new_nacos`                                                     | Function | `backends/crates/chathub-relay/src/downstream.rs`     | 89   |
| `new_with_source`                                               | Function | `backends/crates/chathub-relay/src/downstream.rs`     | 306  |
| `with_capacity`                                                 | Function | `backends/crates/chathub-relay/src/hub_service.rs`    | 137  |
| `register_push`                                                 | Function | `backends/crates/chathub-relay/src/nacos.rs`          | 68   |
| `deregister_push`                                               | Function | `backends/crates/chathub-relay/src/nacos.rs`          | 95   |
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

## Execution Flows

| Flow                                                        | Type            | Steps |
| ----------------------------------------------------------- | --------------- | ----- |
| `Event_log_cleanup_deletes_old_rows_up_to_limit → New`      | intra_community | 3     |
| `Event_log_cleanup_deletes_old_rows_up_to_limit → EventRow` | intra_community | 3     |

## Connected Areas

| Area        | Connections |
| ----------- | ----------- |
| Tests       | 1 calls     |
| Cluster_97  | 1 calls     |
| Cluster_98  | 1 calls     |
| Cluster_137 | 1 calls     |
| Cluster_51  | 1 calls     |

## How to Explore

1. `gitnexus_context({name: "new"})` — see callers and callees
2. `gitnexus_query({query: "storage"})` — find related execution flows
3. Read key files listed above for implementation details
