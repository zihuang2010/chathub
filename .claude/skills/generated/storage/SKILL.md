---
name: storage
description: "Skill for the Storage area of chathub. 39 symbols across 7 files."
---

# Storage

39 symbols | 7 files | Cohesion: 75%

## When to Use

- Working with code in `backends/`
- Understanding how app, query_since, with_capacity work
- Modifying storage-related functionality

## Key Files

| File                                                        | Symbols                                                                                        |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `backends/crates/chathub-relay/src/storage/events.rs`       | query_since, cleanup_older_than, row, event_log_cleanup_deletes_old_rows_up_to_limit, new (+9) |
| `backends/crates/chathub-relay/src/push.rs`                 | app, make_state, body, post, healthz_returns_200 (+8)                                          |
| `backends/crates/chathub-relay/src/main.rs`                 | main, now_ms, wait_for_shutdown_signal, init_tracing                                           |
| `backends/crates/chathub-relay/src/storage/mod.rs`          | open, pool, open_leaves_only_hub_events_after_migrations, reopen_is_idempotent                 |
| `backends/crates/chathub-state/src/pool.rs`                 | pool, in_memory_pool_applies_all_migrations                                                    |
| `backends/crates/chathub-relay/src/hub_service.rs`          | with_capacity                                                                                  |
| `frontends/components/workbench/messages/ChatArea.test.tsx` | get                                                                                            |

## Entry Points

Start here when exploring this area:

- **`app`** (Function) — `backends/crates/chathub-relay/src/push.rs:44`
- **`query_since`** (Function) — `backends/crates/chathub-relay/src/storage/events.rs:86`
- **`with_capacity`** (Function) — `backends/crates/chathub-relay/src/hub_service.rs:132`
- **`cleanup_older_than`** (Function) — `backends/crates/chathub-relay/src/storage/events.rs:162`
- **`open`** (Function) — `backends/crates/chathub-relay/src/storage/mod.rs:42`

## Key Symbols

| Symbol                                        | Type     | File                                                  | Line |
| --------------------------------------------- | -------- | ----------------------------------------------------- | ---- |
| `app`                                         | Function | `backends/crates/chathub-relay/src/push.rs`           | 44   |
| `query_since`                                 | Function | `backends/crates/chathub-relay/src/storage/events.rs` | 86   |
| `with_capacity`                               | Function | `backends/crates/chathub-relay/src/hub_service.rs`    | 132  |
| `cleanup_older_than`                          | Function | `backends/crates/chathub-relay/src/storage/events.rs` | 162  |
| `open`                                        | Function | `backends/crates/chathub-relay/src/storage/mod.rs`    | 42   |
| `pool`                                        | Function | `backends/crates/chathub-relay/src/storage/mod.rs`    | 88   |
| `pool`                                        | Function | `backends/crates/chathub-state/src/pool.rs`           | 36   |
| `new`                                         | Function | `backends/crates/chathub-relay/src/storage/events.rs` | 33   |
| `earliest_for`                                | Function | `backends/crates/chathub-relay/src/storage/events.rs` | 138  |
| `insert_batch`                                | Function | `backends/crates/chathub-relay/src/storage/events.rs` | 39   |
| `make_state`                                  | Function | `backends/crates/chathub-relay/src/push.rs`           | 301  |
| `body`                                        | Function | `backends/crates/chathub-relay/src/push.rs`           | 316  |
| `post`                                        | Function | `backends/crates/chathub-relay/src/push.rs`           | 328  |
| `healthz_returns_200`                         | Function | `backends/crates/chathub-relay/src/push.rs`           | 352  |
| `push_happy_path_persists_message_upsert`     | Function | `backends/crates/chathub-relay/src/push.rs`           | 367  |
| `push_auth_failure_returns_401`               | Function | `backends/crates/chathub-relay/src/push.rs`           | 394  |
| `push_unknown_client_id_returns_403`          | Function | `backends/crates/chathub-relay/src/push.rs`           | 410  |
| `push_empty_events_returns_400`               | Function | `backends/crates/chathub-relay/src/push.rs`           | 422  |
| `push_idempotent_on_duplicate_notify_seq`     | Function | `backends/crates/chathub-relay/src/push.rs`           | 429  |
| `push_force_close_evicts_streams_after_grace` | Function | `backends/crates/chathub-relay/src/push.rs`           | 449  |

## Execution Flows

| Flow                                                             | Type            | Steps |
| ---------------------------------------------------------------- | --------------- | ----- |
| `Push_happy_path_persists_message_upsert → PushState`            | intra_community | 3     |
| `Push_idempotent_on_duplicate_notify_seq → PushState`            | intra_community | 3     |
| `Push_force_close_evicts_streams_after_grace → PushState`        | intra_community | 3     |
| `Push_fanout_delivers_to_registered_employee_stream → PushState` | intra_community | 3     |
| `Push_unknown_event_type_persisted_by_default → PushState`       | intra_community | 3     |
| `Event_log_cleanup_deletes_old_rows_up_to_limit → New`           | cross_community | 3     |
| `Event_log_cleanup_deletes_old_rows_up_to_limit → EventRow`      | intra_community | 3     |
| `Push_auth_failure_returns_401 → PushState`                      | intra_community | 3     |
| `Push_empty_events_returns_400 → PushState`                      | intra_community | 3     |

## Connected Areas

| Area       | Connections |
| ---------- | ----------- |
| Cluster_94 | 3 calls     |
| Cluster_6  | 1 calls     |

## How to Explore

1. `gitnexus_context({name: "app"})` — see callers and callees
2. `gitnexus_query({query: "storage"})` — find related execution flows
3. Read key files listed above for implementation details
