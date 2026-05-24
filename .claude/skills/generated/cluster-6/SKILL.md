---
name: cluster-6
description: "Skill for the Cluster_6 area of chathub. 63 symbols across 4 files."
---

# Cluster_6

63 symbols | 4 files | Cohesion: 90%

## When to Use

- Working with code in `backends/`
- Understanding how employee, in_memory, new work
- Modifying cluster_6-related functionality

## Key Files

| File                                                   | Symbols                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------- |
| `backends/crates/chathub-state/src/recent_sessions.rs` | new, list_top, upsert_remote_many, upsert_remote_one, apply_summary (+54) |
| `backends/crates/chathub-state/src/pool.rs`            | in_memory, in_memory_pool_supports_repeated_open                          |
| `backends/crates/chathub-net/src/change_notice.rs`     | employee                                                                  |
| `backends/src/lib.rs`                                  | list_recent_friends_remote_page                                           |

## Entry Points

Start here when exploring this area:

- **`employee`** (Function) — `backends/crates/chathub-net/src/change_notice.rs:45`
- **`in_memory`** (Function) — `backends/crates/chathub-state/src/pool.rs:26`
- **`new`** (Function) — `backends/crates/chathub-state/src/recent_sessions.rs:148`
- **`list_top`** (Function) — `backends/crates/chathub-state/src/recent_sessions.rs:154`
- **`upsert_remote_many`** (Function) — `backends/crates/chathub-state/src/recent_sessions.rs:198`

## Key Symbols

| Symbol                                  | Type     | File                                                   | Line |
| --------------------------------------- | -------- | ------------------------------------------------------ | ---- |
| `employee`                              | Function | `backends/crates/chathub-net/src/change_notice.rs`     | 45   |
| `in_memory`                             | Function | `backends/crates/chathub-state/src/pool.rs`            | 26   |
| `new`                                   | Function | `backends/crates/chathub-state/src/recent_sessions.rs` | 148  |
| `list_top`                              | Function | `backends/crates/chathub-state/src/recent_sessions.rs` | 154  |
| `upsert_remote_many`                    | Function | `backends/crates/chathub-state/src/recent_sessions.rs` | 198  |
| `upsert_remote_one`                     | Function | `backends/crates/chathub-state/src/recent_sessions.rs` | 218  |
| `apply_summary`                         | Function | `backends/crates/chathub-state/src/recent_sessions.rs` | 239  |
| `set_pinned`                            | Function | `backends/crates/chathub-state/src/recent_sessions.rs` | 321  |
| `set_muted`                             | Function | `backends/crates/chathub-state/src/recent_sessions.rs` | 347  |
| `set_removed`                           | Function | `backends/crates/chathub-state/src/recent_sessions.rs` | 401  |
| `set_draft`                             | Function | `backends/crates/chathub-state/src/recent_sessions.rs` | 434  |
| `set_draft_at`                          | Function | `backends/crates/chathub-state/src/recent_sessions.rs` | 461  |
| `trim`                                  | Function | `backends/crates/chathub-state/src/recent_sessions.rs` | 510  |
| `trim_to_max`                           | Function | `backends/crates/chathub-state/src/recent_sessions.rs` | 567  |
| `advance_watermark`                     | Function | `backends/crates/chathub-state/src/recent_sessions.rs` | 572  |
| `clear_for_employee`                    | Function | `backends/crates/chathub-state/src/recent_sessions.rs` | 628  |
| `in_memory_pool_supports_repeated_open` | Function | `backends/crates/chathub-state/src/pool.rs`            | 113  |
| `now_unix_ms`                           | Function | `backends/crates/chathub-state/src/recent_sessions.rs` | 758  |
| `sample_remote`                         | Function | `backends/crates/chathub-state/src/recent_sessions.rs` | 773  |
| `sample_remote_for`                     | Function | `backends/crates/chathub-state/src/recent_sessions.rs` | 777  |

## Execution Flows

| Flow                                                                               | Type            | Steps |
| ---------------------------------------------------------------------------------- | --------------- | ----- |
| `Apply_summary_updates_summary_but_preserves_display_fields → RecentSessionRemote` | intra_community | 4     |
| `Upsert_preserves_local_columns → RecentSessionRemote`                             | intra_community | 4     |
| `Apply_summary_version_guard_rejects_stale → RecentSessionRemote`                  | intra_community | 4     |
| `Apply_summary_same_sortkey_empty_gmt_still_applies → RecentSessionRemote`         | intra_community | 4     |
| `Apply_summary_overwrites_profile_only_when_present → RecentSessionRemote`         | intra_community | 4     |
| `Trim_keeps_pinned_drops_oldest_unpinned → RecentSessionRemote`                    | intra_community | 4     |
| `Trim_pinned_never_culled → RecentSessionRemote`                                   | intra_community | 4     |
| `Pinned_row_set_removed_excluded_but_pin_preserved → RecentSessionRemote`          | intra_community | 4     |
| `Upsert_with_newer_ts_clears_removed → RecentSessionRemote`                        | intra_community | 4     |
| `Pinned_rows_sort_above_non_pinned → RecentSessionRemote`                          | intra_community | 4     |

## Connected Areas

| Area       | Connections |
| ---------- | ----------- |
| Cluster_42 | 1 calls     |
| Cluster_23 | 1 calls     |
| Cluster_9  | 1 calls     |

## How to Explore

1. `gitnexus_context({name: "employee"})` — see callers and callees
2. `gitnexus_query({query: "cluster_6"})` — find related execution flows
3. Read key files listed above for implementation details
