---
name: cluster-90
description: "Skill for the Cluster_90 area of chathub. 15 symbols across 2 files."
---

# Cluster_90

15 symbols | 2 files | Cohesion: 90%

## When to Use

- Working with code in `backends/`
- Understanding how prepopulate, app work
- Modifying cluster_90-related functionality

## Key Files

| File                                               | Symbols                                               |
| -------------------------------------------------- | ----------------------------------------------------- |
| `backends/crates/chathub-relay/src/push.rs`        | app, make_state, body, post, healthz_returns_200 (+9) |
| `backends/crates/chathub-relay/src/hub_service.rs` | prepopulate                                           |

## Entry Points

Start here when exploring this area:

- **`prepopulate`** (Function) — `backends/crates/chathub-relay/src/hub_service.rs:216`
- **`app`** (Function) — `backends/crates/chathub-relay/src/push.rs:47`

## Key Symbols

| Symbol                                                 | Type     | File                                               | Line |
| ------------------------------------------------------ | -------- | -------------------------------------------------- | ---- |
| `prepopulate`                                          | Function | `backends/crates/chathub-relay/src/hub_service.rs` | 216  |
| `app`                                                  | Function | `backends/crates/chathub-relay/src/push.rs`        | 47   |
| `make_state`                                           | Function | `backends/crates/chathub-relay/src/push.rs`        | 344  |
| `body`                                                 | Function | `backends/crates/chathub-relay/src/push.rs`        | 364  |
| `post`                                                 | Function | `backends/crates/chathub-relay/src/push.rs`        | 376  |
| `healthz_returns_200`                                  | Function | `backends/crates/chathub-relay/src/push.rs`        | 400  |
| `push_happy_path_persists_message_upsert`              | Function | `backends/crates/chathub-relay/src/push.rs`        | 415  |
| `push_auth_failure_returns_401`                        | Function | `backends/crates/chathub-relay/src/push.rs`        | 442  |
| `push_unknown_client_id_returns_403`                   | Function | `backends/crates/chathub-relay/src/push.rs`        | 458  |
| `push_empty_events_returns_400`                        | Function | `backends/crates/chathub-relay/src/push.rs`        | 470  |
| `push_idempotent_on_duplicate_notify_seq`              | Function | `backends/crates/chathub-relay/src/push.rs`        | 477  |
| `push_force_close_evicts_streams_after_grace`          | Function | `backends/crates/chathub-relay/src/push.rs`        | 497  |
| `push_force_close_invalidates_auth_cache_for_employee` | Function | `backends/crates/chathub-relay/src/push.rs`        | 538  |
| `push_fanout_delivers_to_registered_employee_stream`   | Function | `backends/crates/chathub-relay/src/push.rs`        | 578  |
| `push_unknown_event_type_persisted_by_default`         | Function | `backends/crates/chathub-relay/src/push.rs`        | 657  |

## Execution Flows

| Flow                                                                       | Type            | Steps |
| -------------------------------------------------------------------------- | --------------- | ----- |
| `Push_happy_path_persists_message_upsert → New_with_defaults`              | cross_community | 3     |
| `Push_happy_path_persists_message_upsert → PushState`                      | intra_community | 3     |
| `Push_idempotent_on_duplicate_notify_seq → New_with_defaults`              | cross_community | 3     |
| `Push_idempotent_on_duplicate_notify_seq → PushState`                      | intra_community | 3     |
| `Push_force_close_evicts_streams_after_grace → New_with_defaults`          | cross_community | 3     |
| `Push_force_close_evicts_streams_after_grace → PushState`                  | intra_community | 3     |
| `Push_force_close_invalidates_auth_cache_for_employee → New_with_defaults` | cross_community | 3     |
| `Push_force_close_invalidates_auth_cache_for_employee → PushState`         | intra_community | 3     |
| `Push_fanout_delivers_to_registered_employee_stream → New_with_defaults`   | cross_community | 3     |
| `Push_fanout_delivers_to_registered_employee_stream → PushState`           | intra_community | 3     |

## Connected Areas

| Area       | Connections |
| ---------- | ----------- |
| Storage    | 3 calls     |
| Cluster_91 | 2 calls     |
| Cluster_68 | 1 calls     |

## How to Explore

1. `gitnexus_context({name: "prepopulate"})` — see callers and callees
2. `gitnexus_query({query: "cluster_90"})` — find related execution flows
3. Read key files listed above for implementation details
