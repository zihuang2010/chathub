# Plan 5: chathub-relay Walking Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a Rust gRPC gateway (`chathub-relay`) that fulfills the client-side protocol contract (Plan 1-4), translates client RPC into downstream HTTP, accepts downstream-pushed events via HTTP, fans them to the active Subscribe stream, persists session/seq/events to SQLite for restart-safety, and signs/verifies its own Ed25519 JWTs.

**Architecture:** Single Rust binary with a tonic gRPC server (Auth+Hub services), an axum HTTP server (push endpoint + healthz), a `parking_lot::RwLock<HashMap>`-backed in-memory `ConnectionRouter`, and a SQLite-backed storage layer (sessions / seq_counters / events ring buffer / kv). Downstream business system is spec-only; e2e tests use `wiremock` to simulate it. The relay implements the server side of the proto contract that Plan 1-4 already nailed down on the client side; tests use the existing `chathub-net::HubClient` as the test client (reverse of the stub_relay pattern that Plan 1-4 used).

**Tech Stack:** Rust 2021, tonic 0.12, prost 0.13, axum 0.7, jsonwebtoken 9 (Ed25519/EdDSA), ring 0.17, reqwest 0.12 (rustls), rusqlite + deadpool-sqlite + rusqlite_migration, parking_lot, tokio, tracing, hmac+sha2 (refresh_token hashing), wiremock + tempfile (dev).

**Spec:** `docs/superpowers/specs/2026-05-11-chat-protocol-relay-design.md` (18 sections, 11 decisions). This plan strictly implements §3 file layout, §5 schema, §6 JWT, §7 Router, §8 Replay, §9 downstream contract, §10 error mapping, §11 config, §12 concurrency, §13 testing, §15 DOD.

**Plan 1-4 状态:** 全部合入 main(最新 commit `ce4514f`)。Plan 5 在新 feature 分支 `feature/0511/relay-walking-skeleton` 上开发。

---

## File Structure

### 新建

```
backends/crates/chathub-relay/
├── Cargo.toml
├── README.md
├── migrations/
│   └── 001_initial.sql
├── src/
│   ├── main.rs
│   ├── lib.rs
│   ├── error.rs
│   ├── config.rs
│   ├── jwt.rs
│   ├── router.rs
│   ├── downstream.rs
│   ├── push.rs
│   ├── auth_service.rs
│   ├── hub_service.rs
│   └── storage/
│       ├── mod.rs
│       ├── migrations.rs
│       ├── sessions.rs
│       ├── seqs.rs
│       ├── events.rs
│       └── kv.rs
└── tests/
    ├── common/
    │   └── mod.rs
    └── relay_e2e.rs
```

### 修改

```
Cargo.toml         ← workspace.members += "backends/crates/chathub-relay" + workspace.dependencies 追加 10 条
```

### 不动(承诺)

```
backends/crates/chathub-{net,state,proto}/    # 客户端 / state / proto codegen 全锁
backends/src/                                  # Tauri commands 不动
proto/chathub/v1/*.proto                       # proto 合约不动
frontends/                                     # 前端不动
```

---

## Task 1: chathub-relay 空 crate skeleton

**Files:**

- Create: `backends/crates/chathub-relay/Cargo.toml`
- Create: `backends/crates/chathub-relay/src/main.rs`
- Create: `backends/crates/chathub-relay/src/lib.rs`
- Modify: `Cargo.toml`(workspace.members)

为什么:先确认新 crate 能进 workspace 编译,后续 task 不会卡在工程基建上。空 binary 打一行日志即退出。

- [ ] **Step 1.1: 创建 `backends/crates/chathub-relay/Cargo.toml`**

```toml
[package]
name = "chathub-relay"
version = "0.1.0"
edition = "2021"

[lib]
name = "chathub_relay"
path = "src/lib.rs"

[[bin]]
name = "chathub-relay"
path = "src/main.rs"

[dependencies]
anyhow       = { workspace = true }
tokio        = { workspace = true }
tracing      = { workspace = true }
```

- [ ] **Step 1.2: 创建 `backends/crates/chathub-relay/src/lib.rs`**

```rust
//! chathub-relay — Rust gRPC gateway (Plan 5 walking skeleton).
//!
//! 模块组织(后续 task 填):
//!   - config / error / jwt / router / downstream
//!   - storage::{sessions, seqs, events, kv, migrations}
//!   - auth_service / hub_service / push
//!
//! Plan 5 walking skeleton 只跑 in-process,不暴露稳定 public API。
```

- [ ] **Step 1.3: 创建 `backends/crates/chathub-relay/src/main.rs`**

```rust
//! chathub-relay binary entrypoint(Task 1 占位)。后续 task 在此装配
//! tonic + axum + storage + signer。

#[tokio::main(flavor = "multi_thread")]
async fn main() -> anyhow::Result<()> {
    tracing::info!("relay starting (skeleton stub)");
    Ok(())
}
```

- [ ] **Step 1.4: 在 root `Cargo.toml` 的 `[workspace] members` 末尾追加新 crate**

把原本的:

```toml
members = [
  "backends",
  "backends/crates/chathub-proto",
  "backends/crates/chathub-state",
  "backends/crates/chathub-net",
]
```

改成:

```toml
members = [
  "backends",
  "backends/crates/chathub-proto",
  "backends/crates/chathub-state",
  "backends/crates/chathub-net",
  "backends/crates/chathub-relay",
]
```

- [ ] **Step 1.5: 验证 build**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo build -p chathub-relay
```

Expected: 成功;`target/debug/chathub-relay` 生成。

- [ ] **Step 1.6: 提交**

```bash
git add Cargo.toml backends/crates/chathub-relay/
git commit -m "$(cat <<'EOF'
feat(chathub-relay): add empty crate skeleton

- 新增 backends/crates/chathub-relay 子 crate(lib + bin)
- workspace.members 追加,与 Plan 1-4 4 个 crate 并列
- main.rs 仅 tracing::info!("relay starting") + Ok(())

后续 Plan 5 task 在此基础上填充 config / storage / jwt / router /
downstream / auth_service / hub_service / push。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: 接入新依赖(workspace + crate)

**Files:**

- Modify: `Cargo.toml`(repo root,`[workspace.dependencies]` 追加 10 条)
- Modify: `backends/crates/chathub-relay/Cargo.toml`(deps + dev-deps)

为什么:Plan 5 引入的所有第三方库必须先进 workspace.dependencies 池(项目规范),再由 crate 用 `{ workspace = true }` 引用。一次性入完,后续 task 不再动 Cargo.toml(仅 T6 / T8 / T9 / T16 / T21 触发功能集成,不动版本)。

- [ ] **Step 2.1: 在 root `Cargo.toml` 的 `[workspace.dependencies]` 末尾追加**

```toml
# Plan 5 新增 ----
axum               = "0.7"
tower              = "0.4"
tower-http         = { version = "0.5", features = ["trace"] }
jsonwebtoken       = "9"
ring               = "0.17"
reqwest            = { version = "0.12", default-features = false, features = ["json", "rustls-tls"] }
serde_json         = "1"
hmac               = "0.12"
sha2               = "0.10"
hex                = "0.4"
tracing-subscriber = { version = "0.3", features = ["env-filter", "fmt"] }
# Plan 5 dev-only ----
wiremock           = "0.6"
tokio-stream       = "0.1"
tempfile           = "3"
```

- [ ] **Step 2.2: 改 `backends/crates/chathub-relay/Cargo.toml`** 覆盖为完整版

```toml
[package]
name = "chathub-relay"
version = "0.1.0"
edition = "2021"

[lib]
name = "chathub_relay"
path = "src/lib.rs"

[[bin]]
name = "chathub-relay"
path = "src/main.rs"

[dependencies]
# workspace 复用
anyhow             = { workspace = true }
thiserror          = { workspace = true }
tokio              = { workspace = true }
tracing            = { workspace = true }
tracing-subscriber = { workspace = true }
serde              = { workspace = true }
serde_json         = { workspace = true }
bytes              = { workspace = true }
prost              = { workspace = true }
tonic              = { workspace = true }
parking_lot        = { workspace = true }
rusqlite           = { workspace = true }
deadpool-sqlite    = { workspace = true }
rusqlite_migration = { workspace = true }
uuid               = { workspace = true }

# Plan 5 新引
axum               = { workspace = true }
tower              = { workspace = true }
tower-http         = { workspace = true }
jsonwebtoken       = { workspace = true }
ring               = { workspace = true }
reqwest            = { workspace = true }
hmac               = { workspace = true }
sha2               = { workspace = true }
hex                = { workspace = true }

# 同 workspace 内 codegen
chathub-proto      = { path = "../chathub-proto" }

[dev-dependencies]
wiremock     = { workspace = true }
tempfile     = { workspace = true }
tokio-stream = { workspace = true }
# 反向用 Plan 1-4 的 HubClient 当 e2e 测试 client
chathub-net  = { path = "../chathub-net" }
chathub-state = { path = "../chathub-state" }
```

- [ ] **Step 2.3: 验证编译**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo check -p chathub-relay
```

Expected: 成功(可能首次拉取依赖较慢)。warn 允许;error 0。

- [ ] **Step 2.4: 验证 workspace 仍全编**

```bash
cargo check --workspace
```

Expected: 整个 workspace(5 个 crate)成功。

- [ ] **Step 2.5: 提交**

```bash
git add Cargo.toml backends/crates/chathub-relay/Cargo.toml Cargo.lock
git commit -m "$(cat <<'EOF'
feat(chathub-relay): wire new workspace + crate deps

- workspace.dependencies 追加 10 条(axum/tower/tower-http/jsonwebtoken/
  ring/reqwest/serde_json/hmac/sha2/hex/tracing-subscriber)+ 3 条 dev-only
  (wiremock/tokio-stream/tempfile)
- chathub-relay/Cargo.toml 通过 `{ workspace = true }` 引用全部依赖
- dev-deps 额外引 chathub-net + chathub-state(e2e 反向用 HubClient)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Config::from_env + 必填校验

**Files:**

- Create: `backends/crates/chathub-relay/src/config.rs`
- Modify: `backends/crates/chathub-relay/src/lib.rs`(`pub mod config;`)

为什么:spec §11 列了 12 个 env vars。先把 Config 起来,后续 T4 storage、T6 jwt、T9 auth_service、T16 push 都从这里读。3 个必填(`RELAY_PUSH_SECRET` / `RELAY_DOWNSTREAM_URL` / `RELAY_REFRESH_HASH_PEPPER`),9 个有默认。

- [ ] **Step 3.1 (RED): 创建 `backends/crates/chathub-relay/src/config.rs`**

```rust
//! Config — relay 启动配置;`from_env()` 读 12 个 env var(spec §11.1)。
//! 必填(无默认):RELAY_PUSH_SECRET / RELAY_DOWNSTREAM_URL / RELAY_REFRESH_HASH_PEPPER

use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

#[derive(thiserror::Error, Debug)]
pub enum ConfigError {
    #[error("missing required env var: {0}")]
    Missing(&'static str),
    #[error("invalid env var {var}: {message}")]
    Invalid {
        var: &'static str,
        message: String,
    },
}

#[derive(Clone, Debug)]
pub struct Config {
    pub grpc_addr: SocketAddr,
    pub push_addr: SocketAddr,
    pub db_path: PathBuf,
    pub downstream_url: String,
    pub downstream_secret: String,
    pub push_secret: String,
    pub jwt_private_pem: Option<String>,
    pub jwt_kid: Option<String>,
    pub issuer: String,
    pub access_ttl: Duration,
    pub refresh_ttl: Duration,
    pub refresh_hash_pepper: String,
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        Ok(Self {
            grpc_addr: parse_addr_or("RELAY_GRPC_ADDR", "127.0.0.1:50051")?,
            push_addr: parse_addr_or("RELAY_PUSH_ADDR", "127.0.0.1:50052")?,
            db_path: std::env::var("RELAY_DB_PATH")
                .unwrap_or_else(|_| "./relay.db".into())
                .into(),
            downstream_url: required("RELAY_DOWNSTREAM_URL")?,
            downstream_secret: std::env::var("RELAY_DOWNSTREAM_SECRET").unwrap_or_default(),
            push_secret: required("RELAY_PUSH_SECRET")?,
            jwt_private_pem: std::env::var("RELAY_JWT_PRIVATE_PEM").ok(),
            jwt_kid: std::env::var("RELAY_JWT_KID").ok(),
            issuer: std::env::var("RELAY_ISSUER").unwrap_or_else(|_| "chathub-relay".into()),
            access_ttl: Duration::from_secs(parse_u64_or("RELAY_ACCESS_TTL_SECS", 1800)?),
            refresh_ttl: Duration::from_secs(parse_u64_or("RELAY_REFRESH_TTL_SECS", 2_592_000)?),
            refresh_hash_pepper: required("RELAY_REFRESH_HASH_PEPPER")?,
        })
    }
}

fn required(var: &'static str) -> Result<String, ConfigError> {
    std::env::var(var)
        .ok()
        .filter(|s| !s.is_empty())
        .ok_or(ConfigError::Missing(var))
}

fn parse_addr_or(var: &'static str, default: &str) -> Result<SocketAddr, ConfigError> {
    let raw = std::env::var(var).unwrap_or_else(|_| default.into());
    raw.parse().map_err(|e: std::net::AddrParseError| ConfigError::Invalid {
        var,
        message: e.to_string(),
    })
}

fn parse_u64_or(var: &'static str, default: u64) -> Result<u64, ConfigError> {
    match std::env::var(var) {
        Ok(s) => s.parse().map_err(|e: std::num::ParseIntError| ConfigError::Invalid {
            var,
            message: e.to_string(),
        }),
        Err(_) => Ok(default),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 把 `from_env` 的全部必填/可选都置成确定值。
    /// 注意:`std::env::set_var` 在多线程测试下不安全,本模块 #[cfg(test)] 使用
    /// `serial_test::serial` 等不在 walking skeleton 范围;改用 lock 保证单线程。
    static ENV_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

    fn clear_all() {
        for k in [
            "RELAY_GRPC_ADDR", "RELAY_PUSH_ADDR", "RELAY_DB_PATH",
            "RELAY_DOWNSTREAM_URL", "RELAY_DOWNSTREAM_SECRET", "RELAY_PUSH_SECRET",
            "RELAY_JWT_PRIVATE_PEM", "RELAY_JWT_KID", "RELAY_ISSUER",
            "RELAY_ACCESS_TTL_SECS", "RELAY_REFRESH_TTL_SECS", "RELAY_REFRESH_HASH_PEPPER",
        ] {
            std::env::remove_var(k);
        }
    }

    #[test]
    fn from_env_happy_path_uses_defaults_for_optional() {
        let _g = ENV_LOCK.lock();
        clear_all();
        std::env::set_var("RELAY_PUSH_SECRET", "ps");
        std::env::set_var("RELAY_DOWNSTREAM_URL", "http://dn.local");
        std::env::set_var("RELAY_REFRESH_HASH_PEPPER", "p".repeat(64));

        let cfg = Config::from_env().expect("config");
        assert_eq!(cfg.grpc_addr.to_string(), "127.0.0.1:50051");
        assert_eq!(cfg.push_addr.to_string(), "127.0.0.1:50052");
        assert_eq!(cfg.issuer, "chathub-relay");
        assert_eq!(cfg.access_ttl, Duration::from_secs(1800));
        assert_eq!(cfg.refresh_ttl, Duration::from_secs(2_592_000));
        assert_eq!(cfg.push_secret, "ps");
        assert!(cfg.jwt_private_pem.is_none());
        clear_all();
    }

    #[test]
    fn from_env_missing_push_secret_errors() {
        let _g = ENV_LOCK.lock();
        clear_all();
        std::env::set_var("RELAY_DOWNSTREAM_URL", "http://dn.local");
        std::env::set_var("RELAY_REFRESH_HASH_PEPPER", "p".repeat(64));
        // PUSH_SECRET 故意不设
        let err = Config::from_env().unwrap_err();
        match err {
            ConfigError::Missing(v) => assert_eq!(v, "RELAY_PUSH_SECRET"),
            other => panic!("wrong variant: {other:?}"),
        }
        clear_all();
    }

    #[test]
    fn from_env_invalid_grpc_addr_errors() {
        let _g = ENV_LOCK.lock();
        clear_all();
        std::env::set_var("RELAY_PUSH_SECRET", "ps");
        std::env::set_var("RELAY_DOWNSTREAM_URL", "http://dn.local");
        std::env::set_var("RELAY_REFRESH_HASH_PEPPER", "p".repeat(64));
        std::env::set_var("RELAY_GRPC_ADDR", "not-an-addr");
        let err = Config::from_env().unwrap_err();
        match err {
            ConfigError::Invalid { var, .. } => assert_eq!(var, "RELAY_GRPC_ADDR"),
            other => panic!("wrong: {other:?}"),
        }
        clear_all();
    }
}
```

- [ ] **Step 3.2: 把 `pub mod config;` 加进 `backends/crates/chathub-relay/src/lib.rs`**

```rust
//! chathub-relay — Rust gRPC gateway (Plan 5 walking skeleton).
pub mod config;
```

- [ ] **Step 3.3 (GREEN): 跑单测**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo test -p chathub-relay --lib config::tests
```

Expected:

```
running 3 tests
test config::tests::from_env_happy_path_uses_defaults_for_optional ... ok
test config::tests::from_env_missing_push_secret_errors ... ok
test config::tests::from_env_invalid_grpc_addr_errors ... ok

test result: ok. 3 passed; 0 failed
```

- [ ] **Step 3.4: 提交**

```bash
git add backends/crates/chathub-relay/src/config.rs backends/crates/chathub-relay/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(chathub-relay): Config::from_env with required-env validation

- 12 env vars(spec §11.1):3 必填 + 9 可选(带默认)
- 必填:RELAY_PUSH_SECRET / RELAY_DOWNSTREAM_URL / RELAY_REFRESH_HASH_PEPPER
- ConfigError{Missing, Invalid}
- 3 单测:happy + missing-required + invalid-addr;set_var 用 ENV_LOCK 串行

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Storage::open + 4 表 migration

**Files:**

- Create: `backends/crates/chathub-relay/migrations/001_initial.sql`
- Create: `backends/crates/chathub-relay/src/storage/mod.rs`
- Create: `backends/crates/chathub-relay/src/storage/migrations.rs`
- Modify: `backends/crates/chathub-relay/src/lib.rs`(`pub mod storage;`)

为什么:T5/T7/T15/T16 都依赖 4 张表 + `deadpool_sqlite::Pool`。WAL + synchronous=NORMAL 是 walking skeleton 默认(spec §12.4)。

- [ ] **Step 4.1: 创建 `backends/crates/chathub-relay/migrations/001_initial.sql`(对应 spec §5)**

```sql
-- 001_initial.sql — Plan 5 schema:sessions / seq_counters / events ring / kv
CREATE TABLE sessions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  refresh_exp_ms INTEGER NOT NULL,
  kicked_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(user_id, device_id)
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE seq_counters(
  wecom_account_id TEXT PRIMARY KEY,
  next_seq INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE events(
  wecom_account_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  payload BLOB NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(wecom_account_id, seq)
);

CREATE TABLE kv(
  key TEXT PRIMARY KEY,
  value BLOB NOT NULL
);
```

- [ ] **Step 4.2: 创建 `backends/crates/chathub-relay/src/storage/migrations.rs`**

```rust
//! 内嵌迁移 SQL,由 rusqlite_migration 应用。

use rusqlite_migration::{Migrations, M};

const M001: &str = include_str!("../../migrations/001_initial.sql");

pub fn migrations() -> Migrations<'static> {
    Migrations::new(vec![M::up(M001)])
}
```

- [ ] **Step 4.3: 创建 `backends/crates/chathub-relay/src/storage/mod.rs`**

```rust
//! Storage — deadpool_sqlite::Pool 包装 + 启动时跑迁移 + PRAGMA WAL。

pub mod migrations;

use deadpool_sqlite::{Config as PoolCfg, Pool, Runtime};
use std::path::Path;

#[derive(thiserror::Error, Debug)]
pub enum StorageError {
    #[error("pool: {0}")]
    Pool(String),
    #[error("interact: {0}")]
    Interact(String),
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("migration: {0}")]
    Migration(#[from] rusqlite_migration::Error),
}

#[derive(Clone)]
pub struct Storage {
    pool: Pool,
}

impl Storage {
    pub async fn open(db_path: impl AsRef<Path>) -> Result<Self, StorageError> {
        let cfg = PoolCfg::new(db_path.as_ref().to_path_buf());
        let pool = cfg
            .create_pool(Runtime::Tokio1)
            .map_err(|e| StorageError::Pool(e.to_string()))?;

        // PRAGMA + migrations 在同一个 connection 里跑
        let conn = pool.get().await.map_err(|e| StorageError::Pool(e.to_string()))?;
        conn.interact(|c| -> Result<(), StorageError> {
            c.pragma_update(None, "journal_mode", "WAL")?;
            c.pragma_update(None, "synchronous", "NORMAL")?;
            c.pragma_update(None, "foreign_keys", "ON")?;
            migrations::migrations().to_latest(c)?;
            Ok(())
        })
        .await
        .map_err(|e| StorageError::Interact(e.to_string()))??;

        Ok(Self { pool })
    }

    pub fn pool(&self) -> &Pool {
        &self.pool
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn open_creates_four_tables() {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("t.db");
        let storage = Storage::open(&db).await.expect("open");

        let conn = storage.pool().get().await.unwrap();
        let names = conn
            .interact(|c| -> Result<Vec<String>, rusqlite::Error> {
                let mut stmt = c.prepare(
                    "SELECT name FROM sqlite_master \
                     WHERE type='table' AND name NOT LIKE 'sqlite_%' \
                     ORDER BY name",
                )?;
                let rows = stmt
                    .query_map([], |r| r.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(rows)
            })
            .await
            .unwrap()
            .unwrap();

        // 4 业务表 + rusqlite_migration 的 1 张元数据表
        assert!(names.contains(&"sessions".to_string()));
        assert!(names.contains(&"seq_counters".to_string()));
        assert!(names.contains(&"events".to_string()));
        assert!(names.contains(&"kv".to_string()));
    }

    #[tokio::test]
    async fn reopen_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("t.db");
        let _ = Storage::open(&db).await.unwrap();
        // 第二次 open 应当不报错(migrations.to_latest 幂等)
        let _ = Storage::open(&db).await.unwrap();
    }
}
```

- [ ] **Step 4.4: 在 `backends/crates/chathub-relay/src/lib.rs` 加模块导出**

```rust
//! chathub-relay — Rust gRPC gateway (Plan 5 walking skeleton).
pub mod config;
pub mod storage;
```

- [ ] **Step 4.5 (GREEN): 跑单测**

```bash
cargo test -p chathub-relay --lib storage::tests
```

Expected:

```
running 2 tests
test storage::tests::open_creates_four_tables ... ok
test storage::tests::reopen_is_idempotent ... ok
test result: ok. 2 passed; 0 failed
```

- [ ] **Step 4.6: 提交**

```bash
git add backends/crates/chathub-relay/migrations/ \
        backends/crates/chathub-relay/src/storage/ \
        backends/crates/chathub-relay/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(chathub-relay): Storage::open + 4-table migration (WAL)

- migrations/001_initial.sql:sessions / seq_counters / events / kv
- Storage 包 deadpool_sqlite::Pool;open() PRAGMA WAL + synchronous=NORMAL
- rusqlite_migration::Migrations::to_latest 启动跑一次
- 2 单测:四表 query sqlite_master 验证 / reopen 幂等

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: storage::sessions + HMAC-SHA256 helper

**Files:**

- Create: `backends/crates/chathub-relay/src/storage/sessions.rs`
- Modify: `backends/crates/chathub-relay/src/storage/mod.rs`(`pub mod sessions;`)

为什么:T9 login / T10 refresh+logout 直接依赖。`refresh_token_hash` 是 HMAC-SHA256(pepper, token) 的 hex(spec §5 + §6.3)。**不用 argon2**(opaque 32B 高熵 token,无需慢哈希;refresh 是热路径)。

- [ ] **Step 5.1: 创建 `backends/crates/chathub-relay/src/storage/sessions.rs`**

```rust
//! sessions 表:upsert / find_by_refresh_hash / delete / mark_kicked +
//! `hash_refresh_token(pepper, token) -> hex`(HMAC-SHA256)。

use super::{Storage, StorageError};
use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// HMAC-SHA256(pepper, refresh_token) → 64-char hex
pub fn hash_refresh_token(pepper: &str, token: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(pepper.as_bytes())
        .expect("HMAC accepts any key length");
    mac.update(token.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

#[derive(Clone, Debug, PartialEq)]
pub struct Session {
    pub id: i64,
    pub user_id: String,
    pub device_id: String,
    pub refresh_token_hash: String,
    pub refresh_exp_ms: i64,
    pub kicked_at_ms: Option<i64>,
    pub created_at_ms: i64,
}

#[derive(Clone)]
pub struct SessionStore {
    storage: Storage,
}

impl SessionStore {
    pub fn new(storage: Storage) -> Self {
        Self { storage }
    }

    /// UPSERT by (user_id, device_id):同 device 重登覆盖 hash + exp + kicked=NULL。
    pub async fn upsert(
        &self,
        user_id: &str,
        device_id: &str,
        refresh_token_hash: &str,
        refresh_exp_ms: i64,
        created_at_ms: i64,
    ) -> Result<(), StorageError> {
        let u = user_id.to_string();
        let d = device_id.to_string();
        let h = refresh_token_hash.to_string();
        let conn = self
            .storage
            .pool()
            .get()
            .await
            .map_err(|e| StorageError::Pool(e.to_string()))?;
        conn.interact(move |c| -> Result<(), rusqlite::Error> {
            c.execute(
                "INSERT INTO sessions(user_id, device_id, refresh_token_hash, refresh_exp_ms, kicked_at_ms, created_at_ms) \
                 VALUES(?1, ?2, ?3, ?4, NULL, ?5) \
                 ON CONFLICT(user_id, device_id) DO UPDATE SET \
                   refresh_token_hash=excluded.refresh_token_hash, \
                   refresh_exp_ms=excluded.refresh_exp_ms, \
                   kicked_at_ms=NULL",
                rusqlite::params![u, d, h, refresh_exp_ms, created_at_ms],
            )?;
            Ok(())
        })
        .await
        .map_err(|e| StorageError::Interact(e.to_string()))??;
        Ok(())
    }

    pub async fn find_by_refresh_hash(
        &self,
        refresh_token_hash: &str,
    ) -> Result<Option<Session>, StorageError> {
        let h = refresh_token_hash.to_string();
        let conn = self
            .storage
            .pool()
            .get()
            .await
            .map_err(|e| StorageError::Pool(e.to_string()))?;
        let row = conn
            .interact(move |c| -> Result<Option<Session>, rusqlite::Error> {
                let mut stmt = c.prepare(
                    "SELECT id, user_id, device_id, refresh_token_hash, refresh_exp_ms, \
                            kicked_at_ms, created_at_ms \
                     FROM sessions WHERE refresh_token_hash = ?1",
                )?;
                let mut rows = stmt.query(rusqlite::params![h])?;
                if let Some(r) = rows.next()? {
                    Ok(Some(Session {
                        id: r.get(0)?,
                        user_id: r.get(1)?,
                        device_id: r.get(2)?,
                        refresh_token_hash: r.get(3)?,
                        refresh_exp_ms: r.get(4)?,
                        kicked_at_ms: r.get(5)?,
                        created_at_ms: r.get(6)?,
                    }))
                } else {
                    Ok(None)
                }
            })
            .await
            .map_err(|e| StorageError::Interact(e.to_string()))??;
        Ok(row)
    }

    pub async fn delete(&self, refresh_token_hash: &str) -> Result<(), StorageError> {
        let h = refresh_token_hash.to_string();
        let conn = self
            .storage
            .pool()
            .get()
            .await
            .map_err(|e| StorageError::Pool(e.to_string()))?;
        conn.interact(move |c| -> Result<(), rusqlite::Error> {
            c.execute(
                "DELETE FROM sessions WHERE refresh_token_hash = ?1",
                rusqlite::params![h],
            )?;
            Ok(())
        })
        .await
        .map_err(|e| StorageError::Interact(e.to_string()))??;
        Ok(())
    }

    pub async fn mark_kicked(
        &self,
        user_id: &str,
        device_id: &str,
        kicked_at_ms: i64,
    ) -> Result<(), StorageError> {
        let u = user_id.to_string();
        let d = device_id.to_string();
        let conn = self
            .storage
            .pool()
            .get()
            .await
            .map_err(|e| StorageError::Pool(e.to_string()))?;
        conn.interact(move |c| -> Result<(), rusqlite::Error> {
            c.execute(
                "UPDATE sessions SET kicked_at_ms = ?3 \
                 WHERE user_id = ?1 AND device_id = ?2",
                rusqlite::params![u, d, kicked_at_ms],
            )?;
            Ok(())
        })
        .await
        .map_err(|e| StorageError::Interact(e.to_string()))??;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn make() -> SessionStore {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("t.db");
        let storage = Storage::open(&db).await.unwrap();
        // 保留 tempdir 直到测试结束 — leak 即可,test 进程结束自动清
        std::mem::forget(tmp);
        SessionStore::new(storage)
    }

    #[test]
    fn hmac_is_deterministic_and_pepper_dependent() {
        let a = hash_refresh_token("pepperA", "rt-1");
        let b = hash_refresh_token("pepperA", "rt-1");
        let c = hash_refresh_token("pepperB", "rt-1");
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_eq!(a.len(), 64); // hex of 32 bytes
    }

    #[tokio::test]
    async fn upsert_then_find_round_trip() {
        let store = make().await;
        let h = hash_refresh_token("p", "rt-1");
        store.upsert("u1", "dev-1", &h, 1_700_000_000_000, 1_699_000_000_000).await.unwrap();
        let s = store.find_by_refresh_hash(&h).await.unwrap().expect("session");
        assert_eq!(s.user_id, "u1");
        assert_eq!(s.device_id, "dev-1");
        assert!(s.kicked_at_ms.is_none());
    }

    #[tokio::test]
    async fn delete_makes_find_return_none() {
        let store = make().await;
        let h = hash_refresh_token("p", "rt-1");
        store.upsert("u1", "dev-1", &h, 1, 1).await.unwrap();
        store.delete(&h).await.unwrap();
        assert!(store.find_by_refresh_hash(&h).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn mark_kicked_sets_tombstone() {
        let store = make().await;
        let h = hash_refresh_token("p", "rt-1");
        store.upsert("u1", "dev-1", &h, 1, 1).await.unwrap();
        store.mark_kicked("u1", "dev-1", 9_999).await.unwrap();
        let s = store.find_by_refresh_hash(&h).await.unwrap().expect("session");
        assert_eq!(s.kicked_at_ms, Some(9_999));
    }

    #[tokio::test]
    async fn upsert_same_user_device_replaces_hash() {
        let store = make().await;
        let h1 = hash_refresh_token("p", "rt-1");
        let h2 = hash_refresh_token("p", "rt-2");
        store.upsert("u1", "dev-1", &h1, 1, 1).await.unwrap();
        store.upsert("u1", "dev-1", &h2, 2, 2).await.unwrap();
        assert!(store.find_by_refresh_hash(&h1).await.unwrap().is_none());
        assert!(store.find_by_refresh_hash(&h2).await.unwrap().is_some());
    }
}
```

- [ ] **Step 5.2: 在 `backends/crates/chathub-relay/src/storage/mod.rs` 顶部追加**

```rust
pub mod sessions;
```

- [ ] **Step 5.3 (GREEN): 跑单测**

```bash
cargo test -p chathub-relay --lib storage::sessions::tests
```

Expected: 5 passed。

- [ ] **Step 5.4: 提交**

```bash
git add backends/crates/chathub-relay/src/storage/sessions.rs \
        backends/crates/chathub-relay/src/storage/mod.rs
git commit -m "$(cat <<'EOF'
feat(chathub-relay): SessionStore + HMAC-SHA256 refresh-hash

- hash_refresh_token(pepper, token) → hex(HMAC-SHA256;不用 argon2,opaque
  高熵 token 无需慢哈希)
- SessionStore::{upsert, find_by_refresh_hash, delete, mark_kicked}
- UPSERT by (user_id, device_id):同 device 重登覆盖
- 5 单测:HMAC 确定性 / round-trip / delete / kicked tombstone / replace

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: JWT Ed25519 Signer/Verifier + bootstrap

**Files:**

- Create: `backends/crates/chathub-relay/src/jwt.rs`
- Create: `backends/crates/chathub-relay/src/storage/kv.rs`
- Modify: `backends/crates/chathub-relay/src/storage/mod.rs`(`pub mod kv;`)
- Modify: `backends/crates/chathub-relay/src/lib.rs`(`pub mod jwt;`)

为什么:T9 login 直接调 `Signer::sign(claims)`,T11 JwtAuthInterceptor 直接调 `Verifier::verify(jwt)`。bootstrap 把私钥从 env 或 kv 表里加载,缺失则生成新对并入 kv 表持久化(spec §6.2)。

- [ ] **Step 6.1: 创建 `backends/crates/chathub-relay/src/storage/kv.rs`**

```rust
//! kv 表:单行 KV(JWT 私钥 PEM、kid)。

use super::{Storage, StorageError};

#[derive(Clone)]
pub struct KvStore {
    storage: Storage,
}

impl KvStore {
    pub fn new(storage: Storage) -> Self {
        Self { storage }
    }

    pub async fn get(&self, key: &str) -> Result<Option<Vec<u8>>, StorageError> {
        let k = key.to_string();
        let conn = self
            .storage
            .pool()
            .get()
            .await
            .map_err(|e| StorageError::Pool(e.to_string()))?;
        let v = conn
            .interact(move |c| -> Result<Option<Vec<u8>>, rusqlite::Error> {
                let mut stmt = c.prepare("SELECT value FROM kv WHERE key=?1")?;
                let mut rows = stmt.query(rusqlite::params![k])?;
                if let Some(r) = rows.next()? {
                    Ok(Some(r.get(0)?))
                } else {
                    Ok(None)
                }
            })
            .await
            .map_err(|e| StorageError::Interact(e.to_string()))??;
        Ok(v)
    }

    pub async fn put(&self, key: &str, value: Vec<u8>) -> Result<(), StorageError> {
        let k = key.to_string();
        let conn = self
            .storage
            .pool()
            .get()
            .await
            .map_err(|e| StorageError::Pool(e.to_string()))?;
        conn.interact(move |c| -> Result<(), rusqlite::Error> {
            c.execute(
                "INSERT INTO kv(key, value) VALUES(?1, ?2) \
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                rusqlite::params![k, value],
            )?;
            Ok(())
        })
        .await
        .map_err(|e| StorageError::Interact(e.to_string()))??;
        Ok(())
    }
}
```

- [ ] **Step 6.2: 在 `backends/crates/chathub-relay/src/storage/mod.rs` 追加** `pub mod kv;`

- [ ] **Step 6.3: 创建 `backends/crates/chathub-relay/src/jwt.rs`**

```rust
//! JWT Signer / Verifier(Ed25519,jsonwebtoken=9)。
//!
//! 算法决策:Ed25519 替代 Plan 2 spec 的 RS256(密钥 32B vs ~2KB,签快 10×、验快 30%;
//! 客户端 parse_upgrade_required 不校验 alg/kid,wire-compat)。
//!
//! bootstrap 优先级:env RELAY_JWT_PRIVATE_PEM → kv 表 "jwt_priv_pem" → 生成新对入 kv。

use crate::storage::{kv::KvStore, Storage};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation};
use ring::signature::{Ed25519KeyPair, KeyPair};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Claims {
    pub iss: String,
    pub sub: String,
    pub exp: i64,
    pub iat: i64,
    pub accounts: Vec<String>,
    pub device_id: String,
}

#[derive(thiserror::Error, Debug)]
pub enum JwtError {
    #[error("storage: {0}")]
    Storage(#[from] crate::storage::StorageError),
    #[error("jwt: {0}")]
    Jwt(#[from] jsonwebtoken::errors::Error),
    #[error("keygen: {0}")]
    KeyGen(String),
    #[error("invalid PEM")]
    InvalidPem,
    #[error("missing kid")]
    MissingKid,
}

const KV_PRIV_PEM: &str = "jwt_priv_pem";
const KV_KID: &str = "jwt_kid";

#[derive(Clone)]
pub struct Signer {
    inner: Arc<Inner>,
}

struct Inner {
    encoding: EncodingKey,
    decoding: DecodingKey,
    kid: String,
    issuer: String,
}

#[derive(Clone)]
pub struct Verifier {
    inner: Arc<Inner>,
}

impl Signer {
    /// bootstrap:env PEM > kv 表 > 生成。
    pub async fn bootstrap(
        storage: &Storage,
        env_pem: Option<&str>,
        env_kid: Option<&str>,
        issuer: &str,
    ) -> Result<Self, JwtError> {
        let kv = KvStore::new(storage.clone());
        let (pem, kid) = match env_pem {
            Some(p) => (
                p.to_string(),
                env_kid.unwrap_or("env-key").to_string(),
            ),
            None => {
                if let (Some(p), Some(k)) = (kv.get(KV_PRIV_PEM).await?, kv.get(KV_KID).await?) {
                    (
                        String::from_utf8(p).map_err(|_| JwtError::InvalidPem)?,
                        String::from_utf8(k).map_err(|_| JwtError::InvalidPem)?,
                    )
                } else {
                    let (pem, kid) = generate_ed25519_pem()?;
                    kv.put(KV_PRIV_PEM, pem.as_bytes().to_vec()).await?;
                    kv.put(KV_KID, kid.as_bytes().to_vec()).await?;
                    (pem, kid)
                }
            }
        };

        let encoding = EncodingKey::from_ed_pem(pem.as_bytes())?;
        // jsonwebtoken 9 解码 ed25519 公钥需要单独 PEM;最简单是从 ring 私钥推公钥再编码为 PEM。
        // 这里 trick:私钥 PEM 内部含公钥;jsonwebtoken 也接受同一个 PEM 当 DecodingKey
        // (`DecodingKey::from_ed_pem` 解析 SubjectPublicKeyInfo;我们额外生成纯公钥 PEM)。
        let public_pem = derive_public_pem_from_pkcs8_pem(&pem)?;
        let decoding = DecodingKey::from_ed_pem(public_pem.as_bytes())?;

        Ok(Self {
            inner: Arc::new(Inner {
                encoding,
                decoding,
                kid,
                issuer: issuer.to_string(),
            }),
        })
    }

    pub fn verifier(&self) -> Verifier {
        Verifier {
            inner: self.inner.clone(),
        }
    }

    pub fn issuer(&self) -> &str {
        &self.inner.issuer
    }

    pub fn sign(&self, claims: &Claims) -> Result<String, JwtError> {
        let mut header = Header::new(Algorithm::EdDSA);
        header.kid = Some(self.inner.kid.clone());
        Ok(jsonwebtoken::encode(&header, claims, &self.inner.encoding)?)
    }

    /// 工具:用当前 signer 配置构造 Claims(now/exp 自动)
    pub fn make_claims(
        &self,
        user_id: &str,
        accounts: Vec<String>,
        device_id: &str,
        ttl_secs: i64,
    ) -> Claims {
        let now = unix_now();
        Claims {
            iss: self.inner.issuer.clone(),
            sub: user_id.to_string(),
            exp: now + ttl_secs,
            iat: now,
            accounts,
            device_id: device_id.to_string(),
        }
    }
}

impl Verifier {
    pub fn verify(&self, token: &str) -> Result<Claims, JwtError> {
        let mut v = Validation::new(Algorithm::EdDSA);
        v.set_issuer(&[&self.inner.issuer]);
        let data = jsonwebtoken::decode::<Claims>(token, &self.inner.decoding, &v)?;
        Ok(data.claims)
    }
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 生成 Ed25519 PKCS#8 私钥 PEM(jsonwebtoken 9 EncodingKey 接受此格式)+ kid。
fn generate_ed25519_pem() -> Result<(String, String), JwtError> {
    let rng = ring::rand::SystemRandom::new();
    let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).map_err(|e| JwtError::KeyGen(e.to_string()))?;
    let pem = pkcs8_to_pem(pkcs8.as_ref());
    let kid = format!("k-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
    Ok((pem, kid))
}

/// 把 PKCS#8 DER 包成 PEM(BEGIN PRIVATE KEY)。
fn pkcs8_to_pem(der: &[u8]) -> String {
    use base64_lite as _;
    const B64: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    // 简化 base64 不引入外部依赖:用 ring 已传递依赖中的 untrusted? 否,直接手写。
    let mut s = String::new();
    let mut buf = [0u8; 4];
    let mut i = 0;
    while i + 3 <= der.len() {
        let v = ((der[i] as u32) << 16) | ((der[i + 1] as u32) << 8) | (der[i + 2] as u32);
        buf[0] = B64[((v >> 18) & 0x3f) as usize];
        buf[1] = B64[((v >> 12) & 0x3f) as usize];
        buf[2] = B64[((v >> 6) & 0x3f) as usize];
        buf[3] = B64[(v & 0x3f) as usize];
        s.push_str(std::str::from_utf8(&buf).unwrap());
        i += 3;
    }
    let rem = der.len() - i;
    if rem == 1 {
        let v = (der[i] as u32) << 16;
        buf[0] = B64[((v >> 18) & 0x3f) as usize];
        buf[1] = B64[((v >> 12) & 0x3f) as usize];
        s.push_str(std::str::from_utf8(&buf[..2]).unwrap());
        s.push_str("==");
    } else if rem == 2 {
        let v = ((der[i] as u32) << 16) | ((der[i + 1] as u32) << 8);
        buf[0] = B64[((v >> 18) & 0x3f) as usize];
        buf[1] = B64[((v >> 12) & 0x3f) as usize];
        buf[2] = B64[((v >> 6) & 0x3f) as usize];
        s.push_str(std::str::from_utf8(&buf[..3]).unwrap());
        s.push('=');
    }
    let mut out = String::from("-----BEGIN PRIVATE KEY-----\n");
    for chunk in s.as_bytes().chunks(64) {
        out.push_str(std::str::from_utf8(chunk).unwrap());
        out.push('\n');
    }
    out.push_str("-----END PRIVATE KEY-----\n");
    out
}

/// 注:`base64_lite` 在 dep 列表里不引入 — 上面 pkcs8_to_pem 手写 base64。
/// 真正实现可换 `base64 = "0.22"`(workspace 已经在 backends/Cargo.toml 用了),
/// 但 chathub-relay 这里为不再扩 workspace.deps,手写 ~20 行。
///
/// 从 PKCS#8 私钥 PEM 推 SubjectPublicKeyInfo 公钥 PEM。
fn derive_public_pem_from_pkcs8_pem(priv_pem: &str) -> Result<String, JwtError> {
    // ring Ed25519KeyPair::from_pkcs8 接受 DER;先把 PEM 拆 base64
    let der = decode_pem_body(priv_pem).ok_or(JwtError::InvalidPem)?;
    let kp = Ed25519KeyPair::from_pkcs8(&der).map_err(|e| JwtError::KeyGen(e.to_string()))?;
    let pub_bytes = kp.public_key().as_ref().to_vec();
    // 包成 SPKI:30 2a 30 05 06 03 2b 65 70 03 21 00 || pub
    let mut spki = Vec::with_capacity(44);
    spki.extend_from_slice(&[
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ]);
    spki.extend_from_slice(&pub_bytes);
    Ok(spki_der_to_pem(&spki))
}

fn decode_pem_body(pem: &str) -> Option<Vec<u8>> {
    let mut body = String::new();
    for line in pem.lines() {
        if line.starts_with("-----") {
            continue;
        }
        body.push_str(line.trim());
    }
    base64_decode_std(&body)
}

fn base64_decode_std(s: &str) -> Option<Vec<u8>> {
    const T: [i8; 128] = build_decode_table();
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let bytes = s.as_bytes();
    let mut i = 0;
    while i + 4 <= bytes.len() {
        let a = T[bytes[i] as usize];
        let b = T[bytes[i + 1] as usize];
        let c = T[bytes[i + 2] as usize];
        let d = T[bytes[i + 3] as usize];
        if a < 0 || b < 0 {
            return None;
        }
        out.push(((a as u32) << 2 | (b as u32) >> 4) as u8);
        if c >= 0 {
            out.push(((b as u32) << 4 | (c as u32) >> 2) as u8);
            if d >= 0 {
                out.push(((c as u32) << 6 | (d as u32)) as u8);
            }
        }
        i += 4;
    }
    Some(out)
}

const fn build_decode_table() -> [i8; 128] {
    let mut t = [-1i8; 128];
    let abc = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut i = 0;
    while i < 64 {
        t[abc[i] as usize] = i as i8;
        i += 1;
    }
    t
}

fn spki_der_to_pem(der: &[u8]) -> String {
    // 复用上面手写 base64 编码
    let mut s = String::new();
    const B64: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut buf = [0u8; 4];
    let mut i = 0;
    while i + 3 <= der.len() {
        let v = ((der[i] as u32) << 16) | ((der[i + 1] as u32) << 8) | (der[i + 2] as u32);
        buf[0] = B64[((v >> 18) & 0x3f) as usize];
        buf[1] = B64[((v >> 12) & 0x3f) as usize];
        buf[2] = B64[((v >> 6) & 0x3f) as usize];
        buf[3] = B64[(v & 0x3f) as usize];
        s.push_str(std::str::from_utf8(&buf).unwrap());
        i += 3;
    }
    let rem = der.len() - i;
    if rem == 1 {
        let v = (der[i] as u32) << 16;
        buf[0] = B64[((v >> 18) & 0x3f) as usize];
        buf[1] = B64[((v >> 12) & 0x3f) as usize];
        s.push_str(std::str::from_utf8(&buf[..2]).unwrap());
        s.push_str("==");
    } else if rem == 2 {
        let v = ((der[i] as u32) << 16) | ((der[i + 1] as u32) << 8);
        buf[0] = B64[((v >> 18) & 0x3f) as usize];
        buf[1] = B64[((v >> 12) & 0x3f) as usize];
        buf[2] = B64[((v >> 6) & 0x3f) as usize];
        s.push_str(std::str::from_utf8(&buf[..3]).unwrap());
        s.push('=');
    }
    let mut out = String::from("-----BEGIN PUBLIC KEY-----\n");
    for chunk in s.as_bytes().chunks(64) {
        out.push_str(std::str::from_utf8(chunk).unwrap());
        out.push('\n');
    }
    out.push_str("-----END PUBLIC KEY-----\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn fresh_signer() -> Signer {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("t.db");
        let storage = Storage::open(&db).await.unwrap();
        std::mem::forget(tmp);
        Signer::bootstrap(&storage, None, None, "chathub-relay")
            .await
            .expect("bootstrap")
    }

    #[tokio::test]
    async fn sign_then_verify_round_trip() {
        let signer = fresh_signer().await;
        let claims = signer.make_claims("u1", vec!["wa-1".into()], "dev-1", 1800);
        let tok = signer.sign(&claims).unwrap();
        let got = signer.verifier().verify(&tok).unwrap();
        assert_eq!(got, claims);
    }

    #[tokio::test]
    async fn tampered_token_fails_verify() {
        let signer = fresh_signer().await;
        let claims = signer.make_claims("u1", vec![], "dev-1", 1800);
        let mut tok = signer.sign(&claims).unwrap();
        // 翻转最后一个 base64 字符(签名段)
        let last = tok.pop().unwrap();
        tok.push(if last == 'A' { 'B' } else { 'A' });
        assert!(signer.verifier().verify(&tok).is_err());
    }

    #[tokio::test]
    async fn expired_token_fails_verify() {
        let signer = fresh_signer().await;
        let mut claims = signer.make_claims("u1", vec![], "dev-1", 0);
        claims.exp = unix_now() - 10; // 已过期 10 秒
        claims.iat = claims.exp - 10;
        let tok = signer.sign(&claims).unwrap();
        let err = signer.verifier().verify(&tok).unwrap_err();
        match err {
            JwtError::Jwt(_) => {}
            other => panic!("wrong: {other:?}"),
        }
    }

    #[tokio::test]
    async fn wrong_issuer_fails_verify() {
        let signer = fresh_signer().await;
        let mut claims = signer.make_claims("u1", vec![], "dev-1", 1800);
        claims.iss = "evil".into();
        let tok = signer.sign(&claims).unwrap();
        assert!(signer.verifier().verify(&tok).is_err());
    }

    #[tokio::test]
    async fn bootstrap_persists_key_across_restart() {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("t.db");
        let storage1 = Storage::open(&db).await.unwrap();
        let s1 = Signer::bootstrap(&storage1, None, None, "iss").await.unwrap();
        let claims = s1.make_claims("u1", vec![], "dev-1", 1800);
        let tok = s1.sign(&claims).unwrap();
        drop(s1);
        drop(storage1);

        // 重新打开同 DB
        let storage2 = Storage::open(&db).await.unwrap();
        let s2 = Signer::bootstrap(&storage2, None, None, "iss").await.unwrap();
        let got = s2.verifier().verify(&tok).unwrap();
        assert_eq!(got, claims);
    }
}
```

> **实现决策**:为不再扩 `workspace.dependencies`,手写 ~30 行 base64(只用于 PEM 包装,不在 RPC 热路径)。如果团队偏好用 crate,可改为 `workspace.dependencies` 加 `base64 = "0.22"`。

- [ ] **Step 6.4: 在 `backends/crates/chathub-relay/src/lib.rs` 追加** `pub mod jwt;`

- [ ] **Step 6.5 (GREEN): 跑单测**

```bash
cargo test -p chathub-relay --lib jwt::tests
```

Expected: 5 passed(round-trip / 篡改 / 过期 / 错 iss / restart 持久化)。

- [ ] **Step 6.6: 提交**

```bash
git add backends/crates/chathub-relay/src/jwt.rs \
        backends/crates/chathub-relay/src/storage/kv.rs \
        backends/crates/chathub-relay/src/storage/mod.rs \
        backends/crates/chathub-relay/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(chathub-relay): Ed25519 JWT Signer/Verifier + KV-persisted keypair

- jwt.rs:Claims{iss,sub,exp,iat,accounts,device_id};Signer/Verifier
  走 jsonwebtoken 9 EdDSA;header.kid 注入
- bootstrap 优先级:env PEM > kv 表 > ring 生成新对入 kv(restart 持久)
- 手写 PKCS#8/SPKI base64 PEM(避免扩 workspace.deps base64)
- storage/kv.rs:KvStore{get, put}
- 5 单测:sign/verify round-trip / 篡改 / 过期 / 错 iss / restart 持久

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: seqs + events ring buffer

**Files:**

- Create: `backends/crates/chathub-relay/src/storage/seqs.rs`
- Create: `backends/crates/chathub-relay/src/storage/events.rs`
- Modify: `backends/crates/chathub-relay/src/storage/mod.rs`

为什么:T15 Subscribe replay 直接 `events.replay_after`;T16 push 直接 `seqs.next_seq` + `events.record`。`UPDATE...RETURNING` 单语句原子,rusqlite bundled 3.40+ 已支持。Ring 修剪:每次 record 后 `DELETE WHERE seq <= max-1000`。

- [ ] **Step 7.1: 创建 `backends/crates/chathub-relay/src/storage/seqs.rs`**

```rust
//! seqs 仓:`next_seq(account)` 通过 `UPDATE...RETURNING` 单语句原子递增。

use super::{Storage, StorageError};

#[derive(Clone)]
pub struct SeqAllocator {
    storage: Storage,
}

impl SeqAllocator {
    pub fn new(storage: Storage) -> Self {
        Self { storage }
    }

    /// 原子分配 next_seq:不存在则插入 next_seq=2 并返回 1;存在则 +1 返回新值。
    pub async fn next_seq(&self, account_id: &str) -> Result<i64, StorageError> {
        let a = account_id.to_string();
        let conn = self
            .storage
            .pool()
            .get()
            .await
            .map_err(|e| StorageError::Pool(e.to_string()))?;
        let seq = conn
            .interact(move |c| -> Result<i64, rusqlite::Error> {
                // 单事务原子;UPSERT 用 RETURNING 拿到新值
                let tx = c.transaction()?;
                let assigned: i64 = tx.query_row(
                    "INSERT INTO seq_counters(wecom_account_id, next_seq) VALUES(?1, 2) \
                     ON CONFLICT(wecom_account_id) DO UPDATE SET next_seq=next_seq+1 \
                     RETURNING next_seq - 1",
                    rusqlite::params![a],
                    |r| r.get::<_, i64>(0),
                )?;
                tx.commit()?;
                Ok(assigned)
            })
            .await
            .map_err(|e| StorageError::Interact(e.to_string()))??;
        Ok(seq)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn make() -> SeqAllocator {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("t.db");
        let storage = Storage::open(&db).await.unwrap();
        std::mem::forget(tmp);
        SeqAllocator::new(storage)
    }

    #[tokio::test]
    async fn first_call_returns_one() {
        let alloc = make().await;
        assert_eq!(alloc.next_seq("wa-1").await.unwrap(), 1);
        assert_eq!(alloc.next_seq("wa-1").await.unwrap(), 2);
        assert_eq!(alloc.next_seq("wa-1").await.unwrap(), 3);
    }

    #[tokio::test]
    async fn different_accounts_independent() {
        let alloc = make().await;
        assert_eq!(alloc.next_seq("wa-1").await.unwrap(), 1);
        assert_eq!(alloc.next_seq("wa-2").await.unwrap(), 1);
        assert_eq!(alloc.next_seq("wa-1").await.unwrap(), 2);
    }

    #[tokio::test]
    async fn hundred_concurrent_no_gaps() {
        let alloc = make().await;
        let mut handles = Vec::new();
        for _ in 0..100 {
            let a = alloc.clone();
            handles.push(tokio::spawn(async move { a.next_seq("wa-1").await.unwrap() }));
        }
        let mut got: Vec<i64> = Vec::new();
        for h in handles {
            got.push(h.await.unwrap());
        }
        got.sort();
        assert_eq!(got, (1..=100).collect::<Vec<i64>>());
    }
}
```

- [ ] **Step 7.2: 创建 `backends/crates/chathub-relay/src/storage/events.rs`**

```rust
//! events 表(ring buffer):record / replay_after。
//! 每 account 保留最近 1000 条;每次 record 后修剪。

use super::{Storage, StorageError};

const RING_SIZE: i64 = 1000;

#[derive(Clone)]
pub struct EventStore {
    storage: Storage,
}

impl EventStore {
    pub fn new(storage: Storage) -> Self {
        Self { storage }
    }

    pub async fn record(
        &self,
        account_id: &str,
        seq: i64,
        payload: Vec<u8>,
        created_at_ms: i64,
    ) -> Result<(), StorageError> {
        let a = account_id.to_string();
        let conn = self
            .storage
            .pool()
            .get()
            .await
            .map_err(|e| StorageError::Pool(e.to_string()))?;
        conn.interact(move |c| -> Result<(), rusqlite::Error> {
            let tx = c.transaction()?;
            tx.execute(
                "INSERT INTO events(wecom_account_id, seq, payload, created_at_ms) \
                 VALUES(?1, ?2, ?3, ?4)",
                rusqlite::params![a, seq, payload, created_at_ms],
            )?;
            // ring 修剪
            tx.execute(
                "DELETE FROM events WHERE wecom_account_id = ?1 AND seq <= ?2 - ?3",
                rusqlite::params![a, seq, RING_SIZE],
            )?;
            tx.commit()?;
            Ok(())
        })
        .await
        .map_err(|e| StorageError::Interact(e.to_string()))??;
        Ok(())
    }

    /// 返回 seq > since 的 events,按 seq 升序,limit 限定。
    pub async fn replay_after(
        &self,
        account_id: &str,
        since: i64,
        limit: i64,
    ) -> Result<Vec<(i64, Vec<u8>)>, StorageError> {
        let a = account_id.to_string();
        let conn = self
            .storage
            .pool()
            .get()
            .await
            .map_err(|e| StorageError::Pool(e.to_string()))?;
        let rows = conn
            .interact(move |c| -> Result<Vec<(i64, Vec<u8>)>, rusqlite::Error> {
                let mut stmt = c.prepare(
                    "SELECT seq, payload FROM events \
                     WHERE wecom_account_id = ?1 AND seq > ?2 \
                     ORDER BY seq ASC LIMIT ?3",
                )?;
                let rows = stmt
                    .query_map(rusqlite::params![a, since, limit], |r| {
                        Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?))
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(rows)
            })
            .await
            .map_err(|e| StorageError::Interact(e.to_string()))??;
        Ok(rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn make() -> EventStore {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("t.db");
        let storage = Storage::open(&db).await.unwrap();
        std::mem::forget(tmp);
        EventStore::new(storage)
    }

    #[tokio::test]
    async fn record_then_replay_ascending() {
        let es = make().await;
        for s in 1..=5_i64 {
            es.record("wa-1", s, vec![s as u8], s).await.unwrap();
        }
        let out = es.replay_after("wa-1", 2, 200).await.unwrap();
        assert_eq!(out, vec![(3, vec![3]), (4, vec![4]), (5, vec![5])]);
    }

    #[tokio::test]
    async fn replay_respects_limit() {
        let es = make().await;
        for s in 1..=10_i64 {
            es.record("wa-1", s, vec![s as u8], s).await.unwrap();
        }
        let out = es.replay_after("wa-1", 0, 3).await.unwrap();
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].0, 1);
        assert_eq!(out[2].0, 3);
    }

    #[tokio::test]
    async fn replay_isolates_per_account() {
        let es = make().await;
        es.record("wa-1", 1, vec![1], 1).await.unwrap();
        es.record("wa-2", 1, vec![9], 1).await.unwrap();
        let out = es.replay_after("wa-1", 0, 200).await.unwrap();
        assert_eq!(out, vec![(1, vec![1])]);
    }

    #[tokio::test]
    async fn ring_trims_to_thousand() {
        let es = make().await;
        for s in 1..=1100_i64 {
            es.record("wa-1", s, vec![0xAB], s).await.unwrap();
        }
        // 余下应为 seq 101..=1100
        let all = es.replay_after("wa-1", 0, 2000).await.unwrap();
        assert_eq!(all.len(), 1000);
        assert_eq!(all.first().unwrap().0, 101);
        assert_eq!(all.last().unwrap().0, 1100);
    }
}
```

- [ ] **Step 7.3: 在 `backends/crates/chathub-relay/src/storage/mod.rs` 追加**

```rust
pub mod events;
pub mod seqs;
```

- [ ] **Step 7.4 (GREEN): 跑单测**

```bash
cargo test -p chathub-relay --lib storage::seqs::tests storage::events::tests
```

Expected: 3 + 4 = 7 passed。

- [ ] **Step 7.5: 提交**

```bash
git add backends/crates/chathub-relay/src/storage/
git commit -m "$(cat <<'EOF'
feat(chathub-relay): SeqAllocator (UPSERT+RETURNING) + EventStore ring buffer

- seqs.rs:next_seq(account) 单事务 UPSERT...RETURNING,首次返 1
- events.rs:record(account, seq, payload) + 每次 record 后修剪 ≤1000;
  replay_after(account, since, limit) 升序 + per-account 隔离
- 7 单测:next_seq 单调 / 100 并发无空洞 / 多账号独立 /
  replay 升序 / limit / ring 修剪到 1000

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: DownstreamClient + RelayError + verify_user

**Files:**

- Create: `backends/crates/chathub-relay/src/error.rs`
- Create: `backends/crates/chathub-relay/src/downstream.rs`
- Modify: `backends/crates/chathub-relay/src/lib.rs`

为什么:T9 login 调 `downstream.verify_user`,T18-T20 各自调 `send/recall/ack_read/fetch_history`。先把 reqwest client + 错误模型固化,后续 4 个 method 共用。

- [ ] **Step 8.1: 创建 `backends/crates/chathub-relay/src/error.rs`** (RelayError + into tonic::Status sanitize)

```rust
//! RelayError — relay 内部统一错误类型。
//! From<RelayError> for tonic::Status 用静态字符串,不透传下游 message(spec §12.5)。

use chathub_proto::v1::{error_detail, ErrorDetail, UpgradeRequired};
use prost::Message;

#[derive(thiserror::Error, Debug)]
pub enum RelayError {
    #[error("invalid credentials")]
    InvalidCreds,

    #[error("account disabled")]
    AccountDisabled,

    #[error("upgrade required (min={min_version})")]
    UpgradeRequired {
        min_version: String,
        download_url: String,
    },

    #[error("invalid argument")]
    InvalidArg,

    #[error("transient downstream")]
    Transient,

    #[error("internal")]
    Internal,

    #[error("storage: {0}")]
    Storage(#[from] crate::storage::StorageError),

    #[error("jwt: {0}")]
    Jwt(#[from] crate::jwt::JwtError),

    #[error("http: {0}")]
    Http(String),
}

impl From<RelayError> for tonic::Status {
    fn from(e: RelayError) -> Self {
        use tonic::{Code, Status};
        match e {
            RelayError::InvalidCreds => Status::unauthenticated("invalid credentials"),
            RelayError::AccountDisabled => Status::permission_denied("account disabled"),
            RelayError::UpgradeRequired {
                min_version,
                download_url,
            } => {
                let detail = ErrorDetail {
                    body: Some(error_detail::Body::Upgrade(UpgradeRequired {
                        min_client_version: min_version,
                        download_url,
                    })),
                };
                Status::with_details(
                    Code::FailedPrecondition,
                    "upgrade required",
                    detail.encode_to_vec().into(),
                )
            }
            RelayError::InvalidArg => Status::invalid_argument("invalid argument"),
            RelayError::Transient => Status::unavailable("downstream unavailable"),
            RelayError::Internal | RelayError::Http(_) | RelayError::Storage(_) | RelayError::Jwt(_) => {
                Status::internal("internal")
            }
        }
    }
}
```

- [ ] **Step 8.2: 创建 `backends/crates/chathub-relay/src/downstream.rs`**(只含 `verify_user`,T18/T19/T20 再补 send/recall/ack_read/fetch_history)

```rust
//! DownstreamClient — reqwest 封装下游 HTTP 合约(spec §9.2)。
//! 共用错误转化:HTTP code → RelayError。

use crate::error::RelayError;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Clone)]
pub struct DownstreamClient {
    base_url: String,
    secret: String,
    http: Client,
}

#[derive(Serialize)]
pub struct VerifyUserReq<'a> {
    pub username: &'a str,
    pub password: &'a str,
    pub device_id: &'a str,
    pub device_name: &'a str,
}

#[derive(Deserialize, Debug, Clone)]
pub struct VerifyUserResp {
    pub user_id: String,
    pub display_name: String,
    #[serde(default)]
    pub avatar_url: String,
    pub role: String,
    pub tenant_id: String,
    pub wecom_accounts: Vec<WecomAccount>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct WecomAccount {
    pub wecom_account_id: String,
    pub corp_id: String,
    pub agent_id: i64,
    pub display_name: String,
    pub enabled: bool,
}

#[derive(Deserialize, Debug)]
struct ErrPayload {
    code: String,
    #[serde(default)]
    min_version: String,
    #[serde(default)]
    download_url: String,
}

impl DownstreamClient {
    pub fn new(base_url: &str, secret: &str) -> Result<Self, RelayError> {
        let http = Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|e| RelayError::Http(e.to_string()))?;
        Ok(Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            secret: secret.to_string(),
            http,
        })
    }

    pub async fn verify_user(&self, req: VerifyUserReq<'_>) -> Result<VerifyUserResp, RelayError> {
        let url = format!("{}/v1/verify_user", self.base_url);
        let resp = self
            .http
            .post(&url)
            .bearer_auth(&self.secret)
            .json(&req)
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() || e.is_connect() {
                    RelayError::Transient
                } else {
                    RelayError::Http(e.to_string())
                }
            })?;
        translate(resp).await
    }
}

/// 通用响应翻译:200 → 反序列化 T;4xx/5xx → 映射错误。
pub(crate) async fn translate<T: for<'de> Deserialize<'de>>(
    resp: reqwest::Response,
) -> Result<T, RelayError> {
    let status = resp.status();
    if status.is_success() {
        let body = resp
            .json::<T>()
            .await
            .map_err(|e| RelayError::Http(e.to_string()))?;
        return Ok(body);
    }
    // 试着解析 {code, ...}
    let code = status.as_u16();
    let err: Option<ErrPayload> = resp.json().await.ok();
    match (code, err.as_ref().map(|e| e.code.as_str())) {
        (401, _) => Err(RelayError::InvalidCreds),
        (403, _) => Err(RelayError::AccountDisabled),
        (412, _) => {
            let (m, d) = err
                .map(|e| (e.min_version, e.download_url))
                .unwrap_or_default();
            Err(RelayError::UpgradeRequired {
                min_version: m,
                download_url: d,
            })
        }
        (400, _) => Err(RelayError::InvalidArg),
        (c, _) if c >= 500 => Err(RelayError::Transient),
        _ => Err(RelayError::Internal),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test(flavor = "multi_thread")]
    async fn verify_user_happy() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/verify_user"))
            .and(header("authorization", "Bearer dn-secret"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "user_id":"u-1","display_name":"D","role":"op","tenant_id":"t",
                "wecom_accounts":[{"wecom_account_id":"wa-1","corp_id":"c","agent_id":1,"display_name":"w","enabled":true}]
            })))
            .mount(&mock)
            .await;

        let client = DownstreamClient::new(&mock.uri(), "dn-secret").unwrap();
        let resp = client
            .verify_user(VerifyUserReq {
                username: "u",
                password: "p",
                device_id: "d1",
                device_name: "Mac",
            })
            .await
            .unwrap();
        assert_eq!(resp.user_id, "u-1");
        assert_eq!(resp.wecom_accounts.len(), 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn verify_user_401_maps_invalid_creds() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/verify_user"))
            .respond_with(
                ResponseTemplate::new(401).set_body_json(serde_json::json!({"code":"INVALID_CREDS"})),
            )
            .mount(&mock)
            .await;

        let client = DownstreamClient::new(&mock.uri(), "dn-secret").unwrap();
        let err = client
            .verify_user(VerifyUserReq {
                username: "u",
                password: "bad",
                device_id: "d1",
                device_name: "Mac",
            })
            .await
            .unwrap_err();
        assert!(matches!(err, RelayError::InvalidCreds));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn verify_user_503_maps_transient() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/verify_user"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&mock)
            .await;
        let client = DownstreamClient::new(&mock.uri(), "dn-secret").unwrap();
        let err = client
            .verify_user(VerifyUserReq {
                username: "u",
                password: "p",
                device_id: "d",
                device_name: "M",
            })
            .await
            .unwrap_err();
        assert!(matches!(err, RelayError::Transient));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn verify_user_412_maps_upgrade_required() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/verify_user"))
            .respond_with(ResponseTemplate::new(412).set_body_json(serde_json::json!({
                "code":"UPGRADE_REQUIRED","min_version":"1.5.0","download_url":"https://x/y"
            })))
            .mount(&mock)
            .await;
        let client = DownstreamClient::new(&mock.uri(), "dn-secret").unwrap();
        let err = client
            .verify_user(VerifyUserReq {
                username: "u",
                password: "p",
                device_id: "d",
                device_name: "M",
            })
            .await
            .unwrap_err();
        match err {
            RelayError::UpgradeRequired { min_version, .. } => assert_eq!(min_version, "1.5.0"),
            other => panic!("wrong: {other:?}"),
        }
    }
}
```

- [ ] **Step 8.3: 在 `backends/crates/chathub-relay/src/lib.rs` 追加**

```rust
pub mod downstream;
pub mod error;
```

- [ ] **Step 8.4 (GREEN): 跑单测**

```bash
cargo test -p chathub-relay --lib downstream::tests
```

Expected: 4 passed(必须 `#[tokio::test(flavor = "multi_thread")]`,否则 wiremock + reqwest 死锁)。

- [ ] **Step 8.5: 提交**

```bash
git add backends/crates/chathub-relay/src/error.rs \
        backends/crates/chathub-relay/src/downstream.rs \
        backends/crates/chathub-relay/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(chathub-relay): RelayError + DownstreamClient::verify_user

- error.rs:RelayError 7 variant + From<RelayError> for tonic::Status,
  sanitize 静态字符串(spec §10/§12.5)
- UpgradeRequired 走 Status::with_details + ErrorDetail.Upgrade(wire-compat
  Plan 2 客户端 parse_upgrade_required)
- downstream.rs:DownstreamClient(reqwest::Client, timeout 10s)
- verify_user + 通用 translate(): 401/403/412/400/5xx → RelayError
- 4 单测全部 #[tokio::test(flavor="multi_thread")];wiremock fixture

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: AuthSvc::login(in-process tonic + wiremock e2e)

**Files:**

- Create: `backends/crates/chathub-relay/src/auth_service.rs`
- Modify: `backends/crates/chathub-relay/src/lib.rs`(`pub mod auth_service;`)

为什么:把 verify_user → HMAC refresh → upsert session → sign JWT → LoginResponse 串成一条业务路径。客户端 `chathub-net::AuthClient::login` 调用此 method 应当返 LoginResponse。

- [ ] **Step 9.1: 创建 `backends/crates/chathub-relay/src/auth_service.rs`**

```rust
//! AuthSvc — server-side impl Auth(login / refresh_token / logout)。
//! AuthSvc 本身 **不挂 JWT 拦截器**(spec §10);仅 HubSvc 挂(T11)。

use crate::downstream::{DownstreamClient, VerifyUserReq};
use crate::error::RelayError;
use crate::jwt::Signer;
use crate::storage::sessions::{hash_refresh_token, SessionStore};
use chathub_proto::v1::auth_server::Auth;
use chathub_proto::v1::{
    LoginRequest, LoginResponse, LogoutRequest, LogoutResponse, RefreshTokenRequest,
    RefreshTokenResponse, UserProfile, WecomAccount,
};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tonic::{Request, Response, Status};

pub struct AuthSvc {
    pub downstream: Arc<DownstreamClient>,
    pub sessions: SessionStore,
    pub signer: Signer,
    pub pepper: String,
    pub access_ttl: Duration,
    pub refresh_ttl: Duration,
}

#[tonic::async_trait]
impl Auth for AuthSvc {
    async fn login(&self, req: Request<LoginRequest>) -> Result<Response<LoginResponse>, Status> {
        let r = req.into_inner();
        let resp = self
            .downstream
            .verify_user(VerifyUserReq {
                username: &r.username,
                password: &r.password,
                device_id: &r.device_id,
                device_name: &r.device_name,
            })
            .await
            .map_err(Status::from)?;

        let now_ms = now_ms();
        let refresh_token = mint_opaque();
        let refresh_hash = hash_refresh_token(&self.pepper, &refresh_token);
        let refresh_exp_ms = now_ms + self.refresh_ttl.as_millis() as i64;

        self.sessions
            .upsert(
                &resp.user_id,
                &r.device_id,
                &refresh_hash,
                refresh_exp_ms,
                now_ms,
            )
            .await
            .map_err(|e| Status::from(RelayError::from(e)))?;

        let accounts: Vec<String> = resp
            .wecom_accounts
            .iter()
            .map(|a| a.wecom_account_id.clone())
            .collect();
        let claims = self
            .signer
            .make_claims(&resp.user_id, accounts, &r.device_id, self.access_ttl.as_secs() as i64);
        let access_token = self
            .signer
            .sign(&claims)
            .map_err(|e| Status::from(RelayError::from(e)))?;
        let access_exp_ms = now_ms + self.access_ttl.as_millis() as i64;

        Ok(Response::new(LoginResponse {
            access_token,
            access_exp_ms,
            refresh_token,
            refresh_exp_ms,
            user: Some(UserProfile {
                user_id: resp.user_id,
                display_name: resp.display_name,
                avatar_url: resp.avatar_url,
                role: resp.role,
                tenant_id: resp.tenant_id,
            }),
            wecom_accounts: resp
                .wecom_accounts
                .into_iter()
                .map(|a| WecomAccount {
                    wecom_account_id: a.wecom_account_id,
                    corp_id: a.corp_id,
                    agent_id: a.agent_id as i32,
                    display_name: a.display_name,
                    enabled: a.enabled,
                })
                .collect(),
        }))
    }

    async fn refresh_token(
        &self,
        _req: Request<RefreshTokenRequest>,
    ) -> Result<Response<RefreshTokenResponse>, Status> {
        // T10 实现
        Err(Status::unimplemented("refresh_token: T10"))
    }

    async fn logout(
        &self,
        _req: Request<LogoutRequest>,
    ) -> Result<Response<LogoutResponse>, Status> {
        // T10 实现
        Err(Status::unimplemented("logout: T10"))
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn mint_opaque() -> String {
    // 32 bytes 高熵;UUIDv4 (16B) ×2 拼接,encode hex
    let a = uuid::Uuid::new_v4();
    let b = uuid::Uuid::new_v4();
    format!("{}{}", a.simple(), b.simple())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Storage;
    use chathub_proto::v1::auth_client::AuthClient;
    use chathub_proto::v1::auth_server::AuthServer;
    use std::net::SocketAddr;
    use tokio::net::TcpListener;
    use tokio_stream::wrappers::TcpListenerStream;
    use tonic::transport::{Endpoint, Server};
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    async fn spawn_auth(
        downstream_uri: &str,
        pepper: &str,
    ) -> (SocketAddr, tokio::task::JoinHandle<()>, Storage, Signer) {
        let tmp = tempfile::tempdir().unwrap();
        std::mem::forget(tmp.path().to_path_buf()); // 路径已 leak by tempdir 持续到测试退出
        let db = tmp.path().join("t.db");
        let storage = Storage::open(&db).await.unwrap();
        std::mem::forget(tmp);

        let signer = Signer::bootstrap(&storage, None, None, "chathub-relay")
            .await
            .unwrap();
        let sessions = SessionStore::new(storage.clone());
        let downstream = Arc::new(DownstreamClient::new(downstream_uri, "dn-secret").unwrap());

        let svc = AuthSvc {
            downstream,
            sessions,
            signer: signer.clone(),
            pepper: pepper.to_string(),
            access_ttl: Duration::from_secs(1800),
            refresh_ttl: Duration::from_secs(86400 * 30),
        };

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let stream = TcpListenerStream::new(listener);
        let handle = tokio::spawn(async move {
            let _ = Server::builder()
                .add_service(AuthServer::new(svc))
                .serve_with_incoming(stream)
                .await;
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        (addr, handle, storage, signer)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn login_happy_returns_token_and_user() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/verify_user"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "user_id":"u-7","display_name":"Alice","role":"op","tenant_id":"t-1",
                "wecom_accounts":[
                    {"wecom_account_id":"wa-1","corp_id":"c","agent_id":1,"display_name":"w","enabled":true}
                ]
            })))
            .mount(&mock)
            .await;
        let (addr, _h, _st, signer) = spawn_auth(&mock.uri(), "pep").await;
        let endpoint = Endpoint::from_shared(format!("http://{addr}")).unwrap();
        let mut client = AuthClient::connect(endpoint).await.unwrap();
        let resp = client
            .login(LoginRequest {
                username: "u".into(),
                password: "p".into(),
                device_id: "dev-A".into(),
                device_name: "Mac".into(),
            })
            .await
            .unwrap()
            .into_inner();

        assert!(!resp.access_token.is_empty());
        assert!(resp.access_exp_ms > 0);
        assert_eq!(resp.user.as_ref().unwrap().user_id, "u-7");
        // JWT 内部含 user_id + device_id + accounts
        let claims = signer.verifier().verify(&resp.access_token).unwrap();
        assert_eq!(claims.sub, "u-7");
        assert_eq!(claims.device_id, "dev-A");
        assert_eq!(claims.accounts, vec!["wa-1".to_string()]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn login_bad_creds_maps_unauthenticated() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/verify_user"))
            .respond_with(
                ResponseTemplate::new(401).set_body_json(serde_json::json!({"code":"INVALID_CREDS"})),
            )
            .mount(&mock)
            .await;
        let (addr, _h, _st, _s) = spawn_auth(&mock.uri(), "pep").await;
        let endpoint = Endpoint::from_shared(format!("http://{addr}")).unwrap();
        let mut client = AuthClient::connect(endpoint).await.unwrap();
        let st = client
            .login(LoginRequest {
                username: "u".into(),
                password: "wrong".into(),
                device_id: "dev-A".into(),
                device_name: "Mac".into(),
            })
            .await
            .unwrap_err();
        assert_eq!(st.code(), tonic::Code::Unauthenticated);
    }
}
```

- [ ] **Step 9.2: 在 `backends/crates/chathub-relay/src/lib.rs` 追加** `pub mod auth_service;`

- [ ] **Step 9.3 (GREEN): 跑单测**

```bash
cargo test -p chathub-relay --lib auth_service::tests
```

Expected: 2 passed。注意必须 multi_thread。

- [ ] **Step 9.4: 提交**

```bash
git add backends/crates/chathub-relay/src/auth_service.rs \
        backends/crates/chathub-relay/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(chathub-relay): AuthSvc::login (verify_user → HMAC → JWT)

- AuthSvc 装配:DownstreamClient + SessionStore + Signer + pepper + TTL
- login 流程:downstream.verify_user → mint opaque refresh → HMAC →
  sessions.upsert(user_id, device_id) → sign Ed25519 JWT(accounts 快照,
  device_id 注入)→ LoginResponse
- refresh_token / logout 暂 unimplemented(T10 补)
- 2 单测:happy(decode JWT 校 claim)+ 401→Unauthenticated

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: AuthSvc::refresh_token + logout

**Files:** Modify `backends/crates/chathub-relay/src/auth_service.rs`

为什么:闭合 Auth 全套。refresh 校 tombstone + exp,旋转 refresh token,重签 access(accounts 沿用 session 上次快照——Plan 5 不重拉下游,留 Plan 6+ 引 AccountStatus event)。logout best-effort delete。

- [ ] **Step 10.1: 把 `auth_service.rs` 中 refresh_token / logout 的 `unimplemented!` 替换为**

```rust
    async fn refresh_token(
        &self,
        req: Request<RefreshTokenRequest>,
    ) -> Result<Response<RefreshTokenResponse>, Status> {
        let r = req.into_inner();
        let hash = hash_refresh_token(&self.pepper, &r.refresh_token);
        let session = self
            .sessions
            .find_by_refresh_hash(&hash)
            .await
            .map_err(|e| Status::from(RelayError::from(e)))?
            .ok_or_else(|| Status::unauthenticated("invalid credentials"))?;

        if session.kicked_at_ms.is_some() {
            return Err(Status::unauthenticated("invalid credentials"));
        }
        let now_ms = now_ms();
        if session.refresh_exp_ms <= now_ms {
            return Err(Status::unauthenticated("invalid credentials"));
        }

        // 旋转 refresh
        let new_refresh = mint_opaque();
        let new_hash = hash_refresh_token(&self.pepper, &new_refresh);
        let new_exp = now_ms + self.refresh_ttl.as_millis() as i64;
        self.sessions
            .delete(&hash)
            .await
            .map_err(|e| Status::from(RelayError::from(e)))?;
        self.sessions
            .upsert(&session.user_id, &session.device_id, &new_hash, new_exp, now_ms)
            .await
            .map_err(|e| Status::from(RelayError::from(e)))?;

        // accounts 沿用上次快照(Plan 5 限制):JWT 旧 access 可能含 accounts,但 session 不存。
        // 简化做法:此处 accounts 空数组(Plan 6+ 引 AccountStatus event 同步;skeleton 允许)
        let claims = self.signer.make_claims(
            &session.user_id,
            vec![],
            &session.device_id,
            self.access_ttl.as_secs() as i64,
        );
        let access = self
            .signer
            .sign(&claims)
            .map_err(|e| Status::from(RelayError::from(e)))?;
        let access_exp_ms = now_ms + self.access_ttl.as_millis() as i64;

        Ok(Response::new(RefreshTokenResponse {
            access_token: access,
            access_exp_ms,
            refresh_token: new_refresh,
            refresh_exp_ms: new_exp,
        }))
    }

    async fn logout(
        &self,
        req: Request<LogoutRequest>,
    ) -> Result<Response<LogoutResponse>, Status> {
        let r = req.into_inner();
        let hash = hash_refresh_token(&self.pepper, &r.refresh_token);
        // best-effort:不存在也返 Ok
        let _ = self.sessions.delete(&hash).await;
        Ok(Response::new(LogoutResponse {}))
    }
```

- [ ] **Step 10.2: 在 `mod tests` 中追加 3 个测试**

```rust
    #[tokio::test(flavor = "multi_thread")]
    async fn refresh_happy_rotates_pair() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/verify_user"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "user_id":"u-7","display_name":"A","role":"op","tenant_id":"t",
                "wecom_accounts":[{"wecom_account_id":"wa-1","corp_id":"c","agent_id":1,"display_name":"w","enabled":true}]
            })))
            .mount(&mock).await;
        let (addr, _h, _st, _s) = spawn_auth(&mock.uri(), "pep").await;
        let ep = Endpoint::from_shared(format!("http://{addr}")).unwrap();
        let mut client = AuthClient::connect(ep).await.unwrap();
        let login = client
            .login(LoginRequest {
                username: "u".into(), password: "p".into(),
                device_id: "dev".into(), device_name: "M".into(),
            })
            .await.unwrap().into_inner();
        let rt1 = login.refresh_token.clone();
        let r = client
            .refresh_token(RefreshTokenRequest { refresh_token: rt1.clone() })
            .await.unwrap().into_inner();
        assert_ne!(r.refresh_token, rt1);
        assert!(!r.access_token.is_empty());
        // 旧 refresh 应当不再 work
        let st = client
            .refresh_token(RefreshTokenRequest { refresh_token: rt1 })
            .await.unwrap_err();
        assert_eq!(st.code(), tonic::Code::Unauthenticated);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn logout_then_refresh_unauthenticated() {
        let mock = MockServer::start().await;
        Mock::given(method("POST")).and(path("/v1/verify_user"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "user_id":"u-7","display_name":"A","role":"op","tenant_id":"t",
                "wecom_accounts":[]
            })))
            .mount(&mock).await;
        let (addr, _h, _st, _s) = spawn_auth(&mock.uri(), "pep").await;
        let ep = Endpoint::from_shared(format!("http://{addr}")).unwrap();
        let mut client = AuthClient::connect(ep).await.unwrap();
        let login = client.login(LoginRequest {
            username:"u".into(), password:"p".into(),
            device_id:"d".into(), device_name:"M".into() })
            .await.unwrap().into_inner();
        let _ = client.logout(LogoutRequest { refresh_token: login.refresh_token.clone() })
            .await.unwrap();
        let st = client.refresh_token(RefreshTokenRequest { refresh_token: login.refresh_token })
            .await.unwrap_err();
        assert_eq!(st.code(), tonic::Code::Unauthenticated);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn kicked_then_refresh_unauthenticated() {
        let mock = MockServer::start().await;
        Mock::given(method("POST")).and(path("/v1/verify_user"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "user_id":"u-7","display_name":"A","role":"op","tenant_id":"t",
                "wecom_accounts":[]
            })))
            .mount(&mock).await;
        let (addr, _h, storage, _s) = spawn_auth(&mock.uri(), "pep").await;
        let ep = Endpoint::from_shared(format!("http://{addr}")).unwrap();
        let mut client = AuthClient::connect(ep).await.unwrap();
        let login = client.login(LoginRequest {
            username:"u".into(), password:"p".into(),
            device_id:"d-X".into(), device_name:"M".into() })
            .await.unwrap().into_inner();
        // 后台直接 mark_kicked
        SessionStore::new(storage).mark_kicked("u-7", "d-X", 99_999).await.unwrap();
        let st = client.refresh_token(RefreshTokenRequest { refresh_token: login.refresh_token })
            .await.unwrap_err();
        assert_eq!(st.code(), tonic::Code::Unauthenticated);
    }
```

- [ ] **Step 10.3 (GREEN): 跑全套 auth 单测**

```bash
cargo test -p chathub-relay --lib auth_service::tests
```

Expected: 5 passed(2 from T9 + 3 from T10)。

- [ ] **Step 10.4: 提交**

```bash
git add backends/crates/chathub-relay/src/auth_service.rs
git commit -m "$(cat <<'EOF'
feat(chathub-relay): AuthSvc::refresh_token + logout(tombstone + 旋转)

- refresh:HMAC 找 session → tombstone/exp 检查 → delete 旧 + upsert 新 +
  重签 access(accounts 留空,等 Plan 6+ AccountStatus event 同步)
- logout:best-effort delete-by-hash
- +3 单测:happy 旋转 + 旧 token 失效 / logout→refresh→Unauthenticated /
  kicked tombstone→refresh→Unauthenticated

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: JwtAuthInterceptor + 协议版本校验

**Files:** Create `backends/crates/chathub-relay/src/hub_service.rs`(先放 interceptor + UserCtx,impl Hub 留 T13)

为什么:HubService 必须经此 interceptor,验 JWT 取 UserCtx 入 extensions;同时校 `chathub-protocol-version` metadata = "1",否则 FailedPrecondition + UpgradeRequired。

- [ ] **Step 11.1: 创建 `backends/crates/chathub-relay/src/hub_service.rs`**

```rust
//! HubSvc + JwtAuthInterceptor。
//! interceptor 仅挂在 HubServer(spec §10);AuthService 自己不挂。

use crate::error::RelayError;
use crate::jwt::{Claims, Verifier};
use tonic::metadata::MetadataValue;
use tonic::service::Interceptor;
use tonic::{Request, Status};

#[derive(Clone, Debug)]
pub struct UserCtx {
    pub user_id: String,
    pub accounts: Vec<String>,
    pub device_id: String,
}

#[derive(Clone)]
pub struct JwtAuthInterceptor {
    verifier: Verifier,
}

impl JwtAuthInterceptor {
    pub fn new(verifier: Verifier) -> Self {
        Self { verifier }
    }
}

impl Interceptor for JwtAuthInterceptor {
    fn call(&mut self, mut req: Request<()>) -> Result<Request<()>, Status> {
        // 1. 校协议版本
        let ver = req
            .metadata()
            .get("chathub-protocol-version")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if ver != "1" {
            return Err(Status::from(RelayError::UpgradeRequired {
                min_version: "1.0.0".into(),
                download_url: "".into(),
            }));
        }
        // 2. 校 Bearer
        let auth = req
            .metadata()
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| Status::unauthenticated("missing bearer"))?;
        let token = auth
            .strip_prefix("Bearer ")
            .ok_or_else(|| Status::unauthenticated("missing bearer"))?;
        let claims: Claims = self
            .verifier
            .verify(token)
            .map_err(|_| Status::unauthenticated("invalid token"))?;
        req.extensions_mut().insert(UserCtx {
            user_id: claims.sub,
            accounts: claims.accounts,
            device_id: claims.device_id,
        });
        let _ = MetadataValue::try_from("ok"); // suppress unused
        Ok(req)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jwt::Signer;
    use crate::storage::Storage;

    async fn fresh_verifier() -> (Signer, Verifier) {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("t.db");
        let storage = Storage::open(&db).await.unwrap();
        std::mem::forget(tmp);
        let signer = Signer::bootstrap(&storage, None, None, "chathub-relay").await.unwrap();
        let v = signer.verifier();
        (signer, v)
    }

    fn req_with(meta: &[(&'static str, &str)]) -> Request<()> {
        let mut r = Request::new(());
        for (k, v) in meta {
            r.metadata_mut().insert(*k, v.parse().unwrap());
        }
        r
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn rejects_missing_protocol_version() {
        let (_s, v) = fresh_verifier().await;
        let mut ic = JwtAuthInterceptor::new(v);
        let r = req_with(&[("authorization", "Bearer x")]);
        let err = ic.call(r).unwrap_err();
        assert_eq!(err.code(), tonic::Code::FailedPrecondition);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn rejects_missing_bearer() {
        let (_s, v) = fresh_verifier().await;
        let mut ic = JwtAuthInterceptor::new(v);
        let r = req_with(&[("chathub-protocol-version", "1")]);
        let err = ic.call(r).unwrap_err();
        assert_eq!(err.code(), tonic::Code::Unauthenticated);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn rejects_bad_signature() {
        let (_s, v) = fresh_verifier().await;
        let mut ic = JwtAuthInterceptor::new(v);
        let r = req_with(&[
            ("chathub-protocol-version", "1"),
            ("authorization", "Bearer not-a-jwt"),
        ]);
        let err = ic.call(r).unwrap_err();
        assert_eq!(err.code(), tonic::Code::Unauthenticated);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn accepts_valid_and_injects_ctx() {
        let (signer, v) = fresh_verifier().await;
        let mut ic = JwtAuthInterceptor::new(v);
        let claims = signer.make_claims("u-1", vec!["wa-1".into()], "dev-A", 1800);
        let tok = signer.sign(&claims).unwrap();
        let r = req_with(&[
            ("chathub-protocol-version", "1"),
            ("authorization", &format!("Bearer {tok}")),
        ]);
        let out = ic.call(r).unwrap();
        let ctx = out.extensions().get::<UserCtx>().unwrap();
        assert_eq!(ctx.user_id, "u-1");
        assert_eq!(ctx.device_id, "dev-A");
        assert_eq!(ctx.accounts, vec!["wa-1".to_string()]);
    }
}
```

- [ ] **Step 11.2:** `lib.rs` 追加 `pub mod hub_service;`

- [ ] **Step 11.3 (GREEN):** `cargo test -p chathub-relay --lib hub_service::tests` → 4 passed

- [ ] **Step 11.4: 提交**

```bash
git add backends/crates/chathub-relay/src/hub_service.rs \
        backends/crates/chathub-relay/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(chathub-relay): JwtAuthInterceptor + UserCtx + 协议版本校验

- JwtAuthInterceptor::call:检 chathub-protocol-version=="1" 否则
  FailedPrecondition + ErrorDetail.Upgrade;再校 Bearer JWT;成功后
  把 UserCtx{user_id, accounts, device_id} 注入 request.extensions()
- 仅挂在 HubServer(spec §10);AuthService 自己不挂
- 4 单测:missing version / missing bearer / bad-sig / happy-inject ctx

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: ConnectionRouter

**Files:** Create `backends/crates/chathub-relay/src/router.rs`,`lib.rs` 加 `pub mod router;`

为什么:T13 Subscribe 直接调 `router.register`;T16 push handler 调 `router.fanout`。**锁序固定:`users.write()` before `accounts.write()`**(spec §12.1)。

- [ ] **Step 12.1: 创建 `backends/crates/chathub-relay/src/router.rs`**

```rust
//! ConnectionRouter — 单实例 in-process 路由表(spec §7)。
//!
//! **锁序固定**:`Router.users.write()` BEFORE `Router.accounts.write()`,严禁反向。
//! `fanout` 只取 `accounts.read()`,与 register/drop_stream 互不阻塞。

use chathub_proto::v1::ServerEvent;
use parking_lot::RwLock;
use std::collections::HashMap;
use tokio::sync::mpsc;
use tonic::Status;

pub type EventSender = mpsc::Sender<Result<ServerEvent, Status>>;

#[derive(Clone, Debug)]
pub struct StreamTicket {
    pub user_id: String,
    pub device_id: String,
    pub accounts: Vec<String>,
}

#[derive(Clone)]
struct ChannelEntry {
    tx: EventSender,
    user_id: String,
    device_id: String,
}

#[derive(Clone)]
struct UserStream {
    device_id: String,
    accounts: Vec<String>,
    tx: EventSender,
}

#[derive(thiserror::Error, Debug)]
pub enum RouterError {
    #[error("no stream")]
    NoStream,
    #[error("backpressure")]
    Backpressure,
}

/// register 返回:被踢的 prev sender 列表 + 是否为"真多端踢"(kicked=true)
/// 同 device 自重连:Vec 非空但 kicked=false。
pub struct RegisterOutcome {
    pub prev_senders: Vec<EventSender>,
    pub kicked: bool,
}

pub struct Router {
    users: RwLock<HashMap<String, UserStream>>,
    accounts: RwLock<HashMap<String, ChannelEntry>>,
}

impl Default for Router {
    fn default() -> Self {
        Self::new()
    }
}

impl Router {
    pub fn new() -> Self {
        Self {
            users: RwLock::new(HashMap::new()),
            accounts: RwLock::new(HashMap::new()),
        }
    }

    /// **锁序:users 先,accounts 后**。
    pub fn register(&self, t: StreamTicket, tx: EventSender) -> RegisterOutcome {
        let mut users = self.users.write();
        let mut accounts = self.accounts.write();

        let mut prev_senders = Vec::new();
        let mut kicked = false;
        if let Some(existing) = users.get(&t.user_id) {
            kicked = existing.device_id != t.device_id;
            prev_senders.push(existing.tx.clone());
            for acc in &existing.accounts {
                accounts.remove(acc);
            }
        }
        users.insert(
            t.user_id.clone(),
            UserStream {
                device_id: t.device_id.clone(),
                accounts: t.accounts.clone(),
                tx: tx.clone(),
            },
        );
        for acc in &t.accounts {
            accounts.insert(
                acc.clone(),
                ChannelEntry {
                    tx: tx.clone(),
                    user_id: t.user_id.clone(),
                    device_id: t.device_id.clone(),
                },
            );
        }
        RegisterOutcome { prev_senders, kicked }
    }

    /// fanout:try_send 非阻塞。Full → Backpressure;Closed/无映射 → NoStream。
    pub fn fanout(&self, account_id: &str, event: ServerEvent) -> Result<(), RouterError> {
        let entry = {
            let accounts = self.accounts.read();
            accounts.get(account_id).cloned()
        };
        match entry {
            None => Err(RouterError::NoStream),
            Some(e) => match e.tx.try_send(Ok(event)) {
                Ok(()) => Ok(()),
                Err(mpsc::error::TrySendError::Closed(_)) => Err(RouterError::NoStream),
                Err(mpsc::error::TrySendError::Full(_)) => Err(RouterError::Backpressure),
            },
        }
    }

    pub fn drop_stream(&self, user_id: &str, device_id: &str) {
        let mut users = self.users.write();
        let mut accounts = self.accounts.write();
        let should_remove = users.get(user_id).map(|u| u.device_id == device_id).unwrap_or(false);
        if should_remove {
            if let Some(u) = users.remove(user_id) {
                for acc in u.accounts {
                    accounts.remove(&acc);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chathub_proto::v1::server_event::Body;
    use chathub_proto::v1::{SystemSignal, system_signal::Kind};

    fn evt(seq: i64) -> ServerEvent {
        ServerEvent {
            wecom_account_id: "wa-1".into(),
            seq,
            body: Some(Body::System(SystemSignal {
                kind: Kind::Unspecified as i32,
                detail: String::new(),
            })),
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn register_first_returns_no_prev() {
        let r = Router::new();
        let (tx, _rx) = mpsc::channel(32);
        let out = r.register(
            StreamTicket {
                user_id: "u".into(),
                device_id: "d".into(),
                accounts: vec!["wa-1".into()],
            },
            tx,
        );
        assert!(out.prev_senders.is_empty());
        assert!(!out.kicked);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn register_different_device_marks_kicked() {
        let r = Router::new();
        let (tx1, _rx1) = mpsc::channel(32);
        let (tx2, _rx2) = mpsc::channel(32);
        r.register(
            StreamTicket { user_id: "u".into(), device_id: "d1".into(), accounts: vec!["wa-1".into()] },
            tx1,
        );
        let out = r.register(
            StreamTicket { user_id: "u".into(), device_id: "d2".into(), accounts: vec!["wa-1".into()] },
            tx2,
        );
        assert_eq!(out.prev_senders.len(), 1);
        assert!(out.kicked);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn register_same_device_silent_replace() {
        let r = Router::new();
        let (tx1, _rx1) = mpsc::channel(32);
        let (tx2, _rx2) = mpsc::channel(32);
        r.register(
            StreamTicket { user_id: "u".into(), device_id: "d".into(), accounts: vec!["wa-1".into()] },
            tx1,
        );
        let out = r.register(
            StreamTicket { user_id: "u".into(), device_id: "d".into(), accounts: vec!["wa-1".into()] },
            tx2,
        );
        assert_eq!(out.prev_senders.len(), 1);
        assert!(!out.kicked);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn fanout_unknown_account_no_stream() {
        let r = Router::new();
        let err = r.fanout("wa-X", evt(1)).unwrap_err();
        assert!(matches!(err, RouterError::NoStream));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn fanout_to_registered_delivers() {
        let r = Router::new();
        let (tx, mut rx) = mpsc::channel(32);
        r.register(
            StreamTicket { user_id: "u".into(), device_id: "d".into(), accounts: vec!["wa-1".into()] },
            tx,
        );
        r.fanout("wa-1", evt(5)).unwrap();
        let got = rx.recv().await.unwrap().unwrap();
        assert_eq!(got.seq, 5);
    }
}
```

- [ ] **Step 12.2 (GREEN):** `cargo test -p chathub-relay --lib router::tests` → 5 passed

- [ ] **Step 12.3: 提交**

```bash
git add backends/crates/chathub-relay/src/router.rs backends/crates/chathub-relay/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(chathub-relay): ConnectionRouter(parking_lot RwLock,锁序固定)

- Router{users, accounts} 双 RwLock<HashMap>;锁序 users 先 accounts 后
- register 返 RegisterOutcome{prev_senders, kicked};同 device 静默替换
  (kicked=false),不同 device 标 kicked=true(供 T14 决定要不要发 KICKED)
- fanout 用 try_send:Full → Backpressure / Closed/无映射 → NoStream
- drop_stream 守 device_id(避免别人覆盖后被错误清)
- 5 单测覆盖 register/KICKED/同 device 静默/fanout no_stream/fanout 成功

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: HubSvc::subscribe 基础版(无 replay 无 KICKED)

**Files:** Modify `backends/crates/chathub-relay/src/hub_service.rs`

为什么:先把 Subscribe 的核心骨架(取 UserCtx → channel(32) → register → return ReceiverStream)装配好,T14/T15 在此基础上加 KICKED + replay。

- [ ] **Step 13.1: 在 `hub_service.rs` 顶部 import 后追加 HubSvc 与 impl Hub::subscribe**

```rust
use crate::router::{Router, StreamTicket};
use crate::storage::seqs::SeqAllocator;
use crate::storage::events::EventStore;
use chathub_proto::v1::hub_server::Hub;
use chathub_proto::v1::{
    AckReadRequest, AckReadResponse, FetchHistoryRequest, FetchHistoryResponse,
    RecallRequest, RecallResponse, SendRequest, SendResponse, ServerEvent, SubscribeRequest,
};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tonic::{Response, async_trait};

pub struct HubSvc {
    pub router: Arc<Router>,
    pub seqs: SeqAllocator,
    pub events: EventStore,
    pub downstream: Arc<crate::downstream::DownstreamClient>,
}

#[async_trait]
impl Hub for HubSvc {
    type SubscribeStream = ReceiverStream<Result<ServerEvent, Status>>;

    async fn subscribe(
        &self,
        req: Request<SubscribeRequest>,
    ) -> Result<Response<Self::SubscribeStream>, Status> {
        let ctx = req
            .extensions()
            .get::<UserCtx>()
            .cloned()
            .ok_or_else(|| Status::unauthenticated("missing ctx"))?;
        let _since = req.into_inner().since_seqs; // T15 才用
        let (tx, rx) = mpsc::channel(32);
        let _out = self.router.register(
            StreamTicket {
                user_id: ctx.user_id,
                device_id: ctx.device_id,
                accounts: ctx.accounts,
            },
            tx,
        );
        Ok(Response::new(ReceiverStream::new(rx)))
    }

    async fn send(&self, _req: Request<SendRequest>) -> Result<Response<SendResponse>, Status> {
        Err(Status::unimplemented("send: T18"))
    }
    async fn recall(&self, _req: Request<RecallRequest>) -> Result<Response<RecallResponse>, Status> {
        Err(Status::unimplemented("recall: T19"))
    }
    async fn ack_read(&self, _req: Request<AckReadRequest>) -> Result<Response<AckReadResponse>, Status> {
        Err(Status::unimplemented("ack_read: T19"))
    }
    async fn fetch_history(
        &self,
        _req: Request<FetchHistoryRequest>,
    ) -> Result<Response<FetchHistoryResponse>, Status> {
        Err(Status::unimplemented("fetch_history: T20"))
    }
}
```

- [ ] **Step 13.2: 在 `mod tests` 追加 subscribe 单测(in-process tonic + 直接 Router.fanout 推事件)**

```rust
    use chathub_proto::v1::hub_client::HubClient as RawHubClient;
    use chathub_proto::v1::hub_server::HubServer;
    use chathub_proto::v1::SubscribeRequest;
    use crate::router::Router;
    use crate::storage::events::EventStore;
    use crate::storage::seqs::SeqAllocator;
    use crate::storage::Storage;
    use tokio_stream::StreamExt;
    use tonic::transport::{Endpoint, Server};
    use tokio_stream::wrappers::TcpListenerStream;

    async fn spawn_hub() -> (
        SocketAddr,
        Arc<Router>,
        Signer,
    ) {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("t.db");
        let storage = Storage::open(&db).await.unwrap();
        std::mem::forget(tmp);
        let signer = Signer::bootstrap(&storage, None, None, "chathub-relay").await.unwrap();
        let router = Arc::new(Router::new());
        let svc = HubSvc {
            router: router.clone(),
            seqs: SeqAllocator::new(storage.clone()),
            events: EventStore::new(storage.clone()),
            downstream: Arc::new(
                crate::downstream::DownstreamClient::new("http://127.0.0.1:9", "x").unwrap(),
            ),
        };
        let ic = JwtAuthInterceptor::new(signer.verifier());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let stream = TcpListenerStream::new(listener);
        tokio::spawn(async move {
            let _ = Server::builder()
                .add_service(HubServer::with_interceptor(svc, ic))
                .serve_with_incoming(stream)
                .await;
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        (addr, router, signer)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn subscribe_receives_pushed_event() {
        let (addr, router, signer) = spawn_hub().await;
        let claims = signer.make_claims("u-1", vec!["wa-1".into()], "dev-A", 1800);
        let tok = signer.sign(&claims).unwrap();
        let ep = Endpoint::from_shared(format!("http://{addr}")).unwrap();
        let channel = ep.connect().await.unwrap();
        let mut client = RawHubClient::with_interceptor(channel, {
            let tok = tok.clone();
            move |mut r: tonic::Request<()>| -> Result<tonic::Request<()>, Status> {
                r.metadata_mut().insert("chathub-protocol-version", "1".parse().unwrap());
                r.metadata_mut().insert(
                    "authorization",
                    format!("Bearer {tok}").parse().unwrap(),
                );
                Ok(r)
            }
        });
        let stream = client
            .subscribe(SubscribeRequest { since_seqs: Default::default() })
            .await
            .unwrap()
            .into_inner();
        // 让 server-side register 落定
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;

        let evt = ServerEvent {
            wecom_account_id: "wa-1".into(),
            seq: 7,
            body: Some(chathub_proto::v1::server_event::Body::System(
                chathub_proto::v1::SystemSignal {
                    kind: chathub_proto::v1::system_signal::Kind::Unspecified as i32,
                    detail: "hi".into(),
                },
            )),
        };
        router.fanout("wa-1", evt.clone()).unwrap();

        let mut stream = std::pin::pin!(stream);
        let got = stream.next().await.unwrap().unwrap();
        assert_eq!(got.seq, 7);
    }
```

- [ ] **Step 13.3 (GREEN):** `cargo test -p chathub-relay --lib hub_service::tests::subscribe_receives_pushed_event` → 1 passed

- [ ] **Step 13.4: 提交**

```bash
git add backends/crates/chathub-relay/src/hub_service.rs
git commit -m "$(cat <<'EOF'
feat(chathub-relay): HubSvc::subscribe 基础版(无 replay/KICKED)

- impl Hub for HubSvc:subscribe 走 UserCtx → mpsc::channel(32) →
  Router.register → ReceiverStream
- send/recall/ack_read/fetch_history 暂 unimplemented(T18-T20 补)
- 1 单测:in-process tonic + interceptor 注入 Bearer;Router.fanout 推
  ServerEvent → 客户端 stream 收到 seq=7

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: KICKED 分支(多端不同 device 才发 SystemSignal)

**Files:** Modify `backends/crates/chathub-relay/src/hub_service.rs`(subscribe + helper)

为什么:`register` 返回 `prev_senders` + `kicked` 标志(T12 已有)。kicked=true 时给 prev 发 `SystemSignal::KIND_KICKED` 再 drop;kicked=false(同 device 自重连)只 drop。

- [ ] **Step 14.1: 在 subscribe 中,替换 register 一行后追加**

```rust
        let out = self.router.register(
            StreamTicket {
                user_id: ctx.user_id.clone(),
                device_id: ctx.device_id.clone(),
                accounts: ctx.accounts.clone(),
            },
            tx,
        );
        if out.kicked {
            // 真正多端踢:给 prev 发 KICKED
            for prev in out.prev_senders {
                let kicked_evt = ServerEvent {
                    wecom_account_id: String::new(),
                    seq: 0,
                    body: Some(chathub_proto::v1::server_event::Body::System(
                        chathub_proto::v1::SystemSignal {
                            kind: chathub_proto::v1::system_signal::Kind::Kicked as i32,
                            detail: "multi-device".into(),
                        },
                    )),
                };
                let _ = prev.try_send(Ok(kicked_evt));
                drop(prev);
            }
        } else {
            // 同 device 自重连:静默 drop prev
            for prev in out.prev_senders {
                drop(prev);
            }
        }
```

- [ ] **Step 14.2: 在 `mod tests` 追加 2 个单测**

```rust
    #[tokio::test(flavor = "multi_thread")]
    async fn second_subscribe_different_device_kicks_first() {
        let (addr, _router, signer) = spawn_hub().await;
        let tok1 = signer.sign(&signer.make_claims("u-1", vec!["wa-1".into()], "dev-A", 1800)).unwrap();
        let tok2 = signer.sign(&signer.make_claims("u-1", vec!["wa-1".into()], "dev-B", 1800)).unwrap();

        let make_client = |tok: String| {
            let ep = Endpoint::from_shared(format!("http://{addr}")).unwrap();
            async move {
                let channel = ep.connect().await.unwrap();
                RawHubClient::with_interceptor(channel, move |mut r: tonic::Request<()>| {
                    r.metadata_mut().insert("chathub-protocol-version", "1".parse().unwrap());
                    r.metadata_mut().insert("authorization", format!("Bearer {tok}").parse().unwrap());
                    Ok(r)
                })
            }
        };
        let mut c1 = make_client(tok1).await;
        let s1 = c1.subscribe(SubscribeRequest { since_seqs: Default::default() })
            .await.unwrap().into_inner();
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;

        let mut c2 = make_client(tok2).await;
        let _s2 = c2.subscribe(SubscribeRequest { since_seqs: Default::default() })
            .await.unwrap().into_inner();

        let mut s1 = std::pin::pin!(s1);
        let got = tokio::time::timeout(std::time::Duration::from_secs(2), s1.next())
            .await.unwrap().unwrap().unwrap();
        match got.body {
            Some(chathub_proto::v1::server_event::Body::System(sig)) => {
                assert_eq!(sig.kind, chathub_proto::v1::system_signal::Kind::Kicked as i32);
            }
            other => panic!("expected KICKED, got: {other:?}"),
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn same_device_reconnect_does_not_emit_kicked() {
        let (addr, _router, signer) = spawn_hub().await;
        let tok = signer.sign(&signer.make_claims("u-1", vec!["wa-1".into()], "dev-A", 1800)).unwrap();
        let mk = || {
            let ep = Endpoint::from_shared(format!("http://{addr}")).unwrap();
            let tok = tok.clone();
            async move {
                let channel = ep.connect().await.unwrap();
                RawHubClient::with_interceptor(channel, move |mut r: tonic::Request<()>| {
                    r.metadata_mut().insert("chathub-protocol-version", "1".parse().unwrap());
                    r.metadata_mut().insert("authorization", format!("Bearer {tok}").parse().unwrap());
                    Ok(r)
                })
            }
        };
        let mut c1 = mk().await;
        let s1 = c1.subscribe(SubscribeRequest { since_seqs: Default::default() })
            .await.unwrap().into_inner();
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        let mut c2 = mk().await;
        let _s2 = c2.subscribe(SubscribeRequest { since_seqs: Default::default() })
            .await.unwrap().into_inner();
        // s1 应当 EOF(没有 KICKED 事件)
        let mut s1 = std::pin::pin!(s1);
        // 给一点时间 server 处理 register 并 drop prev sender
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let next = tokio::time::timeout(std::time::Duration::from_millis(500), s1.next()).await;
        // 拿到 None(EOF)即可,不能拿到 KICKED 事件
        match next {
            Ok(None) => {}
            Ok(Some(Ok(evt))) => {
                if let Some(chathub_proto::v1::server_event::Body::System(sig)) = evt.body {
                    assert_ne!(sig.kind, chathub_proto::v1::system_signal::Kind::Kicked as i32);
                }
            }
            other => panic!("unexpected: {other:?}"),
        }
    }
```

- [ ] **Step 14.3 (GREEN):** `cargo test -p chathub-relay --lib hub_service::tests` → 全部 passed

- [ ] **Step 14.4: 提交**

```bash
git add backends/crates/chathub-relay/src/hub_service.rs
git commit -m "$(cat <<'EOF'
feat(chathub-relay): subscribe KICKED 分支(多端真踢 vs 同 device 静默)

- register 返 RegisterOutcome.kicked=true 时给 prev 发 SystemSignal::KICKED
  再 drop;kicked=false(同 device 重连)只 drop(stream 自然 EOF)
- 2 单测:不同 device 二次 subscribe → 旧 stream 收 KICKED /
  同 device 重连 → 旧 stream EOF 且不见 KICKED

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: Subscribe Replay-on-Connect

**Files:** Modify `backends/crates/chathub-relay/src/hub_service.rs`(subscribe)

为什么:spec §11/§8 决策 #11 — replay 必须先于 register,否则 live push 会与 replay 乱序破坏 per-account 单调 seq。

- [ ] **Step 15.1: 把 `subscribe` 改为如下完整版**

```rust
    async fn subscribe(
        &self,
        req: Request<SubscribeRequest>,
    ) -> Result<Response<Self::SubscribeStream>, Status> {
        let ctx = req
            .extensions()
            .get::<UserCtx>()
            .cloned()
            .ok_or_else(|| Status::unauthenticated("missing ctx"))?;
        let since = req.into_inner().since_seqs;
        let (tx, rx) = mpsc::channel(32);

        // 1. **REPLAY 必先于 REGISTER**(spec §8,决策 #11)
        for (account, s) in &since {
            if !ctx.accounts.contains(account) {
                continue;
            }
            let rows = self
                .events
                .replay_after(account, *s, 200)
                .await
                .map_err(|e| Status::from(RelayError::from(e)))?;
            for (_seq, payload) in rows {
                let evt = ServerEvent::decode(&payload[..])
                    .map_err(|e| Status::internal(format!("decode: {e}")))?;
                if tx.send(Ok(evt)).await.is_err() {
                    break;
                }
            }
        }

        // 2. register(可能发 KICKED)
        let out = self.router.register(
            StreamTicket {
                user_id: ctx.user_id.clone(),
                device_id: ctx.device_id.clone(),
                accounts: ctx.accounts.clone(),
            },
            tx,
        );
        if out.kicked {
            for prev in out.prev_senders {
                let kicked_evt = ServerEvent {
                    wecom_account_id: String::new(),
                    seq: 0,
                    body: Some(chathub_proto::v1::server_event::Body::System(
                        chathub_proto::v1::SystemSignal {
                            kind: chathub_proto::v1::system_signal::Kind::Kicked as i32,
                            detail: "multi-device".into(),
                        },
                    )),
                };
                let _ = prev.try_send(Ok(kicked_evt));
                drop(prev);
            }
        } else {
            for prev in out.prev_senders { drop(prev); }
        }

        Ok(Response::new(ReceiverStream::new(rx)))
    }
```

需要在文件顶部 `use prost::Message;` 来调用 `ServerEvent::decode`。

- [ ] **Step 15.2: 在 `mod tests` 追加 replay 测试**

```rust
    #[tokio::test(flavor = "multi_thread")]
    async fn subscribe_replays_after_since_seq() {
        let (addr, _router, signer) = spawn_hub().await;
        // 通过 router 本进程 + EventStore record:模拟 push 把 5 条事件落库
        // 但 spawn_hub 返回的 router 和 events 是同 storage 才行 — 需要扩 spawn_hub
        // 这里改 fix 路径:用 helper spawn_hub_with_events 返回 events 句柄
        // (实际实现把 spawn_hub 改成同时返回 events: EventStore)
        // 为简洁,本 step 在 spawn_hub 改完后再补此测试。
    }
```

> **实现决策**:`spawn_hub` 需要扩成返回 `EventStore` 句柄(同 storage),让单测可以预先 record 5 条。改完 `spawn_hub` 签名后,实际 replay 单测如下:

```rust
    // spawn_hub 改为返回 (SocketAddr, Arc<Router>, Signer, EventStore)
    #[tokio::test(flavor = "multi_thread")]
    async fn subscribe_replays_strictly_above_since() {
        let (addr, _router, signer, events) = spawn_hub().await;
        for s in 1..=5_i64 {
            let evt = ServerEvent {
                wecom_account_id: "wa-1".into(),
                seq: s,
                body: Some(chathub_proto::v1::server_event::Body::System(
                    chathub_proto::v1::SystemSignal {
                        kind: chathub_proto::v1::system_signal::Kind::Unspecified as i32,
                        detail: format!("{s}"),
                    },
                )),
            };
            let mut buf = Vec::new();
            prost::Message::encode(&evt, &mut buf).unwrap();
            events.record("wa-1", s, buf, s).await.unwrap();
        }
        let tok = signer.sign(&signer.make_claims("u-1", vec!["wa-1".into()], "dev-A", 1800)).unwrap();
        let ep = Endpoint::from_shared(format!("http://{addr}")).unwrap();
        let channel = ep.connect().await.unwrap();
        let mut client = RawHubClient::with_interceptor(channel, move |mut r: tonic::Request<()>| {
            r.metadata_mut().insert("chathub-protocol-version", "1".parse().unwrap());
            r.metadata_mut().insert("authorization", format!("Bearer {tok}").parse().unwrap());
            Ok(r)
        });
        let mut since = std::collections::HashMap::new();
        since.insert("wa-1".to_string(), 2_i64);
        let stream = client
            .subscribe(SubscribeRequest { since_seqs: since })
            .await.unwrap().into_inner();
        let mut stream = std::pin::pin!(stream);
        let mut got_seqs = Vec::new();
        for _ in 0..3 {
            let e = tokio::time::timeout(std::time::Duration::from_secs(2), stream.next())
                .await.unwrap().unwrap().unwrap();
            got_seqs.push(e.seq);
        }
        assert_eq!(got_seqs, vec![3, 4, 5]);
    }
```

- [ ] **Step 15.3:** 更新 `spawn_hub()` 返回 `EventStore` 句柄(共享 storage)— 把 `let events = EventStore::new(storage.clone());` 与 svc 同来源,函数末尾返回 `(addr, router, signer, events)`,更新所有现有调用点(T13 / T14 单测忽略多返回值用 `_`)。

- [ ] **Step 15.4 (GREEN):** `cargo test -p chathub-relay --lib hub_service::tests::subscribe_replays_strictly_above_since` → passed

- [ ] **Step 15.5: 提交**

```bash
git add backends/crates/chathub-relay/src/hub_service.rs
git commit -m "$(cat <<'EOF'
feat(chathub-relay): Subscribe Replay-on-Connect(先 replay 后 register)

- subscribe:since_seqs 每 entry → events.replay_after(account, since, 200) →
  prost-decode → tx.send。REPLAY 必先于 REGISTER(spec §8 决策 #11),
  否则 live push 与 replay 乱序破坏 per-account 单调 seq
- spawn_hub fixture 扩为返 EventStore 句柄供单测 record
- 1 单测:预 record seq 1..=5 / subscribe with since=2 → 严格按序收 3,4,5

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: push.rs axum endpoint + Bearer middleware + healthz

**Files:** Create `backends/crates/chathub-relay/src/push.rs`,`lib.rs` 加 `pub mod push;`

为什么:下游 POST 事件到此入口;handler 调 `seqs.next_seq` → `events.record` → `router.fanout`,202 返 `{assigned_seq, no_stream}`(spec §9.3)。

- [ ] **Step 16.1: 创建 `backends/crates/chathub-relay/src/push.rs`**

```rust
//! axum router:POST /internal/push(Bearer)+ GET /healthz。

use crate::router::{Router, RouterError};
use crate::storage::events::EventStore;
use crate::storage::seqs::SeqAllocator;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router as AxumRouter};
use chathub_proto::v1::ServerEvent;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Clone)]
pub struct PushState {
    pub secret: String,
    pub seqs: SeqAllocator,
    pub events: EventStore,
    pub router: Arc<Router>,
}

#[derive(Deserialize)]
pub struct PushBody {
    pub wecom_account_id: String,
    pub event: ServerEvent,
}

#[derive(Serialize)]
pub struct PushResp {
    pub assigned_seq: i64,
    pub no_stream: bool,
}

pub fn app(state: PushState) -> AxumRouter {
    AxumRouter::new()
        .route("/healthz", get(|| async { (StatusCode::OK, "ok") }))
        .route("/internal/push", post(handle_push))
        .with_state(state)
}

async fn handle_push(
    State(state): State<PushState>,
    headers: HeaderMap,
    Json(body): Json<PushBody>,
) -> impl IntoResponse {
    // Bearer 校验
    let want = format!("Bearer {}", state.secret);
    let ok = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .map(|s| s == want)
        .unwrap_or(false);
    if !ok {
        return (StatusCode::UNAUTHORIZED, "invalid secret").into_response();
    }
    let assigned_seq = match state.seqs.next_seq(&body.wecom_account_id).await {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!("next_seq: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, "seq").into_response();
        }
    };
    let mut evt = body.event;
    evt.wecom_account_id = body.wecom_account_id.clone();
    evt.seq = assigned_seq;
    let mut buf = Vec::new();
    if let Err(e) = prost::Message::encode(&evt, &mut buf) {
        return (StatusCode::BAD_REQUEST, format!("encode: {e}")).into_response();
    }
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    if let Err(e) = state.events.record(&body.wecom_account_id, assigned_seq, buf, now_ms).await {
        tracing::warn!("events.record: {e}");
        return (StatusCode::INTERNAL_SERVER_ERROR, "record").into_response();
    }
    let no_stream = matches!(
        state.router.fanout(&body.wecom_account_id, evt),
        Err(RouterError::NoStream)
    );
    (
        StatusCode::ACCEPTED,
        Json(PushResp { assigned_seq, no_stream }),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Storage;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    async fn make_state() -> PushState {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("t.db");
        let storage = Storage::open(&db).await.unwrap();
        std::mem::forget(tmp);
        PushState {
            secret: "ps".into(),
            seqs: SeqAllocator::new(storage.clone()),
            events: EventStore::new(storage.clone()),
            router: Arc::new(Router::new()),
        }
    }

    fn json_body(account: &str) -> String {
        format!(
            r#"{{"wecom_account_id":"{account}","event":{{
                "wecom_account_id":"","seq":0,
                "system":{{"kind":"KIND_UNSPECIFIED","detail":"hi"}}
            }}}}"#
        )
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn healthz_returns_200() {
        let st = make_state().await;
        let app = app(st);
        let resp = app
            .oneshot(Request::builder().uri("/healthz").body(Body::empty()).unwrap())
            .await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn push_no_auth_401() {
        let st = make_state().await;
        let app = app(st);
        let resp = app
            .oneshot(Request::builder()
                .method("POST").uri("/internal/push")
                .header("content-type", "application/json")
                .body(Body::from(json_body("wa-1"))).unwrap())
            .await.unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn push_wrong_secret_401() {
        let st = make_state().await;
        let app = app(st);
        let resp = app
            .oneshot(Request::builder()
                .method("POST").uri("/internal/push")
                .header("authorization", "Bearer WRONG")
                .header("content-type", "application/json")
                .body(Body::from(json_body("wa-1"))).unwrap())
            .await.unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn push_no_stream_returns_202_no_stream_true() {
        let st = make_state().await;
        let app = app(st.clone());
        let resp = app
            .oneshot(Request::builder()
                .method("POST").uri("/internal/push")
                .header("authorization", "Bearer ps")
                .header("content-type", "application/json")
                .body(Body::from(json_body("wa-1"))).unwrap())
            .await.unwrap();
        assert_eq!(resp.status(), StatusCode::ACCEPTED);
        let body = axum::body::to_bytes(resp.into_body(), 1024).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["assigned_seq"], 1);
        assert_eq!(v["no_stream"], true);
        // event 仍入 ring
        let rows = st.events.replay_after("wa-1", 0, 10).await.unwrap();
        assert_eq!(rows.len(), 1);
    }
}
```

- [ ] **Step 16.2:** `lib.rs` 追加 `pub mod push;`

- [ ] **Step 16.3 (GREEN):** `cargo test -p chathub-relay --lib push::tests` → 4 passed

- [ ] **Step 16.4: 提交**

```bash
git add backends/crates/chathub-relay/src/push.rs backends/crates/chathub-relay/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(chathub-relay): axum POST /internal/push + Bearer + healthz

- PushState{secret, seqs, events, router}
- handle_push:Bearer 校验 → seqs.next_seq → 注入 evt.seq + account →
  prost-encode → events.record → router.fanout(no_stream 反映回响应)
- 响应 202 {assigned_seq, no_stream}
- 4 单测:healthz 200 / 无 auth 401 / 错 secret 401 / no_stream=true 时
  仍入 ring(后续 reconnect replay 兜底)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 17: push → Subscribe in-process 烟雾(下沉到 e2e G2-#3)

**Files:** 本 task 不新增代码,只在 T22 中的 e2e #3(`subscribe_with_valid_jwt_receives_pushed_event`)实现端到端 push→Subscribe→收到事件;此处占位让 phase 编号与原 outline 对齐。

- [ ] **Step 17.1:** 验证 T16 单测已经覆盖了 router.fanout 路径(`push_no_stream_returns_202` 反向用例);完整 e2e 推送到 Subscribe 真客户端在 T22-#3 中跑。本任务标记为合并到 G2,提交一个空 commit 标记编号或直接跳到 T18。

```bash
# (本 task 不产物;不打空 commit。直接进入 Task 18)
```

---

## Task 18: HubSvc::send + 后续 MessageStatusChange fanout

**Files:** Modify `backends/crates/chathub-relay/src/downstream.rs`(加 send method),`backends/crates/chathub-relay/src/hub_service.rs`(impl send)

为什么:Send 是客户端最常用的写路径。下游成功后必须给 originating account 的 stream 推 `MessageStatusChange{client_msg_id, status:STATUS_SENT}`(spec §F1),让客户端 UI 看到本机发送成功。

- [ ] **Step 18.1: 在 `downstream.rs` 追加 send method**

```rust
#[derive(Serialize)]
pub struct SendReq<'a> {
    pub user_id: &'a str,
    pub wecom_account_id: &'a str,
    pub conversation_id: &'a str,
    pub client_msg_id: &'a str,
    pub body: &'a chathub_proto::v1::MessageBody,
}

#[derive(Deserialize)]
pub struct SendResp {
    pub server_msg_id: String,
    pub sent_at_ms: i64,
}

impl DownstreamClient {
    pub async fn send(&self, req: SendReq<'_>) -> Result<SendResp, RelayError> {
        let url = format!("{}/v1/send", self.base_url);
        let resp = self.http.post(&url).bearer_auth(&self.secret).json(&req).send().await
            .map_err(|e| if e.is_timeout() || e.is_connect() { RelayError::Transient } else { RelayError::Http(e.to_string()) })?;
        translate(resp).await
    }
}
```

下游 `MessageBody` 是 prost 类型,直接 `serde::Serialize`(Plan 1-4 已加 type_attribute)。

- [ ] **Step 18.2: 在 `hub_service.rs` 中 send 实现**

```rust
    async fn send(&self, req: Request<SendRequest>) -> Result<Response<SendResponse>, Status> {
        let ctx = req.extensions().get::<UserCtx>().cloned()
            .ok_or_else(|| Status::unauthenticated("missing ctx"))?;
        let r = req.into_inner();
        let body = r.body.as_ref().ok_or_else(|| Status::invalid_argument("missing body"))?;
        let resp = self.downstream.send(crate::downstream::SendReq {
            user_id: &ctx.user_id,
            wecom_account_id: &r.wecom_account_id,
            conversation_id: &r.conversation_id,
            client_msg_id: &r.client_msg_id,
            body,
        }).await.map_err(Status::from)?;

        // 后续 fanout MessageStatusChange{STATUS_SENT}
        let status_evt = ServerEvent {
            wecom_account_id: r.wecom_account_id.clone(),
            seq: 0, // 将由 seqs.next_seq 重写
            body: Some(chathub_proto::v1::server_event::Body::StatusChange(
                chathub_proto::v1::MessageStatusChange {
                    conversation_id: r.conversation_id.clone(),
                    client_msg_id: r.client_msg_id.clone(),
                    server_msg_id: resp.server_msg_id.clone(),
                    status: chathub_proto::v1::message_status_change::Status::Sent as i32,
                },
            )),
        };
        let assigned = self.seqs.next_seq(&r.wecom_account_id).await
            .map_err(|e| Status::from(RelayError::from(e)))?;
        let mut evt = status_evt;
        evt.seq = assigned;
        let mut buf = Vec::new();
        prost::Message::encode(&evt, &mut buf).map_err(|e| Status::internal(format!("encode: {e}")))?;
        let _ = self.events.record(&r.wecom_account_id, assigned, buf, now_ms()).await;
        let _ = self.router.fanout(&r.wecom_account_id, evt);

        Ok(Response::new(SendResponse {
            server_msg_id: resp.server_msg_id,
            sent_at_ms: resp.sent_at_ms,
        }))
    }
```

注:需要在文件加 `fn now_ms() -> i64`(同 auth_service.rs 那一份)。

- [ ] **Step 18.3:** 把 send 的 e2e 测试合并到 T22 中的 `send_translates_to_downstream_and_emits_status_change`,本 task 仅做 RPC 翻译 + fanout 实现 + 跑现有单测(确保编译过)。

```bash
cargo test -p chathub-relay --lib hub_service::tests
```

Expected:所有现存 hub_service 单测继续过。

- [ ] **Step 18.4: 提交**

```bash
git add backends/crates/chathub-relay/src/downstream.rs backends/crates/chathub-relay/src/hub_service.rs
git commit -m "$(cat <<'EOF'
feat(chathub-relay): HubSvc::send + 后续 MessageStatusChange fanout

- downstream.send → /v1/send,from JWT 取 user_id 注入 body
- 成功后构造 MessageStatusChange{STATUS_SENT, client_msg_id, server_msg_id}
  → next_seq → events.record → router.fanout(originating stream 自己能看到)
- 失败暂不 emit STATUS_FAILED(skeleton 限制,Plan 6+ 加映射表)
- e2e 在 T22-#6 跑通

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 19: Recall + AckRead(纯透传)

**Files:** Modify `downstream.rs` + `hub_service.rs`

为什么:无 follow-up event,只把 client RPC 翻译为下游 HTTP。

- [ ] **Step 19.1:** `downstream.rs` 追加 recall / ack_read:

```rust
#[derive(Serialize)]
pub struct RecallReq<'a> {
    pub user_id: &'a str,
    pub wecom_account_id: &'a str,
    pub conversation_id: &'a str,
    pub server_msg_id: &'a str,
}
#[derive(Deserialize)]
pub struct RecallResp { pub recalled_at_ms: i64 }

#[derive(Serialize)]
pub struct AckReadReq<'a> {
    pub user_id: &'a str,
    pub wecom_account_id: &'a str,
    pub conversation_id: &'a str,
    pub last_read_server_msg_id: &'a str,
}
#[derive(Deserialize)]
pub struct AckReadResp { pub acked_at_ms: i64 }

impl DownstreamClient {
    pub async fn recall(&self, req: RecallReq<'_>) -> Result<RecallResp, RelayError> {
        let url = format!("{}/v1/recall", self.base_url);
        let r = self.http.post(&url).bearer_auth(&self.secret).json(&req).send().await
            .map_err(|e| if e.is_timeout() || e.is_connect() { RelayError::Transient } else { RelayError::Http(e.to_string()) })?;
        translate(r).await
    }
    pub async fn ack_read(&self, req: AckReadReq<'_>) -> Result<AckReadResp, RelayError> {
        let url = format!("{}/v1/ack_read", self.base_url);
        let r = self.http.post(&url).bearer_auth(&self.secret).json(&req).send().await
            .map_err(|e| if e.is_timeout() || e.is_connect() { RelayError::Transient } else { RelayError::Http(e.to_string()) })?;
        translate(r).await
    }
}
```

- [ ] **Step 19.2:** `hub_service.rs` impl recall / ack_read:

```rust
    async fn recall(&self, req: Request<RecallRequest>) -> Result<Response<RecallResponse>, Status> {
        let ctx = req.extensions().get::<UserCtx>().cloned()
            .ok_or_else(|| Status::unauthenticated("missing ctx"))?;
        let r = req.into_inner();
        let resp = self.downstream.recall(crate::downstream::RecallReq {
            user_id: &ctx.user_id,
            wecom_account_id: &r.wecom_account_id,
            conversation_id: &r.conversation_id,
            server_msg_id: &r.server_msg_id,
        }).await.map_err(Status::from)?;
        Ok(Response::new(RecallResponse { recalled_at_ms: resp.recalled_at_ms }))
    }
    async fn ack_read(&self, req: Request<AckReadRequest>) -> Result<Response<AckReadResponse>, Status> {
        let ctx = req.extensions().get::<UserCtx>().cloned()
            .ok_or_else(|| Status::unauthenticated("missing ctx"))?;
        let r = req.into_inner();
        let resp = self.downstream.ack_read(crate::downstream::AckReadReq {
            user_id: &ctx.user_id,
            wecom_account_id: &r.wecom_account_id,
            conversation_id: &r.conversation_id,
            last_read_server_msg_id: &r.last_read_server_msg_id,
        }).await.map_err(Status::from)?;
        Ok(Response::new(AckReadResponse { acked_at_ms: resp.acked_at_ms }))
    }
```

- [ ] **Step 19.3 (GREEN):** `cargo build -p chathub-relay`(单测覆盖在 T22 e2e);

- [ ] **Step 19.4: 提交**

```bash
git add backends/crates/chathub-relay/src/downstream.rs backends/crates/chathub-relay/src/hub_service.rs
git commit -m "$(cat <<'EOF'
feat(chathub-relay): HubSvc::recall + ack_read(透传翻译)

- downstream.recall / ack_read:POST /v1/{recall,ack_read} with Bearer
- hub_service.recall / ack_read:从 JWT 取 user_id 注入下游 body,
  纯透传,无 follow-up event(STATUS_DELIVERED / ReadReceipt 应当由
  下游业务系统 push 进来,Plan 5 不补)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 20: FetchHistory(cursor 透传)

**Files:** Modify `downstream.rs` + `hub_service.rs`

- [ ] **Step 20.1:** `downstream.rs` 追加 fetch_history:

```rust
#[derive(Serialize)]
pub struct FetchHistoryReq<'a> {
    pub user_id: &'a str,
    pub wecom_account_id: &'a str,
    pub conversation_id: &'a str,
    pub limit: u32,
    pub cursor: &'a str,
}
#[derive(Deserialize)]
pub struct FetchHistoryResp {
    pub messages: Vec<chathub_proto::v1::HistoryMessage>,
    #[serde(default)]
    pub next_cursor: String,
}

impl DownstreamClient {
    pub async fn fetch_history(&self, req: FetchHistoryReq<'_>) -> Result<FetchHistoryResp, RelayError> {
        let url = format!("{}/v1/fetch_history", self.base_url);
        let r = self.http.post(&url).bearer_auth(&self.secret).json(&req).send().await
            .map_err(|e| if e.is_timeout() || e.is_connect() { RelayError::Transient } else { RelayError::Http(e.to_string()) })?;
        translate(r).await
    }
}
```

- [ ] **Step 20.2:** `hub_service.rs` impl fetch_history:

```rust
    async fn fetch_history(
        &self, req: Request<FetchHistoryRequest>,
    ) -> Result<Response<FetchHistoryResponse>, Status> {
        let ctx = req.extensions().get::<UserCtx>().cloned()
            .ok_or_else(|| Status::unauthenticated("missing ctx"))?;
        let r = req.into_inner();
        let resp = self.downstream.fetch_history(crate::downstream::FetchHistoryReq {
            user_id: &ctx.user_id,
            wecom_account_id: &r.wecom_account_id,
            conversation_id: &r.conversation_id,
            limit: r.limit,
            cursor: &r.cursor,
        }).await.map_err(Status::from)?;
        Ok(Response::new(FetchHistoryResponse {
            messages: resp.messages,
            next_cursor: resp.next_cursor,
        }))
    }
```

- [ ] **Step 20.3 (GREEN):** `cargo build -p chathub-relay`

- [ ] **Step 20.4: 提交**

```bash
git add backends/crates/chathub-relay/src/downstream.rs backends/crates/chathub-relay/src/hub_service.rs
git commit -m "$(cat <<'EOF'
feat(chathub-relay): HubSvc::fetch_history(opaque cursor 透传)

- downstream.fetch_history:POST /v1/fetch_history + Bearer
- cursor 由 Relay 不解析,直接透传给下游;next_cursor 同样照传回
- e2e 在 T22-#7 跑通(预 wiremock 返 3 msgs + next_cursor="c2",
  client 拿全 + 二次调 cursor="c2" 透传)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 21: tests/common/mod.rs — RelayHarness + spawn_relay + mint_jwt

**Files:** Create `backends/crates/chathub-relay/tests/common/mod.rs`,Create `backends/crates/chathub-relay/tests/relay_e2e.rs`(空骨架)

为什么:G2 全部 7 个 e2e 共用这一份 fixture。fixture 起完 in-process tonic + axum + wiremock + 临时 SQLite。**所有 e2e 必须 `#[tokio::test(flavor = "multi_thread")]`**(spec §12.3 / 风险 R6)。

- [ ] **Step 21.1: 创建 `backends/crates/chathub-relay/tests/common/mod.rs`**

````rust
//! RelayHarness — in-process relay fixture(tonic + axum + wiremock + tempdir)。
//!
//! 用法:
//! ```ignore
//! #[tokio::test(flavor = "multi_thread")]
//! async fn my_test() {
//!     let h = spawn_relay().await;
//!     let token = mint_jwt(&h.signer, "u-1", vec!["wa-1".into()], "dev-A");
//!     // ... 用 chathub-net::HubClient 直连 h.grpc_addr
//! }
//! ```

#![allow(dead_code)]

use chathub_proto::v1::auth_server::AuthServer;
use chathub_proto::v1::hub_server::HubServer;
use chathub_relay::auth_service::AuthSvc;
use chathub_relay::downstream::DownstreamClient;
use chathub_relay::hub_service::{HubSvc, JwtAuthInterceptor};
use chathub_relay::jwt::{Claims, Signer};
use chathub_relay::push::{self, PushState};
use chathub_relay::router::Router;
use chathub_relay::storage::events::EventStore;
use chathub_relay::storage::seqs::SeqAllocator;
use chathub_relay::storage::sessions::SessionStore;
use chathub_relay::storage::Storage;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use tokio_stream::wrappers::TcpListenerStream;
use tonic::transport::Server;
use wiremock::MockServer;

pub struct RelayHarness {
    pub grpc_addr: SocketAddr,
    pub push_addr: SocketAddr,
    pub push_url: String,
    pub push_secret: String,
    pub downstream: MockServer,
    pub signer: Signer,
    pub events: EventStore,
    pub router: Arc<Router>,
    _db: tempfile::TempDir,
    _tonic: JoinHandle<()>,
    _axum: JoinHandle<()>,
}

pub async fn spawn_relay() -> RelayHarness {
    let downstream = MockServer::start().await;
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("relay.db");
    let storage = Storage::open(&db).await.unwrap();
    let signer = Signer::bootstrap(&storage, None, None, "chathub-relay").await.unwrap();
    let sessions = SessionStore::new(storage.clone());
    let seqs = SeqAllocator::new(storage.clone());
    let events = EventStore::new(storage.clone());
    let router = Arc::new(Router::new());
    let dn_client = Arc::new(DownstreamClient::new(&downstream.uri(), "dn-secret").unwrap());

    let auth_svc = AuthSvc {
        downstream: dn_client.clone(),
        sessions,
        signer: signer.clone(),
        pepper: "test-pepper".into(),
        access_ttl: Duration::from_secs(1800),
        refresh_ttl: Duration::from_secs(86400 * 30),
    };
    let hub_svc = HubSvc {
        router: router.clone(),
        seqs: seqs.clone(),
        events: events.clone(),
        downstream: dn_client.clone(),
    };

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let grpc_addr = listener.local_addr().unwrap();
    let stream = TcpListenerStream::new(listener);
    let ic = JwtAuthInterceptor::new(signer.verifier());
    let tonic_h = tokio::spawn(async move {
        let _ = Server::builder()
            .add_service(AuthServer::new(auth_svc))
            .add_service(HubServer::with_interceptor(hub_svc, ic))
            .serve_with_incoming(stream)
            .await;
    });

    let push_state = PushState {
        secret: "push-secret".into(),
        seqs,
        events: events.clone(),
        router: router.clone(),
    };
    let push_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let push_addr = push_listener.local_addr().unwrap();
    let push_app = push::app(push_state);
    let axum_h = tokio::spawn(async move {
        let _ = axum::serve(push_listener, push_app).await;
    });

    tokio::time::sleep(Duration::from_millis(80)).await;

    RelayHarness {
        grpc_addr,
        push_addr,
        push_url: format!("http://{push_addr}"),
        push_secret: "push-secret".into(),
        downstream,
        signer,
        events,
        router,
        _db: tmp,
        _tonic: tonic_h,
        _axum: axum_h,
    }
}

/// 直接由 Signer 签出 JWT,跳过 login(测试用)。
pub fn mint_jwt(signer: &Signer, user_id: &str, accounts: Vec<String>, device_id: &str) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let claims = Claims {
        iss: signer.issuer().to_string(),
        sub: user_id.to_string(),
        exp: now + 1800,
        iat: now,
        accounts,
        device_id: device_id.to_string(),
    };
    signer.sign(&claims).unwrap()
}
````

- [ ] **Step 21.2: 创建 `backends/crates/chathub-relay/tests/relay_e2e.rs` 空骨架**

```rust
//! Plan 5 e2e:7 个场景。fixture 在 common/mod.rs。
//! 所有测试 #[tokio::test(flavor = "multi_thread")] — 否则 wiremock + tonic
//! 共享 runtime 会死锁(spec §12.3,风险 R6)。

mod common;

use common::{mint_jwt, spawn_relay};

#[tokio::test(flavor = "multi_thread")]
async fn fixture_self_test_healthz_returns_ok() {
    let h = spawn_relay().await;
    let resp = reqwest::get(format!("{}/healthz", h.push_url)).await.unwrap();
    assert_eq!(resp.status(), 200);
    let _ = mint_jwt(&h.signer, "u-1", vec!["wa-1".into()], "dev-A");
}
```

- [ ] **Step 21.3 (GREEN):**

```bash
cargo test -p chathub-relay --test relay_e2e fixture_self_test_healthz_returns_ok -- --test-threads=1
```

Expected: passed。

- [ ] **Step 21.4: 提交**

```bash
git add backends/crates/chathub-relay/tests/common/ backends/crates/chathub-relay/tests/relay_e2e.rs
git commit -m "$(cat <<'EOF'
test(chathub-relay): RelayHarness + spawn_relay + mint_jwt fixture

- tests/common/mod.rs:in-process relay(127.0.0.1:0 ×2 + wiremock + tempdir)
- spawn_relay 返 RelayHarness{grpc_addr,push_url,downstream,signer,events,router}
- mint_jwt(signer, user_id, accounts, device_id) → JWT(跳过 login 路径)
- fixture self-test:healthz 200 + JWT 签发不 panic
- 所有 e2e 强制 #[tokio::test(flavor="multi_thread")](spec §12.3,R6)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 22: 7 个 e2e 场景

**Files:** Modify `backends/crates/chathub-relay/tests/relay_e2e.rs`

为什么:验证 client(Plan 1-4 真 `chathub-net::HubClient`)↔ relay(本 Plan 实现)↔ wiremock 下游端到端走通。

公共辅助(放在 `relay_e2e.rs` 文件顶部模块内):

```rust
use chathub_net::auth::AuthClient;
use chathub_net::hub::HubClient;
use chathub_net::interceptor::AuthInterceptor;
use chathub_net::token::SharedTokenStore;
use chathub_proto::v1::{
    LoginRequest, MessageBody, message_body, MessageText, SendRequest, SubscribeRequest,
};
use std::collections::HashMap;
use tokio_stream::StreamExt;
use tonic::transport::Endpoint;
use wiremock::matchers::{method, path};
use wiremock::{Mock, ResponseTemplate};

async fn channel(addr: std::net::SocketAddr) -> tonic::transport::Channel {
    Endpoint::from_shared(format!("http://{addr}")).unwrap().connect().await.unwrap()
}

async fn hub_client_with(addr: std::net::SocketAddr, token: &str) -> HubClient {
    let ch = channel(addr).await;
    let store = SharedTokenStore::default();
    store.set_access(token.to_string()).await;
    let ic = AuthInterceptor::new(store);
    HubClient::new(ch, ic)
}

fn text(s: &str) -> MessageBody {
    MessageBody {
        kind: Some(message_body::Kind::Text(MessageText { content: s.into() })),
    }
}
```

- [ ] **Step 22.1: e2e #1 — `login_success_returns_token_and_user`**

```rust
#[tokio::test(flavor = "multi_thread")]
async fn login_success_returns_token_and_user() {
    let h = spawn_relay().await;
    Mock::given(method("POST")).and(path("/v1/verify_user"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "user_id":"u-1","display_name":"A","role":"op","tenant_id":"t",
            "wecom_accounts":[{"wecom_account_id":"wa-1","corp_id":"c","agent_id":1,"display_name":"w","enabled":true}]
        })))
        .mount(&h.downstream).await;

    let ch = channel(h.grpc_addr).await;
    let mut auth = chathub_proto::v1::auth_client::AuthClient::new(ch);
    let resp = auth.login(LoginRequest {
        username: "u".into(), password: "p".into(),
        device_id: "dev-A".into(), device_name: "Mac".into(),
    }).await.unwrap().into_inner();
    assert!(!resp.access_token.is_empty());
    assert_eq!(resp.user.unwrap().user_id, "u-1");
    let claims = h.signer.verifier().verify(&resp.access_token).unwrap();
    assert_eq!(claims.sub, "u-1");
    assert_eq!(claims.device_id, "dev-A");
}
```

- [ ] **Step 22.2: e2e #2 — `login_invalid_credentials_maps_to_unauthenticated`**

```rust
#[tokio::test(flavor = "multi_thread")]
async fn login_invalid_credentials_maps_to_unauthenticated() {
    let h = spawn_relay().await;
    Mock::given(method("POST")).and(path("/v1/verify_user"))
        .respond_with(ResponseTemplate::new(401).set_body_json(serde_json::json!({"code":"INVALID_CREDS"})))
        .mount(&h.downstream).await;
    let ch = channel(h.grpc_addr).await;
    let mut auth = chathub_proto::v1::auth_client::AuthClient::new(ch);
    let st = auth.login(LoginRequest {
        username: "u".into(), password: "bad".into(),
        device_id: "dev".into(), device_name: "M".into(),
    }).await.unwrap_err();
    assert_eq!(st.code(), tonic::Code::Unauthenticated);
}
```

- [ ] **Step 22.3: e2e #3 — `subscribe_with_valid_jwt_receives_pushed_event`**

```rust
#[tokio::test(flavor = "multi_thread")]
async fn subscribe_with_valid_jwt_receives_pushed_event() {
    let h = spawn_relay().await;
    let token = mint_jwt(&h.signer, "u-1", vec!["wa-1".into()], "dev-A");
    let hub = hub_client_with(h.grpc_addr, &token).await;
    let mut stream = hub.subscribe(SubscribeRequest { since_seqs: Default::default() })
        .await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    // POST /internal/push
    let body = serde_json::json!({
        "wecom_account_id": "wa-1",
        "event": {
            "wecom_account_id": "",
            "seq": 0,
            "incoming": {
                "conversation_id":"conv-1","from_user_id":"peer-1","sent_at_ms":0,
                "server_msg_id":"sm-1",
                "body": {"text":{"content":"hello"}}
            }
        }
    });
    let resp = reqwest::Client::new()
        .post(format!("{}/internal/push", h.push_url))
        .bearer_auth(&h.push_secret)
        .json(&body).send().await.unwrap();
    assert_eq!(resp.status(), 202);

    let evt = tokio::time::timeout(std::time::Duration::from_secs(2), stream.next())
        .await.unwrap().unwrap().unwrap();
    assert_eq!(evt.wecom_account_id, "wa-1");
    assert_eq!(evt.seq, 1);
}
```

- [ ] **Step 22.4: e2e #4 — `subscribe_resumes_after_push_using_since_seqs`**

```rust
#[tokio::test(flavor = "multi_thread")]
async fn subscribe_resumes_after_push_using_since_seqs() {
    let h = spawn_relay().await;
    let token = mint_jwt(&h.signer, "u-1", vec!["wa-1".into()], "dev-A");

    // 第一次:订阅,推 3 条,只消费 2 条,然后 drop
    {
        let hub = hub_client_with(h.grpc_addr, &token).await;
        let mut s1 = hub.subscribe(SubscribeRequest { since_seqs: Default::default() })
            .await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        for i in 1..=3_i64 {
            let body = serde_json::json!({
                "wecom_account_id":"wa-1",
                "event":{"wecom_account_id":"","seq":0,
                    "incoming":{"conversation_id":"c","from_user_id":"p","sent_at_ms":0,
                                "server_msg_id":format!("sm-{i}"),
                                "body":{"text":{"content":format!("m{i}")}}}}
            });
            let _ = reqwest::Client::new()
                .post(format!("{}/internal/push", h.push_url))
                .bearer_auth(&h.push_secret).json(&body).send().await.unwrap();
        }
        let _ = tokio::time::timeout(std::time::Duration::from_millis(500), s1.next()).await; // seq 1
        let _ = tokio::time::timeout(std::time::Duration::from_millis(500), s1.next()).await; // seq 2
        // 这里 drop s1,不消费 seq 3
    }
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    // 第二次:since_seqs={"wa-1":2},应当只收到 seq 3
    let hub2 = hub_client_with(h.grpc_addr, &token).await;
    let mut since = HashMap::new();
    since.insert("wa-1".to_string(), 2_i64);
    let mut s2 = hub2.subscribe(SubscribeRequest { since_seqs: since }).await.unwrap();
    let got = tokio::time::timeout(std::time::Duration::from_secs(2), s2.next())
        .await.unwrap().unwrap().unwrap();
    assert_eq!(got.seq, 3);
}
```

- [ ] **Step 22.5: e2e #5 — `kicked_on_second_subscribe_with_different_device`**

```rust
#[tokio::test(flavor = "multi_thread")]
async fn kicked_on_second_subscribe_with_different_device() {
    let h = spawn_relay().await;
    let tok1 = mint_jwt(&h.signer, "u-1", vec!["wa-1".into()], "dev-A");
    let tok2 = mint_jwt(&h.signer, "u-1", vec!["wa-1".into()], "dev-B");

    let hub1 = hub_client_with(h.grpc_addr, &tok1).await;
    let mut s1 = hub1.subscribe(SubscribeRequest { since_seqs: Default::default() })
        .await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    let hub2 = hub_client_with(h.grpc_addr, &tok2).await;
    let _s2 = hub2.subscribe(SubscribeRequest { since_seqs: Default::default() })
        .await.unwrap();

    let got = tokio::time::timeout(std::time::Duration::from_secs(2), s1.next())
        .await.unwrap().unwrap().unwrap();
    match got.body {
        Some(chathub_proto::v1::server_event::Body::System(sig)) => {
            assert_eq!(sig.kind, chathub_proto::v1::system_signal::Kind::Kicked as i32);
        }
        other => panic!("expected KICKED, got: {other:?}"),
    }
}
```

- [ ] **Step 22.6: e2e #6 — `send_translates_to_downstream_and_emits_status_change`**

```rust
#[tokio::test(flavor = "multi_thread")]
async fn send_translates_to_downstream_and_emits_status_change() {
    let h = spawn_relay().await;
    Mock::given(method("POST")).and(path("/v1/send"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "server_msg_id":"sm-99","sent_at_ms":1_700_000_000_000_i64
        })))
        .mount(&h.downstream).await;
    let token = mint_jwt(&h.signer, "u-1", vec!["wa-1".into()], "dev-A");
    let hub = hub_client_with(h.grpc_addr, &token).await;
    let mut stream = hub.subscribe(SubscribeRequest { since_seqs: Default::default() })
        .await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let resp = hub.send(SendRequest {
        wecom_account_id: "wa-1".into(),
        conversation_id: "conv-1".into(),
        client_msg_id: "client-uuid".into(),
        body: Some(text("hello")),
    }).await.unwrap();
    assert_eq!(resp.server_msg_id, "sm-99");

    let evt = tokio::time::timeout(std::time::Duration::from_secs(2), stream.next())
        .await.unwrap().unwrap().unwrap();
    match evt.body {
        Some(chathub_proto::v1::server_event::Body::StatusChange(s)) => {
            assert_eq!(s.client_msg_id, "client-uuid");
            assert_eq!(s.server_msg_id, "sm-99");
            assert_eq!(s.status, chathub_proto::v1::message_status_change::Status::Sent as i32);
        }
        other => panic!("expected MessageStatusChange, got: {other:?}"),
    }
}
```

- [ ] **Step 22.7: e2e #7 — `push_with_invalid_secret_returns_401`**

```rust
#[tokio::test(flavor = "multi_thread")]
async fn push_with_invalid_secret_returns_401() {
    let h = spawn_relay().await;
    let body = serde_json::json!({
        "wecom_account_id":"wa-1",
        "event":{"wecom_account_id":"","seq":0,
            "system":{"kind":"KIND_UNSPECIFIED","detail":""}}
    });
    let resp = reqwest::Client::new()
        .post(format!("{}/internal/push", h.push_url))
        .bearer_auth("WRONG")
        .json(&body).send().await.unwrap();
    assert_eq!(resp.status(), 401);
}
```

- [ ] **Step 22.8 (GREEN): 全跑**

```bash
cargo test -p chathub-relay --test relay_e2e -- --test-threads=1
```

Expected: 8 passed(1 fixture self-test + 7 e2e)。

- [ ] **Step 22.9: 提交**

```bash
git add backends/crates/chathub-relay/tests/relay_e2e.rs
git commit -m "$(cat <<'EOF'
test(chathub-relay): 7 个 e2e 场景

1. login_success_returns_token_and_user
2. login_invalid_credentials_maps_to_unauthenticated
3. subscribe_with_valid_jwt_receives_pushed_event
4. subscribe_resumes_after_push_using_since_seqs
5. kicked_on_second_subscribe_with_different_device
6. send_translates_to_downstream_and_emits_status_change
7. push_with_invalid_secret_returns_401

全部 #[tokio::test(flavor="multi_thread")];用 chathub-net::HubClient
真客户端 + wiremock 假下游。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 23: Plan 1-4 客户端 e2e 回归(目标 68 tests)

**Files:** 仅跑测;不改代码。

为什么:Plan 5 已经动了 root Cargo.toml(workspace.members + deps),需确认 Plan 1-4 测试仍全过。

- [ ] **Step 23.1: 跑完整 Plan 1-4 测试集**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo test -p chathub-proto                                       # 期望 8
cargo test -p chathub-state                                       # 期望 12
cargo test -p chathub-net --lib                                   # 期望 26
cargo test -p chathub-net --test auth_e2e -- --test-threads=1     # 期望 7
cargo test -p chathub-net --test hub_e2e  -- --test-threads=1     # 期望 15
```

Expected 合计: **8 + 12 + 26 + 7 + 15 = 68 tests passed**。

- [ ] **Step 23.2:** 任何 0 数量不对或失败 → 不提交,立即 root-cause(workspace deps 不应影响 Plan 1-4)。

- [ ] **Step 23.3:** 全过后,本 task 无 commit(仅验证步骤)。

---

## Task 24: DOD 最终检 + main.rs 装配 + README

**Files:** Modify `backends/crates/chathub-relay/src/main.rs`(完整装配),Create `backends/crates/chathub-relay/README.md`

- [ ] **Step 24.1: 完整 `main.rs` 装配**

```rust
//! chathub-relay binary entrypoint。

use chathub_proto::v1::auth_server::AuthServer;
use chathub_proto::v1::hub_server::HubServer;
use chathub_relay::auth_service::AuthSvc;
use chathub_relay::config::Config;
use chathub_relay::downstream::DownstreamClient;
use chathub_relay::hub_service::{HubSvc, JwtAuthInterceptor};
use chathub_relay::jwt::Signer;
use chathub_relay::push::{self, PushState};
use chathub_relay::router::Router;
use chathub_relay::storage::events::EventStore;
use chathub_relay::storage::seqs::SeqAllocator;
use chathub_relay::storage::sessions::SessionStore;
use chathub_relay::storage::Storage;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use tonic::transport::Server;
use tracing_subscriber::EnvFilter;

#[tokio::main(flavor = "multi_thread")]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();
    let cfg = Config::from_env()?;
    let storage = Storage::open(&cfg.db_path).await?;
    let signer = Signer::bootstrap(
        &storage,
        cfg.jwt_private_pem.as_deref(),
        cfg.jwt_kid.as_deref(),
        &cfg.issuer,
    )
    .await?;
    let router = Arc::new(Router::new());
    let sessions = SessionStore::new(storage.clone());
    let seqs = SeqAllocator::new(storage.clone());
    let events = EventStore::new(storage.clone());
    let downstream = Arc::new(DownstreamClient::new(&cfg.downstream_url, &cfg.downstream_secret)?);

    let auth_svc = AuthSvc {
        downstream: downstream.clone(),
        sessions,
        signer: signer.clone(),
        pepper: cfg.refresh_hash_pepper.clone(),
        access_ttl: cfg.access_ttl,
        refresh_ttl: cfg.refresh_ttl,
    };
    let hub_svc = HubSvc {
        router: router.clone(),
        seqs: seqs.clone(),
        events: events.clone(),
        downstream: downstream.clone(),
    };
    let ic = JwtAuthInterceptor::new(signer.verifier());

    let grpc_listener = TcpListener::bind(cfg.grpc_addr).await?;
    let push_listener = TcpListener::bind(cfg.push_addr).await?;
    let push_state = PushState {
        secret: cfg.push_secret.clone(),
        seqs,
        events,
        router: router.clone(),
    };
    let push_app = push::app(push_state);

    tracing::info!(grpc=%cfg.grpc_addr, push=%cfg.push_addr, "relay listening");

    let grpc_stream = tokio_stream::wrappers::TcpListenerStream::new(grpc_listener);
    tokio::select! {
        r = Server::builder()
            .http2_keepalive_interval(Some(Duration::from_secs(30)))
            .add_service(AuthServer::new(auth_svc))
            .add_service(HubServer::with_interceptor(hub_svc, ic))
            .serve_with_incoming(grpc_stream) => { r?; },
        r = axum::serve(push_listener, push_app) => { r?; },
        _ = tokio::signal::ctrl_c() => { tracing::info!("ctrl_c received, shutting down"); },
    }
    Ok(())
}
```

- [ ] **Step 24.2: 创建 `backends/crates/chathub-relay/README.md`**

````markdown
# chathub-relay — Walking Skeleton

Rust gRPC gateway:client ↔ relay ↔ downstream HTTP。

## 环境变量

| Env                         | Required | Default           |
| --------------------------- | -------- | ----------------- |
| `RELAY_GRPC_ADDR`           | no       | `127.0.0.1:50051` |
| `RELAY_PUSH_ADDR`           | no       | `127.0.0.1:50052` |
| `RELAY_DB_PATH`             | no       | `./relay.db`      |
| `RELAY_DOWNSTREAM_URL`      | **yes**  | —                 |
| `RELAY_DOWNSTREAM_SECRET`   | no       | empty             |
| `RELAY_PUSH_SECRET`         | **yes**  | —                 |
| `RELAY_JWT_PRIVATE_PEM`     | no       | (gen 后入 kv 表)  |
| `RELAY_JWT_KID`             | no       | (gen)             |
| `RELAY_ISSUER`              | no       | `chathub-relay`   |
| `RELAY_ACCESS_TTL_SECS`     | no       | `1800`            |
| `RELAY_REFRESH_TTL_SECS`    | no       | `2592000`         |
| `RELAY_REFRESH_HASH_PEPPER` | **yes**  | —                 |

## 启动

```sh
export RELAY_DOWNSTREAM_URL=http://erp.local
export RELAY_DOWNSTREAM_SECRET=dn-secret
export RELAY_PUSH_SECRET=push-secret
export RELAY_REFRESH_HASH_PEPPER=$(openssl rand -hex 32)
cargo run -p chathub-relay --bin chathub-relay
```
````

## 下游 5 endpoint 合约(spec-only,Plan 6+ 实现)

```sh
# verify_user
curl -sX POST $RELAY_DOWNSTREAM_URL/v1/verify_user \
  -H "Authorization: Bearer $RELAY_DOWNSTREAM_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"username":"u","password":"p","device_id":"d","device_name":"M"}'

# send
curl -sX POST $RELAY_DOWNSTREAM_URL/v1/send \
  -H "Authorization: Bearer $RELAY_DOWNSTREAM_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"u-1","wecom_account_id":"wa-1","conversation_id":"c","client_msg_id":"x","body":{"text":{"content":"hi"}}}'

# recall
curl -sX POST $RELAY_DOWNSTREAM_URL/v1/recall \
  -H "Authorization: Bearer $RELAY_DOWNSTREAM_SECRET" -H "Content-Type: application/json" \
  -d '{"user_id":"u-1","wecom_account_id":"wa-1","conversation_id":"c","server_msg_id":"sm-1"}'

# ack_read
curl -sX POST $RELAY_DOWNSTREAM_URL/v1/ack_read \
  -H "Authorization: Bearer $RELAY_DOWNSTREAM_SECRET" -H "Content-Type: application/json" \
  -d '{"user_id":"u-1","wecom_account_id":"wa-1","conversation_id":"c","last_read_server_msg_id":"sm-1"}'

# fetch_history
curl -sX POST $RELAY_DOWNSTREAM_URL/v1/fetch_history \
  -H "Authorization: Bearer $RELAY_DOWNSTREAM_SECRET" -H "Content-Type: application/json" \
  -d '{"user_id":"u-1","wecom_account_id":"wa-1","conversation_id":"c","limit":50,"cursor":""}'
```

## 下游 → relay push

```sh
curl -sX POST http://127.0.0.1:50052/internal/push \
  -H "Authorization: Bearer $RELAY_PUSH_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "wecom_account_id":"wa-1",
    "event":{
      "wecom_account_id":"","seq":0,
      "incoming":{
        "conversation_id":"c-1","from_user_id":"peer-1","sent_at_ms":0,
        "server_msg_id":"sm-1","body":{"text":{"content":"hello"}}
      }
    }
  }'
# → 202 {"assigned_seq":1,"no_stream":false}
```

## 运维注意

- **HMAC pepper 不能轻易换**:换 pepper = invalidate 所有 refresh_token。
- **DB 回滚 = session 失效**:用户需重新 login。
- Plan 5 不做 JWT key rotation,不做 mTLS;留 Plan 6+。

````

- [ ] **Step 24.3: 全量 DOD 验证**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub

# 1. fmt + clippy + build
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo build --workspace

# 2. relay 测试
cargo test -p chathub-relay --lib                                   # ~26 单测
cargo test -p chathub-relay --test relay_e2e -- --test-threads=1    # 8(self-test + 7 e2e)

# 3. 回归 Plan 1-4(68 tests)
cargo test -p chathub-proto
cargo test -p chathub-state
cargo test -p chathub-net --lib
cargo test -p chathub-net --test auth_e2e -- --test-threads=1
cargo test -p chathub-net --test hub_e2e  -- --test-threads=1

# 4. binary smoke
export RELAY_GRPC_ADDR=127.0.0.1:50051
export RELAY_PUSH_ADDR=127.0.0.1:50052
export RELAY_DB_PATH=/tmp/relay-smoke.db
export RELAY_DOWNSTREAM_URL=http://127.0.0.1:9999
export RELAY_DOWNSTREAM_SECRET=dn-secret
export RELAY_PUSH_SECRET=push-secret
export RELAY_REFRESH_HASH_PEPPER=$(openssl rand -hex 32)
cargo run -p chathub-relay --bin chathub-relay &
PID=$!
sleep 2
curl -s http://127.0.0.1:50052/healthz | grep -q ok && echo "healthz OK"
kill $PID
````

Expected: 全部 exit 0;healthz 返回 `ok`。

- [ ] **Step 24.4: 提交**

```bash
git add backends/crates/chathub-relay/src/main.rs backends/crates/chathub-relay/README.md
git commit -m "$(cat <<'EOF'
feat(chathub-relay): main.rs 完整装配 + README + DOD 跑通

- main.rs:Config → Storage → Signer → Router → Auth/Hub/Push 装配 →
  tokio::select! { tonic, axum, ctrl_c };tonic http2_keepalive=30s
- README.md:env 矩阵 + 5 个下游 curl 例 + push curl 例 + 运维注意
- DOD 全绿:fmt / clippy / build / 26 unit + 8 e2e / 回归 68 tests /
  binary healthz smoke

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## DOD 总览

合并前必须满足:

```
cargo fmt --all -- --check                         exit 0
cargo clippy --workspace --all-targets -- -D warnings   exit 0
cargo build --workspace                            exit 0
cargo test -p chathub-relay --lib                  ≥ 26 passed
cargo test -p chathub-relay --test relay_e2e       8 passed
cargo test -p chathub-proto                        8 passed
cargo test -p chathub-state                        12 passed
cargo test -p chathub-net --lib                    26 passed
cargo test -p chathub-net --test auth_e2e          7 passed
cargo test -p chathub-net --test hub_e2e           15 passed
cargo run -p chathub-relay → curl /healthz         "ok"
README.md 存在并含 env 矩阵 + 6 个 curl 示例
```

合计 Plan 5 新增 ≥ **34 个测试**(26 unit + 8 e2e),Plan 1-4 回归 68 tests 不破。
