# ChatHub Plan 2 — Auth End-to-End Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 客户端能登录、自动刷新 token、安全持久化 refresh token、退出,且在 stub Relay 上跑通 7 个 e2e 测试。

**Architecture:** 在已有 workspace 下新增 `chathub-state`(deadpool-sqlite + keyring)与 `chathub-net`(tonic + parking_lot 双检锁 + 后台 refresher task)两个 crate,backends 通过 3 个 Tauri 命令 + 1 个事件桥接到前端。Stub Relay 作为 chathub-net 的测试 fixture(`tests/common/`)。

**Tech Stack:** tokio 1.x + tonic 0.12 + prost 0.13 + parking_lot 0.12 + deadpool-sqlite 0.10 + rusqlite 0.32 + rusqlite_migration 1.x + keyring 3 + uuid 1 + thiserror 1 + serde 1 + tracing 0.1.

**Spec:** `docs/superpowers/specs/2026-05-10-chat-protocol-auth-design.md`(已 commit `7e9a542`)。本计划严格按 spec 落地。

**Plan 1 状态:** 已合入 main(commits `bb82a5b..4ce0f30` + `7247a01` 重构 + `7e9a542` 本 plan 的 spec)。当前 HEAD: `7e9a542`。

---

## File Structure

### 新建

```
backends/crates/chathub-state/
├── Cargo.toml
├── migrations/
│   └── V1__init.sql
└── src/
    ├── lib.rs
    ├── error.rs
    ├── pool.rs
    ├── tokens.rs
    └── session.rs

backends/crates/chathub-net/
├── Cargo.toml
├── build.rs
├── src/
│   ├── lib.rs
│   ├── error.rs
│   ├── channel.rs
│   ├── token.rs
│   ├── interceptor.rs
│   └── auth.rs
└── tests/
    ├── common/
    │   ├── mod.rs
    │   └── stub_relay.rs
    └── auth_e2e.rs
```

### 修改

- `Cargo.toml`(repo root)— `[workspace.dependencies]` 加 deadpool-sqlite/rusqlite/rusqlite_migration/keyring/uuid/parking_lot/thiserror/serde/tokio/tracing/anyhow;`members` 加两个新 crate
- `backends/crates/chathub-proto/Cargo.toml` — 加 `serde = { workspace = true, features = ["derive"] }` 到 `[dependencies]`
- `backends/crates/chathub-proto/build.rs` — 加 6 个 `.type_attribute(...)` 给 prost 类型加 serde derive
- `backends/Cargo.toml` — 加 chathub-net、chathub-state 两个 path 依赖
- `backends/src/lib.rs` — setup 注入 AuthApi、3 个 Tauri 命令、event bridge、try_resume on startup

### 删除

- `docs/superpowers/plans/2026-05-11-chat-protocol-auth.md`(stub,已被本 plan 取代)

### 不动(承诺)

- `proto/` 全部
- `frontends/` 全部
- `package.json` / `pnpm-lock.yaml`
- 现有 `.github/workflows/*.yml`
- `backends/tauri.conf.json` / `backends/capabilities/default.json`(本 Plan 不加新权限)

---

## Task 1: chathub-proto 加 serde derive

**Files:**

- Modify: `backends/crates/chathub-proto/Cargo.toml`
- Modify: `backends/crates/chathub-proto/build.rs`
- Modify: `backends/crates/chathub-proto/src/lib.rs`(测试段加一个 serde 检查)
- Modify: `Cargo.toml`(repo root)— `[workspace.dependencies]` 加 `serde`

为什么:Plan 2 起 Tauri 命令会直接返回 `chathub_proto::v1::UserProfile`,需要 `Serialize` derive。同时 `chathub_proto::v1::WecomAccount` 等也跨边界。

- [ ] **Step 1.1: 在 repo 根 `Cargo.toml` 的 `[workspace.dependencies]` 末尾加 `serde`**

```diff
 [workspace.dependencies]
 prost        = "0.13"
 prost-types  = "0.13"
 tonic        = { version = "0.12", default-features = false, features = ["transport", "tls", "tls-roots", "codegen", "prost"] }
 tonic-build  = { version = "0.12", default-features = false, features = ["prost", "transport"] }
 bytes        = "1"
+serde        = { version = "1", features = ["derive"] }
```

- [ ] **Step 1.2: 修改 `backends/crates/chathub-proto/Cargo.toml`,在 `[dependencies]` 加 serde**

```diff
 [dependencies]
 prost       = { workspace = true }
 prost-types = { workspace = true }
 tonic       = { workspace = true }
 bytes       = { workspace = true }
+serde       = { workspace = true }
```

- [ ] **Step 1.3: 修改 `backends/crates/chathub-proto/build.rs`,加 6 个 type_attribute**

把现有的 `tonic_build::configure()` 链式改为:

```rust
    tonic_build::configure()
        .build_client(true)
        .build_server(true)
        .compile_well_known_types(false)
        .type_attribute(".chathub.v1.UserProfile",  "#[derive(serde::Serialize, serde::Deserialize)]")
        .type_attribute(".chathub.v1.WecomAccount", "#[derive(serde::Serialize, serde::Deserialize)]")
        .type_attribute(".chathub.v1.MessageBody",  "#[derive(serde::Serialize, serde::Deserialize)]")
        .type_attribute(".chathub.v1.Mention",      "#[derive(serde::Serialize, serde::Deserialize)]")
        .type_attribute(".chathub.v1.ReplyToRef",   "#[derive(serde::Serialize, serde::Deserialize)]")
        .type_attribute(".chathub.v1.RemoteId",     "#[derive(serde::Serialize, serde::Deserialize)]")
        .compile_protos(&proto_files, &[proto_root])?;
```

- [ ] **Step 1.4: 在 `backends/crates/chathub-proto/src/lib.rs` 的 tests 模块末尾加一个 serde 编译期检查**

在 `mod tests { ... }` 内最后添加:

```rust
    #[test]
    fn user_profile_serializes_to_json() {
        use super::v1::UserProfile;
        let p = UserProfile {
            user_id: "u-1".into(),
            display_name: "Alice".into(),
            avatar_url: "".into(),
            role: "operator".into(),
            tenant_id: "t-42".into(),
        };
        let json = serde_json::to_string(&p).expect("serialize");
        assert!(json.contains("\"user_id\":\"u-1\""));
        let back: UserProfile = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, p);
    }
```

注意:此测试需要 `serde_json` 作为 `[dev-dependencies]`。在 `crates/chathub-proto/Cargo.toml` 末尾加:

```toml
[dev-dependencies]
serde_json = "1"
```

- [ ] **Step 1.5: 跑测试**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo test -p chathub-proto
```

Expected: 4 个测试全过(原 3 个 + 新 `user_profile_serializes_to_json`)。

- [ ] **Step 1.6: clippy 严格**

```bash
cargo clippy --workspace -- -D warnings
```

Expected: 0 warning。

- [ ] **Step 1.7: 提交**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
git add Cargo.toml Cargo.lock backends/crates/chathub-proto/Cargo.toml backends/crates/chathub-proto/build.rs backends/crates/chathub-proto/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(chathub-proto): add serde derive for cross-Tauri-boundary types

- type_attribute 给 UserProfile/WecomAccount/MessageBody/Mention/ReplyToRef/RemoteId 加 serde derive
- workspace.dependencies 加 serde,本 crate 与未来 crate 共享版本
- smoke test:UserProfile JSON 往返
EOF
)"
```

---

## Task 2: chathub-state crate 骨架 + StateError + workspace 注册

**Files:**

- Create: `backends/crates/chathub-state/Cargo.toml`
- Create: `backends/crates/chathub-state/src/lib.rs`
- Create: `backends/crates/chathub-state/src/error.rs`
- Modify: `Cargo.toml`(repo root)— 加 chathub-state 到 members,workspace.dependencies 加新依赖

- [ ] **Step 2.1: 在 repo 根 `Cargo.toml` 的 workspace.dependencies 加新依赖**

```diff
 [workspace.dependencies]
 prost        = "0.13"
 prost-types  = "0.13"
 tonic        = { version = "0.12", default-features = false, features = ["transport", "tls", "tls-roots", "codegen", "prost"] }
 tonic-build  = { version = "0.12", default-features = false, features = ["prost", "transport"] }
 bytes        = "1"
 serde        = { version = "1", features = ["derive"] }
+thiserror    = "1"
+anyhow       = "1"
+tokio        = { version = "1", features = ["rt-multi-thread", "macros", "sync", "time"] }
+tracing      = "0.1"
+parking_lot  = "0.12"
+rusqlite     = { version = "0.32", features = ["bundled"] }
+deadpool-sqlite = { version = "0.10" }
+rusqlite_migration = "1"
+keyring      = { version = "3", default-features = false, features = ["apple-native", "windows-native", "sync-secret-service"] }
+uuid         = { version = "1", features = ["v4"] }
```

- [ ] **Step 2.2: 在 repo 根 `Cargo.toml` 的 `members` 加 chathub-state**

```diff
 members = [
   "backends",
   "backends/crates/chathub-proto",
+  "backends/crates/chathub-state",
 ]
```

- [ ] **Step 2.3: 创建 `backends/crates/chathub-state/Cargo.toml`**

```toml
[package]
name        = "chathub-state"
version     = "0.1.0"
edition     = "2021"
description = "Local persistence: SQLite + OS keychain"
publish     = false

[dependencies]
chathub-proto = { path = "../chathub-proto" }

deadpool-sqlite     = { workspace = true }
rusqlite            = { workspace = true }
rusqlite_migration  = { workspace = true }
keyring             = { workspace = true }
uuid                = { workspace = true }
tokio               = { workspace = true }
thiserror           = { workspace = true }
tracing             = { workspace = true }
serde               = { workspace = true }

[dev-dependencies]
tokio = { workspace = true, features = ["rt-multi-thread", "macros", "sync", "time", "test-util"] }
```

- [ ] **Step 2.4: 创建 `backends/crates/chathub-state/src/error.rs`**

```rust
//! StateError:chathub-state 公共错误类型。

#[derive(thiserror::Error, Debug)]
pub enum StateError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("sqlite pool error: {0}")]
    Pool(String),

    #[error("sqlite interact error: {0}")]
    Interact(String),

    #[error("migration error: {0}")]
    Migration(String),

    #[error("keyring error: {0}")]
    Keyring(#[from] keyring::Error),

    #[error("missing field: {0}")]
    MissingField(&'static str),

    #[error("internal: {0}")]
    Internal(String),
}

impl From<deadpool_sqlite::PoolError> for StateError {
    fn from(e: deadpool_sqlite::PoolError) -> Self {
        StateError::Pool(e.to_string())
    }
}

impl From<deadpool_sqlite::InteractError> for StateError {
    fn from(e: deadpool_sqlite::InteractError) -> Self {
        StateError::Interact(e.to_string())
    }
}
```

- [ ] **Step 2.5: 创建 `backends/crates/chathub-state/src/lib.rs`(只挂 mod 与 re-export)**

```rust
//! ChatHub local state:SQLite (deadpool-sqlite) + OS keychain (keyring).
//!
//! 公共 API:
//!   - `KeyringTokenStore`:存 refresh_token + device_id 到 OS Keychain
//!   - `SessionStore`:存 UserProfile 与 WecomAccount 镜像到 SQLite
//!   - `SqlitePool`:WAL-mode SQLite 连接池,自动跑迁移
//!   - `StateError`:统一错误类型

pub mod error;
pub mod pool;
pub mod session;
pub mod tokens;

pub use error::StateError;
pub use pool::SqlitePool;
pub use session::SessionStore;
pub use tokens::KeyringTokenStore;
```

- [ ] **Step 2.6: 创建占位 `pool.rs`、`session.rs`、`tokens.rs`(让 cargo build 通过)**

`backends/crates/chathub-state/src/pool.rs`:

```rust
//! SqlitePool:Plan 2 Task 3 实现。
pub struct SqlitePool;
```

`backends/crates/chathub-state/src/session.rs`:

```rust
//! SessionStore:Plan 2 Task 5 实现。
pub struct SessionStore;
```

`backends/crates/chathub-state/src/tokens.rs`:

```rust
//! KeyringTokenStore:Plan 2 Task 4 实现。
pub struct KeyringTokenStore;
```

- [ ] **Step 2.7: 跑 cargo build**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo build -p chathub-state
```

Expected: 编译通过(可能首次拉新依赖,2~3 分钟)。

- [ ] **Step 2.8: 提交**

```bash
git add Cargo.toml Cargo.lock backends/crates/chathub-state/
git commit -m "$(cat <<'EOF'
feat(chathub-state): crate scaffolding + StateError

- Cargo.toml + workspace.dependencies 注册新依赖(deadpool-sqlite/rusqlite/keyring/uuid 等)
- workspace.members 加 chathub-state
- src/error.rs:StateError thiserror enum,涵盖 sqlite/pool/keyring/migration
- src/lib.rs + 占位 pool.rs/session.rs/tokens.rs(后续 task 填充)
EOF
)"
```

---

## Task 3: chathub-state SqlitePool + V1 migration

**Files:**

- Create: `backends/crates/chathub-state/migrations/V1__init.sql`
- Modify: `backends/crates/chathub-state/src/pool.rs`(替换占位)

- [ ] **Step 3.1: 创建 `backends/crates/chathub-state/migrations/V1__init.sql`**

```sql
-- V1__init.sql — Plan 2 first migration
-- 每个用户登录后此表恰好一行(单行约束 by id = 1);登出删除。
CREATE TABLE IF NOT EXISTS current_session (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    user_id         TEXT    NOT NULL,
    display_name    TEXT    NOT NULL,
    avatar_url      TEXT    NOT NULL,
    role            TEXT    NOT NULL,
    tenant_id       TEXT    NOT NULL,
    logged_in_at_ms INTEGER NOT NULL
);

-- WecomAccount 缓存。Plan 2 在 Login 时一并写入,Plan 3 起业务用。
CREATE TABLE IF NOT EXISTS wecom_accounts (
    wecom_account_id TEXT    PRIMARY KEY,
    user_id          TEXT    NOT NULL,
    corp_id          TEXT    NOT NULL,
    agent_id         INTEGER NOT NULL,
    display_name     TEXT    NOT NULL,
    enabled          INTEGER NOT NULL DEFAULT 1,
    cached_at_ms     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wecom_user ON wecom_accounts(user_id);
```

- [ ] **Step 3.2: 写一个失败测试到 `pool.rs`**

替换 `pool.rs` 全部内容为(测试在底部):

```rust
//! SqlitePool:WAL-mode SQLite 连接池,启动时跑迁移。

use crate::error::StateError;
use deadpool_sqlite::{Config, Pool, Runtime};
use rusqlite_migration::{Migrations, M};
use std::path::Path;

#[derive(Clone)]
pub struct SqlitePool {
    pool: Pool,
}

impl SqlitePool {
    /// 打开磁盘 SQLite,自动建文件 + 跑迁移 + 开 WAL。
    pub async fn open(path: impl AsRef<Path>) -> Result<Self, StateError> {
        let cfg = Config::new(path.as_ref().to_path_buf());
        let pool = cfg.create_pool(Runtime::Tokio1)
            .map_err(|e| StateError::Pool(e.to_string()))?;
        let me = Self { pool };
        me.apply_migrations().await?;
        me.set_pragma_wal().await?;
        Ok(me)
    }

    /// 内存 SQLite,跑迁移。仅供测试用。
    pub async fn in_memory() -> Result<Self, StateError> {
        let cfg = Config::new(":memory:");
        let pool = cfg.create_pool(Runtime::Tokio1)
            .map_err(|e| StateError::Pool(e.to_string()))?;
        let me = Self { pool };
        me.apply_migrations().await?;
        Ok(me)
    }

    pub fn pool(&self) -> &Pool {
        &self.pool
    }

    async fn apply_migrations(&self) -> Result<(), StateError> {
        let conn = self.pool.get().await?;
        conn.interact(|c| {
            let migrations = Migrations::new(vec![
                M::up(include_str!("../migrations/V1__init.sql")),
            ]);
            migrations.to_latest(c).map_err(|e| StateError::Migration(e.to_string()))
        })
        .await??;
        Ok(())
    }

    async fn set_pragma_wal(&self) -> Result<(), StateError> {
        let conn = self.pool.get().await?;
        conn.interact(|c| -> Result<(), rusqlite::Error> {
            c.pragma_update(None, "journal_mode", "WAL")?;
            c.pragma_update(None, "foreign_keys", "ON")?;
            Ok(())
        })
        .await??;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn in_memory_pool_applies_v1_migration() {
        let pool = SqlitePool::in_memory().await.expect("pool open");

        let conn = pool.pool().get().await.expect("get conn");
        let table_count: i64 = conn.interact(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('current_session', 'wecom_accounts')",
                [],
                |r| r.get(0),
            )
        }).await.expect("interact").expect("query");

        assert_eq!(table_count, 2, "V1 migration should create both tables");
    }

    #[tokio::test]
    async fn in_memory_pool_supports_repeated_open() {
        // 再开一次:迁移已 idempotent,不应报错(rusqlite_migration 会比对版本)
        let _p1 = SqlitePool::in_memory().await.expect("first");
        let _p2 = SqlitePool::in_memory().await.expect("second");
    }
}
```

- [ ] **Step 3.3: 跑测试,确认绿**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo test -p chathub-state pool::tests
```

Expected: 2 个测试通过。

- [ ] **Step 3.4: 提交**

```bash
git add backends/crates/chathub-state/migrations/V1__init.sql backends/crates/chathub-state/src/pool.rs Cargo.lock
git commit -m "$(cat <<'EOF'
feat(chathub-state): SqlitePool + V1 migration

- migrations/V1__init.sql:current_session(单行) + wecom_accounts
- pool.rs:open() / in_memory() + apply_migrations() + WAL pragma
- 单测覆盖:迁移建表 + 重复打开幂等
EOF
)"
```

---

## Task 4: chathub-state KeyringTokenStore

**Files:**

- Modify: `backends/crates/chathub-state/src/tokens.rs`(替换占位)
- Modify: `backends/crates/chathub-state/Cargo.toml`(dev-deps 加 keyring 的 mock 特性)

- [ ] **Step 4.1: 修改 `Cargo.toml`,在 [dev-dependencies] 加 keyring 的 mock 特性**

```diff
 [dev-dependencies]
 tokio = { workspace = true, features = ["rt-multi-thread", "macros", "sync", "time", "test-util"] }
+keyring = { workspace = true, features = ["apple-native", "windows-native", "sync-secret-service", "vendored"] }
```

注意:dev-deps 里的 `keyring` 和主依赖里同名,但 Cargo 允许 dev-deps 启用额外 feature。我们这里**不实际启用 mock**(keyring 3.x 没有原生 mock backend);测试用真实后端 + 唯一的 service name 隔离。

实际策略:每个测试用 `format!("chathub-test-{}", uuid::Uuid::new_v4())` 当 service,**测试间不共享条目**,且每个测试结尾清理。

- [ ] **Step 4.2: 修改 `Cargo.toml`,把 `[dev-dependencies]` 的 uuid 加进去**

```diff
 [dev-dependencies]
 tokio = { workspace = true, features = ["rt-multi-thread", "macros", "sync", "time", "test-util"] }
 keyring = { workspace = true, features = ["apple-native", "windows-native", "sync-secret-service", "vendored"] }
+uuid = { workspace = true }
```

- [ ] **Step 4.3: 替换 `tokens.rs` 全部内容**

```rust
//! KeyringTokenStore:把 refresh_token 与 device_id 存进 OS Keychain。
//!
//! Account naming:
//!   - "device_id"     → 持久 UUIDv4(本地设备唯一标识)
//!   - "refresh_token" → opaque base64 token 串
//!
//! 同一时刻只支持一个本地用户;切换用户必须先 logout(清 refresh)。

use crate::error::StateError;
use keyring::Entry;

const ACCOUNT_DEVICE_ID:     &str = "device_id";
const ACCOUNT_REFRESH_TOKEN: &str = "refresh_token";

#[derive(Clone)]
pub struct KeyringTokenStore {
    service: String,
}

impl KeyringTokenStore {
    pub fn new(service: impl Into<String>) -> Self {
        Self { service: service.into() }
    }

    /// 取 device_id;不存在则生成 UUIDv4 写入并返回。幂等。
    pub fn ensure_device_id(&self) -> Result<String, StateError> {
        let entry = Entry::new(&self.service, ACCOUNT_DEVICE_ID)?;
        match entry.get_password() {
            Ok(id) => Ok(id),
            Err(keyring::Error::NoEntry) => {
                let id = uuid::Uuid::new_v4().to_string();
                entry.set_password(&id)?;
                Ok(id)
            }
            Err(e) => Err(e.into()),
        }
    }

    pub fn read_refresh_token(&self) -> Result<Option<String>, StateError> {
        let entry = Entry::new(&self.service, ACCOUNT_REFRESH_TOKEN)?;
        match entry.get_password() {
            Ok(t) => Ok(Some(t)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn write_refresh_token(&self, token: &str) -> Result<(), StateError> {
        let entry = Entry::new(&self.service, ACCOUNT_REFRESH_TOKEN)?;
        entry.set_password(token)?;
        Ok(())
    }

    pub fn clear_refresh_token(&self) -> Result<(), StateError> {
        let entry = Entry::new(&self.service, ACCOUNT_REFRESH_TOKEN)?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.into()),
        }
    }

    /// 仅供测试:清掉 device_id(测试隔离用)
    #[doc(hidden)]
    pub fn _clear_device_id_for_test(&self) -> Result<(), StateError> {
        let entry = Entry::new(&self.service, ACCOUNT_DEVICE_ID)?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_service() -> String {
        format!("chathub-test-{}", uuid::Uuid::new_v4())
    }

    fn cleanup(s: &KeyringTokenStore) {
        let _ = s.clear_refresh_token();
        let _ = s._clear_device_id_for_test();
    }

    #[test]
    fn ensure_device_id_is_idempotent() {
        let s = KeyringTokenStore::new(unique_service());
        let id1 = s.ensure_device_id().expect("first");
        let id2 = s.ensure_device_id().expect("second");
        assert_eq!(id1, id2);
        assert!(uuid::Uuid::parse_str(&id1).is_ok(), "should be valid UUIDv4");
        cleanup(&s);
    }

    #[test]
    fn refresh_token_round_trip() {
        let s = KeyringTokenStore::new(unique_service());
        assert!(s.read_refresh_token().unwrap().is_none(), "starts empty");
        s.write_refresh_token("rt-abc").expect("write");
        assert_eq!(s.read_refresh_token().unwrap().as_deref(), Some("rt-abc"));
        s.clear_refresh_token().expect("clear");
        assert!(s.read_refresh_token().unwrap().is_none(), "cleared");
        cleanup(&s);
    }

    #[test]
    fn clear_when_absent_is_ok() {
        let s = KeyringTokenStore::new(unique_service());
        assert!(s.clear_refresh_token().is_ok());
        cleanup(&s);
    }
}
```

- [ ] **Step 4.4: 跑测试**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo test -p chathub-state tokens::tests
```

Expected: 3 个测试通过。

⚠️ **macOS 注意**: 第一次 keyring 写入时系统会弹"允许应用访问 Keychain"对话框。本地开发者点"始终允许"即可。CI 环境(Linux GitHub Actions)用 `secret-service`,默认 D-Bus 桶可访问;若 CI 失败提示 "secret service not available",在 CI workflow 里加一行 `apt-get install -y gnome-keyring && eval $(dbus-launch --auto-syntax) && echo "" | gnome-keyring-daemon --unlock`。本计划暂不改 CI(Plan 1 的 build.yml 不跑 cargo test;若引入 cargo-test CI 再补)。

- [ ] **Step 4.5: 提交**

```bash
git add backends/crates/chathub-state/Cargo.toml backends/crates/chathub-state/src/tokens.rs Cargo.lock
git commit -m "$(cat <<'EOF'
feat(chathub-state): KeyringTokenStore for refresh + device_id

- ensure_device_id 幂等生成 UUIDv4
- refresh_token CRUD,clear 容忍 NoEntry
- 单测使用唯一 service name 隔离,测试结束清理 keychain
EOF
)"
```

---

## Task 5: chathub-state SessionStore

**Files:**

- Modify: `backends/crates/chathub-state/src/session.rs`(替换占位)

- [ ] **Step 5.1: 替换 `session.rs` 全部内容**

```rust
//! SessionStore:UserProfile 当前会话 + WecomAccount 镜像 → SQLite。

use crate::error::StateError;
use crate::pool::SqlitePool;
use chathub_proto::v1::{UserProfile, WecomAccount};

#[derive(Clone)]
pub struct SessionStore {
    pool: SqlitePool,
}

impl SessionStore {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// 写入(或覆盖)当前用户会话与其授权账号镜像。
    /// 同一时刻只允许一个 session(由 current_session.id = 1 约束)。
    pub async fn upsert_session(
        &self,
        profile: &UserProfile,
        accounts: &[WecomAccount],
    ) -> Result<(), StateError> {
        let profile = profile.clone();
        let accounts: Vec<WecomAccount> = accounts.to_vec();
        let now = now_unix_ms();

        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            let tx = c.transaction()?;
            // current_session 永远只有一行(id = 1)
            tx.execute(
                "INSERT INTO current_session (id, user_id, display_name, avatar_url, role, tenant_id, logged_in_at_ms) \
                 VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6) \
                 ON CONFLICT(id) DO UPDATE SET \
                   user_id = excluded.user_id, \
                   display_name = excluded.display_name, \
                   avatar_url = excluded.avatar_url, \
                   role = excluded.role, \
                   tenant_id = excluded.tenant_id, \
                   logged_in_at_ms = excluded.logged_in_at_ms",
                rusqlite::params![
                    profile.user_id, profile.display_name, profile.avatar_url,
                    profile.role, profile.tenant_id, now,
                ],
            )?;
            // wecom_accounts:全表替换为该 user 的最新列表
            tx.execute(
                "DELETE FROM wecom_accounts WHERE user_id = ?1",
                rusqlite::params![profile.user_id],
            )?;
            for acc in &accounts {
                tx.execute(
                    "INSERT OR REPLACE INTO wecom_accounts (wecom_account_id, user_id, corp_id, agent_id, display_name, enabled, cached_at_ms) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    rusqlite::params![
                        acc.wecom_account_id, profile.user_id, acc.corp_id,
                        acc.agent_id, acc.display_name, acc.enabled as i64, now,
                    ],
                )?;
            }
            tx.commit()?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    pub async fn read_current(&self) -> Result<Option<UserProfile>, StateError> {
        let conn = self.pool.pool().get().await?;
        let profile: Option<UserProfile> = conn.interact(move |c| -> Result<Option<UserProfile>, StateError> {
            c.query_row(
                "SELECT user_id, display_name, avatar_url, role, tenant_id FROM current_session WHERE id = 1",
                [],
                |row| {
                    Ok(UserProfile {
                        user_id:      row.get(0)?,
                        display_name: row.get(1)?,
                        avatar_url:   row.get(2)?,
                        role:         row.get(3)?,
                        tenant_id:    row.get(4)?,
                    })
                },
            )
            .map(Some)
            .or_else(|e| if matches!(e, rusqlite::Error::QueryReturnedNoRows) { Ok(None) } else { Err(e.into()) })
        }).await??;
        Ok(profile)
    }

    pub async fn read_wecom_accounts(&self, user_id: &str) -> Result<Vec<WecomAccount>, StateError> {
        let user_id = user_id.to_string();
        let conn = self.pool.pool().get().await?;
        let accounts: Vec<WecomAccount> = conn.interact(move |c| -> Result<Vec<WecomAccount>, StateError> {
            let mut stmt = c.prepare(
                "SELECT wecom_account_id, corp_id, agent_id, display_name, enabled \
                 FROM wecom_accounts WHERE user_id = ?1 ORDER BY wecom_account_id"
            )?;
            let rows = stmt.query_map(rusqlite::params![user_id], |row| {
                Ok(WecomAccount {
                    wecom_account_id: row.get(0)?,
                    corp_id:          row.get(1)?,
                    agent_id:         row.get::<_, i64>(2)? as u32,
                    display_name:     row.get(3)?,
                    enabled:          row.get::<_, i64>(4)? != 0,
                })
            })?.collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        }).await??;
        Ok(accounts)
    }

    pub async fn clear(&self) -> Result<(), StateError> {
        let conn = self.pool.pool().get().await?;
        conn.interact(|c| -> Result<(), rusqlite::Error> {
            c.execute("DELETE FROM current_session", [])?;
            c.execute("DELETE FROM wecom_accounts", [])?;
            Ok(())
        }).await??;
        Ok(())
    }
}

fn now_unix_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_profile() -> UserProfile {
        UserProfile {
            user_id:      "u-1".into(),
            display_name: "Alice".into(),
            avatar_url:   "".into(),
            role:         "operator".into(),
            tenant_id:    "t-42".into(),
        }
    }

    fn sample_accounts() -> Vec<WecomAccount> {
        vec![
            WecomAccount {
                wecom_account_id: "wa-1".into(),
                corp_id:          "wwd00".into(),
                agent_id:         1000001,
                display_name:     "杭州企微-小美".into(),
                enabled:          true,
            },
            WecomAccount {
                wecom_account_id: "wa-2".into(),
                corp_id:          "wwd00".into(),
                agent_id:         1000002,
                display_name:     "上海企微-大白".into(),
                enabled:          false,
            },
        ]
    }

    #[tokio::test]
    async fn upsert_then_read_round_trip() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = SessionStore::new(pool);
        store.upsert_session(&sample_profile(), &sample_accounts()).await.unwrap();

        let p = store.read_current().await.unwrap().expect("profile");
        assert_eq!(p, sample_profile());

        let accs = store.read_wecom_accounts("u-1").await.unwrap();
        assert_eq!(accs.len(), 2);
        assert_eq!(accs[0].wecom_account_id, "wa-1");
        assert!(!accs[1].enabled);
    }

    #[tokio::test]
    async fn upsert_replaces_existing_accounts_for_same_user() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = SessionStore::new(pool);
        store.upsert_session(&sample_profile(), &sample_accounts()).await.unwrap();

        let new_accounts = vec![WecomAccount {
            wecom_account_id: "wa-9".into(),
            corp_id:          "wwd00".into(),
            agent_id:         9000001,
            display_name:     "新账号".into(),
            enabled:          true,
        }];
        store.upsert_session(&sample_profile(), &new_accounts).await.unwrap();

        let accs = store.read_wecom_accounts("u-1").await.unwrap();
        assert_eq!(accs.len(), 1);
        assert_eq!(accs[0].wecom_account_id, "wa-9");
    }

    #[tokio::test]
    async fn clear_removes_session_and_accounts() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = SessionStore::new(pool);
        store.upsert_session(&sample_profile(), &sample_accounts()).await.unwrap();
        store.clear().await.unwrap();

        assert!(store.read_current().await.unwrap().is_none());
        assert!(store.read_wecom_accounts("u-1").await.unwrap().is_empty());
    }
}
```

- [ ] **Step 5.2: 跑测试**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo test -p chathub-state session::tests
```

Expected: 3 个测试通过。

- [ ] **Step 5.3: 整 chathub-state 一起跑确认无回归**

```bash
cargo test -p chathub-state
cargo clippy -p chathub-state -- -D warnings
```

Expected: 全过、零警告。

- [ ] **Step 5.4: 提交**

```bash
git add backends/crates/chathub-state/src/session.rs
git commit -m "$(cat <<'EOF'
feat(chathub-state): SessionStore for UserProfile + WecomAccount mirror

- upsert_session 用 transaction:current_session 单行 upsert + wecom_accounts 全替换
- read_current / read_wecom_accounts / clear
- 3 个单测覆盖往返、覆盖、清空
EOF
)"
```

---

## Task 6: chathub-net 骨架 + build.rs RELAY_URL + 工作区注册

**Files:**

- Create: `backends/crates/chathub-net/Cargo.toml`
- Create: `backends/crates/chathub-net/build.rs`
- Create: `backends/crates/chathub-net/src/lib.rs`
- Modify: `Cargo.toml`(repo root)

- [ ] **Step 6.1: 在 repo 根 `Cargo.toml` 的 `members` 加 chathub-net**

```diff
 members = [
   "backends",
   "backends/crates/chathub-proto",
   "backends/crates/chathub-state",
+  "backends/crates/chathub-net",
 ]
```

- [ ] **Step 6.2: 创建 `backends/crates/chathub-net/Cargo.toml`**

```toml
[package]
name        = "chathub-net"
version     = "0.1.0"
edition     = "2021"
description = "ChatHub network layer: gRPC client + token + auth"
publish     = false

[dependencies]
chathub-proto = { path = "../chathub-proto" }
chathub-state = { path = "../chathub-state" }

tonic       = { workspace = true }
prost       = { workspace = true }
tokio       = { workspace = true }
parking_lot = { workspace = true }
thiserror   = { workspace = true }
tracing     = { workspace = true }
serde       = { workspace = true }

[dev-dependencies]
tokio = { workspace = true, features = ["rt-multi-thread", "macros", "sync", "time", "test-util"] }
tokio-stream = "0.1"
serde_json = "1"

[build-dependencies]
# 无 — RELAY_URL 直接用 std::env in build.rs
```

- [ ] **Step 6.3: 创建 `backends/crates/chathub-net/build.rs`**

```rust
//! 在编译期把 CHATHUB_RELAY_URL env 注入为 const RELAY_URL;
//! 没设 env 时回落到占位串(并 emit cargo warning)。

fn main() {
    println!("cargo:rerun-if-env-changed=CHATHUB_RELAY_URL");

    let url = std::env::var("CHATHUB_RELAY_URL")
        .unwrap_or_else(|_| {
            println!("cargo:warning=CHATHUB_RELAY_URL not set; falling back to https://relay.example.com (placeholder)");
            "https://relay.example.com".to_string()
        });

    // 经由 cfg-attribute 传给 src/lib.rs 的 const 声明:
    println!("cargo:rustc-env=CHATHUB_RELAY_URL_RESOLVED={url}");
}
```

- [ ] **Step 6.4: 创建 `backends/crates/chathub-net/src/lib.rs`(只挂 mod 与暴露 RELAY_URL)**

```rust
//! ChatHub network layer:tonic gRPC client + TokenStore + AuthInterceptor + AuthApi。
//!
//! 公共 API:
//!   - `RELAY_URL`:编译期注入,CHATHUB_RELAY_URL env 提供
//!   - `build_endpoint(url)`:tonic Endpoint 配置(keep-alive、TLS、超时)
//!   - `TokenStore`:同步 RwLock + 后台 refresher task
//!   - `AuthInterceptor`:同步 Interceptor,注入 Bearer + 版本头
//!   - `AuthApi`:login/logout/try_resume_session 业务包装
//!   - `AuthError`:统一错误类型 + From<Status>

pub mod auth;
pub mod channel;
pub mod error;
pub mod interceptor;
pub mod token;

pub use auth::{AuthApi, LoggedOutReason};
pub use channel::build_endpoint;
pub use error::AuthError;
pub use interceptor::AuthInterceptor;
pub use token::{TokenState, TokenStore};

/// 编译期由 build.rs 注入。无 env 时为占位 https://relay.example.com。
pub const RELAY_URL: &str = env!("CHATHUB_RELAY_URL_RESOLVED");
```

- [ ] **Step 6.5: 创建 5 个空模块文件让 cargo build 通过**

`backends/crates/chathub-net/src/error.rs`:

```rust
//! Plan 2 Task 7。
#[derive(thiserror::Error, Debug)]
pub enum AuthError { #[error("placeholder")] Placeholder }
```

`backends/crates/chathub-net/src/channel.rs`:

```rust
//! Plan 2 Task 8。
pub fn build_endpoint(_url: impl Into<String>) -> Result<(), crate::AuthError> {
    Err(crate::AuthError::Placeholder)
}
```

`backends/crates/chathub-net/src/token.rs`:

```rust
//! Plan 2 Task 9~12。
pub struct TokenState;
pub struct TokenStore;
```

`backends/crates/chathub-net/src/interceptor.rs`:

```rust
//! Plan 2 Task 13。
pub struct AuthInterceptor;
```

`backends/crates/chathub-net/src/auth.rs`:

```rust
//! Plan 2 Task 14~15。
pub struct AuthApi;
#[derive(Debug, Clone, Copy)]
pub enum LoggedOutReason { Manual, RefreshFailed, Kicked }
```

- [ ] **Step 6.6: 跑 cargo build**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
CHATHUB_RELAY_URL=http://test.local cargo build -p chathub-net
```

Expected: 编译通过;若不设 env,build script 会输出 `cargo:warning=CHATHUB_RELAY_URL not set; ...`。

也跑一次不设 env 验证占位生效:

```bash
unset CHATHUB_RELAY_URL
cargo build -p chathub-net 2>&1 | grep -i "warning"
```

Expected: 看到 `warning: CHATHUB_RELAY_URL not set; falling back ...`。

- [ ] **Step 6.7: 提交**

```bash
git add Cargo.toml Cargo.lock backends/crates/chathub-net/
git commit -m "$(cat <<'EOF'
feat(chathub-net): crate scaffolding + RELAY_URL build-time env

- workspace.members 加 chathub-net
- Cargo.toml:tonic + chathub-proto/state path 依赖
- build.rs:CHATHUB_RELAY_URL env → const RELAY_URL,无 env 时占位 + cargo warning
- src/lib.rs + 五个占位 mod(后续 task 填)
EOF
)"
```

---

## Task 7: chathub-net AuthError + Status 翻译

**Files:**

- Modify: `backends/crates/chathub-net/src/error.rs`(替换占位)

- [ ] **Step 7.1: 替换 `error.rs` 全部内容**

```rust
//! AuthError:chathub-net 的统一错误类型。
//! 翻译自 tonic::Status,序列化后跨 Tauri 边界给前端。

use chathub_proto::v1::{ErrorDetail, error_detail};
use prost::Message;

#[derive(thiserror::Error, Debug, serde::Serialize, Clone)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum AuthError {
    #[error("invalid credentials")]
    Unauthenticated,

    #[error("upgrade required (min={min_version})")]
    UpgradeRequired { min_version: String, download_url: String },

    #[error("network error: {message}")]
    Network { message: String },

    #[error("storage error: {message}")]
    Storage { message: String },

    #[error("internal: {message}")]
    Internal { message: String },
}

impl From<tonic::Status> for AuthError {
    fn from(s: tonic::Status) -> Self {
        use tonic::Code::*;
        // 优先解析 details 里的 ErrorDetail.UpgradeRequired
        if matches!(s.code(), FailedPrecondition) {
            if let Some(upgrade) = parse_upgrade_required(&s) {
                return upgrade;
            }
        }
        match s.code() {
            Unauthenticated      => AuthError::Unauthenticated,
            Unavailable | DeadlineExceeded => AuthError::Network { message: s.message().to_string() },
            FailedPrecondition   => AuthError::Internal { message: format!("precondition: {}", s.message()) },
            _                    => AuthError::Internal { message: s.message().to_string() },
        }
    }
}

impl From<chathub_state::StateError> for AuthError {
    fn from(e: chathub_state::StateError) -> Self {
        AuthError::Storage { message: e.to_string() }
    }
}

impl From<tonic::transport::Error> for AuthError {
    fn from(e: tonic::transport::Error) -> Self {
        AuthError::Network { message: e.to_string() }
    }
}

fn parse_upgrade_required(s: &tonic::Status) -> Option<AuthError> {
    let details = s.details();
    if details.is_empty() {
        return None;
    }
    // gRPC 的 details 是 protobuf-encoded google.rpc.Status,Plan 2 阶段我们简化为
    // "details 直接编码 ErrorDetail",由 stub-relay 与未来 Relay 共同遵守。
    let detail = ErrorDetail::decode(details).ok()?;
    match detail.body? {
        error_detail::Body::Upgrade(u) => Some(AuthError::UpgradeRequired {
            min_version: u.min_client_version,
            download_url: u.download_url,
        }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tonic::{Code, Status};

    #[test]
    fn unauthenticated_translates() {
        let err: AuthError = Status::unauthenticated("bad creds").into();
        assert!(matches!(err, AuthError::Unauthenticated));
    }

    #[test]
    fn unavailable_translates_to_network() {
        let err: AuthError = Status::unavailable("relay down").into();
        match err {
            AuthError::Network { message } => assert!(message.contains("relay down")),
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn deadline_exceeded_translates_to_network() {
        let err: AuthError = Status::deadline_exceeded("timeout").into();
        assert!(matches!(err, AuthError::Network { .. }));
    }

    #[test]
    fn upgrade_required_with_details_parses() {
        let detail = ErrorDetail {
            body: Some(error_detail::Body::Upgrade(chathub_proto::v1::UpgradeRequired {
                min_client_version: "1.5.0".into(),
                download_url: "https://example.com/dl".into(),
            })),
        };
        let bytes = detail.encode_to_vec();
        let status = Status::with_details(Code::FailedPrecondition, "upgrade", bytes.into());
        let err: AuthError = status.into();
        match err {
            AuthError::UpgradeRequired { min_version, download_url } => {
                assert_eq!(min_version, "1.5.0");
                assert_eq!(download_url, "https://example.com/dl");
            }
            other => panic!("wrong: {other:?}"),
        }
    }

    #[test]
    fn internal_fallback() {
        let err: AuthError = Status::internal("boom").into();
        match err {
            AuthError::Internal { message } => assert!(message.contains("boom")),
            other => panic!("wrong: {other:?}"),
        }
    }

    #[test]
    fn serializes_to_kebab_case_kind() {
        let err = AuthError::Unauthenticated;
        let json = serde_json::to_string(&err).unwrap();
        assert!(json.contains("\"kind\":\"unauthenticated\""), "json = {json}");
    }
}
```

- [ ] **Step 7.2: 跑测试**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo test -p chathub-net error::tests
```

Expected: 6 个测试通过。

- [ ] **Step 7.3: 提交**

```bash
git add backends/crates/chathub-net/src/error.rs
git commit -m "$(cat <<'EOF'
feat(chathub-net): AuthError + Status translation

- typed enum 5 个变体,serde tag=kind kebab-case
- From<Status>:Unauthenticated/Network(Unavailable+DeadlineExceeded)/UpgradeRequired/Internal
- 解析 Status.details 中的 ErrorDetail.UpgradeRequired
- 6 个单测覆盖每条翻译路径 + serde 序列化
EOF
)"
```

---

## Task 8: chathub-net channel.rs(build_endpoint)

**Files:**

- Modify: `backends/crates/chathub-net/src/channel.rs`(替换占位)

- [ ] **Step 8.1: 替换 `channel.rs` 全部内容**

```rust
//! Endpoint 配置:keep-alive、超时、TLS 选择。

use crate::error::AuthError;
use std::time::Duration;
use tonic::transport::{ClientTlsConfig, Endpoint};

/// 根据 url(http:// 或 https://)构造一个带 keep-alive 与超时的 Endpoint。
/// https:// 的连接自动启 TLS 并使用系统 root certs。
pub fn build_endpoint(url: impl Into<String>) -> Result<Endpoint, AuthError> {
    let url = url.into();
    let is_tls = url.starts_with("https://");
    let mut ep = Endpoint::from_shared(url)
        .map_err(|e| AuthError::Internal { message: format!("bad url: {e}") })?
        .http2_keep_alive_interval(Duration::from_secs(10))
        .keep_alive_timeout(Duration::from_secs(5))
        .keep_alive_while_idle(true)
        .tcp_keepalive(Some(Duration::from_secs(30)))
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(30));
    if is_tls {
        ep = ep
            .tls_config(ClientTlsConfig::new().with_native_roots())
            .map_err(|e| AuthError::Internal { message: format!("tls config: {e}") })?;
    }
    Ok(ep)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_https_endpoint_succeeds() {
        let ep = build_endpoint("https://relay.example.com").expect("https");
        let _ = ep; // 不实际 connect
    }

    #[test]
    fn build_http_endpoint_succeeds() {
        let ep = build_endpoint("http://127.0.0.1:50001").expect("http");
        let _ = ep;
    }

    #[test]
    fn build_with_invalid_url_errors() {
        let err = build_endpoint("not a url").expect_err("should err");
        assert!(matches!(err, AuthError::Internal { .. }));
    }
}
```

- [ ] **Step 8.2: 跑测试**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo test -p chathub-net channel::tests
```

Expected: 3 个通过。

- [ ] **Step 8.3: 提交**

```bash
git add backends/crates/chathub-net/src/channel.rs
git commit -m "$(cat <<'EOF'
feat(chathub-net): build_endpoint() with keep-alive + TLS

- http2_keep_alive_interval=10s / timeout=5s / while_idle=true
- tcp_keepalive=30s / connect_timeout=8s / timeout=30s
- https:// 自动启 TLS + native roots;http:// 直连
- 3 单测覆盖 https/http/invalid
EOF
)"
```

---

## Task 9: chathub-net TokenStore 类型 + 同步 getter(无网络调用)

**Files:**

- Modify: `backends/crates/chathub-net/src/token.rs`(替换占位)

注意:本 Task **只**构造 TokenState/TokenStore 的同步基础部分;login/refresh/refresher task 在 Task 11~13 加。

- [ ] **Step 9.1: 替换 `token.rs` 全部内容**

```rust
//! TokenStore:sync RwLock 持有 TokenState,interceptor 友好。
//!
//! 本 Task 只含类型 + 同步 getter;login/refresh/refresher 在后续 task 加。

use crate::error::AuthError;
use chathub_state::KeyringTokenStore;
use parking_lot::RwLock;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::{broadcast, Mutex};

/// 进程内的 token 当前值。
#[derive(Clone, Debug, PartialEq)]
pub struct TokenState {
    pub access_token:   String,
    pub access_exp_ms:  i64,
    pub refresh_exp_ms: i64,
    pub user_id:        String,
}

impl TokenState {
    pub fn is_near_expiry(&self, threshold_ms: i64) -> bool {
        let now = now_unix_ms();
        (self.access_exp_ms - now) < threshold_ms
    }
}

#[derive(Debug, Clone, Copy)]
pub enum LoggedOutReason {
    Manual,
    RefreshFailed,
    Kicked,
}

pub(crate) const PROACTIVE_REFRESH_THRESHOLD_MS: i64 = 5 * 60 * 1000;

pub struct TokenStore {
    pub(crate) state:         Arc<RwLock<Option<TokenState>>>,
    pub(crate) refresh_lock:  Arc<Mutex<()>>,
    pub(crate) keyring:       Arc<KeyringTokenStore>,
    pub(crate) device_id:     String,
    pub(crate) logged_out_tx: broadcast::Sender<LoggedOutReason>,
    /// Auth client(不带 interceptor)— Channel 内部 Arc,clone 廉价。
    /// 每次 RPC 前 .clone() 出 &mut 副本调用,不需要 Mutex。
    pub(crate) auth_client:   chathub_proto::v1::auth_client::AuthClient<tonic::transport::Channel>,
    /// Plan 2 Task 13:后台 refresher task 句柄(Option 是因为可能未启动或被 abort)
    pub(crate) refresher:     tokio::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl TokenStore {
    /// 构造一个空的 TokenStore(未登录)。endpoint 已配置好,后续 login 时连。
    pub fn new(
        endpoint: tonic::transport::Endpoint,
        keyring: KeyringTokenStore,
    ) -> Result<Self, AuthError> {
        let device_id = keyring.ensure_device_id()?;
        let (tx, _rx) = broadcast::channel(8);
        let channel = endpoint.connect_lazy();
        let auth_client = chathub_proto::v1::auth_client::AuthClient::new(channel);
        Ok(Self {
            state:         Arc::new(RwLock::new(None)),
            refresh_lock:  Arc::new(Mutex::new(())),
            keyring:       Arc::new(keyring),
            device_id,
            logged_out_tx: tx,
            auth_client,
            refresher:     tokio::sync::Mutex::new(None),
        })
    }

    /// 同步读 access token。Interceptor 用此。
    pub fn current_access_token(&self) -> Option<String> {
        self.state.read().as_ref().map(|s| s.access_token.clone())
    }

    pub fn current_user_id(&self) -> Option<String> {
        self.state.read().as_ref().map(|s| s.user_id.clone())
    }

    pub fn logged_out_subscribe(&self) -> broadcast::Receiver<LoggedOutReason> {
        self.logged_out_tx.subscribe()
    }

    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    pub fn is_logged_in(&self) -> bool {
        self.state.read().is_some()
    }
}

pub(crate) fn now_unix_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_state_is_near_expiry_boundary() {
        let now = now_unix_ms();
        let exp_in_4min = now + 4 * 60 * 1000;
        let s = TokenState {
            access_token:   "a".into(),
            access_exp_ms:  exp_in_4min,
            refresh_exp_ms: now + 30 * 24 * 60 * 60 * 1000,
            user_id:        "u-1".into(),
        };
        assert!(s.is_near_expiry(5 * 60 * 1000), "4min < 5min threshold should be near");
        assert!(!s.is_near_expiry(60 * 1000),     "4min > 1min threshold should NOT be near");
    }

    #[tokio::test]
    async fn empty_store_returns_none() {
        let kr = KeyringTokenStore::new(format!("chathub-test-{}", uuid::Uuid::new_v4()));
        let ep = tonic::transport::Endpoint::from_static("http://127.0.0.1:1");
        let store = TokenStore::new(ep, kr.clone()).expect("new");
        assert!(store.current_access_token().is_none());
        assert!(store.current_user_id().is_none());
        assert!(!store.is_logged_in());
        let _ = kr._clear_device_id_for_test();
    }
}
```

- [ ] **Step 9.2: 加 dev-dep uuid 到 chathub-net/Cargo.toml**

```diff
 [dev-dependencies]
 tokio = { workspace = true, features = ["rt-multi-thread", "macros", "sync", "time", "test-util"] }
 tokio-stream = "0.1"
 serde_json = "1"
+uuid = { workspace = true }
```

- [ ] **Step 9.3: 跑测试**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo test -p chathub-net token::tests
```

Expected: 2 个通过。

- [ ] **Step 9.4: 提交**

```bash
git add backends/crates/chathub-net/Cargo.toml backends/crates/chathub-net/src/token.rs Cargo.lock
git commit -m "$(cat <<'EOF'
feat(chathub-net): TokenState + TokenStore types + sync getters

- parking_lot::RwLock<Option<TokenState>> + tokio::sync::Mutex 序列化点
- 同步:current_access_token / current_user_id / is_logged_in / device_id
- broadcast::Sender 预备 LoggedOut 事件
- AuthClient 与 refresher 字段占位,后续 task 填
- 2 单测:near_expiry 边界 + 空 store 返回 None
EOF
)"
```

---

## Task 10: Stub Relay 测试基础设施

**Files:**

- Create: `backends/crates/chathub-net/tests/common/mod.rs`
- Create: `backends/crates/chathub-net/tests/common/stub_relay.rs`

注意:Cargo 对 `tests/common/mod.rs` 有特殊处理 —— 它不被识别为单独的 test target,只是被其它 test 文件用 `mod common;` 引入。

- [ ] **Step 10.1: 创建 `tests/common/mod.rs`**

```rust
//! 测试共享代码。Cargo 不会把这个目录当独立 test target。
pub mod stub_relay;
```

- [ ] **Step 10.2: 创建 `tests/common/stub_relay.rs`**

```rust
//! Stub Relay:进程内 tonic Server 实现 chathub.v1.Auth 三个 method。
//! 测试通过共享的 Arc<Mutex<StubState>> 控制返回值。

#![allow(dead_code)]

use chathub_proto::v1::auth_server::{Auth, AuthServer};
use chathub_proto::v1::{
    LoginRequest, LoginResponse, LogoutRequest, LogoutResponse,
    RefreshTokenRequest, RefreshTokenResponse,
    UserProfile, WecomAccount,
};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use tokio_stream::wrappers::TcpListenerStream;
use tonic::{transport::Server, Request, Response, Status};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum LoginOutcome {
    Ok,
    Unauthenticated,
    Network,
    UpgradeRequired,
}

impl Default for LoginOutcome {
    fn default() -> Self { LoginOutcome::Ok }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum RefreshOutcome {
    Ok,
    Revoked,
    Network,
}

impl Default for RefreshOutcome {
    fn default() -> Self { RefreshOutcome::Ok }
}

#[derive(Default, Clone)]
pub struct StubState {
    pub login_outcome:   LoginOutcome,
    pub refresh_outcome: RefreshOutcome,
    /// access TTL,默认 30 分钟;测试用小值(如 2_000ms)触发主动刷新
    pub access_ttl_ms:   i64,
    /// refresh TTL,默认 30 天
    pub refresh_ttl_ms:  i64,
    pub login_count:     usize,
    pub refresh_count:   usize,
    pub logout_count:    usize,
    /// 模拟 KICKED 等场景:置 true 后下一次 refresh 强制返回 Unauthenticated
    pub force_revoke_next_refresh: bool,
}

impl StubState {
    pub fn new_default_ttls() -> Self {
        Self {
            login_outcome:   LoginOutcome::Ok,
            refresh_outcome: RefreshOutcome::Ok,
            access_ttl_ms:   30 * 60 * 1000,
            refresh_ttl_ms:  30 * 24 * 60 * 60 * 1000,
            ..Default::default()
        }
    }
}

pub struct StubAuth { pub state: Arc<Mutex<StubState>> }

#[tonic::async_trait]
impl Auth for StubAuth {
    async fn login(&self, req: Request<LoginRequest>) -> Result<Response<LoginResponse>, Status> {
        let mut s = self.state.lock().unwrap();
        s.login_count += 1;
        match s.login_outcome {
            LoginOutcome::Unauthenticated => return Err(Status::unauthenticated("bad creds")),
            LoginOutcome::Network          => return Err(Status::unavailable("relay down")),
            LoginOutcome::UpgradeRequired  => return Err(upgrade_required_status()),
            LoginOutcome::Ok => {}
        }
        let _ = req;
        let now = now_ms();
        Ok(Response::new(LoginResponse {
            access_token:   "a-".to_string() + &uuid_seed(now),
            access_exp_ms:  now + s.access_ttl_ms,
            refresh_token:  "r-".to_string() + &uuid_seed(now),
            refresh_exp_ms: now + s.refresh_ttl_ms,
            user:           Some(default_profile()),
            wecom_accounts: default_accounts(),
        }))
    }

    async fn refresh_token(&self, _req: Request<RefreshTokenRequest>)
        -> Result<Response<RefreshTokenResponse>, Status>
    {
        let mut s = self.state.lock().unwrap();
        s.refresh_count += 1;
        if s.force_revoke_next_refresh {
            s.force_revoke_next_refresh = false;
            return Err(Status::unauthenticated("revoked"));
        }
        match s.refresh_outcome {
            RefreshOutcome::Revoked => return Err(Status::unauthenticated("revoked")),
            RefreshOutcome::Network => return Err(Status::unavailable("relay down")),
            RefreshOutcome::Ok => {}
        }
        let now = now_ms();
        Ok(Response::new(RefreshTokenResponse {
            access_token:   "a-".to_string() + &uuid_seed(now),
            access_exp_ms:  now + s.access_ttl_ms,
            refresh_token:  "r-".to_string() + &uuid_seed(now),
            refresh_exp_ms: now + s.refresh_ttl_ms,
        }))
    }

    async fn logout(&self, _req: Request<LogoutRequest>) -> Result<Response<LogoutResponse>, Status> {
        let mut s = self.state.lock().unwrap();
        s.logout_count += 1;
        Ok(Response::new(LogoutResponse {}))
    }
}

pub async fn start_stub() -> (SocketAddr, Arc<Mutex<StubState>>, JoinHandle<()>) {
    let state = Arc::new(Mutex::new(StubState::new_default_ttls()));
    let auth = StubAuth { state: state.clone() };
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("local_addr");
    let stream = TcpListenerStream::new(listener);
    let handle = tokio::spawn(async move {
        let _ = Server::builder()
            .add_service(AuthServer::new(auth))
            .serve_with_incoming(stream)
            .await;
    });
    // 给 server 一点点启动时间(本地通常 < 1ms,加 sleep 保险)
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    (addr, state, handle)
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn uuid_seed(seed: i64) -> String {
    // 让每次返回的 token 字面值不同(便于断言"换新")
    format!("{seed:x}-{}", uuid::Uuid::new_v4().simple())
}

fn default_profile() -> UserProfile {
    UserProfile {
        user_id:      "u-stub".into(),
        display_name: "Stub User".into(),
        avatar_url:   "".into(),
        role:         "operator".into(),
        tenant_id:    "t-stub".into(),
    }
}

fn default_accounts() -> Vec<WecomAccount> {
    vec![WecomAccount {
        wecom_account_id: "wa-stub-1".into(),
        corp_id:          "wwd00".into(),
        agent_id:         1,
        display_name:     "Stub WeCom".into(),
        enabled:          true,
    }]
}

fn upgrade_required_status() -> Status {
    use chathub_proto::v1::{ErrorDetail, error_detail, UpgradeRequired};
    use prost::Message;
    let detail = ErrorDetail {
        body: Some(error_detail::Body::Upgrade(UpgradeRequired {
            min_client_version: "9.9.9".into(),
            download_url: "https://example.com/dl".into(),
        })),
    };
    Status::with_details(tonic::Code::FailedPrecondition, "upgrade required", detail.encode_to_vec().into())
}
```

- [ ] **Step 10.3: 跑 cargo build --tests 确认 stub 自身可编译**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo build -p chathub-net --tests
```

Expected: 编译通过(可能 warning "common::stub_relay 未使用",可忽略,后面 e2e 测试会用)。

- [ ] **Step 10.4: 提交**

```bash
git add backends/crates/chathub-net/tests/common/
git commit -m "$(cat <<'EOF'
feat(chathub-net): stub Relay test fixture

- tests/common/stub_relay.rs:进程内 tonic Server,实现 Auth 三 method
- StubState 控制 login/refresh/logout outcome、access/refresh TTL、计数
- start_stub() 监听 127.0.0.1:0,返回 (addr, state, handle)
- LoginOutcome / RefreshOutcome 覆盖正常 / Unauthenticated / Network / UpgradeRequired
EOF
)"
```

---

## Task 11: chathub-net TokenStore::login + e2e 场景 1, 2

**Files:**

- Modify: `backends/crates/chathub-net/src/token.rs`(添加 login + 私有 do_login_inner)
- Create: `backends/crates/chathub-net/tests/auth_e2e.rs`

- [ ] **Step 11.1: 在 `token.rs` 加 login 方法**

在 `impl TokenStore { ... }` 块内末尾追加:

```rust
    /// 同步发起一次 Login RPC,成功后写 keyring + 设置 state。
    /// **不**启动后台 refresher task(留给 AuthApi::login 决定何时启动)。
    pub async fn login(&self, username: &str, password: &str)
        -> Result<chathub_proto::v1::LoginResponse, AuthError>
    {
        use chathub_proto::v1::LoginRequest;

        let req = LoginRequest {
            username:    username.to_string(),
            password:    password.to_string(),
            device_id:   self.device_id.clone(),
            device_name: hostname_or_default(),
            client_ver:  env!("CARGO_PKG_VERSION").to_string(),
        };

        // Channel 内部 Arc,clone 廉价。每次 RPC 用一个本地 &mut 副本。
        let mut client = self.auth_client.clone();
        let resp = client.login(req).await?.into_inner();

        // 写 keyring + 内存 state
        self.keyring.write_refresh_token(&resp.refresh_token)?;
        let state = TokenState {
            access_token:   resp.access_token.clone(),
            access_exp_ms:  resp.access_exp_ms,
            refresh_exp_ms: resp.refresh_exp_ms,
            user_id:        resp.user.as_ref().map(|p| p.user_id.clone()).unwrap_or_default(),
        };
        *self.state.write() = Some(state);

        Ok(resp)
    }
}

fn hostname_or_default() -> String {
    std::env::var("CHATHUB_DEVICE_NAME")
        .ok()
        .unwrap_or_else(|| "chathub-desktop".into())
}
```

注意:`}` 是 `impl TokenStore` 的关闭括号,所以在它之前插入 login;`hostname_or_default` 是 `impl` 外的自由函数。

- [ ] **Step 11.2: 创建 `tests/auth_e2e.rs`(场景 1 + 2)**

```rust
//! End-to-end tests against in-process stub Relay.
//! Covers 7 scenarios from spec §7.2.

mod common;

use chathub_net::TokenStore;
use chathub_state::KeyringTokenStore;
use common::stub_relay::{start_stub, LoginOutcome};

fn unique_keyring() -> KeyringTokenStore {
    KeyringTokenStore::new(format!("chathub-test-{}", uuid::Uuid::new_v4()))
}

#[tokio::test]
async fn scenario_1_login_success() {
    let (addr, state, _h) = start_stub().await;
    let kr = unique_keyring();

    let ep = chathub_net::build_endpoint(format!("http://{addr}")).expect("ep");
    let store = TokenStore::new(ep, kr.clone()).expect("store");

    let resp = store.login("alice", "pwd").await.expect("login");
    assert_eq!(resp.user.as_ref().unwrap().user_id, "u-stub");

    assert!(store.is_logged_in());
    assert!(store.current_access_token().is_some());
    assert_eq!(state.lock().unwrap().login_count, 1);
    assert!(kr.read_refresh_token().unwrap().is_some(), "refresh persisted to keyring");

    // cleanup
    let _ = kr.clear_refresh_token();
    let _ = kr._clear_device_id_for_test();
}

#[tokio::test]
async fn scenario_2_login_unauthenticated() {
    let (addr, state, _h) = start_stub().await;
    state.lock().unwrap().login_outcome = LoginOutcome::Unauthenticated;

    let kr = unique_keyring();
    let ep = chathub_net::build_endpoint(format!("http://{addr}")).expect("ep");
    let store = TokenStore::new(ep, kr.clone()).expect("store");

    let err = store.login("alice", "pwd").await.expect_err("should fail");
    assert!(matches!(err, chathub_net::AuthError::Unauthenticated));
    assert!(!store.is_logged_in());
    assert!(kr.read_refresh_token().unwrap().is_none(), "no token written on failure");

    let _ = kr.clear_refresh_token();
    let _ = kr._clear_device_id_for_test();
}
```

- [ ] **Step 11.3: 跑 e2e 测试**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo test -p chathub-net --test auth_e2e
```

Expected: 2 个测试通过。

- [ ] **Step 11.4: 提交**

```bash
git add backends/crates/chathub-net/src/token.rs backends/crates/chathub-net/tests/auth_e2e.rs
git commit -m "$(cat <<'EOF'
feat(chathub-net): TokenStore::login + e2e scenarios 1 and 2

- TokenStore::login 调 Auth.Login, 写 keyring, 更新内存 state
- e2e 1:login_success — 鉴权成功,token 落地,login_count=1
- e2e 2:login_unauthenticated — Status::Unauthenticated → AuthError;无 keyring 写入
EOF
)"
```

---

## Task 12: chathub-net TokenStore::do_refresh + force_refresh + e2e 场景 4, 6

**Files:**

- Modify: `backends/crates/chathub-net/src/token.rs`
- Modify: `backends/crates/chathub-net/tests/auth_e2e.rs`

- [ ] **Step 12.1: 在 `token.rs` 加 do_refresh 与 force_refresh**

在 `impl TokenStore` 内追加(login 之后):

```rust
    /// 强制刷新一次。被动调用(业务拿到 Status::Unauthenticated 时调)。
    /// 内部 取 refresh_lock 序列化;失败后清 keyring 并 broadcast LoggedOutReason::RefreshFailed。
    pub async fn force_refresh(&self) -> Result<(), AuthError> {
        let _g = self.refresh_lock.lock().await;
        // 双检:可能别的 task 已经刷过了
        if let Some(s) = self.state.read().as_ref() {
            if !s.is_near_expiry(PROACTIVE_REFRESH_THRESHOLD_MS) {
                return Ok(());
            }
        }
        self.do_refresh_inner().await
    }

    pub(crate) async fn do_refresh_inner(&self) -> Result<(), AuthError> {
        use chathub_proto::v1::RefreshTokenRequest;

        let refresh_token = match self.keyring.read_refresh_token()? {
            Some(t) => t,
            None    => return Err(AuthError::Unauthenticated),
        };
        let req = RefreshTokenRequest {
            refresh_token,
            device_id: self.device_id.clone(),
        };

        let mut client = self.auth_client.clone();
        let resp = client.refresh_token(req).await;

        let resp = match resp {
            Ok(r) => r.into_inner(),
            Err(s) => {
                let err = AuthError::from(s);
                if matches!(err, AuthError::Unauthenticated) {
                    // 失效:清 keyring,清 state,广播
                    let _ = self.keyring.clear_refresh_token();
                    *self.state.write() = None;
                    let _ = self.logged_out_tx.send(LoggedOutReason::RefreshFailed);
                }
                return Err(err);
            }
        };

        // 成功:轮换 refresh + 更新 access
        self.keyring.write_refresh_token(&resp.refresh_token)?;
        let user_id = self.state.read().as_ref().map(|s| s.user_id.clone()).unwrap_or_default();
        *self.state.write() = Some(TokenState {
            access_token:   resp.access_token,
            access_exp_ms:  resp.access_exp_ms,
            refresh_exp_ms: resp.refresh_exp_ms,
            user_id,
        });
        Ok(())
    }
```

- [ ] **Step 12.2: 在 `tests/auth_e2e.rs` 加场景 4 和 6**

在文件末尾追加:

```rust
#[tokio::test]
async fn scenario_4_reactive_refresh_on_unauthenticated() {
    let (addr, state, _h) = start_stub().await;
    let kr = unique_keyring();

    let ep = chathub_net::build_endpoint(format!("http://{addr}")).expect("ep");
    let store = TokenStore::new(ep, kr.clone()).expect("store");
    store.login("alice", "pwd").await.expect("login");

    // 模拟"业务拿到 Unauthenticated → 调 force_refresh":
    let access_before = store.current_access_token().unwrap();
    store.force_refresh().await.expect("refresh ok");
    let access_after = store.current_access_token().unwrap();

    assert_ne!(access_before, access_after, "access token should be rotated");
    assert_eq!(state.lock().unwrap().refresh_count, 1);
    assert!(store.is_logged_in());

    let _ = kr.clear_refresh_token();
    let _ = kr._clear_device_id_for_test();
}

#[tokio::test]
async fn scenario_6_refresh_revoked_emits_event() {
    let (addr, state, _h) = start_stub().await;
    let kr = unique_keyring();

    let ep = chathub_net::build_endpoint(format!("http://{addr}")).expect("ep");
    let store = TokenStore::new(ep, kr.clone()).expect("store");
    store.login("alice", "pwd").await.expect("login");

    // 订阅 LoggedOut 事件
    let mut rx = store.logged_out_subscribe();

    // 让下一次 refresh 返回 Unauthenticated(revoked)
    state.lock().unwrap().force_revoke_next_refresh = true;

    let err = store.force_refresh().await.expect_err("should fail");
    assert!(matches!(err, chathub_net::AuthError::Unauthenticated));

    // 事件应当广播
    let reason = tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv())
        .await.expect("timeout").expect("recv");
    assert!(matches!(reason, chathub_net::token::LoggedOutReason::RefreshFailed));

    // 状态应清空
    assert!(!store.is_logged_in());
    assert!(kr.read_refresh_token().unwrap().is_none());

    let _ = kr.clear_refresh_token();
    let _ = kr._clear_device_id_for_test();
}
```

注意:测试代码引用了 `chathub_net::token::LoggedOutReason`,意味着 `token` mod 需要 `pub`。检查 lib.rs:`pub mod token;` —— 已是 pub,没问题。

- [ ] **Step 12.3: 跑测试**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo test -p chathub-net --test auth_e2e
```

Expected: 4 个 e2e 通过(原 2 + 新 2)。

- [ ] **Step 12.4: 提交**

```bash
git add backends/crates/chathub-net/src/token.rs backends/crates/chathub-net/tests/auth_e2e.rs
git commit -m "$(cat <<'EOF'
feat(chathub-net): force_refresh + reactive paths + scenarios 4 and 6

- force_refresh:取 refresh_lock + 双检 + do_refresh_inner
- 失败为 Unauthenticated 时:清 keyring + state + broadcast RefreshFailed
- 成功时轮换 refresh + 更新 access(保留原 user_id)
- e2e 4:reactive refresh 后 access token 换新
- e2e 6:服务端 revoke → 事件广播 + 本地清干净
EOF
)"
```

---

## Task 13: chathub-net TokenStore 后台 refresher task + e2e 场景 3

**Files:**

- Modify: `backends/crates/chathub-net/src/token.rs`
- Modify: `backends/crates/chathub-net/tests/auth_e2e.rs`

- [ ] **Step 13.1: 在 `token.rs` 加 spawn_refresher / abort_refresher**

在 `impl TokenStore` 内追加(force_refresh 之后):

```rust
    /// 启动后台 refresher task。`login()` 与 `try_resume_session()` 成功后调。
    /// 如果已有运行中的 task,先 abort 再起新的。
    pub async fn spawn_refresher(self: &Arc<Self>) {
        self.abort_refresher().await;
        let me = Arc::clone(self);
        let h = tokio::spawn(async move { me.refresher_loop().await; });
        let mut guard = self.refresher.lock().await;
        *guard = Some(h);
    }

    pub async fn abort_refresher(&self) {
        let mut guard = self.refresher.lock().await;
        if let Some(h) = guard.take() {
            h.abort();
        }
    }

    async fn refresher_loop(self: Arc<Self>) {
        loop {
            // 计算下一次 refresh 时机
            let sleep_ms: i64 = {
                let guard = self.state.read();
                match guard.as_ref() {
                    None => return,  // 已登出
                    Some(s) => {
                        let until_threshold = s.access_exp_ms - now_unix_ms() - PROACTIVE_REFRESH_THRESHOLD_MS;
                        until_threshold.max(0)
                    }
                }
            };
            if sleep_ms > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(sleep_ms as u64)).await;
            }

            // 已到 5min 阈值 → 取 refresh_lock 序列化(可能 force_refresh 已经在跑)
            let _g = self.refresh_lock.lock().await;
            // 双检
            let still_near = {
                let guard = self.state.read();
                match guard.as_ref() {
                    None    => return,
                    Some(s) => s.is_near_expiry(PROACTIVE_REFRESH_THRESHOLD_MS),
                }
            };
            if !still_near { continue; }

            match self.do_refresh_inner().await {
                Ok(()) => {} // 继续 loop
                Err(AuthError::Unauthenticated) => return,  // 已 broadcast、清状态、退出
                Err(_other) => {
                    // 网络类:退避重试。简单实现:sleep 5s 然后继续 loop。
                    drop(_g);
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                }
            }
        }
    }
```

- [ ] **Step 13.2: 在 `tests/auth_e2e.rs` 加场景 3**

在文件末尾追加:

```rust
#[tokio::test]
async fn scenario_3_proactive_refresh_when_near_expiry() {
    let (addr, state, _h) = start_stub().await;
    // 让 stub 返回非常短的 access_ttl,触发立即 proactive refresh
    state.lock().unwrap().access_ttl_ms = 1_000; // 1s

    let kr = unique_keyring();
    let ep = chathub_net::build_endpoint(format!("http://{addr}")).expect("ep");
    let store = std::sync::Arc::new(TokenStore::new(ep, kr.clone()).expect("store"));
    store.login("alice", "pwd").await.expect("login");

    // 启动后台 refresher
    store.spawn_refresher().await;

    // 由于 access 1s 后过期且 threshold 是 5min,refresher 应**立即**触发刷新
    // 给它 2s 跑一轮 + 一次刷新
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;

    let count = state.lock().unwrap().refresh_count;
    assert!(count >= 1, "refresher should have refreshed at least once, got {count}");

    store.abort_refresher().await;

    let _ = kr.clear_refresh_token();
    let _ = kr._clear_device_id_for_test();
}
```

- [ ] **Step 13.3: 跑测试**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo test -p chathub-net --test auth_e2e scenario_3
```

Expected: 通过(可能 2~3 秒,因为 sleep)。

- [ ] **Step 13.4: 跑全部 e2e 确认无回归**

```bash
cargo test -p chathub-net --test auth_e2e
```

Expected: 5 个通过(场景 1, 2, 3, 4, 6)。

- [ ] **Step 13.5: 提交**

```bash
git add backends/crates/chathub-net/src/token.rs backends/crates/chathub-net/tests/auth_e2e.rs
git commit -m "$(cat <<'EOF'
feat(chathub-net): background refresher task + scenario 3

- spawn_refresher / abort_refresher,由 login + try_resume 触发
- refresher_loop:sleep 至 access exp - 5min threshold → refresh
- 失败 Unauthenticated 自动退出(已 broadcast 清状态);网络错退避 5s
- e2e 3:access_ttl=1s + threshold 5min → 立即 refresh,refresh_count >= 1
EOF
)"
```

---

## Task 14: chathub-net TokenStore::logout + e2e 场景 5

**Files:**

- Modify: `backends/crates/chathub-net/src/token.rs`
- Modify: `backends/crates/chathub-net/tests/auth_e2e.rs`

- [ ] **Step 14.1: 在 `token.rs` 加 logout 方法**

在 `impl TokenStore` 内追加(spawn_refresher 之后):

```rust
    /// 主动登出:abort refresher → 调 Auth.Logout(best-effort)→ 清 keyring + state → broadcast Manual。
    pub async fn logout(&self) -> Result<(), AuthError> {
        use chathub_proto::v1::LogoutRequest;

        self.abort_refresher().await;

        // best-effort RPC
        if let Ok(Some(refresh)) = self.keyring.read_refresh_token() {
            let req = LogoutRequest { refresh_token: refresh };
            let mut client = self.auth_client.clone();
            let _ = client.logout(req).await;  // 网络错忽略
        }

        let _ = self.keyring.clear_refresh_token();
        *self.state.write() = None;
        let _ = self.logged_out_tx.send(LoggedOutReason::Manual);
        Ok(())
    }
```

- [ ] **Step 14.2: 在 `tests/auth_e2e.rs` 加场景 5**

在末尾追加:

```rust
#[tokio::test]
async fn scenario_5_logout_emits_event() {
    let (addr, state, _h) = start_stub().await;
    let kr = unique_keyring();

    let ep = chathub_net::build_endpoint(format!("http://{addr}")).expect("ep");
    let store = TokenStore::new(ep, kr.clone()).expect("store");
    store.login("alice", "pwd").await.expect("login");

    let mut rx = store.logged_out_subscribe();
    store.logout().await.expect("logout");

    let reason = tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv())
        .await.expect("timeout").expect("recv");
    assert!(matches!(reason, chathub_net::token::LoggedOutReason::Manual));

    assert!(!store.is_logged_in());
    assert!(kr.read_refresh_token().unwrap().is_none());
    assert_eq!(state.lock().unwrap().logout_count, 1);

    let _ = kr.clear_refresh_token();
    let _ = kr._clear_device_id_for_test();
}
```

- [ ] **Step 14.3: 跑测试**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo test -p chathub-net --test auth_e2e
```

Expected: 6 个通过。

- [ ] **Step 14.4: 提交**

```bash
git add backends/crates/chathub-net/src/token.rs backends/crates/chathub-net/tests/auth_e2e.rs
git commit -m "$(cat <<'EOF'
feat(chathub-net): TokenStore::logout + scenario 5

- logout:abort refresher → best-effort Auth.Logout → 清 keyring + state → broadcast Manual
- 网络错忽略(本地清是关键)
- e2e 5:logout_count=1, 状态清空, 事件 reason=Manual
EOF
)"
```

---

## Task 15: chathub-net AuthInterceptor

**Files:**

- Modify: `backends/crates/chathub-net/src/interceptor.rs`(替换占位)

- [ ] **Step 15.1: 替换 `interceptor.rs` 全部内容**

```rust
//! AuthInterceptor:同步 Interceptor,注入 Bearer + 协议头。
//!
//! 仅供 Plan 3 起的 Hub.* 客户端使用;Auth.* RPC 不走此 interceptor。

use crate::token::TokenStore;
use std::sync::Arc;
use tonic::metadata::MetadataValue;
use tonic::{Request, Status};

#[derive(Clone)]
pub struct AuthInterceptor {
    token_store:    Arc<TokenStore>,
    client_version: &'static str,
    platform:       &'static str,
}

impl AuthInterceptor {
    pub fn new(token_store: Arc<TokenStore>) -> Self {
        Self {
            token_store,
            client_version: env!("CARGO_PKG_VERSION"),
            platform: PLATFORM,
        }
    }
}

impl tonic::service::Interceptor for AuthInterceptor {
    fn call(&mut self, mut req: Request<()>) -> Result<Request<()>, Status> {
        let access = self.token_store
            .current_access_token()
            .ok_or_else(|| Status::unauthenticated("not logged in"))?;
        let md = req.metadata_mut();

        let bearer: MetadataValue<_> = format!("Bearer {access}")
            .parse()
            .map_err(|_| Status::internal("bearer encode"))?;
        md.insert("authorization", bearer);

        md.insert("chathub-protocol-version",
            MetadataValue::from_static("1"));
        md.insert("chathub-client-version",
            self.client_version.parse().map_err(|_| Status::internal("client_version"))?);
        md.insert("chathub-platform",
            MetadataValue::from_static(self.platform));

        Ok(req)
    }
}

#[cfg(target_os = "macos")]
const PLATFORM: &str = "macos";
#[cfg(target_os = "windows")]
const PLATFORM: &str = "windows";
#[cfg(all(target_os = "linux"))]
const PLATFORM: &str = "linux";
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
const PLATFORM: &str = "unknown";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::token::TokenStore;
    use chathub_state::KeyringTokenStore;

    fn unique_keyring() -> KeyringTokenStore {
        KeyringTokenStore::new(format!("chathub-test-{}", uuid::Uuid::new_v4()))
    }

    #[tokio::test]
    async fn unauthenticated_when_not_logged_in() {
        let kr = unique_keyring();
        let ep = tonic::transport::Endpoint::from_static("http://127.0.0.1:1");
        let store = Arc::new(TokenStore::new(ep, kr.clone()).expect("store"));
        let mut interceptor = AuthInterceptor::new(store);

        let req = Request::new(());
        let err = interceptor.call(req).expect_err("should be unauthenticated");
        assert_eq!(err.code(), tonic::Code::Unauthenticated);

        let _ = kr.clear_refresh_token();
        let _ = kr._clear_device_id_for_test();
    }

    // 集成测试覆盖"已登录情况下注入 Bearer + 头" — 在 Plan 3 真正用 Hub.* 时验证。
}
```

- [ ] **Step 15.2: 跑测试**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo test -p chathub-net interceptor::tests
```

Expected: 1 个通过。

- [ ] **Step 15.3: 提交**

```bash
git add backends/crates/chathub-net/src/interceptor.rs
git commit -m "$(cat <<'EOF'
feat(chathub-net): AuthInterceptor — sync, no block_on

- 注入 Bearer + chathub-protocol-version + chathub-client-version + chathub-platform
- 未登录时返回 Status::Unauthenticated
- platform const 由 cfg!(target_os) 决定(macos/windows/linux/unknown)
- 单测:未登录 → Unauthenticated
EOF
)"
```

---

## Task 16: chathub-net AuthApi(login + logout)

**Files:**

- Modify: `backends/crates/chathub-net/src/auth.rs`(替换占位)

- [ ] **Step 16.1: 替换 `auth.rs` 全部内容**

```rust
//! AuthApi:供 backends 用的高层包装。
//! 内部 持有 TokenStore + SessionStore,负责 keyring/SQLite/state 协同。

use crate::error::AuthError;
use crate::token::{TokenStore, LoggedOutReason as TokenLoggedOutReason};
use chathub_proto::v1::UserProfile;
use chathub_state::SessionStore;
use std::sync::Arc;
use tokio::sync::broadcast;

pub use crate::token::LoggedOutReason;

#[derive(Clone)]
pub struct AuthApi {
    token_store:   Arc<TokenStore>,
    session_store: SessionStore,
}

impl AuthApi {
    pub fn new(token_store: Arc<TokenStore>, session_store: SessionStore) -> Self {
        Self { token_store, session_store }
    }

    pub async fn login(&self, username: &str, password: &str)
        -> Result<UserProfile, AuthError>
    {
        let resp = self.token_store.login(username, password).await?;
        let profile = resp.user.ok_or_else(|| AuthError::Internal {
            message: "login response missing user".into()
        })?;
        let accounts = resp.wecom_accounts;

        self.session_store.upsert_session(&profile, &accounts).await?;

        // 启动后台 refresher
        self.token_store.spawn_refresher().await;

        Ok(profile)
    }

    pub async fn logout(&self) -> Result<(), AuthError> {
        self.token_store.logout().await?;
        self.session_store.clear().await?;
        Ok(())
    }

    pub async fn current_session(&self) -> Result<Option<UserProfile>, AuthError> {
        // 以 SessionStore + TokenStore 双重一致性返回:任一缺失都视为未登录。
        if !self.token_store.is_logged_in() {
            return Ok(None);
        }
        Ok(self.session_store.read_current().await?)
    }

    pub fn logged_out_subscribe(&self) -> broadcast::Receiver<TokenLoggedOutReason> {
        self.token_store.logged_out_subscribe()
    }
}
```

- [ ] **Step 16.2: 跑 cargo build 确认编译过**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo build -p chathub-net
```

Expected: 编译通过。

- [ ] **Step 16.3: 跑全部测试无回归**

```bash
cargo test -p chathub-net
```

Expected: 所有单测 + 6 个 e2e 通过。

- [ ] **Step 16.4: 提交**

```bash
git add backends/crates/chathub-net/src/auth.rs
git commit -m "$(cat <<'EOF'
feat(chathub-net): AuthApi — login + logout + current_session

- AuthApi 包装 TokenStore + SessionStore
- login:RPC + 写 session 表 + spawn refresher
- logout:TokenStore.logout(本地清) + session.clear
- current_session:TokenStore 与 SessionStore 双一致才返回 Some
EOF
)"
```

---

## Task 17: chathub-net AuthApi::try_resume_session + e2e 场景 7

**Files:**

- Modify: `backends/crates/chathub-net/src/auth.rs`
- Modify: `backends/crates/chathub-net/tests/auth_e2e.rs`

- [ ] **Step 17.1: 在 `auth.rs` 的 `impl AuthApi` 加 try_resume_session**

```rust
    /// 进程启动时调用:keyring 有 refresh → 触发 force_refresh 复活会话。
    /// 失败时(包括 Unauthenticated)返回 Ok(None) 而非 Err,因为这是冷启动场景。
    pub async fn try_resume_session(&self) -> Result<Option<UserProfile>, AuthError> {
        // 1. 检查是否有 refresh
        let has_refresh = match self.token_store.keyring_has_refresh() {
            true  => true,
            false => return Ok(None),
        };
        let _ = has_refresh;

        // 2. 从 SessionStore 读 user_id 提示给 TokenStore(没有也行)
        let saved_profile = self.session_store.read_current().await.ok().flatten();
        if let Some(p) = &saved_profile {
            self.token_store.seed_user_id(&p.user_id);
        }

        // 3. force_refresh 拉新 access
        match self.token_store.force_refresh().await {
            Ok(()) => {
                self.token_store.spawn_refresher().await;
                Ok(saved_profile)
            }
            Err(AuthError::Unauthenticated) => {
                let _ = self.session_store.clear().await;
                Ok(None)
            }
            Err(other) => Err(other),
        }
    }
```

- [ ] **Step 17.2: 在 `token.rs` 加两个辅助方法**

在 `impl TokenStore` 内追加(logout 之后):

```rust
    /// 仅供 AuthApi::try_resume_session 用:keyring 是否有 refresh_token。
    pub fn keyring_has_refresh(&self) -> bool {
        matches!(self.keyring.read_refresh_token(), Ok(Some(_)))
    }

    /// 仅供 AuthApi::try_resume_session 用:在 force_refresh 之前先种 user_id 到 state。
    /// 在 do_refresh_inner 成功时,user_id 会被保留(详见 do_refresh_inner)。
    pub fn seed_user_id(&self, user_id: &str) {
        let mut s = self.state.write();
        if s.is_none() {
            *s = Some(TokenState {
                access_token:   String::new(),    // 占位,refresh 后被覆盖
                access_exp_ms:  0,
                refresh_exp_ms: 0,
                user_id:        user_id.to_string(),
            });
        }
    }
```

注意 do_refresh_inner 已经在成功路径里 `let user_id = self.state.read().as_ref().map(|s| s.user_id.clone()).unwrap_or_default();` —— seed_user_id 把这个值预填好,refresh 成功后 state 的 user_id 不会丢。

- [ ] **Step 17.3: 在 `tests/auth_e2e.rs` 加场景 7**

```rust
#[tokio::test]
async fn scenario_7_resume_after_restart() {
    let (addr, state, _h) = start_stub().await;
    let kr = unique_keyring();

    let pool1 = chathub_state::SqlitePool::in_memory().await.expect("pool1");
    let session1 = chathub_state::SessionStore::new(pool1);
    let ep = chathub_net::build_endpoint(format!("http://{addr}")).expect("ep");
    let store1 = std::sync::Arc::new(TokenStore::new(ep.clone(), kr.clone()).expect("store1"));
    let api1 = chathub_net::AuthApi::new(store1.clone(), session1.clone());
    api1.login("alice", "pwd").await.expect("login");
    drop(api1);
    drop(store1);

    // "进程重启":新 store + 新 session + 同一个 keyring
    // session 表是 in-memory,不能跨实例;此处用同一个 SessionStore 模拟磁盘持久化(实际用例里 SQLite 落盘是持久的)
    // 关键测试点:从 keyring 读 refresh + force_refresh 拿新 access
    let store2 = std::sync::Arc::new(TokenStore::new(ep, kr.clone()).expect("store2"));
    let api2 = chathub_net::AuthApi::new(store2.clone(), session1);
    let resumed = api2.try_resume_session().await.expect("resume");
    assert!(resumed.is_some(), "should resume session");
    assert!(store2.is_logged_in());
    assert!(state.lock().unwrap().refresh_count >= 1);

    let _ = kr.clear_refresh_token();
    let _ = kr._clear_device_id_for_test();
}
```

注:测试里复用同一个 `session1` 模拟磁盘持久化(实际生产里 SQLite 落盘自然跨实例存在)。这个测试主要验证 keyring → refresh → 新 access 的链路。

- [ ] **Step 17.4: 跑全部 e2e**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo test -p chathub-net --test auth_e2e
```

Expected: 7 个 e2e 全过。

- [ ] **Step 17.5: clippy + 全 workspace test 一次,确认无回归**

```bash
cargo test --workspace
cargo clippy --workspace -- -D warnings
```

Expected: 全过、零警告。

- [ ] **Step 17.6: 提交**

```bash
git add backends/crates/chathub-net/src/auth.rs backends/crates/chathub-net/src/token.rs backends/crates/chathub-net/tests/auth_e2e.rs
git commit -m "$(cat <<'EOF'
feat(chathub-net): try_resume_session + scenario 7

- AuthApi::try_resume_session:keyring 有 refresh → force_refresh 复活会话
- TokenStore::keyring_has_refresh / seed_user_id 辅助
- e2e 7:重新建实例 + 同 keyring → resume 成功 + refresh_count >= 1
- 至此 7 个 e2e 场景全覆盖
EOF
)"
```

---

## Task 18: backends — workspace 依赖 + AppState + 3 Tauri 命令

**Files:**

- Modify: `backends/Cargo.toml`
- Modify: `backends/src/lib.rs`

注意:这个 task 改动较大,但聚焦于"把 chathub-net 接进 Tauri"这一个目标。如果你要进一步拆分,可以分成 18a (Cargo.toml + setup) / 18b (3 commands) / 18c (event bridge),但本计划保持单任务。

- [ ] **Step 18.1: 修改 `backends/Cargo.toml`,加 chathub-net + chathub-state path 依赖**

```diff
 chathub-proto = { path = "crates/chathub-proto" }
+chathub-state = { path = "crates/chathub-state" }
+chathub-net   = { path = "crates/chathub-net" }
```

- [ ] **Step 18.2: 替换 `backends/src/lib.rs` 的内容**

```rust
mod logging;

use serde::Serialize;
use std::sync::Arc;
use tauri::{Emitter, Manager, State};
use tracing::info;

use chathub_net::{AuthApi, AuthError, LoggedOutReason, TokenStore};
use chathub_proto::v1::UserProfile;
use chathub_state::{KeyringTokenStore, SessionStore, SqlitePool};

const KEYRING_SERVICE: &str = "com.pis0sion.chathub";

// ============================== 现有命令保留 ==============================

#[tauri::command]
fn greet(name: &str) -> String {
    info!(target: "chathub::cmd", %name, "greet command invoked");
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScreenshotResult {
    cancelled: bool,
    base64: Option<String>,
}

#[tauri::command]
async fn take_screenshot() -> Result<ScreenshotResult, String> {
    take_screenshot_impl()
}

#[cfg(target_os = "macos")]
fn take_screenshot_impl() -> Result<ScreenshotResult, String> {
    use base64::engine::general_purpose::STANDARD as BASE64;
    use base64::Engine;
    use std::fs;
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("生成截图文件名失败: {e}"))?
        .as_millis();
    let path = std::env::temp_dir().join(format!("chathub-screenshot-{stamp}.png"));

    let output = Command::new("screencapture")
        .args(["-i", "-x", "-t", "png"])
        .arg(&path)
        .output()
        .map_err(|e| format!("无法启动系统截图工具: {e}"))?;

    let bytes = match fs::read(&path) {
        Ok(bytes) if !bytes.is_empty() => bytes,
        _ => {
            let _ = fs::remove_file(&path);
            if output.status.success() {
                tracing::warn!(target: "chathub::cmd", "screenshot picker returned without an image");
            }
            return Ok(ScreenshotResult { cancelled: true, base64: None });
        }
    };
    let _ = fs::remove_file(&path);

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        tracing::warn!(target: "chathub::cmd", status = ?output.status, stderr, "screenshot command failed");
        return Err(if stderr.is_empty() { "截图失败".to_string() } else { format!("截图失败: {stderr}") });
    }

    info!(target: "chathub::cmd", bytes = bytes.len(), "screenshot region captured");
    Ok(ScreenshotResult { cancelled: false, base64: Some(BASE64.encode(bytes)) })
}

#[cfg(not(target_os = "macos"))]
fn take_screenshot_impl() -> Result<ScreenshotResult, String> {
    Err("当前平台暂不支持区域截图，请使用系统截图后粘贴".to_string())
}

// ============================== Plan 2:Auth 命令 ==============================

#[tauri::command]
async fn login(state: State<'_, Arc<AuthApi>>, username: String, password: String)
    -> Result<UserProfile, AuthError>
{
    state.login(&username, &password).await
}

#[tauri::command]
async fn logout(state: State<'_, Arc<AuthApi>>) -> Result<(), AuthError> {
    state.logout().await
}

#[tauri::command]
async fn current_session(state: State<'_, Arc<AuthApi>>)
    -> Result<Option<UserProfile>, AuthError>
{
    state.current_session().await
}

// ============================== run() ==============================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let log_dir = app.path().app_log_dir()?;
            let guard = logging::init(&log_dir)
                .map_err(|e| Box::<dyn std::error::Error>::from(e.to_string()))?;
            app.manage(guard);
            info!(?log_dir, "tracing initialised");

            // ---- Plan 2:接入 chathub-net auth 链路 ----
            let app_data = app.path().app_data_dir()?;
            let app_handle = app.handle().clone();

            // tauri::async_runtime::block_on 在 setup 同步完成 SQLite 与 endpoint 初始化。
            // setup 闭包本身不在 async 上下文,block_on 安全可用。
            let auth_api = tauri::async_runtime::block_on(async {
                std::fs::create_dir_all(&app_data).ok();
                let pool = SqlitePool::open(app_data.join("state.sqlite"))
                    .await.map_err(|e| e.to_string())?;
                let session_store = SessionStore::new(pool);
                let keyring = KeyringTokenStore::new(KEYRING_SERVICE);
                let endpoint = chathub_net::build_endpoint(chathub_net::RELAY_URL)
                    .map_err(|e| format!("endpoint: {e}"))?;
                let token_store = Arc::new(TokenStore::new(endpoint, keyring)
                    .map_err(|e| format!("token_store: {e}"))?);
                Ok::<_, String>(AuthApi::new(token_store, session_store))
            }).map_err(|e| Box::<dyn std::error::Error>::from(e))?;
            let auth_api = Arc::new(auth_api);
            app.manage(Arc::clone(&auth_api));

            // 启动时 try_resume(后台 task,不阻塞 setup)
            let api_for_resume = Arc::clone(&auth_api);
            tauri::async_runtime::spawn(async move {
                match api_for_resume.try_resume_session().await {
                    Ok(Some(p)) => info!(target: "chathub::auth", user_id = %p.user_id, "resumed session"),
                    Ok(None)    => info!(target: "chathub::auth", "no session to resume"),
                    Err(e)      => tracing::warn!(target: "chathub::auth", error = %e, "try_resume_session failed"),
                }
            });

            // LoggedOut 事件桥接
            let mut rx = auth_api.logged_out_subscribe();
            let app_for_event = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                while let Ok(reason) = rx.recv().await {
                    let kind = match reason {
                        LoggedOutReason::Manual        => "manual",
                        LoggedOutReason::RefreshFailed => "refresh-failed",
                        LoggedOutReason::Kicked        => "kicked",
                    };
                    let _ = app_for_event.emit("auth:logged_out", serde_json::json!({ "reason": kind }));
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet, take_screenshot,
            login, logout, current_session,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// 编译期烟雾测试在 Plan 2 起被实际通信代码替代,删除占位。
```

- [ ] **Step 18.3: 把 chathub-state / net 加进 backends/Cargo.toml 的 [dependencies] 后,跑 cargo build**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo build --workspace
```

Expected: 全 workspace 编译通过(可能慢,首次拉新 dep)。

- [ ] **Step 18.4: clippy + tests 跑一次确认 backends 无回归**

```bash
cargo clippy --workspace -- -D warnings
cargo test --workspace
```

Expected: 全过 + 零警告 + 7 e2e 通过 + 各 crate 单测通过。

- [ ] **Step 18.5: Tauri 打包 smoke**

```bash
pnpm tauri build --debug
```

Expected: macOS 下打出 .app(可能要几分钟)。如果失败,看错误是 Tauri 配置还是 Rust 代码 —— 修后再 commit。

- [ ] **Step 18.6: 提交**

```bash
git add backends/Cargo.toml backends/src/lib.rs Cargo.lock
git commit -m "$(cat <<'EOF'
feat(backends): wire AuthApi + 3 Tauri commands + auth:logged_out event

- backends/Cargo.toml 加 chathub-net + chathub-state path 依赖
- setup 注入 SqlitePool + KeyringTokenStore + TokenStore + AuthApi(via async_runtime::block_on)
- 启动时 try_resume_session(后台 task)
- LoggedOut 事件桥接到 Tauri emit("auth:logged_out", {reason})
- 三个 #[tauri::command]:login / logout / current_session
- 既有 greet / take_screenshot 保留
EOF
)"
```

---

## Task 19: 清理 Plan 2 stub doc + 整体验证

**Files:**

- Delete: `docs/superpowers/plans/2026-05-11-chat-protocol-auth.md`(已被本 plan 取代)

- [ ] **Step 19.1: 删除旧 stub**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
git rm docs/superpowers/plans/2026-05-11-chat-protocol-auth.md
```

- [ ] **Step 19.2: 运行完整验证套件**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub

cargo build --workspace
cargo test --workspace
cargo clippy --workspace -- -D warnings
( cd proto && buf lint ) || echo "buf 未安装,跳过"
pnpm tauri build --debug
```

全部应退出码 0。

- [ ] **Step 19.3: 提交清理**

```bash
git commit -m "$(cat <<'EOF'
docs(plans): remove Plan 2 stub (superseded by 2026-05-10-chat-protocol-auth.md)

Plan 2 已经按本 PR 实现完成;stub 文档无意义,清掉。
EOF
)"
```

---

## Verification Checklist(合并前必走)

干净 checkout 上跑这些命令,**全部退出码 0** 才合并:

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub

# 1. workspace 编译
cargo build --workspace

# 2. 所有 unit + integration tests
cargo test --workspace
# 应见:
#   - chathub-proto: 4 tests
#   - chathub-state: pool=2, tokens=3, session=3 = 8 tests
#   - chathub-net unit: error=6, channel=3, token=2, interceptor=1 = 12 tests
#   - chathub-net auth_e2e: 7 tests
#   - 总: 31 个测试通过

# 3. clippy 严格
cargo clippy --workspace -- -D warnings

# 4. proto lint(本 plan 未改 proto,buf 应 silent 通过)
( cd proto && buf lint )

# 5. Tauri 打包(确认链路完整)
pnpm tauri build --debug

# 6. version 抽取(CI 对齐)
grep -m1 '^version = ' backends/Cargo.toml | sed 's/.*"\(.*\)"/\1/'
# 预期: 0.1.4

# 7. 启动 .app,后端日志应包含
#    - "tracing initialised"
#    - "no session to resume"(干净状态)或 "resumed session"(若 keyring 有遗留 refresh)
```

---

## Subsequent Plans(本计划合并后再细化)

| 计划                      | 关键交付                                                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Plan 3 (Subscribe + Send) | chathub-net 的 hub mod:Subscribe + Send + Recall + AckRead + FetchHistory;ConnectionManager 状态机;per-account since_seqs 持久化 |
| Plan 4 (Blob)             | chathub-blob crate:multipart/chunked 上传 + 下载 + 30 天 LRU                                                                     |
| Plan 5 (Frontend Switch)  | frontends/lib/transport + useChatMessages 切真实数据流                                                                           |

---

## Out of Scope(本计划不做)

- 任何 Hub.\* RPC(Plan 3)
- 任何附件 / blob 处理(Plan 4)
- 前端切真实数据流(Plan 5)
- 多用户同设备登录
- mTLS / 客户端证书
- 跨进程的 keyring 锁
- E2E 用 WebDriver 跑 Tauri UI(Plan 5 时再考虑)
