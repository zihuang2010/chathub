---
name: cluster-116
description: "Skill for the Cluster_116 area of chathub. 17 symbols across 2 files."
---

# Cluster_116

17 symbols | 2 files | Cohesion: 89%

## When to Use

- Working with code in `backends/`
- Understanding how new, read_for_employee, replace_all_for_employee work
- Modifying cluster_116-related functionality

## Key Files

| File                                                 | Symbols                                                                                  |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `backends/crates/chathub-state/src/account_cache.rs` | new, read_for_employee, replace_all_for_employee, apply_binding, clear_for_employee (+9) |
| `backends/src/lib.rs`                                | list_accounts, item_to_row, filter_rows                                                  |

## Entry Points

Start here when exploring this area:

- **`new`** (Function) — `backends/crates/chathub-state/src/account_cache.rs:58`
- **`read_for_employee`** (Function) — `backends/crates/chathub-state/src/account_cache.rs:62`
- **`replace_all_for_employee`** (Function) — `backends/crates/chathub-state/src/account_cache.rs:97`
- **`apply_binding`** (Function) — `backends/crates/chathub-state/src/account_cache.rs:131`
- **`clear_for_employee`** (Function) — `backends/crates/chathub-state/src/account_cache.rs:175`

## Key Symbols

| Symbol                                                 | Type     | File                                                 | Line |
| ------------------------------------------------------ | -------- | ---------------------------------------------------- | ---- |
| `new`                                                  | Function | `backends/crates/chathub-state/src/account_cache.rs` | 58   |
| `read_for_employee`                                    | Function | `backends/crates/chathub-state/src/account_cache.rs` | 62   |
| `replace_all_for_employee`                             | Function | `backends/crates/chathub-state/src/account_cache.rs` | 97   |
| `apply_binding`                                        | Function | `backends/crates/chathub-state/src/account_cache.rs` | 131  |
| `clear_for_employee`                                   | Function | `backends/crates/chathub-state/src/account_cache.rs` | 175  |
| `sample_row`                                           | Function | `backends/crates/chathub-state/src/account_cache.rs` | 202  |
| `replace_then_read_round_trip`                         | Function | `backends/crates/chathub-state/src/account_cache.rs` | 217  |
| `replace_isolates_per_employee`                        | Function | `backends/crates/chathub-state/src/account_cache.rs` | 230  |
| `apply_binding_added_inserts_row`                      | Function | `backends/crates/chathub-state/src/account_cache.rs` | 248  |
| `apply_binding_disabled_flips_status`                  | Function | `backends/crates/chathub-state/src/account_cache.rs` | 261  |
| `apply_binding_transferred_removes_row_only_for_owner` | Function | `backends/crates/chathub-state/src/account_cache.rs` | 279  |
| `apply_binding_alias_changed_updates_only_alias`       | Function | `backends/crates/chathub-state/src/account_cache.rs` | 298  |
| `apply_binding_is_idempotent_under_redelivery`         | Function | `backends/crates/chathub-state/src/account_cache.rs` | 318  |
| `clear_for_employee_wipes_cache`                       | Function | `backends/crates/chathub-state/src/account_cache.rs` | 333  |
| `list_accounts`                                        | Function | `backends/src/lib.rs`                                | 193  |
| `item_to_row`                                          | Function | `backends/src/lib.rs`                                | 238  |
| `filter_rows`                                          | Function | `backends/src/lib.rs`                                | 265  |

## Execution Flows

| Flow                                                                     | Type            | Steps |
| ------------------------------------------------------------------------ | --------------- | ----- |
| `Apply_binding_disabled_flips_status → WecomAccountRow`                  | intra_community | 3     |
| `Apply_binding_alias_changed_updates_only_alias → WecomAccountRow`       | intra_community | 3     |
| `Replace_isolates_per_employee → WecomAccountRow`                        | intra_community | 3     |
| `Apply_binding_added_inserts_row → WecomAccountRow`                      | intra_community | 3     |
| `Apply_binding_transferred_removes_row_only_for_owner → WecomAccountRow` | intra_community | 3     |
| `Apply_binding_is_idempotent_under_redelivery → WecomAccountRow`         | intra_community | 3     |
| `Clear_for_employee_wipes_cache → WecomAccountRow`                       | intra_community | 3     |

## Connected Areas

| Area       | Connections |
| ---------- | ----------- |
| Cluster_51 | 8 calls     |

## How to Explore

1. `gitnexus_context({name: "new"})` — see callers and callees
2. `gitnexus_query({query: "cluster_116"})` — find related execution flows
3. Read key files listed above for implementation details
