# ChatHub Plan 3 — Stream + Send + ConnectionManager 设计规范

## Context

Plan 1 (Foundation) 已合入 main:Cargo workspace + chathub-proto + 全部 Rust 代码归位 `backends/crates/`。

Plan 2 (Auth End-to-End) 已合入 main:`AuthApi` (login/logout/current_session/try_resume_session) + `TokenStore` (后台 refresher) + `AuthInterceptor` (Bearer + 版本头) + 7 个 e2e + Tauri 命令 + `auth:logged_out` 事件桥。

Plan 3 的目标: **打通客户端 ↔ Relay 的双向数据流** —— 让 Tauri 客户端能 (a) 通过 `Hub.Subscribe` 持续接收服务端事件,(b) 通过 `Hub.Send` 发消息,(c) 在网络抖动 / token 过期 / 服务端 GOAWAY / 被踢号等场景下,通过 `ConnectionManager` 状态机自动重连或优雅终止。

**不在范围(显式)**:

- `Recall` / `AckRead` / `FetchHistory` RPC — Plan 4
- `ListWecomAccounts` / `EnableAccount` / `DisableAccount` — Plan 4 或 5
- `MessageRecalled` / `ReadReceipt` / `AccountStatus` / `PresenceChange` / `MessageStatusChange` ServerEvent kind — Plan 4
- `MessageBody` 的 image/voice/video/file/location/link/markdown 扩展 — Plan 5
- Send 的本地排队 / 离线重发 / 失败持久化 / in-Send 退避重试 — Plan 6
- 前端 React 的实际接线 — 独立前端 plan

**预期交付**: 一个端到端可演示的 PR,9 个新 e2e 测试 + 12 个新单元测试全绿,Plan 2 的 7 个 e2e 不破。前端仍不接入。

**协议层依据**: 协议设计 brainstorm 已锁定单连接 + 帧带 `wecom_account_id`、tonic gRPC bidi 风格、TLS + HTTP/2 keep-alive。本 spec 不重复协议层决策。

---

## 1. 架构总览

```
+-----------------------+         +-------------------------------------+
| Frontend (React)      |         | chathub-net (Rust)                  |
|                       | invoke  |                                     |
|  send_message(...)    | ------> |  HubClient::send -- Channel + intc  |
|                       |         |                                     |
|                       | event   |  ConnectionManager  (Arc<Inner>)    |
|  on hub:event         | <-----  |    ├─ state_tx: watch<ConnState>    |
|  on hub:connection    | <-----  |    ├─ event_tx: broadcast<Event>    |
|                       |         |    ├─ task: tokio JoinHandle        |
+-----------------------+         |    └─ run_loop:                     |
                                  |        ├─ subscribe(since_seqs)     |
                                  |        ├─ select { stream | logged_ |
                                  |        │           out_rx }         |
                                  |        ├─ classify(error)           |
                                  |        └─ ExponentialBackoff        |
                                  |                                     |
                                  |  SeqStore (deadpool-sqlite)         |
                                  |    └─ wecom_account_seqs            |
                                  +-----+----------------+--------------+
                                        | gRPC HTTP/2    |
                                        v                v
                                  +-------------------------------------+
                                  | chathub.v1.Hub                       |
                                  |   Subscribe (server-stream)          |
                                  |   Send       (unary)                 |
                                  +-------------------------------------+
```

**核心模块边界**:

- `HubClient` — 薄客户端;`send` 直接被 Tauri 命令调用(unary,无状态);`subscribe` 仅供 ConnectionManager 内部用
- `ConnectionManager` — 状态机 + 后台 task + 事件总线;**不**持有 `AuthApi`,通过 `TokenStore.logged_out_subscribe` 监听登出
- `SeqStore` — 单表 `wecom_account_seqs(account_id PK, last_seq, updated_at_ms)`;UPSERT 写在 Subscribe 热路径,不批量
- `backends/src/lib.rs` — 协调器,持 `AuthApi + Arc<ConnectionManager>`,login/logout 命令串联两者,KICKED 后由桥接 task 主动调 `auth.logout()`

---

## 2. 关键设计决策(已锁定)

| #   | 决策                                                                                                  | 备选与理由                                                                                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Scope: Subscribe + Send + ConnectionManager**                                                       | Recall/AckRead/FetchHistory 留 Plan 4+;ConnectionManager 本身就是硬骨头,不再叠加 RPC                                                                                 |
| 2   | **3 状态机 `Connecting / Subscribed / Disconnected{last_error}`**                                     | 5 状态(分 Idle/Reconnecting)对 UI 价值低;2 状态损失体验                                                                                                              |
| 3   | **退避: base=1s factor=2 cap=15s full jitter**                                                        | 业界默认。500ms 太激进,2s/60s 太保守                                                                                                                                 |
| 4   | **Send 完全独立于 ConnectionManager**                                                                 | tonic Channel 内部已 reconnect;Subscribe 状态 ⊥ Send 可用性                                                                                                          |
| 5   | **Stream 错误完整分流**                                                                               | Unauthenticated→reactive refresh + 立即重连;Upgrade→terminate;Network/Internal→backoff;Storage→terminate;PermissionDenied 现走 Internal→backoff(Plan 4 再加 variant) |
| 6   | **Tauri 事件: 统一 `hub:event {kind, ...}` + `hub:connection {state, last_error}`**                   | 业务 event 一个名带 kind,新 kind 不改命令端;状态独立通道                                                                                                             |
| 7   | **ServerEvent kind: 仅 IncomingMsg + SystemSignal**                                                   | YAGNI,其余 5 种 wire-compat 可后加                                                                                                                                   |
| 8   | **since_seqs 持久化到 SQLite,UPSERT 单条不批量**                                                      | WAL + UPSERT 亚毫秒,聊天频率下 IO 闲置                                                                                                                               |
| 9   | **测试: 同进程 tonic Server,Auth + Hub 共用 SocketAddr**                                              | Plan 2 风格延续,`start_stub_full()` 新增,`start_stub()` 签名不变                                                                                                     |
| 10  | **生命周期入口: backends 层协调,而非 AuthApi 持 ConnectionManager**                                   | 模块边界清晰:AuthApi 不知 hub 存在;backends.login/logout 串联两者                                                                                                    |
| 11  | **KICKED 处理: ConnectionManager 只 emit + terminate;清会话由 backends 桥接 task 调 `auth.logout()`** | ConnectionManager 不知 keyring/SessionStore 存在,职责单一                                                                                                            |
| 12  | **broadcast 容量 256 + Lagged 触发重连**                                                              | 慢消费者下,reconnect 用 since_seqs 补漏(at-least-once + 前端 server_msg_id 去重)                                                                                     |

---

## 3. 文件布局变更

### 3.1 移动 / 新建

```
proto/chathub/v1/
  hub.proto         ← 修改: 加 Send/SendRequest/SendResponse
  event.proto       ← 修改: ServerEvent oneof body + IncomingMsg + SystemSignal
  message.proto     ← 不动(Plan 3 仍仅 text)

backends/crates/chathub-state/
  migrations/V2__seqs.sql     ← 新建
  src/seqs.rs                 ← 新建
  src/lib.rs                  ← 修改: pub mod seqs; pub use seqs::SeqStore;

backends/crates/chathub-net/
  src/hub.rs        ← 新建: HubClient + ConnectionManager + ConnectionState
                              + ExponentialBackoff + BackoffConfig + classify
  src/lib.rs        ← 修改: pub mod hub; pub use hub::*;
  tests/common/stub_relay.rs  ← 修改: + StubHub/StubHubState + start_stub_full
  tests/hub_e2e.rs  ← 新建: 9 个 e2e

backends/src/lib.rs ← 修改: setup 加桥接 + send_message/hub_state 命令
                            + login/logout 串 cm.start/stop
```

### 3.2 修改但保留主体

- `chathub-proto/build.rs` — 在已有 8 条 `type_attribute` 后追加 6 条(见 §4.3),proto 文件列表与 OUT_DIR 配置不动

### 3.3 不动

- `chathub-net/src/{auth,channel,error,interceptor,token}.rs` — Plan 2 全部保留(token.rs 加 1 个 `#[cfg(test)]` helper,见 §11 风险点 #6)
- `chathub-state/src/{pool,session,tokens}.rs` — Plan 2 全部保留
- `Cargo.toml` (workspace) — 无新 workspace 依赖
- `backends/Cargo.toml` — 仅 `+uuid`(已在 workspace.dependencies,只需在 backends 启用)

---

## 4. proto 增量

### 4.1 `proto/chathub/v1/hub.proto`

```proto
service Hub {
  rpc Subscribe(SubscribeRequest) returns (stream ServerEvent);
  rpc Send(SendRequest) returns (SendResponse);
}

message SubscribeRequest {
  map<string, int64> since_seqs = 1;  // wecom_account_id -> last_seq
}

message SendRequest {
  string wecom_account_id = 1;
  string conversation_id  = 2;
  string client_msg_id    = 3;   // UUIDv4,客户端生成,服务端幂等键
  MessageBody body        = 4;
}

message SendResponse {
  string server_msg_id = 1;
  int64  sent_at_ms    = 2;
}
```

### 4.2 `proto/chathub/v1/event.proto`

```proto
message ServerEvent {
  string wecom_account_id = 1;
  int64  seq              = 2;
  oneof body {
    IncomingMsg     incoming = 10;
    SystemSignal    system   = 90;
    // 11-89 留给 Plan 4+ 业务事件
    // 91-99 留给 Plan 4+ 系统信号扩展
  }
}

message IncomingMsg {
  string conversation_id = 1;
  string from_user_id    = 2;
  MessageBody body       = 3;
  int64  sent_at_ms      = 4;
  string server_msg_id   = 5;
  optional RemoteId remote = 6;
}

message SystemSignal {
  enum Kind {
    KIND_UNSPECIFIED = 0;
    KICKED           = 1;   // 服务端撤销凭证(其它设备登录、会话失效等)
    SERVER_DRAIN     = 2;   // 服务端正在重启 / 即将 GOAWAY,客户端预期重连
  }
  Kind   kind   = 1;
  string detail = 2;
}
```

### 4.3 `chathub-proto/build.rs` 增量

加 6 条 `type_attribute` 让前端可解码:

```rust
.type_attribute(".chathub.v1.ServerEvent",       "#[derive(serde::Serialize, serde::Deserialize)]")
.type_attribute(".chathub.v1.ServerEvent.Body",  "#[derive(serde::Serialize, serde::Deserialize)]")
.type_attribute(".chathub.v1.IncomingMsg",       "#[derive(serde::Serialize, serde::Deserialize)]")
.type_attribute(".chathub.v1.SystemSignal",      "#[derive(serde::Serialize, serde::Deserialize)]")
.type_attribute(".chathub.v1.SystemSignal.Kind", "#[derive(serde::Serialize, serde::Deserialize)]")
.type_attribute(".chathub.v1.SendResponse",      "#[derive(serde::Serialize, serde::Deserialize)]")
```

---

## 5. chathub-state 增量

### 5.1 `migrations/V2__seqs.sql`

```sql
CREATE TABLE IF NOT EXISTS wecom_account_seqs (
  wecom_account_id TEXT PRIMARY KEY,
  last_seq         INTEGER NOT NULL DEFAULT 0,
  updated_at_ms    INTEGER NOT NULL
);
```

### 5.2 `src/seqs.rs`

```rust
#[derive(Clone)]
pub struct SeqStore { pool: SqlitePool }

impl SeqStore {
    pub fn new(pool: SqlitePool) -> Self;

    /// 读全部 (account_id, last_seq) 拼成 since_seqs map
    pub async fn read_all(&self) -> Result<HashMap<String, i64>, StateError>;

    /// UPSERT 单条 — INSERT ... ON CONFLICT(wecom_account_id) DO UPDATE SET ...
    /// updated_at_ms 取 SystemTime::now()
    pub async fn upsert(&self, account_id: &str, seq: i64) -> Result<(), StateError>;

    /// 清空 — logout / 切租户场景
    pub async fn clear(&self) -> Result<(), StateError>;
}
```

`StateError` 沿用 Plan 2 已有 enum,无新 variant。

### 5.3 单元测试(`#[cfg(test)] mod tests`)

| 名称                                           | 验证                                              |
| ---------------------------------------------- | ------------------------------------------------- |
| `seq_store_upsert_then_read_all_round_trips`   | upsert 三条 → read_all 拿回三条,seq 值一致        |
| `seq_store_upsert_overwrites_existing_account` | 同一 account_id upsert 两次,read_all 拿后写入的值 |
| `seq_store_clear_empties_table`                | upsert 几条后 clear,read_all 返回空 map           |
| `seq_store_in_memory_pool_works`               | `SqlitePool::in_memory()` 上跑完整流程            |

---

## 6. chathub-net 增量

### 6.1 类型契约(`src/hub.rs` 公共 API)

```rust
#[derive(Clone)]
pub struct HubClient {
    inner: HubServiceClient<InterceptedService<Channel, AuthInterceptor>>,
}

impl HubClient {
    pub fn new(channel: Channel, interceptor: AuthInterceptor) -> Self;
    pub async fn send(&self, req: SendRequest) -> Result<SendResponse, AuthError>;
    pub(crate) async fn subscribe(
        &self,
        since_seqs: HashMap<String, i64>,
    ) -> Result<tonic::Streaming<ServerEvent>, AuthError>;
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum ConnectionState {
    Connecting,
    Subscribed,
    Disconnected { last_error: Option<AuthError> },
}

#[derive(Clone, Debug)]
pub struct BackoffConfig {
    pub base: Duration,
    pub factor: f64,
    pub cap: Duration,
}
impl Default for BackoffConfig {
    fn default() -> Self {
        Self { base: Duration::from_secs(1), factor: 2.0, cap: Duration::from_secs(15) }
    }
}

pub struct ConnectionManager {
    inner: Arc<Inner>,
}

impl ConnectionManager {
    pub fn new(
        hub: HubClient,
        token_store: Arc<TokenStore>,
        seq_store: SeqStore,
        backoff: BackoffConfig,
    ) -> Self;

    /// idempotent — 已活则 no-op,否则 spawn 后台 run_loop
    pub async fn start(&self);

    /// idempotent — abort task,不 await join
    pub async fn stop(&self);

    pub fn state_subscribe(&self) -> watch::Receiver<ConnectionState>;
    pub fn event_subscribe(&self) -> broadcast::Receiver<ServerEvent>;
}
```

### 6.2 状态机 + 后台循环

```
                 ┌─────────────────────────────────┐
                 │       start() 入口              │
                 └────────────────┬────────────────┘
                                  ▼
              ┌──────────────────────────────────┐
              │  Connecting                      │
              │  hub.subscribe(since_seqs).await │
              └─────────────────┬────────────────┘
                                │
            ┌───────────────────┼───────────────────┐
            ▼                   ▼                   ▼
       Ok(stream)          Err(transient)      Err(terminal)
            │                   │                   │
            ▼                   ▼                   ▼
   ┌──────────────┐     ┌──────────────┐    ┌──────────────┐
   │ Subscribed   │     │ Disconnected │    │ Disconnected │
   │              │     │ {last_error} │    │ {last_error} │
   │ select 循环  │     │ sleep(backoff│    │ ─→ task 退出 │
   └──────┬───────┘     │   .next())   │    └──────────────┘
          │             │  ─→ 回 Conn  │
          │             └──────────────┘
          ▼
   stream.next() → Some(Ok(event)):
       seq_store.upsert + event_tx.send → 继续
   stream.next() → Some(Err(status)) → classify:
     · Unauthenticated   → reactive_refresh + backoff.reset() → 回 Connecting
     · Upgrade/Storage   → Disconnected{Some(err)} + task 退出
     · Network/Internal  → Disconnected{Some(err)} + backoff
   stream.next() → None  → server close → backoff
   logged_out_rx.recv() → Disconnected{None} + task 退出
```

### 6.3 classify 函数

```rust
enum Action { ReactiveRefresh, Terminate, Backoff }

fn classify(err: &AuthError) -> Action {
    match err {
        AuthError::Unauthenticated         => Action::ReactiveRefresh,
        AuthError::UpgradeRequired { .. }  => Action::Terminate,
        AuthError::Network { .. }          => Action::Backoff,
        AuthError::Storage { .. }          => Action::Terminate,
        AuthError::Internal { .. }         => Action::Backoff,
    }
}
```

> **PermissionDenied** 当前在 `From<tonic::Status>` 走 fallback 归 `Internal`。Plan 3 不为它单加 variant,Plan 4 接 `EnableAccount/DisableAccount` 时再增 `AccountDisabled` 一并处理。

### 6.4 ExponentialBackoff

```rust
pub(crate) struct ExponentialBackoff {
    base: Duration,
    factor: f64,
    cap: Duration,
    attempt: u32,
}
impl ExponentialBackoff {
    pub fn new(base: Duration, factor: f64, cap: Duration) -> Self;

    /// delay = min(cap, base * factor^attempt) * rand_f64(0..1) -- full jitter
    /// attempt 饱和加,不溢出
    pub fn next(&mut self) -> Duration;

    pub fn reset(&mut self);
}
```

### 6.5 后台循环骨架(伪 Rust,实施时按此结构)

```rust
async fn run_loop(self: Arc<Inner>, mut logged_out_rx: broadcast::Receiver<LoggedOutReason>) {
    let mut backoff = ExponentialBackoff::new(self.backoff.base, self.backoff.factor, self.backoff.cap);

    'reconnect: loop {
        self.state_tx.send_replace(ConnectionState::Connecting);
        let since_seqs = self.seq_store.read_all().await.unwrap_or_default();

        let mut stream = match self.hub.subscribe(since_seqs).await {
            Ok(s) => s,
            Err(err) => match classify(&err) {
                Action::ReactiveRefresh => {
                    let _ = self.token_store.force_refresh().await;
                    backoff.reset();
                    continue 'reconnect;
                }
                Action::Terminate => {
                    self.state_tx.send_replace(ConnectionState::Disconnected { last_error: Some(err) });
                    return;
                }
                Action::Backoff => {
                    self.state_tx.send_replace(ConnectionState::Disconnected { last_error: Some(err) });
                    tokio::time::sleep(backoff.next()).await;
                    continue 'reconnect;
                }
            },
        };

        self.state_tx.send_replace(ConnectionState::Subscribed);
        backoff.reset();

        loop {
            tokio::select! {
                biased;
                _ = logged_out_rx.recv() => {
                    self.state_tx.send_replace(ConnectionState::Disconnected { last_error: None });
                    return;
                }
                msg = stream.message() => match msg {
                    Ok(Some(event)) => {
                        if let Err(e) = self.seq_store.upsert(&event.wecom_account_id, event.seq).await {
                            tracing::warn!(?e, "seq_store upsert failed, ignored on hot path");
                        }
                        let _ = self.event_tx.send(event);
                    }
                    Ok(None) => {
                        self.state_tx.send_replace(ConnectionState::Disconnected { last_error: None });
                        tokio::time::sleep(backoff.next()).await;
                        continue 'reconnect;
                    }
                    Err(status) => {
                        let err: AuthError = status.into();
                        match classify(&err) {
                            Action::ReactiveRefresh => {
                                let _ = self.token_store.force_refresh().await;
                                backoff.reset();
                                continue 'reconnect;
                            }
                            Action::Terminate => {
                                self.state_tx.send_replace(ConnectionState::Disconnected { last_error: Some(err) });
                                return;
                            }
                            Action::Backoff => {
                                self.state_tx.send_replace(ConnectionState::Disconnected { last_error: Some(err) });
                                tokio::time::sleep(backoff.next()).await;
                                continue 'reconnect;
                            }
                        }
                    }
                }
            }
        }
    }
}
```

---

## 7. 异步 / 性能 / 安全考量

### 7.1 task 生命周期 — Arc 切分

`ConnectionManager(Arc<Inner>)`,后台 task 仅持 `Arc<Inner>`,**绝不**反持外层 — 0 引用环。

`start()` 幂等:进 task lock,检查 `as_ref().is_some_and(|h| !h.is_finished())`,活则 no-op。**先**调 `token_store.logged_out_subscribe()`(broadcast.subscribe 只看后续事件),**再** spawn,保证 LoggedOut 不丢。

`stop()` 用 `JoinHandle::abort()`,不 await join。tokio task abort 是 cooperative — 当前 await 点(SQLite 查询、stream.message)收到 cancel 后立即返回 `JoinError::Cancelled`。**SQLite WAL 保证未提交事务直接丢弃,无数据损坏**。已 broadcast 的 event 不回滚(at-least-once 由消费者去重)。

### 7.2 跨 await 持锁审计

| 锁                                        | 性质      | 跨 await?                                               |
| ----------------------------------------- | --------- | ------------------------------------------------------- |
| `parking_lot::RwLock<Option<TokenState>>` | sync      | **严禁**。Plan 2 已审计,Plan 3 沿用,run_loop 内不直接持 |
| `tokio::Mutex<Option<JoinHandle>>` (task) | async     | 可。仅 start/stop 短暂持有                              |
| `tokio::Mutex<()>` (refresh_lock)         | async     | 可。Plan 3 不接触,force_refresh 内部用                  |
| watch / broadcast / mpsc                  | lock-free | N/A                                                     |

**关键 invariant**: `force_refresh` 调用前必须不持有任何锁 — 否则与 refresh_lock 死锁。code review 时显式检查。

### 7.3 broadcast Lag 处理

`event_tx` 容量 = 256。慢消费者收到 `RecvError::Lagged(n)` 时,backends 桥接 task **不直接报错**,而是:

```rust
Err(broadcast::error::RecvError::Lagged(n)) => {
    tracing::warn!(skipped = n, "hub event lag, requesting reconnect");
    cm.stop().await;
    cm.start().await;
}
```

依赖 since_seqs 让服务端补漏。**节流**: 5s 窗口最多触发 1 次 reconnect,防止 lag 风暴下死循环 — 用 `Mutex<Option<Instant>>` 在桥接 task 内自行实现。

### 7.4 SeqStore.upsert 在热路径

每个 ServerEvent 一次 UPSERT。WAL + UPSERT 单条 ~200μs(本地 NVMe);聊天典型 < 100 events/s/account → CPU/IO 闲置。**不**做批量(YAGNI)。

异常处理: `Err(_)` 时**只 log,不 propagate**。run_loop 不把 SeqStore 错误当 Subscribe 错误对待 — classify 只看 Subscribe RPC 自身错误。

### 7.5 安全

| 项                       | 处理                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `client_msg_id` 来源     | 前端生成 UUIDv4。客户端 `send_message` 命令内部生成,前端无法注入。`(wecom_account_id, client_msg_id)` 幂等键由服务端验证                    |
| `wecom_account_id` ACL   | 客户端不防御,Relay 拒 → PermissionDenied → classify 当前归 Internal → backoff(暂时行为,Plan 4 改 Terminate)                                 |
| access token 注入        | `AuthInterceptor` (Plan 2) 处理。token 永不在 ServerEvent / SendRequest 中流转                                                              |
| `hub:event` payload 通道 | Tauri IPC 进程内,不出网。无暴露风险                                                                                                         |
| `KICKED` 处理            | run_loop emit + state→Disconnected{None} + return;backends 桥接 task 识别 → 调 `auth.logout()` 清 keyring + SQLite + emit `auth:logged_out` |

### 7.6 资源 leak 防护

- **Arc 环**: ConnectionManager → Arc<Inner>;Inner 不反持外层 → 0 环
- **task leak**: stop() 用 abort 而非只 drop handle → task 立即停在下一个 await 点
- **broadcast/watch sender drop**: Inner drop 时 sender drop,所有 receiver 收 Closed → 自然 cleanup
- **tonic Channel drop**: HubClient.inner 持 channel,drop 触发 HTTP/2 GOAWAY,服务端清理 stream

### 7.7 优雅 shutdown

Tauri `RunEvent::ExitRequested`:

```rust
.run(|app, event| {
    if let RunEvent::ExitRequested { .. } = event {
        if let Some(cm) = app.try_state::<Arc<ConnectionManager>>() {
            tauri::async_runtime::block_on(cm.stop());
        }
    }
});
```

`SqlitePool` 由 `Drop` 关闭,WAL 自动 checkpoint。

---

## 8. backends 集成

### 8.1 setup 阶段拼装

```rust
.setup(|app| {
    let pool = block_on(SqlitePool::open(db_path))?;
    let keyring = KeyringTokenStore::new("com.example.chathub")?;
    let endpoint = build_endpoint(RELAY_URL)?;
    let channel  = endpoint.connect_lazy();

    // Plan 2
    let token_store = Arc::new(TokenStore::new(endpoint.clone(), keyring)?);
    let session_store = SessionStore::new(pool.clone());
    let auth_api = AuthApi::new(token_store.clone(), session_store);

    // Plan 3
    let interceptor = AuthInterceptor::new(token_store.clone());
    let hub_client  = HubClient::new(channel, interceptor);
    let seq_store   = SeqStore::new(pool);
    let conn_manager = Arc::new(ConnectionManager::new(
        hub_client.clone(), token_store.clone(), seq_store, BackoffConfig::default(),
    ));

    app.manage(auth_api.clone());
    app.manage(hub_client);
    app.manage(conn_manager.clone());

    spawn_resume(auth_api.clone(), conn_manager.clone(), app.handle().clone());
    spawn_logged_out_bridge(auth_api.clone(), app.handle().clone());
    spawn_hub_event_bridge(conn_manager.clone(), app.handle().clone());
    spawn_hub_connection_bridge(conn_manager.clone(), app.handle().clone());
    Ok(())
})
```

### 8.2 Tauri 命令(修订 + 新增)

```rust
// 修订:login 成功后启动 ConnectionManager
#[tauri::command]
async fn login(
    auth: State<'_, AuthApi>,
    cm:   State<'_, Arc<ConnectionManager>>,
    username: String, password: String,
) -> Result<UserProfile, AuthError> {
    let profile = auth.login(&username, &password).await?;
    cm.start().await;
    Ok(profile)
}

// 修订:logout 前先 stop ConnectionManager
#[tauri::command]
async fn logout(
    auth: State<'_, AuthApi>,
    cm:   State<'_, Arc<ConnectionManager>>,
) -> Result<(), AuthError> {
    cm.stop().await;
    auth.logout().await
}

// Plan 3 新增
#[tauri::command]
async fn send_message(
    hub: State<'_, HubClient>,
    wecom_account_id: String,
    conversation_id: String,
    text: String,
) -> Result<SendResponse, AuthError> {
    let req = SendRequest {
        wecom_account_id,
        conversation_id,
        client_msg_id: uuid::Uuid::new_v4().to_string(),
        body: Some(MessageBody {
            kind: Some(message_body::Kind::Text(TextBody { text })),
            reply_to: None, mentions: vec![],
        }),
    };
    hub.send(req).await
}

#[tauri::command]
async fn hub_state(cm: State<'_, Arc<ConnectionManager>>) -> ConnectionState {
    cm.state_subscribe().borrow().clone()
}
```

### 8.3 事件桥接

**hub:event** — broadcast → app.emit + KICKED 识别 + Lagged 节流 reconnect:

```rust
fn spawn_hub_event_bridge(cm: Arc<ConnectionManager>, app: AppHandle) {
    let mut rx = cm.event_subscribe();
    let last_lag_reconnect = Arc::new(tokio::sync::Mutex::new(None::<Instant>));
    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(event) => {
                    let _ = app.emit("hub:event", &event);
                    if matches!(&event.body, Some(server_event::Body::System(s))
                                if s.kind == system_signal::Kind::Kicked as i32) {
                        if let Some(auth) = app.try_state::<AuthApi>() {
                            let _ = auth.logout().await;
                        }
                        let _ = app.emit("auth:logged_out", LoggedOutReason::Kicked);
                    }
                }
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    let mut last = last_lag_reconnect.lock().await;
                    let now = Instant::now();
                    if last.map_or(true, |t| now.duration_since(t) > Duration::from_secs(5)) {
                        tracing::warn!(skipped = n, "hub event lag, requesting reconnect");
                        cm.stop().await;
                        cm.start().await;
                        *last = Some(now);
                    } else {
                        tracing::warn!(skipped = n, "hub event lag throttled");
                    }
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}
```

**hub:connection** — watch → app.emit:

```rust
fn spawn_hub_connection_bridge(cm: Arc<ConnectionManager>, app: AppHandle) {
    let mut rx = cm.state_subscribe();
    tauri::async_runtime::spawn(async move {
        let _ = app.emit("hub:connection", &*rx.borrow());  // 主动 emit 初始态
        while rx.changed().await.is_ok() {
            let s = rx.borrow().clone();
            let _ = app.emit("hub:connection", &s);
        }
    });
}
```

### 8.4 try_resume_session 串联

```rust
fn spawn_resume(auth_api: AuthApi, cm: Arc<ConnectionManager>, app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        match auth_api.try_resume_session().await {
            Ok(Some(profile)) => {
                let _ = app.emit("auth:resumed", &profile);
                cm.start().await;          // ← Plan 3 加:复活后立刻连
            }
            Ok(None) => {}
            Err(e)   => { tracing::error!(?e, "resume failed"); }
        }
    });
}
```

---

## 9. 测试方案

### 9.1 stub Relay 扩展

```rust
// tests/common/stub_relay.rs

// Plan 2 兼容(签名不变)
pub async fn start_stub() -> (SocketAddr, Arc<Mutex<StubAuthState>>, JoinHandle<()>);

// Plan 3 新增
pub async fn start_stub_full() -> (
    SocketAddr,
    Arc<Mutex<StubAuthState>>,
    Arc<Mutex<StubHubState>>,
    JoinHandle<()>,
);
```

`start_stub_full` 同进程 tonic Server 注册 `AuthServer + HubServer`,共用 SocketAddr。`start_stub` 内部转调并丢弃 hub_state,保证 Plan 2 7 个 e2e 0 改动。

```rust
pub struct StubHubState {
    pub subscribes: Vec<HashMap<String, i64>>,           // 客户端发来的 since_seqs 历史
    pub event_tx: Option<mpsc::Sender<Result<ServerEvent, Status>>>, // 当前活跃 stream 的 tx
    pub send_outcome: Outcome<SendResponse>,             // Send 默认返回
    pub sends: Vec<SendRequest>,                         // 客户端发来的 SendRequest 历史
    pub subscribe_outcome: SubscribeOutcome,             // Subscribe 初始策略
}

pub enum SubscribeOutcome {
    Stream,                    // 默认 — 创建 mpsc,等测试 inject
    Reject(Status),            // 直接 Err
}

pub enum Outcome<T> {
    Ok(T),
    Status(Status),
}
```

### 9.2 e2e 场景(`tests/hub_e2e.rs`)

| #   | 名称                                               | 路径                                                                                                                                              |
| --- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `subscribe_success_streams_event`                  | stub 推 1 IncomingMsg → broadcast 收到 + state Connecting→Subscribed                                                                              |
| 2   | `subscribe_resumes_with_since_seqs`                | 收 event(seq=10) → stop()/start() → stub 第二次 subscribe 拿到 `since_seqs={"wxa1":10}`                                                           |
| 3   | `subscribe_unauthenticated_triggers_force_refresh` | stub 一开始 Reject(Unauthenticated) → force_refresh → stub 切 Stream → state 走完不退避                                                           |
| 4   | `subscribe_unavailable_backoffs_and_reconnects`    | stub Reject(Unavailable) → 退避 → 切 Stream → 第二次成功;断言 backoff.attempt ≥ 1                                                                 |
| 5   | `subscribe_upgrade_required_terminates`            | stub Reject(FailedPrecondition + UpgradeRequired details) → state=Disconnected{Some(UpgradeRequired)} → sleep 200ms 后 task `is_finished()==true` |
| 6   | `logged_out_during_subscribe_terminates_task`      | 已 Subscribed → token_store.\_emit_logged_out_for_test(RefreshFailed) → task 退出,state→Disconnected{None}                                        |
| 7   | `subscribe_kicked_emits_event_then_terminates`     | stub 推 SystemSignal::KICKED → broadcast 收到 → state→Disconnected{None} → task 退出(后续 logout 由 backends,不在本测试)                          |
| 8   | `send_success_returns_server_msg_id`               | Send 走 channel,stub 返回 SendResponse → 拿到 server_msg_id;断言 stub 收到的 client_msg_id 是合法 UUID                                            |
| 9   | `send_unavailable_returns_network_error`           | stub send_outcome=Status(Unavailable) → 客户端 Send 拿 AuthError::Network                                                                         |

### 9.3 单元测试

`chathub-net/src/hub.rs` `#[cfg(test)] mod tests`:

| 名称                                                | 验证                                                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `exponential_backoff_first_call_within_1x_base`     | base=1s, attempt=0 → next() ∈ [0, 1s]                                                             |
| `exponential_backoff_caps_at_cap`                   | attempt 大到不行,next() ≤ cap                                                                     |
| `exponential_backoff_reset_zeroes_attempt`          | reset 后 next() 又回 [0, base]                                                                    |
| `classify_unauthenticated_returns_reactive_refresh` | match Action::ReactiveRefresh                                                                     |
| `classify_upgrade_required_returns_terminate`       | match Action::Terminate                                                                           |
| `classify_network_returns_backoff`                  | match Action::Backoff                                                                             |
| `classify_storage_returns_terminate`                | match Action::Terminate                                                                           |
| `connection_state_serializes_kebab_case_tag`        | `{"state":"connecting"}` / `{"state":"subscribed"}` / `{"state":"disconnected","last_error":...}` |

### 9.4 测试工具(`tests/common/mod.rs`)

```rust
// 等到 ConnectionState 满足谓词,带超时
pub async fn wait_for_state(
    rx: &mut watch::Receiver<ConnectionState>,
    pred: impl Fn(&ConnectionState) -> bool,
    timeout: Duration,
) -> ConnectionState;

// 推 event / status 到当前活跃 stream
pub async fn push_event(stub: &Arc<Mutex<StubHubState>>, event: ServerEvent);
pub async fn push_status(stub: &Arc<Mutex<StubHubState>>, s: Status);
```

### 9.5 测试加速

`BackoffConfig { base: 10ms, factor: 2.0, cap: 150ms }` — Plan 3 e2e 全部用此,任意单测 < 1s 完成。

### 9.6 测试覆盖目标

- e2e: 9(Plan 3)+ 7(Plan 2 不变)= 16
- 单元: 8(hub.rs)+ 4(seqs.rs)+ 5(error.rs Plan 2)+ 7(token.rs Plan 2)+ ... ≥ 24
- 总数: chathub-net 至少 25 + chathub-state 至少 12

---

## 10. Definition of Done

| #   | 验收项                                                                             | 验证                                                              |
| --- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1   | proto 加 Send + IncomingMsg + SystemSignal                                         | `cargo build --workspace` 成功 + buf lint 0 错(由 proto.yml CI)   |
| 2   | chathub-state V2 migration + SeqStore                                              | `cargo test -p chathub-state` 12 测试绿(原 8 + 新 4)              |
| 3   | chathub-net hub.rs (HubClient + ConnectionManager + ExponentialBackoff + classify) | `cargo test -p chathub-net --lib` ≥ 20 测试绿                     |
| 4   | 9 个 e2e 场景全绿                                                                  | `cargo test -p chathub-net --test hub_e2e` 9/9                    |
| 5   | Plan 2 的 7 个 auth e2e 不破                                                       | `cargo test -p chathub-net --test auth_e2e` 7/7                   |
| 6   | backends 加 send_message + hub_state 命令 + 2 个事件桥接 + KICKED→logout 联动      | `cargo build` + 桥接代码 review                                   |
| 7   | clippy 全绿                                                                        | `cargo clippy --workspace -- -D warnings` 0 warn                  |
| 8   | Cargo.lock 一致                                                                    | `cargo build` 后 lockfile diff 仅含 +uuid(若 backends 之前未启用) |

---

## 11. 风险点与缓解

| #   | 风险                                            | 触发                              | 缓解                                                            |
| --- | ----------------------------------------------- | --------------------------------- | --------------------------------------------------------------- |
| 1   | broadcast Lagged 引发死循环 reconnect           | 慢消费者持续 lag → stop/start 抖  | 桥接 task 内 5s 节流(8.3 已写)                                  |
| 2   | SeqStore.upsert 偶发 IO 异常被当 Subscribe 错误 | classify 错误归类                 | run_loop 显式 `if let Err(e) = upsert { warn };` 吞错(6.5 已写) |
| 3   | force_refresh 与 refresh_lock 死锁              | run_loop 持有锁后调 force_refresh | run_loop 内部从不持锁;code review 显式检查                      |
| 4   | LoggedOut 事件丢失                              | broadcast.subscribe 在 spawn 之后 | start() 内**先** subscribe **后** spawn(7.1 已写)               |
| 5   | Tauri `RunEvent::ExitRequested` 时 cm 已 drop   | 顺序问题                          | 用 `app.try_state` 而非 unwrap,允许 None(7.7 已写)              |
| 6   | 测试 #6 无法主动 emit LoggedOut                 | TokenStore 无 force_logout        | 加 `_emit_logged_out_for_test(reason)`,`#[cfg(test)]` gated     |
| 7   | stub Auth + stub Hub 端口冲突                   | 两个 service                      | 同 server 多 service,无冲突;`start_stub_full` 已设计            |
| 8   | Tauri 桥接 task 与 cm 形成 cycle                | task 持 cm                        | 桥接 task 是 detached spawn,task 退出 drop cm clone — 无环      |

---

## 12. 与 Plan 4+ 的接口承诺

Plan 3 落地后,以下契约 **Plan 4+ 永远稳定**(改需 SemVer 决议):

- `ConnectionState` 三 variant 不变;新加状态需 minor bump
- `hub:event` payload schema 不变;新增 ServerEvent kind 是 wire-compat 的
- `hub:connection` payload schema 不变;ConnectionState serde tag 不变
- `HubClient::send` 签名不变;`SendRequest/SendResponse` 字段只增不删
- `SeqStore` 公共 API(`new / upsert / read_all / clear`)稳定;V3+ migration 可加列不删 V2 列
- backends 命令 `send_message / hub_state` 签名稳定
- `BackoffConfig::default()` 数值即生产值,改需 major bump

---

## 13. 与 Plan 3 不在范围的连接点

Plan 4 接 `Recall / AckRead / FetchHistory` 时:

- 只在 `hub.proto` 加 RPC + 在 `HubClient` 加方法,**不**触碰 ConnectionManager
- ServerEvent 加 `MessageRecalled / ReadReceipt / MessageStatusChange` kind — wire-compat
- 桥接 task 0 改动(payload 透传)

Plan 5 接 `MessageBody` 媒体扩展时:

- 只改 `message.proto` 加 oneof 变体 — wire-compat
- backends `send_message` 命令需要扩展或重构(Plan 5 决策)

Plan 6 接可靠性增强时:

- Send 加本地排队 / 持久化重试 — 在 `HubClient` 之上加一层 `SendQueue`,不动 HubClient
- broadcast 容量调优 + 优先级队列 — 在 ConnectionManager 内部演化

---

End of spec.
