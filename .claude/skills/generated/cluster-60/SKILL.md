---
name: cluster-60
description: "Skill for the Cluster_60 area of chathub. 9 symbols across 2 files."
---

# Cluster_60

9 symbols | 2 files | Cohesion: 76%

## When to Use

- Working with code in `backends/`
- Understanding how new, ensure_device_id, write_token work
- Modifying cluster_60-related functionality

## Key Files

| File                                               | Symbols                                                                              |
| -------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `backends/crates/chathub-state/src/local_token.rs` | new, ensure_device_id, write_token, clear_token, ensure_device_id_is_idempotent (+3) |
| `backends/crates/chathub-net/src/token.rs`         | try_load_token_reads_local_persistence                                               |

## Entry Points

Start here when exploring this area:

- **`new`** (Function) — `backends/crates/chathub-state/src/local_token.rs:23`
- **`ensure_device_id`** (Function) — `backends/crates/chathub-state/src/local_token.rs:28`
- **`write_token`** (Function) — `backends/crates/chathub-state/src/local_token.rs:74`
- **`clear_token`** (Function) — `backends/crates/chathub-state/src/local_token.rs:89`

## Key Symbols

| Symbol                                   | Type     | File                                               | Line |
| ---------------------------------------- | -------- | -------------------------------------------------- | ---- |
| `new`                                    | Function | `backends/crates/chathub-state/src/local_token.rs` | 23   |
| `ensure_device_id`                       | Function | `backends/crates/chathub-state/src/local_token.rs` | 28   |
| `write_token`                            | Function | `backends/crates/chathub-state/src/local_token.rs` | 74   |
| `clear_token`                            | Function | `backends/crates/chathub-state/src/local_token.rs` | 89   |
| `try_load_token_reads_local_persistence` | Function | `backends/crates/chathub-net/src/token.rs`         | 241  |
| `ensure_device_id_is_idempotent`         | Function | `backends/crates/chathub-state/src/local_token.rs` | 116  |
| `token_round_trip`                       | Function | `backends/crates/chathub-state/src/local_token.rs` | 129  |
| `clear_when_absent_is_ok`                | Function | `backends/crates/chathub-state/src/local_token.rs` | 148  |
| `device_id_and_token_are_independent`    | Function | `backends/crates/chathub-state/src/local_token.rs` | 155  |

## Execution Flows

| Flow                      | Type            | Steps |
| ------------------------- | --------------- | ----- |
| `Main → Ensure_device_id` | cross_community | 3     |

## Connected Areas

| Area       | Connections |
| ---------- | ----------- |
| Cluster_6  | 5 calls     |
| Cluster_52 | 1 calls     |

## How to Explore

1. `gitnexus_context({name: "new"})` — see callers and callees
2. `gitnexus_query({query: "cluster_60"})` — find related execution flows
3. Read key files listed above for implementation details
