---
name: cluster-2
description: "Skill for the Cluster_2 area of chathub. 8 symbols across 1 files."
---

# Cluster_2

8 symbols | 1 files | Cohesion: 100%

## When to Use

- Working with code in `backends/`
- Understanding how decode_action, decode_full_row, full_added_event work
- Modifying cluster_2-related functionality

## Key Files

| File                                               | Symbols                                                                                                                       |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `backends/crates/chathub-net/src/account_event.rs` | decode_action, decode_full_row, full_added_event, account_added_decodes_to_action, account_added_missing_field_fallbacks (+3) |

## Key Symbols

| Symbol                                          | Type     | File                                               | Line |
| ----------------------------------------------- | -------- | -------------------------------------------------- | ---- |
| `decode_action`                                 | Function | `backends/crates/chathub-net/src/account_event.rs` | 181  |
| `decode_full_row`                               | Function | `backends/crates/chathub-net/src/account_event.rs` | 217  |
| `full_added_event`                              | Function | `backends/crates/chathub-net/src/account_event.rs` | 235  |
| `account_added_decodes_to_action`               | Function | `backends/crates/chathub-net/src/account_event.rs` | 251  |
| `account_added_missing_field_fallbacks`         | Function | `backends/crates/chathub-net/src/account_event.rs` | 271  |
| `account_disabled_decodes_with_minimal_payload` | Function | `backends/crates/chathub-net/src/account_event.rs` | 281  |
| `account_transferred_uses_current_employee_id`  | Function | `backends/crates/chathub-net/src/account_event.rs` | 296  |
| `account_alias_changed_carries_new_alias`       | Function | `backends/crates/chathub-net/src/account_event.rs` | 320  |

## How to Explore

1. `gitnexus_context({name: "decode_action"})` — see callers and callees
2. `gitnexus_query({query: "cluster_2"})` — find related execution flows
3. Read key files listed above for implementation details
