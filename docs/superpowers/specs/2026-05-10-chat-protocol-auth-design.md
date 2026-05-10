# ChatHub Plan 2 — Auth End-to-End 设计规范

## Context

Plan 1 (Foundation) 已合入 main:Cargo workspace + chathub-proto crate(由 tonic-build 从 `proto/chathub/v1/*.proto` 生成),所有 Rust 代码归位 `backends/crates/`。Plan 1 的产物**只能编译,不能通信** —— Tauri 客户端目前仅有 `greet` / `take_screenshot` 两个 demo 命令,没有任何 gRPC 调用。

Plan 2 的目标: **打通客户端 → Relay 的鉴权链路**,让 Tauri 客户端能登录、自动刷新 token、安全持久化、退出。

**不在范围**: Hub.Subscribe(下行实时推送)/ Send(发消息)/ FetchHistory / 附件上传 —— 这些是 Plan 3+。

**预期交付**: 一个**端到端可演示**的 PR,在 stub Relay 上跑完整 7 个测试场景全绿;前端**仍不接入**(前端切真实数据流是 Plan 5)。

**协议层依据**: `~/.claude/plans/...protocol-design.md` §4(已锁定:Access JWT 30min + Refresh opaque 30day rolling、自建用户体系、Auth 三个 RPC、metadata Bearer + 版本头)。本 spec 不再重复协议层决策。

---

## 1. 架构总览

```
+-----------------------+        +--------------------------------+
| Frontend (React)      |        | chathub-net (Rust)             |
|                       | invoke |                                |
|  login(u, p)          | -----> |  AuthApi::login() ----+        |
|  logout()             |        |                       |        |
|  current_session()    | <----- |  result <-------------+        |
|                       | event  |                                |
|  on auth:logged_out   | <----- |  TokenStore (双检锁)             |
+-----------------------+        |    ├─ access (内存)              |
                                 |    └─ refresh (keyring)         |
                                 |                                |
                                 |  AuthInterceptor                |
                                 |    └─ metadata: Bearer + 版本头  |
                                 +------+------------------+-------+
                                        | gRPC over HTTP/2 |
                                        v                  v
                                 +--------------------------------+
                                 | chathub.v1.Auth                |
                                 |   Login / RefreshToken / Logout|
                                 +--------------------------------+
                                            ↑
                                   生产: Relay 服务端(独立仓库)
                                   测试: tests/common/stub_relay
```

`chathub-state` 同时被 chathub-net(读写 token / session)与 backends(Tauri State 持有)使用。

---

## 2. Crate 结构

Plan 1 已锁定: 所有新 crate 落 `backends/crates/`。Plan 2 新增 2 个:

```
backends/crates/
├── chathub-proto/         # Plan 1,已存在,无改动
├── chathub-state/         # Plan 2 新增
│   ├── Cargo.toml
│   │   依赖:deadpool-sqlite, rusqlite, rusqlite_migration, keyring,
│   │         serde, thiserror, tokio (rt-multi-thread + sync 仅在 future-pin 处)
│   ├── migrations/
│   │   └── V1__init.sql       # refresh_tokens(代替 keyring 的 audit 表)、current_session
│   └── src/
│       ├── lib.rs              # pub use TokenStore, SessionStore, StateError
│       ├── pool.rs             # DeadpoolSqlitePool 包装 + 启动迁移
│       ├── tokens.rs           # KeyringTokenStore (refresh_token + device_id 走 OS Keychain)
│       ├── session.rs          # SessionStore (UserProfile / WecomAccount 镜像走 SQLite)
│       └── error.rs            # StateError thiserror enum
└── chathub-net/           # Plan 2 新增
    ├── Cargo.toml
    │   依赖:tonic (workspace), prost (workspace), tokio,
    │         chathub-proto (path), chathub-state (path),
    │         thiserror, tracing, parking_lot
    └── src/
        ├── lib.rs              # pub use AuthApi, TokenStore, AuthError
        ├── channel.rs          # build_endpoint(url) -> Endpoint:keep-alive/timeout/TLS
        ├── token.rs            # TokenStore + Arc<RwLock<TokenState>> + Arc<Mutex<()>>
        ├── interceptor.rs      # AuthInterceptor(注入 Bearer + 协议头)
        ├── auth.rs             # AuthApi: login/refresh/logout 业务包装
        └── error.rs            # AuthError thiserror enum + Status 翻译
```

`backends/Cargo.toml` 新增 path 依赖 `chathub-net`、`chathub-state`,Tauri bin crate 不直接 import chathub-proto(透过 chathub-net re-export)。

---

## 3. chathub-state 详情

### 3.1 SQLite schema(`migrations/V1__init.sql`)

```sql
-- 当前会话:有且只有一行(用户登录后更新,登出删除)。
-- 与 keyring 协同:keyring 存 refresh_token / device_id,session 表存可见的 profile 副本。
CREATE TABLE IF NOT EXISTS current_session (
    id              INTEGER PRIMARY KEY CHECK (id = 1),  -- 单行约束
    user_id         TEXT    NOT NULL,
    display_name    TEXT    NOT NULL,
    avatar_url      TEXT    NOT NULL,
    role            TEXT    NOT NULL,
    tenant_id       TEXT    NOT NULL,
    logged_in_at_ms INTEGER NOT NULL
);

-- WecomAccount 缓存表:Plan 3 起会用;Plan 2 落空表占位即可,Login 时一并写入。
CREATE TABLE IF NOT EXISTS wecom_accounts (
    wecom_account_id TEXT    PRIMARY KEY,
    user_id          TEXT    NOT NULL REFERENCES current_session(user_id),
    corp_id          TEXT    NOT NULL,
    agent_id         INTEGER NOT NULL,
    display_name     TEXT    NOT NULL,
    enabled          INTEGER NOT NULL DEFAULT 1,
    cached_at_ms     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wecom_user ON wecom_accounts(user_id);
```

### 3.2 SQLite 文件位置

由 Tauri `app_data_dir()`(`~/Library/Application Support/com.pis0sion.chathub/` on macOS)解析,文件名 `state.sqlite`,WAL 模式打开。

### 3.3 keyring keys

| Service                | Account         | Value                                            |
| ---------------------- | --------------- | ------------------------------------------------ |
| `com.pis0sion.chathub` | `device_id`     | UUIDv4(首启动生成,永不变)                        |
| `com.pis0sion.chathub` | `refresh_token` | opaque base64 string(从 RefreshTokenResponse 来) |

> 同一时刻只支持一个本地用户。Plan 2 不引入 multi-user-on-one-device 概念。

### 3.4 公共 API

```rust
// chathub-state/src/lib.rs
pub use error::StateError;
pub use pool::SqlitePool;
pub use tokens::KeyringTokenStore;
pub use session::SessionStore;

// chathub-state/src/tokens.rs
pub struct KeyringTokenStore { service: String /* "com.pis0sion.chathub" */ }

impl KeyringTokenStore {
    pub fn new(service: impl Into<String>) -> Self;
    pub fn ensure_device_id(&self) -> Result<String, StateError>;  // 不存在即生成 UUIDv4
    pub fn read_refresh_token(&self) -> Result<Option<String>, StateError>;
    pub fn write_refresh_token(&self, token: &str) -> Result<(), StateError>;
    pub fn clear_refresh_token(&self) -> Result<(), StateError>;
}

// chathub-state/src/session.rs
pub struct SessionStore { pool: SqlitePool }

impl SessionStore {
    pub async fn upsert_session(&self, p: &UserProfile, accounts: &[WecomAccount])
        -> Result<(), StateError>;
    pub async fn read_current(&self) -> Result<Option<UserProfile>, StateError>;
    pub async fn clear(&self) -> Result<(), StateError>;
}
```

`UserProfile` / `WecomAccount` 直接复用 `chathub_proto::v1::*` 的类型(由 prost 生成)。

**为此 Plan 2 需要顺手改 `backends/crates/chathub-proto/build.rs`** —— 给会跨 Tauri 边界的 message 类型加 serde derive,以便 Tauri 命令直接返回它们:

```rust
// build.rs 里 tonic_build::configure() 之后
.type_attribute(".chathub.v1.UserProfile",  "#[derive(serde::Serialize, serde::Deserialize)]")
.type_attribute(".chathub.v1.WecomAccount", "#[derive(serde::Serialize, serde::Deserialize)]")
.type_attribute(".chathub.v1.MessageBody",  "#[derive(serde::Serialize, serde::Deserialize)]")
.type_attribute(".chathub.v1.Mention",      "#[derive(serde::Serialize, serde::Deserialize)]")
.type_attribute(".chathub.v1.ReplyToRef",   "#[derive(serde::Serialize, serde::Deserialize)]")
.type_attribute(".chathub.v1.RemoteId",     "#[derive(serde::Serialize, serde::Deserialize)]")
```

`chathub-proto/Cargo.toml` 加 `serde = { version = "1", features = ["derive"] }` 到 `[dependencies]`(只引入 derive,不影响 prost)。

---

## 4. chathub-net 详情

### 4.1 channel.rs

```rust
pub fn build_endpoint(url: impl Into<String>) -> Result<Endpoint, AuthError> {
    Endpoint::from_shared(url.into())?
        .http2_keep_alive_interval(Duration::from_secs(10))
        .keep_alive_timeout(Duration::from_secs(5))
        .keep_alive_while_idle(true)
        .tcp_keepalive(Some(Duration::from_secs(30)))
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(30))
}
```

**TLS** 仅在 url scheme 为 `https://` 时通过 `tls_config(ClientTlsConfig::new().with_native_roots())` 启用。`http://` 直连(测试 / 本地开发 / 内网)。

### 4.2 token.rs

**关键设计决策**: `TokenStore` 使用**同步** `parking_lot::RwLock` 持有 `TokenState`,而非 `tokio::sync::RwLock`。原因:tonic 的 `Interceptor` trait 是同步的,无法 `.await`,而 `block_on` 在异步 runtime 内会 panic。配合一个**后台 refresh task**(在 `TokenStore::login` / `try_resume` 时 spawn)做主动刷新,interceptor 只读 cached 值。

```rust
#[derive(Clone)]
pub struct TokenState {
    pub access_token:   String,
    pub access_exp_ms:  i64,
    pub refresh_exp_ms: i64,
    pub user_id:        String,
}

pub struct TokenStore {
    state:         Arc<parking_lot::RwLock<Option<TokenState>>>,  // 同步,interceptor 友好
    refresh_lock:  Arc<tokio::sync::Mutex<()>>,                   // 序列化 refresh,异步路径用
    auth_client:   AuthClient<Channel>,                            // 不带 interceptor 的裸 client
    keyring:       Arc<KeyringTokenStore>,
    device_id:     String,
    proactive_refresh_threshold_ms: i64,                           // 默认 5*60*1000
    refresher_handle: Mutex<Option<JoinHandle<()>>>,               // 后台 refresh task
    logged_out_tx: broadcast::Sender<LoggedOutReason>,
}

impl TokenStore {
    /// 同步读已缓存的 access。Interceptor 用这个。
    /// 返回 None 表示未登录(interceptor 应回 Status::Unauthenticated)。
    pub fn current_access_token(&self) -> Option<String>;

    /// 异步刷新一次(被动:业务调用拿到 Status::Unauthenticated 后调)。
    pub async fn force_refresh(&self) -> Result<(), AuthError>;

    /// 登录:调 AuthClient.Login → 写 keyring + state → spawn refresher task。
    pub async fn login(&self, username: &str, password: &str)
        -> Result<UserProfile, AuthError>;

    /// 登出:abort refresher task → 调 AuthClient.Logout(best-effort) → 清 keyring/state → broadcast Manual。
    pub async fn logout(&self) -> Result<(), AuthError>;

    pub fn current_user_id(&self) -> Option<String>;
    pub fn logged_out_subscribe(&self) -> broadcast::Receiver<LoggedOutReason>;
}
```

`is_near_expiry()` = `(access_exp_ms - now_ms) < proactive_refresh_threshold_ms`。

**后台 refresher task 算法**:

```
loop {
    let state = state.read().clone();   // parking_lot 同步 read
    match state {
        None => return,                 // 已登出
        Some(s) => {
            let until_refresh = (s.access_exp_ms - now_ms - PROACTIVE_THRESHOLD_MS).max(0);
            tokio::time::sleep(Duration::from_millis(until_refresh as u64)).await;

            // 拿 refresh_lock 序列化(防 force_refresh 与 background 同时跑)
            let _g = refresh_lock.lock().await;

            // 双检
            if state.read().as_ref().map(|s| s.is_near_expiry()).unwrap_or(false) {
                match do_refresh().await {
                    Ok(_) => {} // 写 state + keyring
                    Err(AuthError::Unauthenticated) => {
                        clear_all().await;
                        let _ = logged_out_tx.send(LoggedOutReason::RefreshFailed);
                        return;
                    }
                    Err(AuthError::Network { .. }) => {
                        // 退避后重试(指数,封顶 60s,最多 5 次,然后视为吊销)
                    }
                    _ => return,
                }
            }
        }
    }
}
```

### 4.3 interceptor.rs

```rust
pub struct AuthInterceptor {
    token_store: Arc<TokenStore>,
    client_version: String,    // env!("CARGO_PKG_VERSION")
    platform: &'static str,    // "macos" | "windows" | "linux"
}

impl tonic::service::Interceptor for AuthInterceptor {
    fn call(&mut self, mut req: Request<()>) -> Result<Request<()>, Status> {
        let access = self.token_store
            .current_access_token()
            .ok_or_else(|| Status::unauthenticated("not logged in"))?;
        let md = req.metadata_mut();
        md.insert("authorization",
            format!("Bearer {access}").parse().map_err(|_| Status::internal("token"))?);
        md.insert("chathub-protocol-version", "1".parse().unwrap());
        md.insert("chathub-client-version", self.client_version.parse().unwrap());
        md.insert("chathub-platform", self.platform.parse().unwrap());
        Ok(req)
    }
}
```

interceptor **完全同步、零 await、零 block_on**。所有"刷新"逻辑都在后台 task 里完成。

**注意**: AuthInterceptor 仅供 Plan 3 起的 Hub._ 客户端使用。Auth._ RPC(Login / RefreshToken / Logout)由 TokenStore 内部直接用裸 `AuthClient<Channel>` 调用,**不走 interceptor**(它们本就不要求 Bearer)。

### 4.4 auth.rs

`AuthApi` 是给 backends 用的高层包装,屏蔽 TokenStore + AuthClient 内部:

```rust
pub struct AuthApi { /* 持有 TokenStore + SessionStore */ }

impl AuthApi {
    pub async fn login(&self, username: &str, password: &str)
        -> Result<UserProfile, AuthError>;
    //   内部:1) Auth.Login RPC
    //         2) keyring.write_refresh_token + ensure_device_id
    //         3) session.upsert_session(profile, accounts)
    //         4) TokenStore 状态切到 Some(state)

    pub async fn logout(&self) -> Result<(), AuthError>;
    //   内部:1) Auth.Logout RPC(best-effort,网络失败也清本地)
    //         2) keyring.clear_refresh_token
    //         3) session.clear
    //         4) TokenStore 切 None
    //         5) 通过 mpsc 发 LoggedOut 事件给 backends

    pub async fn current_session(&self) -> Result<Option<UserProfile>, AuthError>;
    //   读 SessionStore;若 SQLite 与 TokenStore 状态不一致则以 None 返回

    /// 进程启动时:keyring 有 refresh → 触发 force_refresh,把 TokenStore 复活
    pub async fn try_resume_session(&self) -> Result<Option<UserProfile>, AuthError>;
}

#[derive(Debug)]
pub enum LoggedOutReason { Manual, RefreshFailed, Kicked }
```

`AuthApi` 持有一个 `tokio::sync::broadcast::Sender<LoggedOutReason>` 的引用;backends 在 setup 时订阅,收到后 emit Tauri 事件。

### 4.5 error.rs

```rust
#[derive(thiserror::Error, Debug, serde::Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum AuthError {
    #[error("invalid credentials")]
    Unauthenticated,

    #[error("upgrade required")]
    UpgradeRequired { min_version: String, download_url: String },

    #[error("network error: {message}")]
    Network { message: String },

    #[error("storage error: {message}")]
    Storage { message: String },

    #[error("internal: {message}")]
    Internal { message: String },
}

impl From<tonic::Status> for AuthError { /* Status → AuthError 翻译表 */ }
impl From<chathub_state::StateError> for AuthError { /* … */ }
```

`Status` → `AuthError` 翻译规则(spec §10.1 + §10.2):

| Status code                                  | AuthError                              | 备注         |
| -------------------------------------------- | -------------------------------------- | ------------ |
| Unauthenticated                              | Unauthenticated                        | 直接         |
| FailedPrecondition + UpgradeRequired details | UpgradeRequired { min, url }           | 解析 details |
| Unavailable / DeadlineExceeded               | Network { message }                    | 网络类       |
| Internal / Unknown                           | Internal { message }                   | bug 类       |
| 其它                                         | Internal { message: status.message() } | 兜底         |

---

## 5. backends 的 Tauri 桥接

### 5.1 AppState 注入

```rust
// backends/src/lib.rs(setup 闭包内)
let app_data = app.path().app_data_dir()?;
let state_pool = chathub_state::SqlitePool::open(app_data.join("state.sqlite")).await?;
let session_store = chathub_state::SessionStore::new(state_pool.clone());
let keyring = chathub_state::KeyringTokenStore::new("com.pis0sion.chathub");

let endpoint = chathub_net::build_endpoint(env!("CHATHUB_RELAY_URL"))?;
let token_store = chathub_net::TokenStore::connect(endpoint, keyring).await?;
let auth_api = chathub_net::AuthApi::new(token_store, session_store);

// 启动时尝试恢复会话(keyring 有 refresh → force_refresh)
let app_handle = app.handle().clone();
let auth_for_resume = auth_api.clone();
tokio::spawn(async move {
    let _ = auth_for_resume.try_resume_session().await;
});

// LoggedOut 事件桥接:chathub-net broadcast → Tauri emit
let mut rx = auth_api.logged_out_subscribe();
tokio::spawn(async move {
    while let Ok(reason) = rx.recv().await {
        let _ = app_handle.emit("auth:logged_out",
            serde_json::json!({ "reason": match reason { … } }));
    }
});

app.manage(auth_api);
```

`CHATHUB_RELAY_URL` 注入位置: **`backends/crates/chathub-net/build.rs`**(因为 chathub-net 是网络层的所有者),通过 `option_env!("CHATHUB_RELAY_URL")` 在编译期取 env,生成一个 `pub const RELAY_URL: &str = ...;` 暴露到 `chathub_net::RELAY_URL`。无 env 时 fallback `"https://relay.example.com"`(占位,build 时 `cargo:warning=` 输出告警)。

backends 用 `chathub_net::RELAY_URL` 作为 `build_endpoint()` 的入参。

### 5.2 命令签名

```rust
#[tauri::command]
async fn login(state: State<'_, Arc<AuthApi>>, username: String, password: String)
    -> Result<UserProfile, AuthError> {
    state.login(&username, &password).await
}

#[tauri::command]
async fn logout(state: State<'_, Arc<AuthApi>>) -> Result<(), AuthError> {
    state.logout().await
}

#[tauri::command]
async fn current_session(state: State<'_, Arc<AuthApi>>)
    -> Result<Option<UserProfile>, AuthError> {
    state.current_session().await
}
```

`UserProfile` 必须 `Serialize`;由 chathub-state(或 chathub-proto 的镜像)提供。

### 5.3 capabilities 更新

`backends/capabilities/default.json` 不需要新加权限 —— 这三个命令是 user-defined,自动允许。

---

## 6. 完整数据流(关键路径)

### 6.1 登录(冷启动 → 用户输入用户名密码)

```
1. 前端 invoke('login', {username, password})
2. backends::login Tauri 命令
3. AuthApi::login
   a. 取 device_id(keyring,无则新生成 UUIDv4 写入)
   b. 用 TokenStore 持有的**裸 `AuthClient<Channel>`**(无 interceptor)调
      Login(LoginRequest { username, password, device_id, device_name, client_ver })
      —— Auth.* 三个 RPC 不要求 Bearer,所以不走 AuthInterceptor
   c. 收到 LoginResponse:解析 access/refresh/exp/user/wecom_accounts
   d. KeyringTokenStore::write_refresh_token(refresh)
   e. SessionStore::upsert_session(user, wecom_accounts)
   f. TokenStore.state = Some(TokenState { access_token, access_exp_ms, refresh_exp_ms, user_id })
   g. **spawn refresher task**(算法见 §4.2)
4. 返回 UserProfile 给前端
```

### 6.2 主动刷新(有调用方调 current_access_token,access 5min 内过期)

```
1. interceptor 调 token_store.current_access_token()
2. read RwLock,is_near_expiry() = true → drop read
3. 取 refresh_lock(Mutex) ← 此处序列化并发请求
4. 再 read RwLock 一次:
   - 仍近过期 → 继续刷新
   - 已被别的 task 刷过 → 直接返回缓存的 access
5. 用 keyring 里的 refresh_token + device_id 调 RefreshTokenRequest
6. 拿到 RefreshTokenResponse:新 access + 新 refresh + 新 exp
7. KeyringTokenStore::write_refresh_token(new_refresh)
8. write RwLock:覆盖 TokenState
9. 释放 refresh_lock,返回新 access
```

### 6.3 被动刷新(调用方拿到 Status::Unauthenticated)

由调用方层(Plan 3 起的业务调用)在拿到 `Status::Unauthenticated` 时主动调 `token_store.force_refresh()` + retry once。Plan 2 阶段没有真正业务调用,但 chathub-net 必须暴露 force_refresh 给 Plan 3 用。

### 6.4 退出(用户点登出 / refresh 失败)

```
manual:
  AuthApi::logout
    a. AuthClient::logout(refresh)  ← best-effort,网络失败继续
    b. keyring.clear_refresh_token
    c. session.clear
    d. TokenStore.state = None
    e. broadcast::send(LoggedOutReason::Manual)
  → Tauri 桥接收到 → emit('auth:logged_out', {reason: 'manual'})

refresh-failed:
  TokenStore::do_refresh 拿到 Status::Unauthenticated
    a. 同 b/c/d/e,reason = RefreshFailed
```

---

## 7. 测试方案

### 7.1 测试 harness(`chathub-net/tests/common/stub_relay.rs`)

```rust
pub struct StubAuth { state: Arc<Mutex<StubState>> }

#[derive(Default, Clone)]
pub struct StubState {
    pub login_outcome: LoginOutcome,         // Ok(profile) | Unauthenticated | Network
    pub access_ttl_ms: i64,                  // 控制 access_exp_ms - now,默认 30*60*1000
    pub refresh_ttl_ms: i64,                 // 同,默认 30*24*60*60*1000
    pub refresh_outcome: RefreshOutcome,     // Ok | Revoked | Network
    pub login_count:   usize,
    pub refresh_count: usize,
    pub logout_count:  usize,
}

pub async fn start_stub() -> (SocketAddr, Arc<Mutex<StubState>>, JoinHandle<()>);
```

### 7.2 7 个集成测试(`chathub-net/tests/auth_e2e.rs`)

| #   | 名称                                | 设置                                                          | 调用                                                                                 | 断言                                                          |
| --- | ----------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| 1   | login_success                       | login_outcome = Ok                                            | api.login("u","p")                                                                   | profile 返回;keyring 有 refresh;session 表 1 行;state.is_some |
| 2   | login_unauthenticated               | login_outcome = Unauthenticated                               | api.login("u","p")                                                                   | AuthError::Unauthenticated;keyring 空;session 表 0 行         |
| 3   | proactive_refresh_when_near_expiry  | login_outcome=Ok, access_ttl_ms=2000                          | login → sleep(1.7s) → token_store.current_access_token()                             | refresh_count=1;access 已换新                                 |
| 4   | reactive_refresh_on_unauthenticated | login_outcome=Ok                                              | login → 模拟一个返回 Status::Unauthenticated 的 stub method,调 force_refresh + retry | refresh_count=1;第二次调用拿到新 access                       |
| 5   | logout_emits_event                  | login_outcome=Ok                                              | login → logout → 等 broadcast                                                        | reason=Manual;keyring 空;session 空;state.is_none             |
| 6   | refresh_revoked_emits_event         | login_outcome=Ok, access_ttl_ms=2000, refresh_outcome=Revoked | login → sleep → current_access_token()                                               | reason=RefreshFailed;keyring 空;session 空                    |
| 7   | resume_after_restart                | login_outcome=Ok                                              | api1.login → drop → 重建 api2 → api2.try_resume_session()                            | session 还在;refresh_count=1;state.is_some                    |

### 7.3 单元测试(各 crate `src/` 内 `#[cfg(test)]`)

- chathub-state::KeyringTokenStore: `ensure_device_id` 幂等(call 两次返回同值)
- chathub-state::SessionStore: upsert → read 来回一致
- chathub-net::TokenState::is_near_expiry: 边界值
- chathub-net::AuthError: From<Status> 翻译表(8 种 Status code 各一个用例)

### 7.4 测试运行

```bash
cargo test --workspace                 # 全部
cargo test -p chathub-net --test auth_e2e   # 7 个 e2e
```

---

## 8. 关键文件路径(实施时按此创建)

```
backends/crates/chathub-state/Cargo.toml                   (new)
backends/crates/chathub-state/migrations/V1__init.sql      (new)
backends/crates/chathub-state/src/lib.rs                   (new)
backends/crates/chathub-state/src/pool.rs                  (new)
backends/crates/chathub-state/src/tokens.rs                (new)
backends/crates/chathub-state/src/session.rs               (new)
backends/crates/chathub-state/src/error.rs                 (new)

backends/crates/chathub-net/Cargo.toml                     (new)
backends/crates/chathub-net/src/lib.rs                     (new)
backends/crates/chathub-net/src/channel.rs                 (new)
backends/crates/chathub-net/src/token.rs                   (new)
backends/crates/chathub-net/src/interceptor.rs             (new)
backends/crates/chathub-net/src/auth.rs                    (new)
backends/crates/chathub-net/src/error.rs                   (new)
backends/crates/chathub-net/build.rs                       (new) — 注入 CHATHUB_RELAY_URL via option_env!
backends/crates/chathub-net/tests/common/mod.rs            (new)
backends/crates/chathub-net/tests/common/stub_relay.rs     (new)
backends/crates/chathub-net/tests/auth_e2e.rs              (new)

Cargo.toml                                                 (modified — workspace.dependencies 加 deadpool-sqlite/rusqlite/keyring/serde 等;members 加新成员)
backends/Cargo.toml                                        (modified — 加 chathub-net、chathub-state path 依赖)
backends/src/lib.rs                                        (modified — setup 注入 AuthApi、3 个 Tauri 命令、事件桥接)
backends/crates/chathub-proto/Cargo.toml                   (modified — 加 serde = { version = "1", features = ["derive"] })
backends/crates/chathub-proto/build.rs                     (modified — 加 .type_attribute(...) for UserProfile/WecomAccount/MessageBody/Mention/ReplyToRef/RemoteId)
```

---

## 9. 验证方案(end-to-end)

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub

# 1. 全 workspace 编译
cargo build --workspace

# 2. 全部测试(应见 chathub-state 单测 + chathub-net 单测 + 7 e2e 全过)
cargo test --workspace

# 3. clippy 严格
cargo clippy --workspace -- -D warnings

# 4. Tauri 打包(含 setup 注入新 AppState)
pnpm tauri build --debug
# 启动 .app,前端只能看到登录页(本 Plan 不接前端);后端日志应显示
# "tracing initialised" + (若 keyring 有遗留 refresh) "try_resume_session failed: network"

# 5. 手动烟雾(启动 stub-relay 二进制 + 客户端连本地)
# (可选,Plan 3 的"集成 demo"再做)
```

---

## 10. Out of Scope(明确不做)

- 前端 UI 切换到真实数据流(Plan 5)
- 任何 Hub.\* RPC(Plan 3)
- 任何附件 / blob 处理(Plan 4)
- 多用户同设备登录(架构允许,但 Plan 2 不做)
- 在 backends 之外暴露 SQL DSN / DB schema(`chathub-state` 模块边界封闭)
- mTLS / 客户端证书(Plan 2 默认服务器单向 TLS;mTLS 留作未来增强)
- 本地 audit log(token 何时被写、被读、被删 —— 调试时加 tracing 即可,不做持久化 audit)
- 跨进程的 keyring 锁(并发开 N 个客户端实例的情况;不在 Plan 2 测)

---

## 11. 风险与缓解

| 风险                                              | 缓解                                                                                            |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| ~~`block_on` 在 async 上下文里 panic~~            | **已规避**:interceptor 同步读 parking_lot::RwLock 缓存,proactive refresh 由后台 tokio task 完成 |
| keyring 在 macOS Keychain 解锁前调用 → 阻塞或弹窗 | 启动时不主动读 keyring;等 try_resume_session 后台 task 跑(其 timeout 由我们控制)                |
| stub Relay 测试在 CI 上 race                      | 使用 127.0.0.1:0 拿动态端口,避免端口冲突;测试间不共享 stub                                      |
| `parking_lot` vs `tokio::sync` 混用               | 全用 `tokio::sync::{RwLock, Mutex}` 在 async 路径;`parking_lot` 只在同步路径(暂无)              |
| Tauri AppHandle clone 问题                        | `app.handle().clone()` Tauri 2 已支持;`AuthApi` 用 `Arc` 包装注入 State                         |
| chathub-state SQLite 开 WAL 后 in-memory race     | 开 WAL 但 PoolBuilder::max_size = 4(够并发,不多)                                                |

---

## 12. 后续 Plan 引用

- **Plan 3** 会 import `chathub_net::{TokenStore, AuthInterceptor, build_endpoint}`,新增 chathub-net 的 `hub` mod(Subscribe / Send / Recall / AckRead / FetchHistory)。本 Plan 2 把所有"通用网络层"已经准备好,Plan 3 只加业务 RPC + ConnectionManager 状态机。
- **Plan 4** 不依赖本 Plan 直接产物(Blob 走 HTTPS 旁路而非 gRPC),但会复用 `chathub-state::SqlitePool` 加新表。
- **Plan 5** 前端 `useChatMessages` 切到 `invoke('login', …)` 等命令,届时本 Plan 的 3 个命令成为前端真实入口。
