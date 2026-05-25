---
name: cluster-68
description: "Skill for the Cluster_68 area of chathub. 11 symbols across 3 files."
---

# Cluster_68

11 symbols | 3 files | Cohesion: 61%

## When to Use

- Working with code in `backends/`
- Understanding how default_for_test, new_with_defaults, forward work
- Modifying cluster_68-related functionality

## Key Files

| File                                                | Symbols                                                                                                                                                           |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backends/crates/chathub-relay/src/downstream.rs`   | new_with_defaults, forward, logout_is_best_effort_ok_even_on_404, forward_post_uses_client_token_not_relay_secret, forward_get_omits_body_and_dispatches_get (+4) |
| `backends/crates/chathub-relay/src/config.rs`       | default_for_test                                                                                                                                                  |
| `backends/crates/chathub-relay/tests/common/mod.rs` | spawn_relay_with                                                                                                                                                  |

## Entry Points

Start here when exploring this area:

- **`default_for_test`** (Function) — `backends/crates/chathub-relay/src/config.rs:213`
- **`new_with_defaults`** (Function) — `backends/crates/chathub-relay/src/downstream.rs:286`
- **`forward`** (Function) — `backends/crates/chathub-relay/src/downstream.rs:602`
- **`spawn_relay_with`** (Function) — `backends/crates/chathub-relay/tests/common/mod.rs:69`

## Key Symbols

| Symbol                                            | Type     | File                                                | Line |
| ------------------------------------------------- | -------- | --------------------------------------------------- | ---- |
| `default_for_test`                                | Function | `backends/crates/chathub-relay/src/config.rs`       | 213  |
| `new_with_defaults`                               | Function | `backends/crates/chathub-relay/src/downstream.rs`   | 286  |
| `forward`                                         | Function | `backends/crates/chathub-relay/src/downstream.rs`   | 602  |
| `spawn_relay_with`                                | Function | `backends/crates/chathub-relay/tests/common/mod.rs` | 69   |
| `logout_is_best_effort_ok_even_on_404`            | Function | `backends/crates/chathub-relay/src/downstream.rs`   | 1046 |
| `forward_post_uses_client_token_not_relay_secret` | Function | `backends/crates/chathub-relay/src/downstream.rs`   | 1054 |
| `forward_get_omits_body_and_dispatches_get`       | Function | `backends/crates/chathub-relay/src/downstream.rs`   | 1080 |
| `forward_get_passes_query_params_into_url`        | Function | `backends/crates/chathub-relay/src/downstream.rs`   | 1112 |
| `forward_unknown_method_returns_invalid_arg`      | Function | `backends/crates/chathub-relay/src/downstream.rs`   | 1143 |
| `forward_business_4xx_returns_outcome_not_error`  | Function | `backends/crates/chathub-relay/src/downstream.rs`   | 1162 |
| `forward_business_5xx_maps_internal`              | Function | `backends/crates/chathub-relay/src/downstream.rs`   | 1189 |

## Execution Flows

| Flow                                                                            | Type            | Steps |
| ------------------------------------------------------------------------------- | --------------- | ----- |
| `Subscribe_with_since_replays_events_grouped_by_notify_seq → New_with_defaults` | cross_community | 3     |
| `Ack_updates_router_water_mark → New_with_defaults`                             | cross_community | 3     |
| `Ack_rejected_when_employee_id_missing → New_with_defaults`                     | cross_community | 3     |
| `Forward_passes_through_to_business_backend → New_with_defaults`                | cross_community | 3     |
| `Forward_business_4xx_surfaces_as_ok_with_http_status → New_with_defaults`      | cross_community | 3     |
| `Forward_business_5xx_maps_to_internal_grpc_error → New_with_defaults`          | cross_community | 3     |
| `Forward_unknown_method_returns_invalid_argument → New_with_defaults`           | cross_community | 3     |
| `Forward_rejected_when_employee_id_missing → New_with_defaults`                 | cross_community | 3     |
| `Push_happy_path_persists_message_upsert → New_with_defaults`                   | cross_community | 3     |
| `Push_idempotent_on_duplicate_notify_seq → New_with_defaults`                   | cross_community | 3     |

## Connected Areas

| Area       | Connections |
| ---------- | ----------- |
| Cluster_90 | 1 calls     |

## How to Explore

1. `gitnexus_context({name: "default_for_test"})` — see callers and callees
2. `gitnexus_query({query: "cluster_68"})` — find related execution flows
3. Read key files listed above for implementation details
