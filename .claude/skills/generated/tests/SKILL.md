---
name: tests
description: "Skill for the Tests area of chathub. 43 symbols across 10 files."
---

# Tests

43 symbols | 10 files | Cohesion: 82%

## When to Use

- Working with code in `backends/`
- Understanding how spawn_relay, logged_out_subscribe, login work
- Modifying tests-related functionality

## Key Files

| File                                                     | Symbols                                                                                                                                                                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backends/crates/chathub-relay/tests/relay_e2e.rs`       | raw_channel, hub_client, do_push, push_body, fixture_self_test_healthz_returns_ok (+15)                                                                                                                       |
| `backends/crates/chathub-net/tests/auth_e2e.rs`          | fresh_local, scenario_1_login_success_persists_token, scenario_2_login_unauthenticated_writes_nothing, scenario_5_logout_emits_event_and_clears_token, scenario_7_resume_after_restart_loads_local_token (+1) |
| `backends/crates/chathub-net/src/token.rs`               | logged_out_subscribe, login, logout                                                                                                                                                                           |
| `backends/crates/chathub-net/tests/common/stub_relay.rs` | default, start_stub, start_stub_full                                                                                                                                                                          |
| `backends/crates/chathub-net/src/hub.rs`                 | new, state_subscribe, stop                                                                                                                                                                                    |
| `backends/crates/chathub-net/tests/common/mod.rs`        | wait_for_state, push_event                                                                                                                                                                                    |
| `backends/src/lib.rs`                                    | logout, hub_state                                                                                                                                                                                             |
| `backends/crates/chathub-net/src/auth.rs`                | login, try_resume_session                                                                                                                                                                                     |
| `backends/crates/chathub-relay/tests/common/mod.rs`      | spawn_relay                                                                                                                                                                                                   |
| `backends/crates/chathub-net/tests/message_e2e.rs`       | message_upsert_lands_bubble_via_connection_manager                                                                                                                                                            |

## Entry Points

Start here when exploring this area:

- **`spawn_relay`** (Function) — `backends/crates/chathub-relay/tests/common/mod.rs:46`
- **`logged_out_subscribe`** (Function) — `backends/crates/chathub-net/src/token.rs:69`
- **`login`** (Function) — `backends/crates/chathub-net/src/token.rs:82`
- **`logout`** (Function) — `backends/crates/chathub-net/src/token.rs:145`
- **`start_stub`** (Function) — `backends/crates/chathub-net/tests/common/stub_relay.rs:164`

## Key Symbols

| Symbol                                                | Type     | File                                                     | Line |
| ----------------------------------------------------- | -------- | -------------------------------------------------------- | ---- |
| `spawn_relay`                                         | Function | `backends/crates/chathub-relay/tests/common/mod.rs`      | 46   |
| `logged_out_subscribe`                                | Function | `backends/crates/chathub-net/src/token.rs`               | 69   |
| `login`                                               | Function | `backends/crates/chathub-net/src/token.rs`               | 82   |
| `logout`                                              | Function | `backends/crates/chathub-net/src/token.rs`               | 145  |
| `start_stub`                                          | Function | `backends/crates/chathub-net/tests/common/stub_relay.rs` | 164  |
| `start_stub_full`                                     | Function | `backends/crates/chathub-net/tests/common/stub_relay.rs` | 169  |
| `new`                                                 | Function | `backends/crates/chathub-net/src/hub.rs`                 | 694  |
| `state_subscribe`                                     | Function | `backends/crates/chathub-net/src/hub.rs`                 | 732  |
| `stop`                                                | Function | `backends/crates/chathub-net/src/hub.rs`                 | 768  |
| `wait_for_state`                                      | Function | `backends/crates/chathub-net/tests/common/mod.rs`        | 14   |
| `push_event`                                          | Function | `backends/crates/chathub-net/tests/common/mod.rs`        | 40   |
| `login`                                               | Function | `backends/crates/chathub-net/src/auth.rs`                | 26   |
| `try_resume_session`                                  | Function | `backends/crates/chathub-net/src/auth.rs`                | 59   |
| `raw_channel`                                         | Function | `backends/crates/chathub-relay/tests/relay_e2e.rs`       | 14   |
| `hub_client`                                          | Function | `backends/crates/chathub-relay/tests/relay_e2e.rs`       | 22   |
| `do_push`                                             | Function | `backends/crates/chathub-relay/tests/relay_e2e.rs`       | 42   |
| `push_body`                                           | Function | `backends/crates/chathub-relay/tests/relay_e2e.rs`       | 52   |
| `fixture_self_test_healthz_returns_ok`                | Function | `backends/crates/chathub-relay/tests/relay_e2e.rs`       | 64   |
| `jdd_response`                                        | Function | `backends/crates/chathub-relay/tests/relay_e2e.rs`       | 74   |
| `login_oauth2_passes_through_business_token_and_user` | Function | `backends/crates/chathub-relay/tests/relay_e2e.rs`       | 95   |

## Connected Areas

| Area        | Connections |
| ----------- | ----------- |
| Build\_     | 6 calls     |
| Cluster_6   | 3 calls     |
| Cluster_35  | 1 calls     |
| Cluster_108 | 1 calls     |
| Cluster_79  | 1 calls     |
| Cluster_68  | 1 calls     |
| Storage     | 1 calls     |

## How to Explore

1. `gitnexus_context({name: "spawn_relay"})` — see callers and callees
2. `gitnexus_query({query: "tests"})` — find related execution flows
3. Read key files listed above for implementation details
