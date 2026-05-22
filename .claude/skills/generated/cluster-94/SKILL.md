---
name: cluster-94
description: "Skill for the Cluster_94 area of chathub. 20 symbols across 1 files."
---

# Cluster_94

20 symbols | 1 files | Cohesion: 92%

## When to Use

- Working with code in `backends/`
- Understanding how new, register_employee, fanout_employee work
- Modifying cluster_94-related functionality

## Key Files

| File                                          | Symbols                                                                                        |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `backends/crates/chathub-relay/src/router.rs` | new, register_employee, fanout_employee, drop_employee_stream, drop_all_employee_streams (+15) |

## Entry Points

Start here when exploring this area:

- **`new`** (Function) — `backends/crates/chathub-relay/src/router.rs:64`
- **`register_employee`** (Function) — `backends/crates/chathub-relay/src/router.rs:72`
- **`fanout_employee`** (Function) — `backends/crates/chathub-relay/src/router.rs:94`
- **`drop_employee_stream`** (Function) — `backends/crates/chathub-relay/src/router.rs:119`
- **`drop_all_employee_streams`** (Function) — `backends/crates/chathub-relay/src/router.rs:134`

## Key Symbols

| Symbol                                                   | Type     | File                                          | Line |
| -------------------------------------------------------- | -------- | --------------------------------------------- | ---- |
| `new`                                                    | Function | `backends/crates/chathub-relay/src/router.rs` | 64   |
| `register_employee`                                      | Function | `backends/crates/chathub-relay/src/router.rs` | 72   |
| `fanout_employee`                                        | Function | `backends/crates/chathub-relay/src/router.rs` | 94   |
| `drop_employee_stream`                                   | Function | `backends/crates/chathub-relay/src/router.rs` | 119  |
| `drop_all_employee_streams`                              | Function | `backends/crates/chathub-relay/src/router.rs` | 134  |
| `broadcast_server_drain`                                 | Function | `backends/crates/chathub-relay/src/router.rs` | 163  |
| `update_ack_mark`                                        | Function | `backends/crates/chathub-relay/src/router.rs` | 188  |
| `_new_arc`                                               | Function | `backends/crates/chathub-relay/src/router.rs` | 207  |
| `empty_evt`                                              | Function | `backends/crates/chathub-relay/src/router.rs` | 215  |
| `register_employee_returns_unique_connection_id`         | Function | `backends/crates/chathub-relay/src/router.rs` | 220  |
| `fanout_employee_delivers_to_all_connections`            | Function | `backends/crates/chathub-relay/src/router.rs` | 232  |
| `fanout_employee_unknown_employee_zero_delivered`        | Function | `backends/crates/chathub-relay/src/router.rs` | 247  |
| `fanout_employee_full_channel_reports_backpressure`      | Function | `backends/crates/chathub-relay/src/router.rs` | 254  |
| `fanout_employee_closed_channel_reports_closed`          | Function | `backends/crates/chathub-relay/src/router.rs` | 265  |
| `drop_employee_stream_removes_only_specified_connection` | Function | `backends/crates/chathub-relay/src/router.rs` | 276  |
| `drop_employee_stream_cleans_empty_vec_entry`            | Function | `backends/crates/chathub-relay/src/router.rs` | 289  |
| `drop_all_employee_streams_returns_dropped_conn_ids`     | Function | `backends/crates/chathub-relay/src/router.rs` | 298  |
| `ack_mark_starts_at_zero_and_is_monotonic`               | Function | `backends/crates/chathub-relay/src/router.rs` | 312  |
| `broadcast_server_drain_hits_all_employee_streams`       | Function | `backends/crates/chathub-relay/src/router.rs` | 325  |
| `concurrent_register_no_data_loss`                       | Function | `backends/crates/chathub-relay/src/router.rs` | 349  |

## How to Explore

1. `gitnexus_context({name: "new"})` — see callers and callees
2. `gitnexus_query({query: "cluster_94"})` — find related execution flows
3. Read key files listed above for implementation details
