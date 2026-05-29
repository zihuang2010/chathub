---
name: cluster-87
description: "Skill for the Cluster_87 area of chathub. 11 symbols across 2 files."
---

# Cluster_87

11 symbols | 2 files | Cohesion: 50%

## When to Use

- Working with code in `backends/`
- Understanding how new_with_defaults, authenticate, invalidate work
- Modifying cluster_87-related functionality

## Key Files

| File                                               | Symbols                                                                                                                                   |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `backends/crates/chathub-relay/src/hub_service.rs` | authenticate, invalidate, envelope_ok_json, authenticator_happy_returns_ctx, authenticator_missing_employee_id_returns_ctx_with_zero (+4) |
| `backends/crates/chathub-relay/src/downstream.rs`  | new_with_defaults, logout_is_best_effort_ok_even_on_404                                                                                   |

## Entry Points

Start here when exploring this area:

- **`new_with_defaults`** (Function) — `backends/crates/chathub-relay/src/downstream.rs:348`
- **`authenticate`** (Function) — `backends/crates/chathub-relay/src/hub_service.rs:149`
- **`invalidate`** (Function) — `backends/crates/chathub-relay/src/hub_service.rs:223`

## Key Symbols

| Symbol                                                      | Type     | File                                               | Line |
| ----------------------------------------------------------- | -------- | -------------------------------------------------- | ---- |
| `new_with_defaults`                                         | Function | `backends/crates/chathub-relay/src/downstream.rs`  | 348  |
| `authenticate`                                              | Function | `backends/crates/chathub-relay/src/hub_service.rs` | 149  |
| `invalidate`                                                | Function | `backends/crates/chathub-relay/src/hub_service.rs` | 223  |
| `logout_is_best_effort_ok_even_on_404`                      | Function | `backends/crates/chathub-relay/src/downstream.rs`  | 1121 |
| `envelope_ok_json`                                          | Function | `backends/crates/chathub-relay/src/hub_service.rs` | 732  |
| `authenticator_happy_returns_ctx`                           | Function | `backends/crates/chathub-relay/src/hub_service.rs` | 868  |
| `authenticator_missing_employee_id_returns_ctx_with_zero`   | Function | `backends/crates/chathub-relay/src/hub_service.rs` | 881  |
| `authenticator_backend_401_maps_unauthenticated`            | Function | `backends/crates/chathub-relay/src/hub_service.rs` | 901  |
| `authenticator_caches_result_second_call_skips_downstream`  | Function | `backends/crates/chathub-relay/src/hub_service.rs` | 917  |
| `authenticator_invalidate_forces_reverify`                  | Function | `backends/crates/chathub-relay/src/hub_service.rs` | 937  |
| `authenticator_singleflight_50_concurrent_calls_one_verify` | Function | `backends/crates/chathub-relay/src/hub_service.rs` | 976  |

## Execution Flows

| Flow                                                                            | Type            | Steps |
| ------------------------------------------------------------------------------- | --------------- | ----- |
| `Subscribe_with_since_replays_events_grouped_by_notify_seq → Envelope_ok_json`  | cross_community | 3     |
| `Subscribe_with_since_replays_events_grouped_by_notify_seq → New_with_defaults` | cross_community | 3     |
| `Ack_updates_router_water_mark → Envelope_ok_json`                              | cross_community | 3     |
| `Ack_updates_router_water_mark → New_with_defaults`                             | cross_community | 3     |
| `Ack_rejected_when_employee_id_missing → Envelope_ok_json`                      | cross_community | 3     |
| `Ack_rejected_when_employee_id_missing → New_with_defaults`                     | cross_community | 3     |
| `Forward_passes_through_to_business_backend → Envelope_ok_json`                 | cross_community | 3     |
| `Forward_passes_through_to_business_backend → New_with_defaults`                | cross_community | 3     |
| `Forward_business_4xx_surfaces_as_ok_with_http_status → Envelope_ok_json`       | cross_community | 3     |
| `Forward_business_4xx_surfaces_as_ok_with_http_status → New_with_defaults`      | cross_community | 3     |

## Connected Areas

| Area       | Connections |
| ---------- | ----------- |
| Cluster_96 | 7 calls     |
| Cluster_95 | 1 calls     |

## How to Explore

1. `gitnexus_context({name: "new_with_defaults"})` — see callers and callees
2. `gitnexus_query({query: "cluster_87"})` — find related execution flows
3. Read key files listed above for implementation details
