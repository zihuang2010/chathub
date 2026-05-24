---
name: cluster-87
description: "Skill for the Cluster_87 area of chathub. 16 symbols across 1 files."
---

# Cluster_87

16 symbols | 1 files | Cohesion: 76%

## When to Use

- Working with code in `backends/`
- Understanding how new work
- Modifying cluster_87-related functionality

## Key Files

| File                                               | Symbols                                                                     |
| -------------------------------------------------- | --------------------------------------------------------------------------- |
| `backends/crates/chathub-relay/src/hub_service.rs` | new, ack, forward, mount_verify_token, mount_verify_token_no_employee (+11) |

## Entry Points

Start here when exploring this area:

- **`new`** (Function) — `backends/crates/chathub-relay/src/hub_service.rs:132`

## Key Symbols

| Symbol                                                        | Type     | File                                               | Line |
| ------------------------------------------------------------- | -------- | -------------------------------------------------- | ---- |
| `new`                                                         | Function | `backends/crates/chathub-relay/src/hub_service.rs` | 132  |
| `ack`                                                         | Function | `backends/crates/chathub-relay/src/hub_service.rs` | 635  |
| `forward`                                                     | Function | `backends/crates/chathub-relay/src/hub_service.rs` | 664  |
| `mount_verify_token`                                          | Function | `backends/crates/chathub-relay/src/hub_service.rs` | 744  |
| `mount_verify_token_no_employee`                              | Function | `backends/crates/chathub-relay/src/hub_service.rs` | 767  |
| `build_svc`                                                   | Function | `backends/crates/chathub-relay/src/hub_service.rs` | 783  |
| `authenticator_happy_returns_ctx`                             | Function | `backends/crates/chathub-relay/src/hub_service.rs` | 868  |
| `authenticator_invalidate_employee_evicts_only_that_employee` | Function | `backends/crates/chathub-relay/src/hub_service.rs` | 960  |
| `ack_updates_router_water_mark`                               | Function | `backends/crates/chathub-relay/src/hub_service.rs` | 1083 |
| `ack_rejected_when_employee_id_missing`                       | Function | `backends/crates/chathub-relay/src/hub_service.rs` | 1106 |
| `forward_passes_through_to_business_backend`                  | Function | `backends/crates/chathub-relay/src/hub_service.rs` | 1119 |
| `forward_business_4xx_surfaces_as_ok_with_http_status`        | Function | `backends/crates/chathub-relay/src/hub_service.rs` | 1144 |
| `forward_business_5xx_maps_to_internal_grpc_error`            | Function | `backends/crates/chathub-relay/src/hub_service.rs` | 1173 |
| `forward_unknown_method_returns_invalid_argument`             | Function | `backends/crates/chathub-relay/src/hub_service.rs` | 1193 |
| `forward_rejected_when_employee_id_missing`                   | Function | `backends/crates/chathub-relay/src/hub_service.rs` | 1208 |
| `spawn_hub_listening`                                         | Function | `backends/crates/chathub-relay/src/hub_service.rs` | 1224 |

## Execution Flows

| Flow                                                                            | Type            | Steps |
| ------------------------------------------------------------------------------- | --------------- | ----- |
| `Subscribe_with_since_replays_events_grouped_by_notify_seq → New`               | cross_community | 3     |
| `Subscribe_with_since_replays_events_grouped_by_notify_seq → Envelope_ok_json`  | cross_community | 3     |
| `Subscribe_with_since_replays_events_grouped_by_notify_seq → New_with_defaults` | cross_community | 3     |
| `Subscribe_with_since_replays_events_grouped_by_notify_seq → HubSvc`            | cross_community | 3     |
| `Subscribe_with_since_replays_events_grouped_by_notify_seq → New`               | cross_community | 3     |
| `Ack_updates_router_water_mark → New`                                           | intra_community | 3     |
| `Ack_updates_router_water_mark → Envelope_ok_json`                              | cross_community | 3     |
| `Ack_updates_router_water_mark → New_with_defaults`                             | cross_community | 3     |
| `Ack_updates_router_water_mark → HubSvc`                                        | intra_community | 3     |
| `Ack_updates_router_water_mark → New`                                           | cross_community | 3     |

## Connected Areas

| Area       | Connections |
| ---------- | ----------- |
| Cluster_68 | 4 calls     |
| Cluster_89 | 3 calls     |
| Cluster_86 | 2 calls     |
| Cluster_91 | 1 calls     |

## How to Explore

1. `gitnexus_context({name: "new"})` — see callers and callees
2. `gitnexus_query({query: "cluster_87"})` — find related execution flows
3. Read key files listed above for implementation details
