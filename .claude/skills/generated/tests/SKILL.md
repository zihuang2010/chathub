---
name: tests
description: "Skill for the Tests area of chathub. 48 symbols across 10 files."
---

# Tests

48 symbols | 10 files | Cohesion: 84%

## When to Use

- Working with code in `backends/`
- Understanding how spawn_relay, mount_notify_pull, mount_notify_pull_status work
- Modifying tests-related functionality

## Key Files

| File                                                     | Symbols                                                                                                                                                                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backends/crates/chathub-relay/tests/relay_e2e.rs`       | raw_channel, hub_client, do_push, push_body, fixture_self_test_healthz_returns_ok (+18)                                                                                                                       |
| `backends/crates/chathub-net/tests/auth_e2e.rs`          | fresh_local, scenario_1_login_success_persists_token, scenario_2_login_unauthenticated_writes_nothing, scenario_5_logout_emits_event_and_clears_token, scenario_7_resume_after_restart_loads_local_token (+1) |
| `backends/crates/chathub-relay/tests/common/mod.rs`      | default, spawn_relay, mount_notify_pull, mount_notify_pull_status                                                                                                                                             |
| `backends/crates/chathub-net/src/token.rs`               | logged_out_subscribe, login, logout                                                                                                                                                                           |
| `backends/crates/chathub-net/tests/common/stub_relay.rs` | default, start_stub, start_stub_full                                                                                                                                                                          |
| `backends/crates/chathub-net/src/hub.rs`                 | state_subscribe, stop                                                                                                                                                                                         |
| `backends/crates/chathub-net/tests/common/mod.rs`        | wait_for_state, push_event                                                                                                                                                                                    |
| `backends/src/lib.rs`                                    | logout, hub_state                                                                                                                                                                                             |
| `backends/crates/chathub-net/src/auth.rs`                | login, try_resume_session                                                                                                                                                                                     |
| `backends/crates/chathub-net/tests/message_e2e.rs`       | message_upsert_lands_bubble_via_connection_manager                                                                                                                                                            |

## Entry Points

Start here when exploring this area:

- **`spawn_relay`** (Function) — `backends/crates/chathub-relay/tests/common/mod.rs:65`
- **`mount_notify_pull`** (Function) — `backends/crates/chathub-relay/tests/common/mod.rs:144`
- **`mount_notify_pull_status`** (Function) — `backends/crates/chathub-relay/tests/common/mod.rs:192`
- **`logged_out_subscribe`** (Function) — `backends/crates/chathub-net/src/token.rs:69`
- **`login`** (Function) — `backends/crates/chathub-net/src/token.rs:82`

## Key Symbols

| Symbol                                 | Type     | File                                                     | Line |
| -------------------------------------- | -------- | -------------------------------------------------------- | ---- |
| `spawn_relay`                          | Function | `backends/crates/chathub-relay/tests/common/mod.rs`      | 65   |
| `mount_notify_pull`                    | Function | `backends/crates/chathub-relay/tests/common/mod.rs`      | 144  |
| `mount_notify_pull_status`             | Function | `backends/crates/chathub-relay/tests/common/mod.rs`      | 192  |
| `logged_out_subscribe`                 | Function | `backends/crates/chathub-net/src/token.rs`               | 69   |
| `login`                                | Function | `backends/crates/chathub-net/src/token.rs`               | 82   |
| `logout`                               | Function | `backends/crates/chathub-net/src/token.rs`               | 145  |
| `start_stub`                           | Function | `backends/crates/chathub-net/tests/common/stub_relay.rs` | 164  |
| `start_stub_full`                      | Function | `backends/crates/chathub-net/tests/common/stub_relay.rs` | 169  |
| `state_subscribe`                      | Function | `backends/crates/chathub-net/src/hub.rs`                 | 769  |
| `stop`                                 | Function | `backends/crates/chathub-net/src/hub.rs`                 | 805  |
| `wait_for_state`                       | Function | `backends/crates/chathub-net/tests/common/mod.rs`        | 14   |
| `push_event`                           | Function | `backends/crates/chathub-net/tests/common/mod.rs`        | 40   |
| `login`                                | Function | `backends/crates/chathub-net/src/auth.rs`                | 26   |
| `try_resume_session`                   | Function | `backends/crates/chathub-net/src/auth.rs`                | 59   |
| `default`                              | Function | `backends/crates/chathub-relay/tests/common/mod.rs`      | 55   |
| `raw_channel`                          | Function | `backends/crates/chathub-relay/tests/relay_e2e.rs`       | 17   |
| `hub_client`                           | Function | `backends/crates/chathub-relay/tests/relay_e2e.rs`       | 25   |
| `do_push`                              | Function | `backends/crates/chathub-relay/tests/relay_e2e.rs`       | 45   |
| `push_body`                            | Function | `backends/crates/chathub-relay/tests/relay_e2e.rs`       | 55   |
| `fixture_self_test_healthz_returns_ok` | Function | `backends/crates/chathub-relay/tests/relay_e2e.rs`       | 67   |

## Connected Areas

| Area        | Connections |
| ----------- | ----------- |
| Build\_     | 6 calls     |
| Cluster_6   | 3 calls     |
| Cluster_68  | 2 calls     |
| Cluster_29  | 1 calls     |
| Cluster_35  | 1 calls     |
| Cluster_110 | 1 calls     |
| Storage     | 1 calls     |

## How to Explore

1. `gitnexus_context({name: "spawn_relay"})` — see callers and callees
2. `gitnexus_query({query: "tests"})` — find related execution flows
3. Read key files listed above for implementation details
