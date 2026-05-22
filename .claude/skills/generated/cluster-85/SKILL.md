---
name: cluster-85
description: "Skill for the Cluster_85 area of chathub. 15 symbols across 1 files."
---

# Cluster_85

15 symbols | 1 files | Cohesion: 77%

## When to Use

- Working with code in `backends/`
- Understanding how new work
- Modifying cluster_85-related functionality

## Key Files

| File                                               | Symbols                                                                     |
| -------------------------------------------------- | --------------------------------------------------------------------------- |
| `backends/crates/chathub-relay/src/hub_service.rs` | new, ack, forward, mount_verify_token, mount_verify_token_no_employee (+10) |

## Entry Points

Start here when exploring this area:

- **`new`** (Function) — `backends/crates/chathub-relay/src/hub_service.rs:127`

## Key Symbols

| Symbol                                                 | Type     | File                                               | Line |
| ------------------------------------------------------ | -------- | -------------------------------------------------- | ---- |
| `new`                                                  | Function | `backends/crates/chathub-relay/src/hub_service.rs` | 127  |
| `ack`                                                  | Function | `backends/crates/chathub-relay/src/hub_service.rs` | 434  |
| `forward`                                              | Function | `backends/crates/chathub-relay/src/hub_service.rs` | 463  |
| `mount_verify_token`                                   | Function | `backends/crates/chathub-relay/src/hub_service.rs` | 543  |
| `mount_verify_token_no_employee`                       | Function | `backends/crates/chathub-relay/src/hub_service.rs` | 566  |
| `build_svc`                                            | Function | `backends/crates/chathub-relay/src/hub_service.rs` | 582  |
| `authenticator_happy_returns_ctx`                      | Function | `backends/crates/chathub-relay/src/hub_service.rs` | 662  |
| `ack_updates_router_water_mark`                        | Function | `backends/crates/chathub-relay/src/hub_service.rs` | 838  |
| `ack_rejected_when_employee_id_missing`                | Function | `backends/crates/chathub-relay/src/hub_service.rs` | 861  |
| `forward_passes_through_to_business_backend`           | Function | `backends/crates/chathub-relay/src/hub_service.rs` | 874  |
| `forward_business_4xx_surfaces_as_ok_with_http_status` | Function | `backends/crates/chathub-relay/src/hub_service.rs` | 899  |
| `forward_business_5xx_maps_to_internal_grpc_error`     | Function | `backends/crates/chathub-relay/src/hub_service.rs` | 928  |
| `forward_unknown_method_returns_invalid_argument`      | Function | `backends/crates/chathub-relay/src/hub_service.rs` | 948  |
| `forward_rejected_when_employee_id_missing`            | Function | `backends/crates/chathub-relay/src/hub_service.rs` | 963  |
| `spawn_hub_listening`                                  | Function | `backends/crates/chathub-relay/src/hub_service.rs` | 979  |

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
| Cluster_87 | 3 calls     |
| Cluster_79 | 2 calls     |
| Cluster_84 | 2 calls     |
| Cluster_68 | 1 calls     |

## How to Explore

1. `gitnexus_context({name: "new"})` — see callers and callees
2. `gitnexus_query({query: "cluster_85"})` — find related execution flows
3. Read key files listed above for implementation details
