# 设计：relay 流心跳 + 客户端静默看门狗（消除“显示已连接、实际已掉线”僵尸态）

- 日期：2026-06-08
- 状态：设计已与用户对齐（兼容方案选 ②；参数取默认值）
- 关联记忆：`project-windows-360-blocks-push-stream`、`project-force-close-kicked`、`project-connecting-frontend-race`

---

## 1. 背景与问题

relay 把连接从内存路由表移除（`Router::drop_employee_stream` / `drop_all_employee_streams` /
`drop_employee_streams_except_terminal`）时，**只删注册、不关 socket、不下发任何帧**
（见 `chathub-relay/src/router.rs:50-52`、`push.rs:303-316` 注释）。

客户端 `run_loop`（`chathub-net/src/hub.rs:1178-1360`）在 `tokio::select!` 里等
`stream.message()`。当出现以下任一“传输活着但应用帧不来”的情况：

1. **backpressure 摘注册**：客户端落后导致 mpsc(256) 满，relay `drop_employee_stream`
   停止 fanout，但流不关（subscribe spawn 仍持 `tx` 至 `tx.closed()`）。
2. **360 吞帧**：安全软件吞掉 subscribe server-streaming 的推送帧（unary 放行）。
3. **网络黑洞但 TCP 仍被 keepalive 维持**：应用帧不到，但 HTTP/2 PING 仍 ack。

`stream.message()` 既不返回 `Ok`（无帧）也不返回 `Err`（传输未死），**永久阻塞**在该臂上，
连接态停在 `Subscribed`，UI 显示“已连接”，但实际收不到任何推送 → **僵尸在线**。
每秒的 `ack`（unary）此时照样成功，反而掩盖问题。

现有 HTTP/2 keepalive（`chathub-net/src/channel.rs:16-19`：interval 10s / timeout 5s /
while_idle / tcp_keepalive 30s）只能探测“TCP 真死”，无法探测上述 1/2/3 这类“传输健康、应用帧不来”。

---

## 2. 目标 / 非目标

### 目标

- 客户端能在有界时间内（约 45s）发现“流已静默死亡”，并按原因区分恢复：
  - 静默掉线（backpressure / 360 / 黑洞）→ **静默自动重连 + resync 续点**，不打断用户。
- 一个机制同时覆盖路由表移除、360 吞帧、网络黑洞三类静默死。

### 非目标（本次不做）

- **不**改 `force_close → 重登`（`hub.rs:1284-1298` 已实现，保持）。
- **不**改 `token 失效 → Rejected 终态 → 重登`（subscribe/ack/stream 三处 `classify→Logout` 已实现，保持）。
- **不**做“relay 移除注册时主动 drop tx 关流”（方案 B）——它覆盖不到 360/黑洞，已否决。
- **不**改 resync/水位/重放逻辑（复用现成的 `since=durable_seq` 重订阅链路）。

---

## 3. 现状边界（已实现，保持不动）

| 情形                                      | 现有行为                                                                | 代码位置                                   |
| ----------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------ |
| force_close 顶号                          | 收 `CONNECTION_FORCE_CLOSE` → `mark_kicked` + `Rejected` → 前端切登录页 | `hub.rs:1284-1298`                         |
| token 失效（subscribe/ack/stream 鉴权拒） | `classify→Logout/Terminate` → `Rejected` 终态                           | `hub.rs:1131-1158 / 1196-1215 / 1329-1356` |
| `Ok(None)` 服务端关流                     | `Disconnected` + backoff 重连                                           | `hub.rs:1309-1318`                         |
| `SERVER_DRAIN`                            | 主动断 + 重连                                                           | `hub.rs:1300-1307`                         |

**唯一缺口**：`stream.message()` 永久阻塞（既非 `Ok(None)` 也非 `Err`）的静默死。本设计只补这一个洞。

---

## 4. 方案总览

三处改动 + 一个自协商策略：

- **A. proto**：`SystemSignal.Kind` 增 `KIND_HEARTBEAT = 3`。
- **B. relay**：周期心跳任务，向所有已注册连接 fanout 心跳帧。被摘注册者自然收不到。
- **C. 客户端**：`run_loop` 增“静默超时”看门狗臂，超时 → 静默重连。
- **②自协商武装**：客户端**收到过至少一帧心跳后**才武装看门狗 → 连旧 relay（不发心跳）时退化为今日行为，无重连风暴、无发布顺序耦合。

### 为什么必须有 relay 心跳（不能纯客户端）

subscribe 是 server-streaming，建流后客户端无法在同一条流上回发探测；唯一的 client→server
通道是 unary（ack/forward），不走推送流路径，测不到 360 对**推送流**的封锁。因此“这条流还活着吗”
只能由 relay 在该流上周期下发心跳来判定；空闲连接也收得到心跳，看门狗才不误杀。

---

## 5. 详细设计

### 5.A proto（`proto/chathub/v1/event.proto`）

在 `SystemSignal.Kind` 末尾新增（原位扩枚举，向后兼容）：

```proto
KIND_HEARTBEAT = 3;   // relay 周期下发的流保活帧;客户端仅用于重置静默看门狗,不入库/不动水位/不触发 resync
```

`detail` 留空。重新 `cargo build`（build.rs/prost 生成 `Kind::Heartbeat`）。

### 5.B relay 周期心跳任务

#### B1. Router 新增 sweep 方法（`chathub-relay/src/router.rs`）

新增 `heartbeat_sweep() -> usize`（返回送达计数，仅观测用）：遍历 `employees.load()` 全部连接，
`try_send` 一帧 `SystemSignal{kind: HEARTBEAT}`；对 `try_send` 返回 `Closed`/`Full` 的连接，
**在本方法内部直接 `drop_employee_stream` 摘除**（已持 `employee_id` + `connection_id`，无需外抛）。
语义参照 `broadcast_server_drain`（已有的全表遍历下发），但额外做死连接清理。

> 把“下发 + 清理”收在一个 router 方法内，避免把 `employee_id↔connection_id` 关系外泄给调用方，
> 也省去 `FanoutOutcome` 的跨层归集。复用而非新造：实现时与 `broadcast_*` 家族保持风格一致。

#### B2. 心跳 spawn（relay 启动处，`chathub-relay/src/main.rs` 或 HubSvc/PushState 组装处）

启动一个后台 task，仅周期触发 sweep（清理已内化进 B1）：

```text
loop {
    sleep(heartbeat_interval);
    let delivered = router.heartbeat_sweep();   // 内部已顺手摘除投不动的死连接
    tracing::trace!(delivered, "heartbeat sweep");
}
```

- `event.clone()` 是 `Bytes` refcount，开销可忽略；sweep 全程无 IO、无 await（`try_send` 非阻塞）。

#### B3. 配置（`chathub-relay/src/config.rs`）

新增 `heartbeat_interval_ms`，env `RELAY_HEARTBEAT_INTERVAL_MS`，**默认 15000**。
与现有 `force_close_grace_ms` 同位置同风格注入（含 startup 日志打印）。

#### B4. 负载评估

5000 conn ÷ 15s ≈ 333 帧/s，相对峰值 ~1000 push/s 可忽略。心跳帧极小、无 IO、无锁
（fanout 走 `ArcSwap` 原子 load）。

### 5.C 客户端静默看门狗（`chathub-net/src/hub.rs::run_loop`）

#### C1. 常量

```rust
const SILENCE_TIMEOUT: Duration = Duration::from_secs(45); // 必须 > 2× 心跳间隔
```

#### C2. 内层 loop 前初始化

```rust
let mut heartbeat_seen = false;                 // ②自协商:见过心跳才武装
let mut silence = Box::pin(tokio::time::sleep(SILENCE_TIMEOUT));
```

#### C3. `select!` 新增一臂（放在 `stream.message()` **之后**，使就绪帧优先）

```rust
// 仅在“见过心跳”后武装;超时 = 流静默死亡 → 静默重连(不打断用户)
_ = &mut silence, if heartbeat_seen => {
    self.state_tx.send_replace(ConnectionState::Disconnected { last_error: None });
    tracing::warn!(target: "chathub_net::hub",
        silence_secs = SILENCE_TIMEOUT.as_secs(),
        "stream silent past timeout (no heartbeat); reconnecting");
    tokio::time::sleep(backoff.next()).await;   // 建流时已 reset → 约 base(1s),快速恢复
    continue 'reconnect;
}
```

#### C4. `Ok(Some(event))` 臂顶部：任意帧都重置 deadline；心跳帧短路

```rust
// 任意帧到达即证明流活 → 重置静默 deadline
silence.as_mut().reset(tokio::time::Instant::now() + SILENCE_TIMEOUT);

// 心跳帧:武装看门狗 + 直接进入下一轮(不入 handle_frame,纯保活)
if matches!(&event.body, Some(Body::System(s)) if s.kind == Kind::Heartbeat as i32) {
    heartbeat_seen = true;
    continue; // 内层 loop
}
// …其余照旧(SubscribeAck / PushBatch / ResyncRequired / ServerDrain / force_close)…
```

> 即便不短路、让心跳流入 `sync.handle_frame`，它也会落入 catch-all（sync 只显式识别
> `Kind::ResyncRequired`，见 `sync.rs:231`）成为 no-op。短路只是省一次解析、语义更清晰。

#### C5. 不变量

- `heartbeat_seen` 在每次 `'reconnect` 迭代重置为 false（随内层 loop 初始化）：每条新流都要
  重新见到心跳才武装，避免跨连接误带状态。
- 看门狗触发只设 `Disconnected` + `continue 'reconnect`，**绝不**进入 `Rejected`/登出
  （静默重连，符合“按原因区分”里‘临时掉线’的语义）。

---

## 6. 恢复语义对齐（用户选定：按原因区分）

| 情形                                    | 行为                                               | 实现         |
| --------------------------------------- | -------------------------------------------------- | ------------ |
| 看门狗触发（backpressure / 360 / 黑洞） | **静默重连**（Connecting→Subscribed，UI 不弹登录） | 本设计 C     |
| force_close 顶号                        | **踢回登录页重登**                                 | 已实现，不动 |
| token 失效（ack/subscribe 鉴权拒）      | **重登（Rejected 终态）**                          | 已实现，不动 |

---

## 7. 兼容性与发布（②自协商）

- **新客户端 + 旧 relay（无心跳）**：客户端永不 `heartbeat_seen` → 看门狗永不武装 →
  退化为今日行为（不会因空闲误重连）。无发布顺序耦合。
- **新客户端 + 新 relay**：正常武装，约 45s 静默即重连恢复。
- **旧客户端 + 新 relay**：心跳帧 = 未知 `SystemSignal` kind，旧客户端 `handle_frame`
  落 catch-all no-op（与 RESYNC 之外的 SystemSignal 同样被忽略）→ 无害。

> 结论：四象限均安全，relay 与客户端可独立发布、灰度无序。

---

## 8. 风险与边界情况

1. **`SILENCE_TIMEOUT` 下限**：必须 `> 2× 心跳间隔`，否则正常抖动/单次丢包误杀。45s vs 15s
   留 3 次心跳冗余（t=15/30/45 任一到达都会续命）。
2. **force_close 与看门狗竞争**：force_close 帧在 grace（默认 2000ms）内先到 → 客户端
   `return` 重登，远早于 45s 看门狗。两路径不冲突（force_close 先发生且是 `return`）。
3. **重连风暴**：看门狗触发后走 `backoff.next()`（建流时已 reset，≈base 1s）+ 指数退避兜底，
   不会风暴。
4. **360 持续封锁**：重连后的新流可能仍被 360 吞 → 客户端在 Connecting/Subscribed 间循环重连。
   这是 360 环境的固有问题，本设计保证“不再永久僵尸”，彻底解需用户侧关闭/放行（既有结论）。
5. **心跳必须走 router fanout**：若误从 subscribe spawn 持有的 `tx` 直接发心跳，会绕过路由表 →
   被摘注册的僵尸仍收到心跳 → 看门狗失效。**心跳只能经 `router` 已注册连接下发**。

---

## 9. 测试计划（TDD，先红后绿）

### relay（`chathub-relay`，`cargo test -p chathub-relay`）

- `fanout_heartbeat_all` 投递给全部已注册连接、计数正确。
- 已 `drop_employee_stream` 的连接收不到心跳（sweep 不投死连接）。
- 心跳投递遇 closed/backpressure → 归集并被 drop（清理生效）。
- config：`RELAY_HEARTBEAT_INTERVAL_MS` 解析 + 默认 15000。

### 客户端（`chathub-net`，`env -u ALL_PROXY cargo test -p chathub-net`）

- 看门狗：流静默 > `SILENCE_TIMEOUT` 且 `heartbeat_seen=true` → 触发 `Disconnected` + 重连
  （用可控 stub stream + `tokio::time::pause/advance` 注入时间）。
- 自协商：从未收到心跳 → 看门狗不武装，长时间空闲不重连（连旧 relay 行为）。
- 重置：心跳/任意帧到达重置 deadline，不误触发。
- 心跳帧短路：收到 `Kind::Heartbeat` 不进 `handle_frame`、不改水位/不发 ack。
- 回归：force_close 仍走重登；`Ok(None)`/`Err` 路径不受影响。

### 全量

- 仓库根：`pnpm test`（前端无关，预期不受影响）。
- `env -u ALL_PROXY cargo test`（backends，relay e2e 注意 socks5 代理变量，见
  `feedback-relay-tests-all-proxy`）。

---

## 10. 影响面 / 待办

- **改动符号（实现前必跑 `gitnexus_impact`）**：
  - `chathub-net::hub::run_loop`（HIGH 关注：连接主循环，改 select! 结构）。
  - `chathub-relay::router::Router`（新增方法，低风险）。
  - proto `SystemSignal`（生成代码，扩枚举低风险）。
- 提交前跑 `gitnexus_detect_changes()` 核对影响范围。
- **分支/提交**：当前 worktree 处于他人 messages 前端 WIP（未提交），本设计与
  `feat/messages-virtual-windowing` 无关；落哪个分支、是否单独提交 spec 由用户定，
  **绝不 `git add -A`**（见 `feedback-shared-worktree-git-verify`）。
- 真机验证：Windows（360 环境）+ 多端，确认僵尸态消除、静默重连无感、空闲不误重连。
