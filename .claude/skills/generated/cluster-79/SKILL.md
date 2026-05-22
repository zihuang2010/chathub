---
name: cluster-79
description: "Skill for the Cluster_79 area of chathub. 10 symbols across 1 files."
---

# Cluster_79

10 symbols | 1 files | Cohesion: 59%

## When to Use

- Working with code in `backends/`
- Understanding how new_with_defaults, verify_token work
- Modifying cluster_79-related functionality

## Key Files

| File                                              | Symbols                                                                                             |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `backends/crates/chathub-relay/src/downstream.rs` | new_with_defaults, verify_token, envelope_ok_json, jdd_response, login_oauth2_form_basic_query (+5) |

## Entry Points

Start here when exploring this area:

- **`new_with_defaults`** (Function) — `backends/crates/chathub-relay/src/downstream.rs:204`
- **`verify_token`** (Function) — `backends/crates/chathub-relay/src/downstream.rs:367`

## Key Symbols

| Symbol                                                    | Type     | File                                              | Line |
| --------------------------------------------------------- | -------- | ------------------------------------------------- | ---- |
| `new_with_defaults`                                       | Function | `backends/crates/chathub-relay/src/downstream.rs` | 204  |
| `verify_token`                                            | Function | `backends/crates/chathub-relay/src/downstream.rs` | 367  |
| `envelope_ok_json`                                        | Function | `backends/crates/chathub-relay/src/downstream.rs` | 576  |
| `jdd_response`                                            | Function | `backends/crates/chathub-relay/src/downstream.rs` | 585  |
| `login_oauth2_form_basic_query`                           | Function | `backends/crates/chathub-relay/src/downstream.rs` | 602  |
| `verify_token_uses_client_token_as_bearer_and_empty_body` | Function | `backends/crates/chathub-relay/src/downstream.rs` | 704  |
| `verify_token_415_maps_protocol_mismatch`                 | Function | `backends/crates/chathub-relay/src/downstream.rs` | 728  |
| `verify_token_404_maps_protocol_mismatch`                 | Function | `backends/crates/chathub-relay/src/downstream.rs` | 744  |
| `verify_token_401_maps_invalid_creds`                     | Function | `backends/crates/chathub-relay/src/downstream.rs` | 760  |
| `logout_is_best_effort_ok_even_on_404`                    | Function | `backends/crates/chathub-relay/src/downstream.rs` | 773  |

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
| `Login_oauth2_form_basic_query → Envelope_ok_json`                              | intra_community | 3     |
| `Subscribe_first_connection_returns_ack_no_replay → New_with_defaults`          | cross_community | 3     |

## Connected Areas

| Area  | Connections |
| ----- | ----------- |
| Login | 1 calls     |

## How to Explore

1. `gitnexus_context({name: "new_with_defaults"})` — see callers and callees
2. `gitnexus_query({query: "cluster_79"})` — find related execution flows
3. Read key files listed above for implementation details
