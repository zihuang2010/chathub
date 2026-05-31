---
name: cluster-51
description: "Skill for the Cluster_51 area of chathub. 79 symbols across 3 files."
---

# Cluster_51

79 symbols | 3 files | Cohesion: 90%

## When to Use

- Working with code in `backends/`
- Understanding how new, apply_push_batch, in_memory work
- Modifying cluster_51-related functionality

## Key Files

| File                                                      | Symbols                                                                   |
| --------------------------------------------------------- | ------------------------------------------------------------------------- |
| `backends/crates/chathub-state/src/recent_sessions.rs`    | new, list_top, upsert_remote_many, upsert_remote_one, apply_summary (+63) |
| `backends/crates/chathub-net/src/recent_session_event.rs` | new, apply_push_batch, applier_with_stores, batch, account_row (+4)       |
| `backends/crates/chathub-state/src/pool.rs`               | in_memory, in_memory_pool_supports_repeated_open                          |

## Entry Points

Start here when exploring this area:

- **`new`** (Function) — `backends/crates/chathub-net/src/recent_session_event.rs:46`
- **`apply_push_batch`** (Function) — `backends/crates/chathub-net/src/recent_session_event.rs:59`
- **`in_memory`** (Function) — `backends/crates/chathub-state/src/pool.rs:26`
- **`new`** (Function) — `backends/crates/chathub-state/src/recent_sessions.rs:151`
- **`list_top`** (Function) — `backends/crates/chathub-state/src/recent_sessions.rs:157`

## Key Symbols

| Symbol                | Type     | File                                                      | Line |
| --------------------- | -------- | --------------------------------------------------------- | ---- |
| `new`                 | Function | `backends/crates/chathub-net/src/recent_session_event.rs` | 46   |
| `apply_push_batch`    | Function | `backends/crates/chathub-net/src/recent_session_event.rs` | 59   |
| `in_memory`           | Function | `backends/crates/chathub-state/src/pool.rs`               | 26   |
| `new`                 | Function | `backends/crates/chathub-state/src/recent_sessions.rs`    | 151  |
| `list_top`            | Function | `backends/crates/chathub-state/src/recent_sessions.rs`    | 157  |
| `upsert_remote_many`  | Function | `backends/crates/chathub-state/src/recent_sessions.rs`    | 225  |
| `upsert_remote_one`   | Function | `backends/crates/chathub-state/src/recent_sessions.rs`    | 245  |
| `apply_summary`       | Function | `backends/crates/chathub-state/src/recent_sessions.rs`    | 266  |
| `set_pinned`          | Function | `backends/crates/chathub-state/src/recent_sessions.rs`    | 348  |
| `set_muted`           | Function | `backends/crates/chathub-state/src/recent_sessions.rs`    | 374  |
| `set_opened`          | Function | `backends/crates/chathub-state/src/recent_sessions.rs`    | 400  |
| `set_removed`         | Function | `backends/crates/chathub-state/src/recent_sessions.rs`    | 453  |
| `set_draft`           | Function | `backends/crates/chathub-state/src/recent_sessions.rs`    | 486  |
| `set_draft_at`        | Function | `backends/crates/chathub-state/src/recent_sessions.rs`    | 513  |
| `trim`                | Function | `backends/crates/chathub-state/src/recent_sessions.rs`    | 562  |
| `trim_to_max`         | Function | `backends/crates/chathub-state/src/recent_sessions.rs`    | 619  |
| `clear_for_employee`  | Function | `backends/crates/chathub-state/src/recent_sessions.rs`    | 626  |
| `applier_with_stores` | Function | `backends/crates/chathub-net/src/recent_session_event.rs` | 510  |
| `batch`               | Function | `backends/crates/chathub-net/src/recent_session_event.rs` | 524  |
| `account_row`         | Function | `backends/crates/chathub-net/src/recent_session_event.rs` | 536  |

## Execution Flows

| Flow                                                                               | Type            | Steps |
| ---------------------------------------------------------------------------------- | --------------- | ----- |
| `Apply_summary_updates_summary_but_preserves_display_fields → RecentSessionRemote` | intra_community | 4     |
| `Pinned_sorts_above_opened → RecentSessionRemote`                                  | intra_community | 4     |
| `Upsert_preserves_local_columns → RecentSessionRemote`                             | intra_community | 4     |
| `Apply_summary_version_guard_rejects_stale → RecentSessionRemote`                  | intra_community | 4     |
| `Apply_summary_same_sortkey_empty_gmt_still_applies → RecentSessionRemote`         | intra_community | 4     |
| `Apply_summary_overwrites_profile_only_when_present → RecentSessionRemote`         | intra_community | 4     |
| `Trim_keeps_pinned_drops_oldest_unpinned → RecentSessionRemote`                    | intra_community | 4     |
| `Trim_pinned_never_culled → RecentSessionRemote`                                   | intra_community | 4     |
| `Pinned_row_set_removed_excluded_but_pin_preserved → RecentSessionRemote`          | intra_community | 4     |
| `Upsert_with_newer_ts_clears_removed → RecentSessionRemote`                        | intra_community | 4     |

## Connected Areas

| Area        | Connections |
| ----------- | ----------- |
| Cluster_116 | 1 calls     |
| Cluster_52  | 1 calls     |

## How to Explore

1. `gitnexus_context({name: "new"})` — see callers and callees
2. `gitnexus_query({query: "cluster_51"})` — find related execution flows
3. Read key files listed above for implementation details
