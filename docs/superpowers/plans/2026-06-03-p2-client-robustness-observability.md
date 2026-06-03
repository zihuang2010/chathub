# P2 — S:客户端健壮性 + 可观测性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ① 修掉 `start()` 幂等陷阱:login 路径改 `cm.stop().await; cm.start().await;`,让重登录/二次登录强制干净重连,而不是在 run_loop 仍存活时静默空操作 + 误打印 "ConnectionManager started";② 给 `run_loop` 的失败/状态切换路径补 `tracing`(target `chathub_net::hub`),把"卡连接中 / 退避重连 / 服务端关流"从日志里的一片空白变成可观测,零行为改动。

**Architecture:** 客户端单端改动,不动 relay、不动 proto。S1 只改 `backends/src/lib.rs` login 命令一行调用序;复用 ConnectionManager 现有 `stop()`(`h.abort()` + 置 `Disconnected`)与 `start()`(task mutex 串行,共用同一把锁保证不产生双 run_loop)。S2 在 `Inner::run_loop` 的 Connecting / Subscribed / subscribe Err / stream Err / `Ok(None)` 关流 / backoff sleep 各插入一条 `tracing`,不改任何控制流。S1 的 abort 中途切断正在 apply 的批,靠四个 applier 同 seq 重投幂等兜底(P1 Task 5 已核验);首登多发一次 `Disconnected` 的 UI 抖动靠前端 `<300ms` 去抖收敛(本计划落地 + 标注为已知)。

**Tech Stack:** Rust(tokio / tonic 0.12 / tracing),客户端 crate `chathub-net` + 主程序 `backends/src/lib.rs`;前端 React + Vitest(`useHubSyncStatus`)。测试:`cargo test`(复用 `tests/common::stub_relay` e2e 夹具,可驱动真 ConnectionManager 收发);前端 `pnpm vitest run`(仓库根目录,单一 `package.json`)。

**对应 spec:** `docs/superpowers/specs/2026-06-03-subscribe-deadlock-fix-and-resync-decoupling-design.md` §5(S1 §5.1 / S2 §5.2),边界引用 §4.3(applier LWW 幂等)、§1.4(start 幂等陷阱 + 错误无埋点)。

---

## 文件结构

| 文件                                                          | 职责                                  | 改动                                                                                                                                    |
| ------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `backends/src/lib.rs`                                         | `login` tauri 命令(~L112-131)         | S1:`cm.start().await` → `cm.stop().await; cm.start().await;`;改日志措辞为"reconnected"                                                  |
| `backends/crates/chathub-net/src/hub.rs`                      | 客户端 `Inner::run_loop`(~L1090-1285) | S2:Connecting / Subscribed / subscribe Err / stream Err / `Ok(None)` / backoff 各补一条 `tracing`(target `chathub_net::hub`),零行为改动 |
| `backends/crates/chathub-net/tests/s1_clean_reconnect_e2e.rs` | S1 行为 e2e(新建)                     | 新增:对已 Subscribed 的 cm 再 `stop→start`,断言触发一次新 subscribe 且回到 Subscribed(复现 start() 幂等陷阱的修复)                      |
| `frontends/lib/data/useHubSyncStatus.ts`                      | `hub:connection` listener(~L41-65)    | S1 体验:对 `disconnected` 做 `<300ms` 去抖,瞬时抖动不闪"离线";真离线 300ms 后照常显示                                                   |
| `frontends/lib/data/useHubSyncStatus.test.ts`                 | 去抖单测(新建)                        | 新增:验证瞬时 disconnected→subscribed 不暴露 disconnected;持续 disconnected 300ms 后暴露                                                |

---

## Task 1: S1 e2e —— 写失败测试:对已 Subscribed 的 cm 再 stop→start 应触发新 subscribe

**Files:**

- Create(test): `backends/crates/chathub-net/tests/s1_clean_reconnect_e2e.rs`

说明:这是 S1 的**行为锚点**。`stub_relay` 的 `StubHubState.subscribes: Vec<(u64, String)>` 记录每次 Subscribe 调用(`since_notify_seq`, `device_id`)。修复前若直接对一个仍在 Subscribed 的 ConnectionManager 调 `start()`,因 run_loop task 未结束(`h.is_finished()==false`)会**静默 return**,不产生新 subscribe;`stop()` 先 `h.abort()` 让 task 结束,再 `start()` 才会真正重连。本测试直接对 cm 调一次 `stop().await; start().await;`(login 改动的等价行为),断言 `subscribes` 计数从 1 增到 2,且状态回到 `Subscribed`。

> 为何不直接测 `login` 命令:`login` 是 `#[tauri::command]`,依赖 `State<'_, Arc<AuthApi>>` / `State<'_, Arc<ConnectionManager>>` 注入,无法在 crate 单测里脱壳构造。login 改动本身只是把 `cm.start().await` 替换为 `cm.stop().await; cm.start().await;`(见 Task 3),其语义正确性由本 e2e 对 ConnectionManager 直接验证 + Task 3 的编译保证。

- [ ] **Step 1: 写 e2e 测试文件**

新建 `backends/crates/chathub-net/tests/s1_clean_reconnect_e2e.rs`:

```rust
//! S1 e2e:验证"已 Subscribed 的 ConnectionManager 再 stop→start 会强制干净重连"。
//! 修复前(login 直接调 start()):run_loop task 未结束 → start() 静默 return → 不重订阅。
//! 修复后(login 改 stop→start;ConnectionManager::stop 已 abort task):产生第二次 subscribe。

mod common;

use chathub_net::hub::ConnectionState;
use chathub_net::{
    AuthInterceptor, BackoffConfig, ConnectionManager, HubClient, TokenStore,
};
use chathub_state::{LocalTokenStore, NotifySeqStore, SqlitePool};
use common::stub_relay::start_stub_full;
use common::wait_for_state;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast;

#[tokio::test]
async fn stop_then_start_forces_clean_resubscribe() {
    let (addr, _auth_state, hub_state, _h) = start_stub_full().await;

    let ep = chathub_net::build_endpoint(format!("http://{addr}")).expect("ep");
    let channel = ep.connect_lazy();
    // 与既有 e2e 一致:用临时文件库,避免 :memory: 每连接独立 schema。
    let db_path = std::env::temp_dir().join(format!("chathub_s1_{}.db", uuid::Uuid::new_v4()));
    let pool = SqlitePool::open(&db_path).await.unwrap();
    let local = LocalTokenStore::new(pool.clone());
    let token_store = Arc::new(TokenStore::new(ep, local, "dev-1".into()));
    token_store.login("alice", "pwd").await.expect("login");

    let interceptor = AuthInterceptor::new(token_store.clone());
    let hub = HubClient::new(channel, interceptor);
    let notify_seq_store = NotifySeqStore::new(pool.clone());
    let (change_tx, _change_rx) = broadcast::channel(64);

    let cm = Arc::new(ConnectionManager::new(
        hub,
        token_store,
        notify_seq_store,
        "dev-1".into(),
        "test".into(),
        BackoffConfig::default(),
        None,
        None,
        None,
        None,
        change_tx,
    ));

    // 首次启动 → 等到 Subscribed,断言已发生一次 subscribe。
    cm.start().await;
    let mut state_rx = cm.state_subscribe();
    wait_for_state(
        &mut state_rx,
        |s| matches!(s, ConnectionState::Subscribed),
        Duration::from_secs(5),
    )
    .await;
    assert_eq!(
        hub_state.lock().unwrap().subscribes.len(),
        1,
        "首次 start 应触发恰好一次 subscribe"
    );

    // 模拟 login 路径的"强制干净重连":stop → start。
    cm.stop().await;
    cm.start().await;

    // 应再次回到 Subscribed,且 subscribe 计数变 2(证明不是 start() 静默空操作)。
    wait_for_state(
        &mut state_rx,
        |s| matches!(s, ConnectionState::Subscribed),
        Duration::from_secs(5),
    )
    .await;
    assert_eq!(
        hub_state.lock().unwrap().subscribes.len(),
        2,
        "stop→start 必须触发第二次 subscribe(start() 幂等陷阱已修)"
    );

    cm.stop().await;
    let _ = std::fs::remove_file(&db_path);
    let _ = std::fs::remove_file(db_path.with_extension("db-shm"));
    let _ = std::fs::remove_file(db_path.with_extension("db-wal"));
}
```

- [ ] **Step 2: 跑测试,确认基线通过(锚定语义,非红/绿门)**

Run: `cd backends && env -u ALL_PROXY cargo test -p chathub-net --test s1_clean_reconnect_e2e stop_then_start_forces_clean_resubscribe -- --nocapture`
Expected: PASS。

> 说明:本测试直接调 `cm.stop()/cm.start()`,在**当前** `ConnectionManager::stop`(已是 `abort` + `await`)语义下本就应通过 —— 它锚定的是"stop→start 必产生新 subscribe"这一 S1 依赖的不变量。它的"反例"是 login 若**只调 start()**:用 Step 3 临时验证该反例确实失败,证明测试有鉴别力。
> 必须 `env -u ALL_PROXY`(走真 gRPC channel,socks5 代理会假失败,见团队约定)。

- [ ] **Step 3:(可选)确认它能抓 bug**

临时把 Step 1 测试里的 `cm.stop().await; cm.start().await;` 改成只留 `cm.start().await;`(模拟未修复的 login)→ 再跑 → 应在第二个 `assert_eq!(... 2 ...)` 处失败(计数仍为 1,start() 静默空操作)。确认后改回。

- [ ] **Step 4: 提交**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
git add backends/crates/chathub-net/tests/s1_clean_reconnect_e2e.rs
git commit -m "test(client): S1 e2e 验证 stop→start 强制干净重连(锚定 start 幂等陷阱)"
```

---

## Task 2: S2 —— run_loop 补 tracing(零行为改动)

**Files:**

- Modify: `backends/crates/chathub-net/src/hub.rs`(`Inner::run_loop`:Connecting ~L1101、subscribe Err ~L1111-1131、Subscribed ~L1134、stream Err ~L1255-1278、`Ok(None)` ~L1250-1253、backoff sleep 各处)

当前 run_loop 的失败路径全程无 `tracing`:卡 `Connecting`、subscribe `Err`、stream `Err`、`Ok(None)` 服务端关流、backoff 退避在日志里"什么都没发生"(spec §1.4)。补埋点,target 统一 `chathub_net::hub`,**不改任何控制流**(不增删 `continue`/`return`/`sleep`)。

> 已有埋点保持不变:`hub.ack failed`(L1158)、两条 `SubscribeAck.resync_required` / `SystemSignal::ResyncRequired` 的 `info!`(L1181 / L1194)、`notify_seq_store upsert failed`(L1235)。本 Task 只**新增**,不动这些。

- [ ] **Step 1: Connecting 轮入口补 info(打 since)**

把 `'reconnect: loop {` 之后的:

```rust
        'reconnect: loop {
            self.state_tx.send_replace(ConnectionState::Connecting);

            let since = self.notify_seq_store.read().await.unwrap_or(0);
```

改为(在读出 `since` 后补一条 info,信息更全):

```rust
        'reconnect: loop {
            self.state_tx.send_replace(ConnectionState::Connecting);

            let since = self.notify_seq_store.read().await.unwrap_or(0);
            tracing::info!(
                target: "chathub_net::hub",
                since,
                "run_loop connecting; subscribing"
            );
```

- [ ] **Step 2: subscribe 阶段 Err 三分支补 warn(打 classify 结果 + 错误)**

把 subscribe 的 `Err(err) => match classify(&err) { ... }`(~L1111-1131)替换为(每个分支前补一条 warn,控制流不变):

```rust
                Err(err) => {
                    let action = classify(&err);
                    tracing::warn!(
                        target: "chathub_net::hub",
                        ?action,
                        error = %err,
                        "subscribe request failed"
                    );
                    match action {
                        Action::Logout => {
                            self.token_store.mark_token_invalid().await;
                            self.state_tx
                                .send_replace(ConnectionState::Disconnected { last_error: None });
                            return;
                        }
                        Action::Terminate => {
                            self.state_tx.send_replace(ConnectionState::Disconnected {
                                last_error: Some(err),
                            });
                            return;
                        }
                        Action::Backoff => {
                            self.state_tx.send_replace(ConnectionState::Disconnected {
                                last_error: Some(err),
                            });
                            let dur = backoff.next();
                            tracing::warn!(
                                target: "chathub_net::hub",
                                backoff_ms = dur.as_millis() as u64,
                                "subscribe backoff sleep before reconnect"
                            );
                            tokio::time::sleep(dur).await;
                            continue 'reconnect;
                        }
                    }
                }
```

> 注意:`Action` 需可 `Debug`。它已 `#[derive(Debug, PartialEq)]`(`hub.rs:60`),`?action` 可直接用。`err` 在 warn 里以 `%err`(Display)借用打印,之后 `Some(err)` move 不冲突(warn 在 move 前)。

- [ ] **Step 3: Subscribed 补 info**

把:

```rust
            self.state_tx.send_replace(ConnectionState::Subscribed);
            backoff.reset();
```

改为:

```rust
            self.state_tx.send_replace(ConnectionState::Subscribed);
            backoff.reset();
            tracing::info!(target: "chathub_net::hub", since, "subscribed; streaming");
```

- [ ] **Step 4: `Ok(None)` 服务端关流补 warn + backoff**

把(~L1250-1253):

```rust
                        Ok(None) => {
                            self.state_tx.send_replace(ConnectionState::Disconnected { last_error: None });
                            tokio::time::sleep(backoff.next()).await;
                            continue 'reconnect;
                        }
```

改为:

```rust
                        Ok(None) => {
                            self.state_tx.send_replace(ConnectionState::Disconnected { last_error: None });
                            let dur = backoff.next();
                            tracing::warn!(
                                target: "chathub_net::hub",
                                backoff_ms = dur.as_millis() as u64,
                                "stream closed by server (Ok(None)); backoff before reconnect"
                            );
                            tokio::time::sleep(dur).await;
                            continue 'reconnect;
                        }
```

- [ ] **Step 5: stream `Err(status)` 三分支补 warn(打 classify 结果 + 错误)**

把(~L1255-1279)的 `Err(status) => { let err: AuthError = status.into(); match classify(&err) { ... } }` 替换为:

```rust
                        Err(status) => {
                            let err: AuthError = status.into();
                            let action = classify(&err);
                            tracing::warn!(
                                target: "chathub_net::hub",
                                ?action,
                                error = %err,
                                "stream error"
                            );
                            match action {
                                Action::Logout => {
                                    self.token_store.mark_token_invalid().await;
                                    self.state_tx.send_replace(
                                        ConnectionState::Disconnected { last_error: None },
                                    );
                                    return;
                                }
                                Action::Terminate => {
                                    self.state_tx.send_replace(ConnectionState::Disconnected {
                                        last_error: Some(err),
                                    });
                                    return;
                                }
                                Action::Backoff => {
                                    self.state_tx.send_replace(ConnectionState::Disconnected {
                                        last_error: Some(err),
                                    });
                                    let dur = backoff.next();
                                    tracing::warn!(
                                        target: "chathub_net::hub",
                                        backoff_ms = dur.as_millis() as u64,
                                        "stream backoff sleep before reconnect"
                                    );
                                    tokio::time::sleep(dur).await;
                                    continue 'reconnect;
                                }
                            }
                        }
```

> `should_terminate`(SERVER_DRAIN / RESYNC_REQUIRED 主动断流)分支(~L1241-1248)已有上层的 resync `info!`,且属正常协议路径,不在本 Task 补埋点范围;保持不变。

- [ ] **Step 6: 编译 + 跑 chathub-net 全测,确认零行为回归**

Run: `cd backends && cargo test -p chathub-net`
Expected: PASS（既有单测/集成测全绿;本 Task 只加 `tracing`,无控制流改动,无新单测——run_loop 行为不变）。

- [ ] **Step 7: 跑 Task 1 的 S1 e2e,确认埋点改动未破坏重连语义**

Run: `cd backends && env -u ALL_PROXY cargo test -p chathub-net --test s1_clean_reconnect_e2e stop_then_start_forces_clean_resubscribe`
Expected: PASS。

- [ ] **Step 8: 提交**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
git add backends/crates/chathub-net/src/hub.rs
git commit -m "feat(client): run_loop 补 tracing 埋点(connecting/subscribed/err/关流/退避),零行为改动"
```

---

## Task 3: S1 —— login 命令改 stop→start 强制干净重连

**Files:**

- Modify: `backends/src/lib.rs:128-129`(`login` 命令)

`login`(~L112-131)当前在认证成功后无条件 `cm.start().await` 并打印 "ConnectionManager started"。问题(spec §1.4 / §5.1):run_loop 卡住时 `start()` 因 task 未结束静默 return,login 仍打印成功 → 重登录全是空操作 + 日志误导。改为 `cm.stop().await; cm.start().await;` 强制干净重连;日志措辞改为 "reconnected"。

> resume 路径(`lib.rs:1537`)维持 `start()` 不动(冷启动 task 必为 None,无幂等陷阱);lag-reconnect(`lib.rs:1579-1580`)已是 stop→start,不动。

- [ ] **Step 1: 替换 login 的启动调用**

把 `lib.rs` login 命令里的:

```rust
    cm.start().await;
    info!(target: "chathub::cmd", user_id = %profile.user_id, "login command ok, ConnectionManager started");
    Ok(profile)
```

替换为:

```rust
    // S1:强制干净重连。直接 start() 有幂等陷阱——run_loop 仍存活时 start() 静默 return,
    // 重/二次登录变空操作且日志误导。先 stop()(abort 旧 task + 置 Disconnected)再 start()。
    // stop/start 共用 task mutex 串行,不会产生双 run_loop;abort 可能切断正在 apply 的批,
    // 靠四个 applier 同 seq 重投幂等兜底(见 spec §4.3 / P1 Task 5)。
    cm.stop().await;
    cm.start().await;
    info!(target: "chathub::cmd", user_id = %profile.user_id, "login command ok, ConnectionManager reconnected");
    Ok(profile)
```

- [ ] **Step 2: 编译整个 backend 二进制,确认通过**

Run: `cd backends && cargo build`
Expected: 编译通过(login 改动只换调用序 + 日志字符串,类型不变)。

- [ ] **Step 3: 提交**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
git add backends/src/lib.rs
git commit -m "fix(client): login 改 stop→start 强制干净重连,修 start() 幂等陷阱"
```

---

## Task 4: S1 体验 —— 前端 hub:connection 对 disconnected 做 <300ms 去抖

**Files:**

- Modify: `frontends/lib/data/useHubSyncStatus.ts`(`hub:connection` listener ~L41-65)
- Create(test): `frontends/lib/data/useHubSyncStatus.test.ts`

S1 改 stop→start 后,正常态/首登会多发一次 `Disconnected`(`hub.rs:1065` stop 时置 Disconnected)→ `hub:connection` 瞬时把 Sidebar 闪成"离线"。spec §5.1 标注为**已知**、不阻断,治法是前端对 `disconnected` 做 `<300ms` 去抖:收到 `disconnected` 不立即 set,延迟 250ms;期间若来 `subscribed`/`connecting` 则取消,瞬时抖动不外显;真离线 250ms 后照常显示。

> 落点选 `useHubSyncStatus`(Sidebar/TitleBar 等全局组件的连接态唯一来源),只去抖 `disconnected`;`subscribed`/`connecting` 立即 set(它们不是抖动源)。

- [ ] **Step 1: 写失败测试**

新建 `frontends/lib/data/useHubSyncStatus.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

// hub:connection 事件回调捕获 + 受控 invoke。
let connectionCb: ((e: { payload: unknown }) => void) | undefined;

vi.mock("@tauri-apps/api/core", () => ({
  // hub_state 初值返回 subscribed,避免初始 null。
  invoke: vi.fn().mockResolvedValue({ state: "subscribed" }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, cb: (e: { payload: unknown }) => void) => {
    if (name === "hub:connection") connectionCb = cb;
    return Promise.resolve(() => {});
  }),
}));

import { useHubSyncStatus } from "./useHubSyncStatus";

beforeEach(() => {
  connectionCb = undefined;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("useHubSyncStatus hub:connection 去抖", () => {
  it("瞬时 disconnected→subscribed(<300ms)不暴露 disconnected", async () => {
    const { result } = renderHook(() => useHubSyncStatus());
    // 等 listen 注册完成。
    await waitFor(() => expect(connectionCb).toBeTypeOf("function"));

    act(() => {
      // login stop→start 抖动:先 disconnected,50ms 后 subscribed。
      connectionCb!({ payload: { state: "disconnected" } });
    });
    act(() => {
      vi.advanceTimersByTime(50);
      connectionCb!({ payload: { state: "subscribed" } });
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    // disconnected 被去抖吃掉,最终态是 subscribed。
    expect(result.current.connectionState).toEqual({ state: "subscribed" });
  });

  it("持续 disconnected 超过去抖窗口后暴露 disconnected", async () => {
    const { result } = renderHook(() => useHubSyncStatus());
    await waitFor(() => expect(connectionCb).toBeTypeOf("function"));

    act(() => {
      connectionCb!({ payload: { state: "disconnected" } });
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current.connectionState).toEqual({ state: "disconnected" });
  });

  it("subscribed/connecting 立即生效,不被延迟", async () => {
    const { result } = renderHook(() => useHubSyncStatus());
    await waitFor(() => expect(connectionCb).toBeTypeOf("function"));

    act(() => {
      connectionCb!({ payload: { state: "connecting" } });
    });
    expect(result.current.connectionState).toEqual({ state: "connecting" });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run(仓库根目录,pnpm): `pnpm vitest run frontends/lib/data/useHubSyncStatus.test.ts`
Expected: FAIL —— 第一个用例 `瞬时 disconnected→subscribed 不暴露 disconnected` 失败:当前无去抖,disconnected 被立即 set,后续虽被 subscribed 覆盖但断言时序下会暴露中间态(且第二/三用例当前各自通过,确认仅去抖逻辑缺失)。

- [ ] **Step 3: 实现去抖**

把 `useHubSyncStatus.ts` 的 `hub:connection` useEffect(~L41-65)替换为:

```ts
// hub:connection
// S1:login 改 stop→start 后会多发一次 disconnected → Sidebar 瞬时闪"离线"。
// 对 disconnected 做 <300ms 去抖:延迟 set,期间来 subscribed/connecting 则取消;
// 真离线 250ms 后照常显示。subscribed/connecting 立即生效(非抖动源)。
useEffect(() => {
  let unlisten: (() => void) | undefined;
  let cancelled = false;
  let pendingDisconnect: ReturnType<typeof setTimeout> | undefined;
  const clearPending = () => {
    if (pendingDisconnect !== undefined) {
      clearTimeout(pendingDisconnect);
      pendingDisconnect = undefined;
    }
  };
  const applyState = (next: HubConnectionState) => {
    if (next.state === "disconnected") {
      clearPending();
      pendingDisconnect = setTimeout(() => {
        if (!cancelled) setConnectionState(next);
      }, 250);
    } else {
      // subscribed / connecting:取消挂起的 disconnected,立即生效。
      clearPending();
      setConnectionState(next);
    }
  };
  void (async () => {
    try {
      const init = await invoke<HubConnectionState>("hub_state");
      if (!cancelled) setConnectionState(init);
    } catch {
      // hub_state 命令未就绪时静默
    }
    const un = await listen<HubConnectionState>("hub:connection", (event) => {
      if (!cancelled) applyState(event.payload);
    });
    // await 期间组件可能已卸载:cleanup 早于此处赋值会空跑,导致监听器悬挂永不取消。
    if (cancelled) {
      un();
      return;
    }
    unlisten = un;
  })();
  return () => {
    cancelled = true;
    clearPending();
    unlisten?.();
  };
}, []);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run frontends/lib/data/useHubSyncStatus.test.ts`
Expected: PASS（三个用例全绿）。

- [ ] **Step 5: 类型校验 + Sidebar 既有测试不破**

Run: `pnpm tsc --noEmit`
Expected: 无类型错误。

Run: `pnpm vitest run frontends/components/workbench/Sidebar.test.tsx`
Expected: PASS（Sidebar 既有连接态用例不受影响 —— 它 mock `useHubSyncStatus`,去抖在 hook 内部,Sidebar 仍按 `connectionState` 直接渲染）。

- [ ] **Step 6: 提交**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
git add frontends/lib/data/useHubSyncStatus.ts frontends/lib/data/useHubSyncStatus.test.ts
git commit -m "fix(frontend): hub:connection 对 disconnected 做 250ms 去抖,消 stop→start 离线闪烁"
```

---

## 已知边界(记录在案,不在本计划修复)

1. **S1 abort 切断正在 apply 的批**(spec §5.1 / §4.3):`stop()` 用 `h.abort()`(`hub.rs:1060`),可能在四个 async applier 的 `.await` 链(`hub.rs:1213-1230`)中点切断,留下"部分 applier 落库 + `notify_seq` 未前进"中间态。**方向安全**:靠重连重放 + 四个 applier **同 seq 重投幂等**兜底(P1 Task 5 已逐个核验),不是依赖 abort 原子性。**禁止**后续把 abort 改成不 await 的 fire-and-forget(会破坏 start/stop 共用 task mutex 的串行保证 → 双 run_loop)。
2. **首登多发一次 Disconnected 的 UI 抖动**(spec §5.1):本计划 Task 4 已用前端 250ms 去抖收敛瞬时闪烁,作为**已知体验项**标注。去抖只延迟"离线"显示,不吞真离线;真离线仍在 250ms 后照常显示。

---

## 自检(写完计划后)

- **spec 覆盖**:
  - §5.1 S1 `start()` 幂等陷阱(login 改 stop→start)→ Task 3;行为锚点 e2e → Task 1。
  - §5.1 abort 边界 + applier 幂等兜底 → 「已知边界 1」(引用 P1 Task 5,不重复核验)。
  - §5.1 首登 Disconnected UI 抖动(前端 <300ms 去抖,标注已知)→ Task 4 + 「已知边界 2」。
  - §5.2 S2 run_loop 错误埋点(Connecting / Subscribed / subscribe&stream Err 打 classify+错误 / Ok(None) 关流 / backoff)→ Task 2(6 个插入点逐一对应)。
  - 全覆盖。
- **占位符**:无 TBD;所有 Rust/TS 代码块基于读到的真实签名落地:
  - `StubHubState.subscribes: Vec<(u64,String)>`、`start_stub_full()`、`wait_for_state(rx,pred,timeout)`、`ConnectionManager::new(11 参)`、`BackoffConfig::default()`、`HubClient::new`、`TokenStore::new`、`NotifySeqStore::new`、`build_endpoint` 均与 `tests/message_e2e.rs` / `tests/common/` 现有用法一致。
  - `Action`(`#[derive(Debug, PartialEq)]`,`hub.rs:60`)→ `?action` 可用;`classify(&err) -> Action`(`hub.rs:67`)签名一致。
  - `ConnectionState::Connecting/Subscribed/Disconnected{last_error}`、`state_tx.send_replace`、既有 `tracing` target 风格(`chathub_net::hub`,见 `hub.rs:1182`)一致。
  - `useHubSyncStatus` 的 `HubConnectionState` / `invoke("hub_state")` / `listen("hub:connection")` 与现有源一致;测试 mock 方式对齐 `Sidebar.test.tsx`(vitest + @testing-library)。
- **类型/签名一致性**:S2 各插入点 `err` 以 `%err` 借用打印再 move 进 `Some(err)`,无 borrow-after-move;`backoff.next()` 返回 `Duration`,`dur.as_millis() as u64` 与既有 `?e` 风格不冲突;控制流(continue/return/sleep)逐分支与原代码一一对应,无增删。
- **仓库约定**:Rust 测试 `cd backends && cargo test -p chathub-net ...`;e2e(走真 gRPC channel)`env -u ALL_PROXY`;前端在仓库根目录用 `pnpm vitest run` / `pnpm tsc --noEmit`(单一 package.json)。提交信息中文,结尾不加 Co-Authored(执行者统一加)。

---

## 备注:上线序

P2 随客户端版本上(spec §7 部署序 2),依赖 P1 已部署(relay 死锁已修)——否则 login 改 stop→start 强制重连后,旧 relay 仍会在大回放上死锁。P2 是纯客户端改动,可独立 commit / 独立 revert,不影响 P1/P3/P4。
