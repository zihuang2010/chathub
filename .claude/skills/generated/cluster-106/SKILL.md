---
name: cluster-106
description: "Skill for the Cluster_106 area of chathub. 20 symbols across 2 files."
---

# Cluster_106

20 symbols | 2 files | Cohesion: 89%

## When to Use

- Working with code in `backends/`
- Understanding how new, read_for_employee, replace_all_for_employee work
- Modifying cluster_106-related functionality

## Key Files

| File                                                 | Symbols                                                                                  |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `backends/crates/chathub-state/src/account_cache.rs` | new, read_for_employee, replace_all_for_employee, apply_binding, advance_watermark (+12) |
| `backends/src/lib.rs`                                | list_accounts, item_to_row, filter_rows                                                  |

## Entry Points

Start here when exploring this area:

- **`new`** (Function) — `backends/crates/chathub-state/src/account_cache.rs:58`
- **`read_for_employee`** (Function) — `backends/crates/chathub-state/src/account_cache.rs:62`
- **`replace_all_for_employee`** (Function) — `backends/crates/chathub-state/src/account_cache.rs:97`
- **`apply_binding`** (Function) — `backends/crates/chathub-state/src/account_cache.rs:131`
- **`advance_watermark`** (Function) — `backends/crates/chathub-state/src/account_cache.rs:176`

## Key Symbols

| Symbol                                                 | Type     | File                                                 | Line |
| ------------------------------------------------------ | -------- | ---------------------------------------------------- | ---- |
| `new`                                                  | Function | `backends/crates/chathub-state/src/account_cache.rs` | 58   |
| `read_for_employee`                                    | Function | `backends/crates/chathub-state/src/account_cache.rs` | 62   |
| `replace_all_for_employee`                             | Function | `backends/crates/chathub-state/src/account_cache.rs` | 97   |
| `apply_binding`                                        | Function | `backends/crates/chathub-state/src/account_cache.rs` | 131  |
| `advance_watermark`                                    | Function | `backends/crates/chathub-state/src/account_cache.rs` | 176  |
| `clear_for_employee`                                   | Function | `backends/crates/chathub-state/src/account_cache.rs` | 229  |
| `sample_row`                                           | Function | `backends/crates/chathub-state/src/account_cache.rs` | 262  |
| `replace_then_read_round_trip`                         | Function | `backends/crates/chathub-state/src/account_cache.rs` | 277  |
| `replace_isolates_per_employee`                        | Function | `backends/crates/chathub-state/src/account_cache.rs` | 290  |
| `apply_binding_added_inserts_row`                      | Function | `backends/crates/chathub-state/src/account_cache.rs` | 308  |
| `apply_binding_disabled_flips_status`                  | Function | `backends/crates/chathub-state/src/account_cache.rs` | 321  |
| `apply_binding_transferred_removes_row_only_for_owner` | Function | `backends/crates/chathub-state/src/account_cache.rs` | 339  |
| `apply_binding_alias_changed_updates_only_alias`       | Function | `backends/crates/chathub-state/src/account_cache.rs` | 358  |
| `apply_binding_is_idempotent_under_redelivery`         | Function | `backends/crates/chathub-state/src/account_cache.rs` | 378  |
| `watermark_monotonic_upsert`                           | Function | `backends/crates/chathub-state/src/account_cache.rs` | 393  |
| `watermark_isolated_per_client_and_employee`           | Function | `backends/crates/chathub-state/src/account_cache.rs` | 403  |
| `clear_for_employee_wipes_both_cache_and_watermark`    | Function | `backends/crates/chathub-state/src/account_cache.rs` | 416  |
| `list_accounts`                                        | Function | `backends/src/lib.rs`                                | 191  |
| `item_to_row`                                          | Function | `backends/src/lib.rs`                                | 236  |
| `filter_rows`                                          | Function | `backends/src/lib.rs`                                | 263  |

## Execution Flows

| Flow                                                                     | Type            | Steps |
| ------------------------------------------------------------------------ | --------------- | ----- |
| `Apply_binding_disabled_flips_status → WecomAccountRow`                  | intra_community | 3     |
| `Apply_binding_alias_changed_updates_only_alias → WecomAccountRow`       | intra_community | 3     |
| `Clear_for_employee_wipes_both_cache_and_watermark → WecomAccountRow`    | intra_community | 3     |
| `Replace_isolates_per_employee → WecomAccountRow`                        | intra_community | 3     |
| `Apply_binding_added_inserts_row → WecomAccountRow`                      | intra_community | 3     |
| `Apply_binding_transferred_removes_row_only_for_owner → WecomAccountRow` | intra_community | 3     |
| `Apply_binding_is_idempotent_under_redelivery → WecomAccountRow`         | intra_community | 3     |
| `List_accounts → WecomAccountRow`                                        | intra_community | 3     |

## Connected Areas

| Area      | Connections |
| --------- | ----------- |
| Cluster_6 | 10 calls    |

## How to Explore

1. `gitnexus_context({name: "new"})` — see callers and callees
2. `gitnexus_query({query: "cluster_106"})` — find related execution flows
3. Read key files listed above for implementation details
