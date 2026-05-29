---
name: cluster-98
description: "Skill for the Cluster_98 area of chathub. 23 symbols across 3 files."
---

# Cluster_98

23 symbols | 3 files | Cohesion: 93%

## When to Use

- Working with code in `backends/`
- Understanding how invalidate_employee, new, register_employee work
- Modifying cluster_98-related functionality

## Key Files

| File                                               | Symbols                                                                                        |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `backends/crates/chathub-relay/src/router.rs`      | new, register_employee, fanout_employee, drop_employee_stream, drop_all_employee_streams (+15) |
| `backends/crates/chathub-relay/src/push.rs`        | bearer_matches, handle_push                                                                    |
| `backends/crates/chathub-relay/src/hub_service.rs` | invalidate_employee                                                                            |

## Entry Points

Start here when exploring this area:

- **`invalidate_employee`** (Function) — `backends/crates/chathub-relay/src/hub_service.rs:230`
- **`new`** (Function) — `backends/crates/chathub-relay/src/router.rs:64`
- **`register_employee`** (Function) — `backends/crates/chathub-relay/src/router.rs:72`
- **`fanout_employee`** (Function) — `backends/crates/chathub-relay/src/router.rs:94`
- **`drop_employee_stream`** (Function) — `backends/crates/chathub-relay/src/router.rs:124`

## Key Symbols

| Symbol                                                   | Type     | File                                               | Line |
| -------------------------------------------------------- | -------- | -------------------------------------------------- | ---- |
| `invalidate_employee`                                    | Function | `backends/crates/chathub-relay/src/hub_service.rs` | 230  |
| `new`                                                    | Function | `backends/crates/chathub-relay/src/router.rs`      | 64   |
| `register_employee`                                      | Function | `backends/crates/chathub-relay/src/router.rs`      | 72   |
| `fanout_employee`                                        | Function | `backends/crates/chathub-relay/src/router.rs`      | 94   |
| `drop_employee_stream`                                   | Function | `backends/crates/chathub-relay/src/router.rs`      | 124  |
| `drop_all_employee_streams`                              | Function | `backends/crates/chathub-relay/src/router.rs`      | 139  |
| `broadcast_server_drain`                                 | Function | `backends/crates/chathub-relay/src/router.rs`      | 168  |
| `update_ack_mark`                                        | Function | `backends/crates/chathub-relay/src/router.rs`      | 193  |
| `_new_arc`                                               | Function | `backends/crates/chathub-relay/src/router.rs`      | 212  |
| `bearer_matches`                                         | Function | `backends/crates/chathub-relay/src/push.rs`        | 20   |
| `handle_push`                                            | Function | `backends/crates/chathub-relay/src/push.rs`        | 95   |
| `empty_evt`                                              | Function | `backends/crates/chathub-relay/src/router.rs`      | 220  |
| `register_employee_returns_unique_connection_id`         | Function | `backends/crates/chathub-relay/src/router.rs`      | 225  |
| `fanout_employee_delivers_to_all_connections`            | Function | `backends/crates/chathub-relay/src/router.rs`      | 237  |
| `fanout_employee_unknown_employee_zero_delivered`        | Function | `backends/crates/chathub-relay/src/router.rs`      | 252  |
| `fanout_employee_full_channel_reports_backpressure`      | Function | `backends/crates/chathub-relay/src/router.rs`      | 259  |
| `fanout_employee_closed_channel_reports_closed`          | Function | `backends/crates/chathub-relay/src/router.rs`      | 270  |
| `drop_employee_stream_removes_only_specified_connection` | Function | `backends/crates/chathub-relay/src/router.rs`      | 281  |
| `drop_employee_stream_cleans_empty_vec_entry`            | Function | `backends/crates/chathub-relay/src/router.rs`      | 294  |
| `drop_all_employee_streams_returns_dropped_conn_ids`     | Function | `backends/crates/chathub-relay/src/router.rs`      | 303  |

## Execution Flows

| Flow                                | Type            | Steps |
| ----------------------------------- | --------------- | ----- |
| `Handle_push → Policy`              | cross_community | 3     |
| `Handle_push → Is_known_event_type` | cross_community | 3     |
| `Handle_push → EventRow`            | cross_community | 3     |
| `Handle_push → Extract_str`         | cross_community | 3     |

## Connected Areas

| Area       | Connections |
| ---------- | ----------- |
| Cluster_94 | 1 calls     |
| Storage    | 1 calls     |

## How to Explore

1. `gitnexus_context({name: "invalidate_employee"})` — see callers and callees
2. `gitnexus_query({query: "cluster_98"})` — find related execution flows
3. Read key files listed above for implementation details
