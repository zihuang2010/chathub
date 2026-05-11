# Plan 5 — chathub-relay Walking Skeleton 设计规范

**日期**: 2026-05-11
**版本**: v1.0
**状态**: 已批准(brainstorming + plan agent 评审)
**协议层依据**: Plan 1-4 已合入 main。本 spec 不重复 Plan 1-4 决策。

---

## 1. Context

Plan 1-4 已经把 **Tauri 客户端侧的协议层** 全部走通(login / refresh / Subscribe 长连接 / Send / Recall / AckRead / FetchHistory + 5 个 ServerEvent kind),客户端 e2e 通过 `stub_relay.rs` mock 服务器侧验证。但 **远端 Relay/网关本身没有任何代码**:`backends/crates/` 下 4 个 crate(`chathub-proto` / `chathub-state` / `chathub-net` / `backends` Tauri bin)全是客户端侧。

Plan 5 的目标是**起一个 Rust gRPC 网关**(Relay),完成 client ↔ relay ↔ stub-downstream ↔ back 端到端走通。

### 1.1 架构总览

```
+-----------------------+         +-------------------------------+         +--------------------+
| Tauri Client (React)  |         | chathub-relay (Rust gRPC)     |  HTTP   | 下游业务系统       |
|  - HubClient          | <-gRPC->|  - AuthService                | <-----> | (Plan 6+ 实现)     |
|  - Subscribe stream   |         |  - HubService                 |         |  - /v1/verify_user |
|  - JWT Bearer         |         |  - JwtSigner (Ed25519)        |         |  - /v1/send        |
|  - SeqStore           |         |  - ConnectionRouter           |         |  - /v1/recall      |
+-----------------------+         |  - SeqAllocator(SQLite)       |         |  - /v1/ack_read    |
                                  |  - Events ring buffer         |         |  - /v1/fetch_hist  |
                                  |  - axum POST /internal/push   |<--------|  Relay push:       |
                                  |    (Bearer secret)            |         |  POST /push        |
                                  +-------------------------------+         +--------------------+
```

Relay 是**协议翻译 + 长连接路由网关**,**不是 IM backbone**:

- 不实现业务逻辑(下游做)
- 维护 session/refresh_token 持久化 + per-account 单调 seq + bounded 事件 ring buffer 用于断线重连 replay
- 只管"现在在线的人传话"

### 1.2 显式排除(留 Plan 6+)

- 下游业务系统本体(Plan 5 只定义 HTTP 合约 + e2e 用 wiremock mock)
- 前端 React 接线
- 媒体消息扩展(MessageBody 仍只 text)
- 多 Relay 实例 / 横向扩展 / 跨实例 stream 路由(单实例 in-process 路由表)
- 监控/告警/Prometheus / OpenTelemetry(只留 tracing 桩)
- mTLS / 证书管理
- Push 失败的持久化重试队列(skeleton fire-and-forget)
- Send 的 `STATUS_FAILED` 路径(需客户端映射表,Plan 6+ 配套)

### 1.3 预期交付

- 1 个 feature branch:`feature/0511/relay-walking-skeleton`
- **24 个 TDD task**,详见同 plans 目录下 task 文档
- DOD = `chathub-relay` workspace test/clippy 全绿 + 7 个 relay_e2e + Plan 1-4 客户端 e2e 不破(68 tests)

---

## 2. 关键设计决策(11 条)

| #   | 决策                                                                                                       | 备选与理由                                                                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **形态:Walking Skeleton** — 端到端走通(client → relay → stub downstream → back)                            | 一次端到端比 RPC-by-RPC 更早暴露集成问题                                                                                                                                                                                                         |
| 2   | **Tech stack:Rust,同 Cargo workspace,新增 `chathub-relay` crate**                                          | 复用 `chathub-proto` 编出的 server stub(`build_server(true)` 已开);client/server 同源 proto                                                                                                                                                      |
| 3   | **JWT 签发算法:Ed25519(EdDSA),替代 Plan 2 spec 的 RS256**                                                  | 客户端 `parse_upgrade_required` (`chathub-net/src/error.rs:75`) 不校验 alg/kid,wire-compat;Ed25519 密钥 32B vs RS256 PEM ~2KB,签快 ~10×、验快 ~30%;`jsonwebtoken=9` 同 API 支持 EdDSA。**降级条款**:若 Plan 6+ 要做 JWKS endpoint,届时再切回 RSA |
| 4   | **JWT Claims:`{iss, sub:user_id, exp, iat, accounts:Vec<String>, device_id}`**                             | `device_id` 必须 — 同 user 同 device 重连不能自踢;`accounts` 是 issue 时快照(变化由 Plan 6+ AccountStatus event 通知)                                                                                                                            |
| 5   | **Push 路由键:`wecom_account_id` 单 key**                                                                  | 1 user = 1 Tauri = 1 stream,stream 内 demux 多账号;客户身份(conversation_id / from_user_id)在 event payload 里,客户端 frontend 分发                                                                                                              |
| 6   | **多端同 user 不同 device → `SystemSignal::KIND_KICKED`**                                                  | proto 已支持;企微客服员工不该多端同时在线;`device_id` 区分自重连 vs 真的多端                                                                                                                                                                     |
| 7   | **Push 接口认证:共享 Bearer secret** `RELAY_PUSH_SECRET` env                                               | 简单零开销;生产可换 mTLS,Plan 6+ 不在本 spec                                                                                                                                                                                                     |
| 8   | **下游 HTTP 合约 spec-only,不写 binary**                                                                   | 节省 ~8-10 task;e2e 用 `wiremock` in-process mock 模拟下游                                                                                                                                                                                       |
| 9   | **持久化:SQLite 四表 — `sessions` / `events` ring(每 account ≤ 1000 条)/ `seq_counters` / `kv`(JWT 密钥)** | refresh_token 用 `HMAC-SHA256(pepper, token)` 存哈希(**不用 argon2** — refresh 是热路径,opaque 高熵 token 无需慢哈希)                                                                                                                            |
| 10  | **拦截器拆分:`AuthService` 不验 JWT,`HubService` 必验 + `chathub-protocol-version` 校验**                  | 镜像客户端 `interceptor.rs`(只对 Hub 发 Bearer);Server 端 per-service interceptor                                                                                                                                                                |
| 11  | **Replay 在 register 之前完成**                                                                            | 否则 replay 与 fanout 竞态破坏 per-account 单调 seq(客户端 `hub.rs:298` SeqStore upsert 依赖严格升序);Subscribe 期间到达的 push 等下次 reconnect 兜底                                                                                            |

---

## 3. 文件布局

### 3.1 新建

```
backends/crates/chathub-relay/
├── Cargo.toml
├── README.md                       # env 矩阵 + curl 示例
├── migrations/
│   └── 001_initial.sql             # sessions / seq_counters / events / kv 四表
├── src/
│   ├── main.rs                     # tokio main + tokio::select! { tonic, axum, ctrl_c }
│   ├── lib.rs                      # pub mod re-export;pub fn build_app() for tests
│   ├── error.rs                    # RelayError + From + into tonic::Status(sanitize)
│   ├── config.rs                   # Config::from_env(12 env vars)
│   ├── jwt.rs                      # Signer / Verifier(Ed25519);Claims;bootstrap
│   ├── router.rs                   # ConnectionRouter(parking_lot::RwLock<HashMap>)
│   ├── downstream.rs               # DownstreamClient(reqwest);5 个 HTTP 方法
│   ├── push.rs                     # axum router: POST /internal/push + GET /healthz
│   ├── auth_service.rs             # impl Auth for AuthSvc
│   ├── hub_service.rs              # impl Hub for HubSvc + JwtAuthInterceptor
│   └── storage/
│       ├── mod.rs                  # Storage(deadpool_sqlite::Pool)
│       ├── migrations.rs           # rusqlite_migration M::up
│       ├── sessions.rs             # upsert / find_by_refresh_hash / delete / mark_kicked
│       ├── seqs.rs                 # next_seq(UPDATE...RETURNING)
│       ├── events.rs               # record + replay_after + ring 修剪
│       └── kv.rs                   # 单行 KV 表
└── tests/
    ├── common/
    │   └── mod.rs                  # RelayHarness + spawn_relay + mint_jwt helper
    └── relay_e2e.rs                # 7 个 e2e 场景
```

### 3.2 修改

```
Cargo.toml                                  # workspace.members + workspace.dependencies 追加
backends/crates/chathub-proto/build.rs      # 不动(build_server(true) 已开,Plan 1-4 已用)
```

### 3.3 不动(锁,Plan 1-4 客户端 wire-compat 资产)

```
backends/crates/chathub-{net,state,proto}/    # 客户端 / state / proto codegen 全锁
backends/src/                                  # Tauri commands 不动
proto/chathub/v1/*.proto                       # proto 合约不动(only-add 时机不在本 plan)
frontends/                                     # 前端不动
```

---

## 4. proto 合约(不动)

Plan 5 **不增加 proto**。所有 RPC + ServerEvent + Message 都已由 Plan 1-4 锁定:

```protobuf
service Auth {
  rpc Login(LoginRequest) returns (LoginResponse);
  rpc RefreshToken(RefreshTokenRequest) returns (RefreshTokenResponse);
  rpc Logout(LogoutRequest) returns (LogoutResponse);
}

service Hub {
  rpc Subscribe(SubscribeRequest) returns (stream ServerEvent);
  rpc Send(SendRequest) returns (SendResponse);
  rpc Recall(RecallRequest) returns (RecallResponse);
  rpc AckRead(AckReadRequest) returns (AckReadResponse);
  rpc FetchHistory(FetchHistoryRequest) returns (FetchHistoryResponse);
}

ServerEvent.body oneof:
  IncomingMsg          incoming      = 10;
  MessageRecalled      recalled      = 11;
  ReadReceipt          read_receipt  = 12;
  MessageStatusChange  status_change = 13;
  SystemSignal         system        = 90;
```

Relay 必须 server-side 实现全部 8 个 RPC。

---

## 5. SQLite Schema(`migrations/001_initial.sql`)

```sql
-- 客户端 session(对应 Plan 2 的 AuthService)
CREATE TABLE sessions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  refresh_token_hash TEXT NOT NULL UNIQUE,    -- HMAC-SHA256(pepper, token)
  refresh_exp_ms INTEGER NOT NULL,
  kicked_at_ms INTEGER,                       -- tombstone;非空 → refresh 返回 Unauthenticated
  created_at_ms INTEGER NOT NULL,
  UNIQUE(user_id, device_id)                  -- 同 user 同 device 单 session
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- per-account 单调递增 seq 计数器(Plan 1-4 客户端 SeqStore 依赖)
CREATE TABLE seq_counters(
  wecom_account_id TEXT PRIMARY KEY,
  next_seq INTEGER NOT NULL DEFAULT 1
);

-- 事件 ring buffer(支持 Subscribe 断线重连 since_seqs replay)
CREATE TABLE events(
  wecom_account_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  payload BLOB NOT NULL,                      -- prost-encoded ServerEvent
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(wecom_account_id, seq)
);

-- 单行 KV 表(JWT 私钥 PEM / kid)
CREATE TABLE kv(
  key TEXT PRIMARY KEY,
  value BLOB NOT NULL
);
```

Ring buffer 修剪策略:每次 `events.record` 后执行 `DELETE FROM events WHERE wecom_account_id=? AND seq <= ?-1000`。

---

## 6. JWT Claims 与签发流程

### 6.1 Claims 结构

```rust
#[derive(Serialize, Deserialize)]
pub struct Claims {
    pub iss: String,             // "chathub-relay"(配置项 RELAY_ISSUER)
    pub sub: String,             // user_id(来自下游 /v1/verify_user)
    pub exp: i64,                // unix seconds
    pub iat: i64,
    pub accounts: Vec<String>,   // wecom_account_ids 快照(发放时)
    pub device_id: String,       // 来自 login 请求,多端区分键
}
// kid 在 JWT header,不在 claims
```

### 6.2 Signer/Verifier

- 算法:Ed25519(EdDSA)
- 密钥:bootstrap 时 env `RELAY_JWT_PRIVATE_PEM` 有则用,否则 `ring` 生成新 keypair → 入 `kv` 表持久化
- TTL:access 1800s(配置 `RELAY_ACCESS_TTL_SECS`);refresh 30d(`RELAY_REFRESH_TTL_SECS`)
- `jsonwebtoken=9` 已支持 EdDSA(`EncodingKey::from_ed_pem` / `DecodingKey::from_ed_pem`)

### 6.3 login 流程

```
Client AuthService.Login(username, password, device_id, device_name)
  → Relay.AuthSvc::login:
      1. downstream POST /v1/verify_user → (user_id, accounts, ...)
      2. 生成 32-byte 高熵 refresh_token(opaque)
      3. HMAC-SHA256(pepper, refresh_token) → refresh_token_hash
      4. sessions.upsert(user_id, device_id, hash, exp)
      5. Signer.sign(user_id, accounts, device_id) → access_token JWT
      6. 返回 LoginResponse { access_token, refresh_token, user_profile, accounts, access_exp_ms }
```

### 6.4 refresh 流程

```
Client AuthService.RefreshToken(refresh_token)
  → Relay.AuthSvc::refresh_token:
      1. HMAC(pepper, token) → hash
      2. sessions.find_by_refresh_hash(hash) → Option<Session>
      3. session.kicked_at_ms 非空 → Status::Unauthenticated
      4. session.refresh_exp_ms < now → Status::Unauthenticated
      5. 生成新 refresh_token + hash;旧的 sessions.delete(hash) + 新的 upsert
      6. 新 access JWT(从 session 取回 device_id;accounts 从下游重拉?Plan 5 暂用 session 上次快照)
```

### 6.5 logout 流程

```
Client AuthService.Logout(refresh_token)
  → Relay.AuthSvc::logout:
      1. HMAC(pepper, token) → hash
      2. sessions.delete(hash)(best-effort,delete-by-hash 不报错)
      3. 返回 LogoutResponse {}
```

---

## 7. ConnectionRouter + KICKED 状态机

### 7.1 数据结构

```rust
// router.rs
pub struct Router {
    accounts: RwLock<HashMap<String /* wecom_account_id */, ChannelEntry>>,
    users:    RwLock<HashMap<String /* user_id */,         UserStream>>,
}

struct ChannelEntry {
    tx: mpsc::Sender<Result<ServerEvent, Status>>,
    user_id: String,
    device_id: String,
}

struct UserStream {
    device_id: String,                       // 当前 device,KICKED 判定用
    accounts: Vec<String>,                   // 该 user 持有的 wecom_account_ids
    tx: mpsc::Sender<Result<ServerEvent, Status>>,
}
```

(用 `parking_lot::RwLock<HashMap>`,不引入 dashmap — workspace 已有 parking_lot,锁竞争只在 Subscribe / push,不在百万 QPS 热路径。)

### 7.2 register 流程(Subscribe 触发)

```rust
fn register(&self, t: StreamTicket, tx: mpsc::Sender<...>) -> Vec<mpsc::Sender<...>> {
    let mut prev = vec![];
    let mut users = self.users.write();
    let mut accounts = self.accounts.write();

    // 1. KICKED 判定
    if let Some(existing) = users.get(&t.user_id) {
        if existing.device_id != t.device_id {
            // 真的多端:踢前一个
            prev.push(existing.tx.clone());
            for acc in &existing.accounts {
                accounts.remove(acc);
            }
        } else {
            // 同 device_id 自重连:踢前一个(replace),不算 KICKED
            for acc in &existing.accounts {
                accounts.remove(acc);
            }
        }
    }

    // 2. 注册新
    users.insert(t.user_id.clone(), UserStream { ... });
    for acc in &t.accounts {
        accounts.insert(acc.clone(), ChannelEntry { tx: tx.clone(), ... });
    }
    prev
}
```

调用方(`HubSvc::subscribe`)拿到 `prev` 后:

- 多端踢:给每个 prev sender `send(Ok(SystemSignal::KIND_KICKED))` + drop sender(stream 自然 EOF)
- 自重连:仅 drop prev sender(stream EOF,新 stream 立刻起)

### 7.3 fanout 流程(push 触发)

```rust
fn fanout(&self, account_id: &str, event: ServerEvent) -> Result<(), RouterError> {
    let accounts = self.accounts.read();
    match accounts.get(account_id) {
        Some(entry) => match entry.tx.try_send(Ok(event)) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => {
                // 背压:drop 这个 stream + 发 SERVER_DRAIN
                Err(RouterError::Backpressure)
            }
            Err(TrySendError::Closed(_)) => Err(RouterError::NoStream),
        },
        None => Err(RouterError::NoStream),
    }
}
```

Push handler 收到 `Backpressure` 错误时,需要触发 `drop_stream(user_id, device_id)` + 给 sender 发 `SystemSignal::KIND_SERVER_DRAIN`(best-effort)。

### 7.4 mpsc 容量

每个 stream 的 mpsc buffer 配 **32**(stub_relay 用 16,放宽一倍,降低正常流量下的背压触发率)。

---

## 8. Subscribe Replay 流程

```rust
async fn subscribe(&self, req: Request<SubscribeRequest>) -> Result<Response<...>, Status> {
    let ctx = req.extensions().get::<UserCtx>().ok_or_else(|| Status::unauthenticated("..."))?;
    let since_seqs = req.into_inner().since_seqs;

    let (tx, rx) = mpsc::channel(32);

    // 1. **先 replay 后 register**(决策 #11):
    for (account, since) in &since_seqs {
        if !ctx.accounts.contains(account) { continue; }
        let events = storage.events.replay_after(account, *since, 200).await?;
        for (seq, payload) in events {
            let event = ServerEvent::decode(&payload[..])?;
            // event.seq 已是 record 时分配的值
            tx.send(Ok(event)).await.ok();
        }
    }

    // 2. register(若多端,先发 KICKED 给 prev)
    let prev = router.register(StreamTicket { user_id, accounts, device_id, ... }, tx.clone());
    for p in prev {
        let _ = p.send(Ok(ServerEvent::system_kicked("multi-device"))).await;
        drop(p);  // close
    }

    // 3. 返回 stream
    Ok(Response::new(ReceiverStream::new(rx).boxed()))
}
```

**注**:Subscribe 期间(步骤 1)到达 push 的 event 会落 events 表(seq_counters 持续递增)但不会进 fanout(因为 stream 还没 register),客户端下次 reconnect 自动 replay 兜底。

---

## 9. 下游 HTTP 合约(spec-only,Plan 6+ 实现)

### 9.1 通用

- Base URL:`${RELAY_DOWNSTREAM_URL}`(如 `https://erp.example.com`)
- 认证:`Authorization: Bearer ${RELAY_DOWNSTREAM_SECRET}`(与 push secret 不同)
- Content-Type:`application/json`
- 错误结构:`{"code": "...", "message": "..."}`,HTTP 状态码语义化

### 9.2 5 个下游 endpoint

```
POST /v1/verify_user
  req:  { "username", "password", "device_id", "device_name" }
  ok:   200 {
          "user_id", "display_name", "role", "tenant_id",
          "wecom_accounts": [
            {"wecom_account_id", "corp_id", "agent_id", "display_name", "enabled"}
          ]
        }
  err:  401 {"code":"INVALID_CREDS"}
        403 {"code":"ACCOUNT_DISABLED"}
        412 {"code":"UPGRADE_REQUIRED", "min_version":"x.y.z"}

POST /v1/send
  req:  { "user_id", "wecom_account_id", "conversation_id", "client_msg_id", "body": MessageBody }
  ok:   200 { "server_msg_id", "sent_at_ms" }
  err:  403 ACCOUNT_DISABLED | 400 BAD_REQUEST | 503 transient

POST /v1/recall
  req:  { "user_id", "wecom_account_id", "conversation_id", "server_msg_id" }
  ok:   200 { "recalled_at_ms" }
  err:  403 ACCOUNT_DISABLED | 404 not_found | 503 transient

POST /v1/ack_read
  req:  { "user_id", "wecom_account_id", "conversation_id", "last_read_server_msg_id" }
  ok:   200 { "acked_at_ms" }
  err:  403 ACCOUNT_DISABLED | 503 transient

POST /v1/fetch_history
  req:  { "user_id", "wecom_account_id", "conversation_id", "limit", "cursor" }
  ok:   200 { "messages": [HistoryMessage], "next_cursor" }
  err:  403 ACCOUNT_DISABLED | 503 transient
```

### 9.3 下游 → Relay push endpoint

```
POST /internal/push                        Authorization: Bearer ${RELAY_PUSH_SECRET}
  req:  {
          "wecom_account_id": "wa-1",
          "event": ServerEvent JSON(无 seq;Relay 分配)
        }
  ok:   202 { "assigned_seq": 42, "no_stream": false }
        202 { "assigned_seq": 42, "no_stream": true }   # 无活跃 stream,event 仍入 ring buffer
  err:  401 invalid_secret | 400 bad_payload
```

---

## 10. 错误映射(下游 → tonic::Status)

| 下游 HTTP                     | 内部 RelayError | tonic::Status                                     | 客户端 Action(Plan 2/4 sp ec 对齐)  |
| ----------------------------- | --------------- | ------------------------------------------------- | ----------------------------------- |
| 401 INVALID_CREDS             | InvalidCreds    | `Unauthenticated`                                 | client refresh + retry              |
| 403 ACCOUNT_DISABLED          | AccountDisabled | `PermissionDenied`                                | client terminate(`AccountDisabled`) |
| 412 UPGRADE_REQUIRED          | UpgradeRequired | `FailedPrecondition` + details(`UpgradeRequired`) | client terminate                    |
| 400 BAD_REQUEST               | InvalidArg      | `InvalidArgument`                                 | client bug,不重试                   |
| 5xx / timeout / connect-error | Transient       | `Unavailable`                                     | client backoff                      |
| 4xx 其他                      | Internal        | `Internal`                                        | client backoff                      |

**重要**:Relay 不透传下游 `message` 给客户端,只用 sanitize 后的静态字符串(防泄露内部信息)。

---

## 11. 配置与启动

### 11.1 环境变量(Config::from_env)

| Env                         | Required | Default           | 说明                       |
| --------------------------- | -------- | ----------------- | -------------------------- |
| `RELAY_GRPC_ADDR`           | no       | `127.0.0.1:50051` | gRPC 监听                  |
| `RELAY_PUSH_ADDR`           | no       | `127.0.0.1:50052` | axum push HTTP 监听        |
| `RELAY_DB_PATH`             | no       | `./relay.db`      | SQLite 路径                |
| `RELAY_DOWNSTREAM_URL`      | **yes**  | —                 | 下游 base URL              |
| `RELAY_DOWNSTREAM_SECRET`   | **yes**  | —                 | Bearer 给下游              |
| `RELAY_PUSH_SECRET`         | **yes**  | —                 | 验下游 push 的 Bearer      |
| `RELAY_JWT_PRIVATE_PEM`     | no       | (gen 后入 kv 表)  | Ed25519 私钥 PEM(可选)     |
| `RELAY_JWT_KID`             | no       | (gen)             | JWT header kid             |
| `RELAY_ISSUER`              | no       | `chathub-relay`   | JWT iss                    |
| `RELAY_ACCESS_TTL_SECS`     | no       | `1800`            | JWT exp 距 iat             |
| `RELAY_REFRESH_TTL_SECS`    | no       | `2592000`         | refresh 30d                |
| `RELAY_REFRESH_HASH_PEPPER` | **yes**  | —                 | HMAC pepper(32+ bytes hex) |

### 11.2 main.rs 启动序列

```rust
#[tokio::main(flavor = "multi_thread")]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_env_filter(EnvFilter::from_default_env()).init();
    let cfg = Config::from_env()?;
    let storage = Storage::open(&cfg.db_path).await?;
    let signer = Signer::bootstrap(&storage, &cfg).await?;
    let verifier = signer.verifier();
    let router = Arc::new(Router::new());
    let downstream = Arc::new(DownstreamClient::new(&cfg.downstream_url, &cfg.downstream_secret)?);

    let auth_svc = AuthServer::new(AuthSvc::new(downstream.clone(), storage.clone(), signer.clone()));
    let hub_svc = HubServer::with_interceptor(
        HubSvc::new(downstream.clone(), storage.clone(), router.clone()),
        JwtAuthInterceptor::new(verifier.clone()),
    );
    let tonic_srv = tonic::transport::Server::builder()
        .http2_keepalive_interval(Some(Duration::from_secs(30)))
        .add_service(auth_svc)
        .add_service(hub_svc)
        .serve(cfg.grpc_addr);

    let push_app = push::app(cfg.push_secret.clone(), storage.clone(), router.clone());
    let axum_srv = axum::serve(TcpListener::bind(cfg.push_addr).await?, push_app);

    tokio::select! {
        r = tonic_srv => r?,
        r = axum_srv  => r?,
        _ = tokio::signal::ctrl_c() => {},
    }
    Ok(())
}
```

---

## 12. 异步并发与安全

### 12.1 锁层级

为防止死锁,锁获取顺序固定:

1. `Router.users` (write)
2. `Router.accounts` (write)

不允许反向。`register` / `drop_stream` 都按此序;`fanout` 只取 `accounts.read()`,不竞争 users。

### 12.2 mpsc 背压

- buffer 32
- push handler `try_send` Full → router 内部触发 `drop_stream` + best-effort send `SystemSignal::KIND_SERVER_DRAIN`(可能也 Full,放弃)
- 客户端收到 `SERVER_DRAIN` 会显示出 stream EOF,触发 reconnect + since_seqs replay

### 12.3 wiremock + tonic 在测试中

```rust
#[tokio::test(flavor = "multi_thread")]   // 必须!
async fn test_xxx() { ... }
```

`current_thread` flavor 会导致 wiremock 的 hyper server 与 tonic handler 死锁(都在等同一个 task runner)。

### 12.4 SQLite WAL 与并发写

`Storage::open` 启用 WAL(`PRAGMA journal_mode=WAL`)+ `PRAGMA synchronous=NORMAL`(walking skeleton 接受;Plan 6 可调优)。`next_seq` 用 `UPDATE ... RETURNING` 单语句原子。

### 12.5 sanitize 错误消息

`From<RelayError> for Status` 必须用静态字符串:

```rust
RelayError::Downstream(_) => Status::unavailable("downstream unavailable"),
RelayError::InvalidCreds => Status::unauthenticated("invalid credentials"),
// NEVER include downstream's raw message body
```

---

## 13. 测试策略

### 13.1 单测覆盖(预计 ~18-22 个,by module)

| Module              | 单测数量 | 覆盖                                           |
| ------------------- | -------- | ---------------------------------------------- |
| `config`            | 2        | from_env happy + missing required              |
| `storage::sessions` | 3        | upsert + find + kicked tombstone               |
| `storage::seqs`     | 2        | next_seq monotonic + 1000 并发                 |
| `storage::events`   | 3        | record + replay_after + ring 修剪              |
| `jwt`               | 4        | sign/verify + 篡改 + 过期 + 错 iss             |
| `router`            | 3        | register + KICKED detection + fanout no_stream |
| `downstream`        | 5        | 5 个 method × happy/4xx 错误用 wiremock        |

### 13.2 e2e(`tests/relay_e2e.rs`,7 个)

| #   | 名                                                      | 覆盖                                                            |
| --- | ------------------------------------------------------- | --------------------------------------------------------------- |
| 1   | `login_success_returns_token_and_user`                  | AuthService.Login + JWT decode + user_profile                   |
| 2   | `login_invalid_credentials_maps_to_unauthenticated`     | 401 → Unauthenticated                                           |
| 3   | `subscribe_with_valid_jwt_receives_pushed_event`        | Subscribe + POST /push → client 收到 + seq=1                    |
| 4   | `subscribe_resumes_after_push`                          | since_seqs replay 严格升序,断点期间 push 不丢                   |
| 5   | `kicked_on_second_subscribe_with_different_device`      | 多端 KICKED + 同 device 重连 negative                           |
| 6   | `send_translates_to_downstream_and_emits_status_change` | Send → downstream + 后续 MessageStatusChange echo client_msg_id |
| 7   | `push_with_invalid_secret_returns_401`                  | push Bearer 校验                                                |

### 13.3 e2e fixture

```rust
pub struct RelayHarness {
    pub grpc_endpoint: tonic::transport::Endpoint,
    pub push_url: String,
    pub push_secret: String,
    pub downstream: wiremock::MockServer,
    pub signer: Signer,           // mint JWT 跳过 login 用
    _db: tempfile::TempDir,
    _tonic: tokio::task::JoinHandle<()>,
    _axum:  tokio::task::JoinHandle<()>,
}
pub async fn spawn_relay() -> RelayHarness { ... }
pub fn mint_jwt(signer: &Signer, user_id: &str, accounts: Vec<String>, device_id: &str) -> String { ... }
```

### 13.4 回归

Plan 1-4 客户端测试集合(68 tests)必须不破:

```bash
cargo test -p chathub-proto                                       # 8
cargo test -p chathub-state                                       # 12
cargo test -p chathub-net --lib                                   # 26
cargo test -p chathub-net --test auth_e2e -- --test-threads=1     # 7
cargo test -p chathub-net --test hub_e2e  -- --test-threads=1     # 15
# 合计 68
```

---

## 14. 新依赖(workspace.dependencies 追加)

```toml
axum                = "0.7"
tower               = "0.4"
tower-http          = { version = "0.5", features = ["trace"] }
jsonwebtoken        = "9"           # Ed25519 走 EdDSA
ring                = "0.17"        # 仅用 keygen(jsonwebtoken 内部已用)
reqwest             = { version = "0.12", default-features = false, features = ["json", "rustls-tls"] }
serde_json          = "1"
hmac                = "0.12"
sha2                = "0.10"
hex                 = "0.4"
tracing-subscriber  = { version = "0.3", features = ["env-filter", "fmt"] }

# dev-deps(只在 chathub-relay/Cargo.toml [dev-dependencies] 显式声明)
wiremock            = "0.6"
tokio-stream        = "0.1"
tempfile            = "3"
```

**不引入** `dashmap`(用 workspace 已有 `parking_lot::RwLock<HashMap>`);**不引入** `argon2`(用 `hmac + sha2` 做 HMAC-SHA256 refresh hash)。

---

## 15. DOD(Definition of Done)

合并前必须全部退出码 0:

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub

# 1. workspace 全编 + 严格 clippy + fmt
cargo build --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check

# 2. relay 自身
cargo test -p chathub-relay --lib                                   # ~18-22 unit
cargo test -p chathub-relay --test relay_e2e -- --test-threads=1    # 7 e2e

# 3. Plan 1-4 回归(目标 68)
cargo test -p chathub-proto
cargo test -p chathub-state
cargo test -p chathub-net --lib
cargo test -p chathub-net --test auth_e2e -- --test-threads=1
cargo test -p chathub-net --test hub_e2e  -- --test-threads=1

# 4. binary 起得来 + healthz
RELAY_GRPC_ADDR=127.0.0.1:50051 RELAY_PUSH_ADDR=127.0.0.1:50052 \
RELAY_DB_PATH=/tmp/relay-smoke.db RELAY_DOWNSTREAM_URL=http://127.0.0.1:9999 \
RELAY_DOWNSTREAM_SECRET=dn-secret RELAY_PUSH_SECRET=push-secret \
RELAY_REFRESH_HASH_PEPPER=$(openssl rand -hex 32) \
cargo run -p chathub-relay --bin chathub-relay &
sleep 1 && curl -s http://127.0.0.1:50052/healthz | grep -q ok ; kill %1

# 5. README 完整(env 矩阵 + 5 个下游 curl 例子 + push curl 例子)
test -f backends/crates/chathub-relay/README.md

# 6. Cargo.lock diff 仅含合理传递依赖更新
git diff main -- Cargo.lock | grep '^+name = ' | sort -u
```

---

## 16. 与 Plan 6+ 的接口承诺

落地后:

- **5 个下游 HTTP endpoint 形态稳定**;Plan 6 实现真下游按此合约。批改任何字段需 Plan 6 spec 评审。
- **`/internal/push` body 稳定**;Plan 6 可加 `POST /internal/push/batch` 但不破单条。
- **JWT Claims layout 稳定**(`iss=chathub-relay` / `sub=user_id` / `device_id` / `accounts` / `exp` / `iat`)
- **JWT 算法可演化**:Plan 6 加 JWKS endpoint 时可重切回 RS256(决策 #3 降级条款),客户端代码无需改
- **ConnectionRouter / SeqAllocator / events ring** 为 Relay 内部接口,Plan 6 允许重构(只要客户端可见的 stream 行为不变)
- **HMAC pepper 不能轻易换**:换 pepper 等同于 invalidate 所有 refresh_token,需运维事件文档化

---

## 17. 风险与缓解

| ID  | 风险                                                              | 缓解                                                                               |
| --- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| R1  | wire-compat 破裂 — relay 实现与 Plan 1-4 客户端不符               | G2 用真 `chathub-net::HubClient` 跑 e2e,任何偏差直接红                             |
| R2  | SQLite 写放大 — seq 每次 push UPDATE + event INSERT + ring DELETE | walking skeleton 接受;Plan 6 改 WAL + batch flush                                  |
| R3  | JWT 私钥泄露处理缺失 — Plan 5 不做 key rotation                   | 文档化 README;Plan 6 加 JWKS endpoint + kid rotation                               |
| R4  | 多端 KICKED 竞态 — A connect / B connect 几乎同时                 | `Router.users.write()` 单写者锁覆盖 register 全程;D4 单测 cover                    |
| R5  | Replay 与 live push 乱序 — 见决策 #11                             | replay 先于 register,Subscribe 期间到达的 push 走 ring,下次 reconnect 兜底         |
| R6  | wiremock + tonic 共享 runtime 死锁                                | `#[tokio::test(flavor="multi_thread")]` 强制要求;G1 fixture 模板写死,所有 e2e 复用 |
| R7  | Router fanout 背压 — 慢客户端阻塞推送                             | `try_send` + Full → 给该 stream 发 SERVER_DRAIN 然后 drop;mpsc 容量配 32           |
| R8  | DB 回滚导致 session 失效                                          | 运营注意,文档化在 README                                                           |
| R9  | Send 的 STATUS_FAILED 路径缺失,客户端可能 UI 状态不一致           | skeleton 限制,Plan 6+ 加客户端 client_msg_id → 本地状态映射表                      |
| R10 | HMAC pepper 进 env 暴露给 ops                                     | README 标注 secret 管理要求,生产用 secret manager                                  |

---

## 18. 复用 Plan 1-4 的资产

- **`chathub-proto`** — server codegen 已 `build_server(true)`,直接 `use chathub_proto::v1::{auth_server::AuthServer, hub_server::HubServer, ...}`
- **`chathub-net::HubClient`** — relay_e2e 直接当 test client(反向用,这次它连真 server)
- **workspace 共享依赖** — `tokio` / `tonic` / `prost` / `serde` / `thiserror` / `tracing` / `rusqlite` / `parking_lot` / `uuid` / `bytes` / `anyhow` 全复用
- **测试范式** — 镜像 Plan 3/4 hub_e2e 的 fixture + outcome 模式,只是 stub 端反一下:client 真实(`chathub-net::HubClient`),relay 真实(本 plan 实现),下游 wiremock 假
