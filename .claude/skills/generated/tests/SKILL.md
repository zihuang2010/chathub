---
name: tests
description: "Skill for the Tests area of chathub. 59 symbols across 12 files."
---

# Tests

59 symbols | 12 files | Cohesion: 80%

## When to Use

- Working with code in `backends/`
- Understanding how spawn_relay, spawn_relay_with, mount_notify_pull work
- Modifying tests-related functionality

## Key Files

| File                                                     | Symbols                                                                                                                                                                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backends/crates/chathub-relay/tests/relay_e2e.rs`       | raw_channel, hub_client, do_push, push_body, fixture_self_test_healthz_returns_ok (+18)                                                                                                                       |
| `backends/crates/chathub-relay/src/auth_service.rs`      | login, logout, spawn_auth, jdd_response, login_oauth2_passes_through_token_and_user (+3)                                                                                                                      |
| `backends/crates/chathub-net/tests/auth_e2e.rs`          | fresh_local, scenario_1_login_success_persists_token, scenario_2_login_unauthenticated_writes_nothing, scenario_5_logout_emits_event_and_clears_token, scenario_7_resume_after_restart_loads_local_token (+1) |
| `backends/crates/chathub-relay/tests/common/mod.rs`      | default, spawn_relay, spawn_relay_with, mount_notify_pull, mount_notify_pull_status                                                                                                                           |
| `backends/crates/chathub-net/src/token.rs`               | logged_out_subscribe, login, logout                                                                                                                                                                           |
| `backends/crates/chathub-net/tests/common/stub_relay.rs` | default, start_stub, start_stub_full                                                                                                                                                                          |
| `backends/crates/chathub-net/src/hub.rs`                 | new, state_subscribe, stop                                                                                                                                                                                    |
| `backends/crates/chathub-net/tests/common/mod.rs`        | wait_for_state, push_event                                                                                                                                                                                    |
| `backends/src/lib.rs`                                    | logout, hub_state                                                                                                                                                                                             |
| `backends/crates/chathub-net/src/auth.rs`                | login, try_resume_session                                                                                                                                                                                     |

## Entry Points

Start here when exploring this area:

- **`spawn_relay`** (Function) — `backends/crates/chathub-relay/tests/common/mod.rs:65`
- **`spawn_relay_with`** (Function) — `backends/crates/chathub-relay/tests/common/mod.rs:69`
- **`mount_notify_pull`** (Function) — `backends/crates/chathub-relay/tests/common/mod.rs:144`
- **`mount_notify_pull_status`** (Function) — `backends/crates/chathub-relay/tests/common/mod.rs:192`
- **`connect`** (Function) — `backends/crates/chathub-relay/src/nacos.rs:27`

## Key Symbols

| Symbol                     | Type     | File                                                     | Line |
| -------------------------- | -------- | -------------------------------------------------------- | ---- |
| `spawn_relay`              | Function | `backends/crates/chathub-relay/tests/common/mod.rs`      | 65   |
| `spawn_relay_with`         | Function | `backends/crates/chathub-relay/tests/common/mod.rs`      | 69   |
| `mount_notify_pull`        | Function | `backends/crates/chathub-relay/tests/common/mod.rs`      | 144  |
| `mount_notify_pull_status` | Function | `backends/crates/chathub-relay/tests/common/mod.rs`      | 192  |
| `connect`                  | Function | `backends/crates/chathub-relay/src/nacos.rs`             | 27   |
| `logged_out_subscribe`     | Function | `backends/crates/chathub-net/src/token.rs`               | 69   |
| `login`                    | Function | `backends/crates/chathub-net/src/token.rs`               | 82   |
| `logout`                   | Function | `backends/crates/chathub-net/src/token.rs`               | 145  |
| `start_stub`               | Function | `backends/crates/chathub-net/tests/common/stub_relay.rs` | 164  |
| `start_stub_full`          | Function | `backends/crates/chathub-net/tests/common/stub_relay.rs` | 169  |
| `new`                      | Function | `backends/crates/chathub-net/src/hub.rs`                 | 866  |
| `state_subscribe`          | Function | `backends/crates/chathub-net/src/hub.rs`                 | 904  |
| `stop`                     | Function | `backends/crates/chathub-net/src/hub.rs`                 | 940  |
| `wait_for_state`           | Function | `backends/crates/chathub-net/tests/common/mod.rs`        | 14   |
| `push_event`               | Function | `backends/crates/chathub-net/tests/common/mod.rs`        | 40   |
| `login`                    | Function | `backends/crates/chathub-net/src/auth.rs`                | 26   |
| `try_resume_session`       | Function | `backends/crates/chathub-net/src/auth.rs`                | 59   |
| `default`                  | Function | `backends/crates/chathub-relay/tests/common/mod.rs`      | 55   |
| `raw_channel`              | Function | `backends/crates/chathub-relay/tests/relay_e2e.rs`       | 17   |
| `hub_client`               | Function | `backends/crates/chathub-relay/tests/relay_e2e.rs`       | 25   |

## Connected Areas

| Area        | Connections |
| ----------- | ----------- |
| Build\_     | 6 calls     |
| Cluster_51  | 3 calls     |
| Cluster_87  | 3 calls     |
| Cluster_38  | 1 calls     |
| Cluster_119 | 1 calls     |
| Cluster_70  | 1 calls     |
| Cluster_97  | 1 calls     |
| Cluster_137 | 1 calls     |

## How to Explore

1. `gitnexus_context({name: "spawn_relay"})` — see callers and callees
2. `gitnexus_query({query: "tests"})` — find related execution flows
3. Read key files listed above for implementation details
