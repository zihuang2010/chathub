# ChatHub Plan 3 — Stream + Send + ConnectionManager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 客户端能通过 `Hub.Subscribe` 持续接收服务端 ServerEvent、通过 `Hub.Send` 发消息,并由 `ConnectionManager` 状态机在网络抖动 / token 过期 / 升级要求 / 被踢号场景下自动重连或优雅终止;在 stub Relay 上跑通 9 个新 e2e 测试,Plan 2 的 7 个 auth e2e 不破。

**Architecture:** 在已有 `chathub-net` crate 中新建 `hub.rs`(包含 `HubClient` + `ConnectionManager` + `ConnectionState` + `ExponentialBackoff` + `BackoffConfig` + `classify`);在 `chathub-state` 加 `V2__seqs.sql` migration + `SeqStore`(deadpool-sqlite UPSERT);proto 加 `Send/SendResponse + IncomingMsg + SystemSignal`;backends 拼装两个独立单元(`Arc<AuthApi> + Arc<ConnectionManager>`),login/logout 命令串联,加 2 个 Tauri 命令 + 2 个事件桥接 task。stub Relay 同进程注册 `AuthServer + HubServer`,旧 `start_stub` 签名向后兼容。

**Tech Stack:** tonic 0.12 + prost 0.13 + tokio 1.x(broadcast/watch/Mutex/spawn/select)+ parking_lot 0.12 + deadpool-sqlite 0.9 + rusqlite_migration 1.3 + uuid 1 + thiserror 1 + tonic-build 0.12 + tokio-stream 0.1。

**Spec:** `docs/superpowers/specs/2026-05-10-chat-protocol-stream-design.md`(已 commit `76cb087`)。本计划严格按 spec 落地,DOD 见 spec §10。

**Plan 2 状态:** 已合入 main(commits `cd85be2..acd1280`)。当前 HEAD 至少 `76cb087`(本 plan 的 spec)。本 plan 假设当前在 `main` 分支。

---

## File Structure

### 新建

```
backends/crates/chathub-state/
  migrations/V2__seqs.sql                        ← 单表 wecom_account_seqs
  src/seqs.rs                                    ← SeqStore: new/upsert/read_all/clear

backends/crates/chathub-net/
  src/hub.rs                                     ← HubClient + ConnectionManager + ConnectionState
                                                    + BackoffConfig + ExponentialBackoff + classify
  tests/hub_e2e.rs                               ← 9 个 e2e 场景
```

### 修改

- `proto/chathub/v1/hub.proto` — 加 `rpc Send` + `SendRequest` + `SendResponse`
- `proto/chathub/v1/event.proto` — `ServerEvent` 加 oneof body + `IncomingMsg` + `SystemSignal`(含 enum Kind)
- `backends/crates/chathub-proto/build.rs` — 在已有 8 条 `.type_attribute(...)` 后加 6 条
- `backends/crates/chathub-state/src/lib.rs` — `pub mod seqs; pub use seqs::SeqStore;`
- `backends/crates/chathub-state/src/pool.rs` — `apply_migrations` 列表加 V2
- `backends/crates/chathub-net/Cargo.toml` — `[dependencies]` 加 `uuid = { workspace = true }`,`[dev-dependencies]` 加 `rand = "0.8"`(测 backoff jitter 边界)
- `backends/crates/chathub-net/src/lib.rs` — `pub mod hub; pub use hub::*;`
- `backends/crates/chathub-net/tests/common/stub_relay.rs` — 加 `StubHub`/`StubHubState`/`SubscribeOutcome`/`SendOutcome`/`start_stub_full`,`start_stub` 转调
- `backends/crates/chathub-net/tests/common/mod.rs` — 加 `wait_for_state` / `push_event` / `push_status` 辅助
- `backends/Cargo.toml` — `[dependencies]` 加 `uuid = { workspace = true }`
- `backends/src/lib.rs` — setup 加 `HubClient` + `Arc<ConnectionManager>` 拼装、`send_message` + `hub_state` 命令、2 个桥接 task、try_resume 串 cm.start

### 不动(承诺)

- `proto/chathub/v1/{auth,common,error,message}.proto`
- `backends/crates/chathub-net/src/{auth,channel,error,interceptor}.rs`
- `backends/crates/chathub-net/src/token.rs`(仅 Task 16 加一个 `#[cfg(test)]` helper,不动公共 API)
- `backends/crates/chathub-state/src/{error,session,tokens}.rs`
- `frontends/` 全部
- `package.json` / `pnpm-lock.yaml`
- `Cargo.toml`(repo root)— 无新 workspace 依赖
- `.github/workflows/*.yml`
- `backends/tauri.conf.json` / `backends/capabilities/default.json`(本 Plan 不加权限)

---

## Task 1: proto 加 Plan 3 messages

**Files:**

- Modify: `proto/chathub/v1/event.proto`
- Modify: `proto/chathub/v1/hub.proto`

为什么:Plan 3 后续所有代码都依赖这些 proto 类型(SendRequest/Response、IncomingMsg、SystemSignal、ServerEvent 的 oneof body),所以必须先做。proto 改动是 wire-compat 的(只新增 message,字段 tag 不重用)。

- [ ] **Step 1.1: 把 `proto/chathub/v1/event.proto` 整体替换为下面内容**

```proto
// proto/chathub/v1/event.proto
syntax = "proto3";
package chathub.v1;

import "chathub/v1/common.proto";
import "chathub/v1/message.proto";

// ServerEvent 由 Hub.Subscribe 推送。Plan 3 仅 IncomingMsg + SystemSignal,
// Plan 4+ 加 MessageRecalled / ReadReceipt / AccountStatus / PresenceChange
// / MessageStatusChange — 通过新增 oneof variant 是 wire-compat 的。
message ServerEvent {
  string wecom_account_id = 1;
  int64  seq              = 2;
  // 3-9 reserved for envelope-level fields

  oneof body {
    IncomingMsg  incoming = 10;
    SystemSignal system   = 90;
    // 11-89 reserved for business events (Plan 4+)
    // 91-99 reserved for system signals (Plan 4+)
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
    KIND_UNSPECIFIED  = 0;
    KIND_KICKED       = 1;   // 服务端撤销凭证(其它设备登录、会话失效)
    KIND_SERVER_DRAIN = 2;   // 服务端将 GOAWAY,客户端预期重连
  }
  Kind   kind   = 1;
  string detail = 2;
}
```

- [ ] **Step 1.2: 把 `proto/chathub/v1/hub.proto` 整体替换为下面内容**

```proto
// proto/chathub/v1/hub.proto
syntax = "proto3";
package chathub.v1;

import "chathub/v1/event.proto";
import "chathub/v1/message.proto";

// Hub service:Plan 3 填充 Subscribe + Send。
// Plan 4 起会加 Recall / AckRead / FetchHistory / ListWecomAccounts /
// EnableAccount / DisableAccount。
service Hub {
  rpc Subscribe(SubscribeRequest) returns (stream ServerEvent);
  rpc Send     (SendRequest)      returns (SendResponse);
}

message SubscribeRequest {
  // 客户端持久化的 (wecom_account_id, last_seq);Relay 只补发 seq > last_seq 的事件
  map<string, int64> since_seqs = 1;
}

message SendRequest {
  string wecom_account_id = 1;
  string conversation_id  = 2;
  string client_msg_id    = 3;   // UUIDv4,客户端生成,服务端用 (account_id, client_msg_id) 幂等去重
  MessageBody body        = 4;
}

message SendResponse {
  string server_msg_id = 1;
  int64  sent_at_ms    = 2;
}
```

- [ ] **Step 1.3: 跑 `cargo build -p chathub-proto` 验证 proto 能编译**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo build -p chathub-proto
```

Expected: 成功。`chathub-proto` 此时**还没**给新 message 加 serde derive(Task 2 加),build 仍能过。

- [ ] **Step 1.4: 提交**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
git add proto/chathub/v1/event.proto proto/chathub/v1/hub.proto
git commit -m "$(cat <<'EOF'
feat(proto): Plan 3 — Send RPC + IncomingMsg + SystemSignal

- hub.proto: 加 Send(SendRequest)→SendResponse,Subscribe 不变
- event.proto: ServerEvent 加 oneof body { IncomingMsg | SystemSignal }
- IncomingMsg: conversation_id / from_user_id / body / sent_at_ms / server_msg_id / remote
- SystemSignal.Kind: KIND_KICKED / KIND_SERVER_DRAIN(其余 4 种 ServerEvent kind 留 Plan 4+,wire-compat)
- SendRequest 含 client_msg_id (UUIDv4),为服务端幂等去重铺路
EOF
)"
```

---

## Task 2: chathub-proto build.rs 加 type_attribute + smoke test

**Files:**

- Modify: `backends/crates/chathub-proto/build.rs`
- Modify: `backends/crates/chathub-proto/src/lib.rs`(测试段加 ServerEvent JSON 往返)

为什么:Plan 3 的 ServerEvent / SendResponse / IncomingMsg / SystemSignal 都会跨 Tauri 边界给前端(`hub:event` 事件 payload),需要 `serde::Serialize/Deserialize` derive。`.type_attribute` 路径必须用 prost 生成 oneof Rust enum 时的 PascalCase(参考 Plan 2 的 `MessageBody.Kind`)。

- [ ] **Step 2.1: 在 `backends/crates/chathub-proto/build.rs` 的现有 `.type_attribute(...)` 链式末尾追加 6 条**

把现有的 `tonic_build::configure()...compile_protos(...)` 链改成下面这样(只是在 `compile_protos` 之前多加 6 行 `.type_attribute`):

```rust
    tonic_build::configure()
        .build_client(true)
        .build_server(true)
        .compile_well_known_types(false)
        .type_attribute(".chathub.v1.UserProfile",  "#[derive(serde::Serialize, serde::Deserialize)]")
        .type_attribute(".chathub.v1.WecomAccount", "#[derive(serde::Serialize, serde::Deserialize)]")
        .type_attribute(".chathub.v1.MessageBody",       "#[derive(serde::Serialize, serde::Deserialize)]")
        .type_attribute(".chathub.v1.MessageBody.Kind",  "#[derive(serde::Serialize, serde::Deserialize)]")
        .type_attribute(".chathub.v1.TextBody",          "#[derive(serde::Serialize, serde::Deserialize)]")
        .type_attribute(".chathub.v1.Mention",           "#[derive(serde::Serialize, serde::Deserialize)]")
        .type_attribute(".chathub.v1.ReplyToRef",        "#[derive(serde::Serialize, serde::Deserialize)]")
        .type_attribute(".chathub.v1.RemoteId",          "#[derive(serde::Serialize, serde::Deserialize)]")
        // ↓↓↓ Plan 3 新增 6 条 ↓↓↓
        .type_attribute(".chathub.v1.ServerEvent",       "#[derive(serde::Serialize, serde::Deserialize)]")
        .type_attribute(".chathub.v1.ServerEvent.Body",  "#[derive(serde::Serialize, serde::Deserialize)]")
        .type_attribute(".chathub.v1.IncomingMsg",       "#[derive(serde::Serialize, serde::Deserialize)]")
        .type_attribute(".chathub.v1.SystemSignal",      "#[derive(serde::Serialize, serde::Deserialize)]")
        .type_attribute(".chathub.v1.SystemSignal.Kind", "#[derive(serde::Serialize, serde::Deserialize)]")
        .type_attribute(".chathub.v1.SendResponse",      "#[derive(serde::Serialize, serde::Deserialize)]")
        .compile_protos(&proto_files, &[proto_root])?;
```

- [ ] **Step 2.2: 在 `backends/crates/chathub-proto/src/lib.rs` 的 `mod tests { ... }` 内追加一个 ServerEvent JSON 往返测试**

```rust
    #[test]
    fn server_event_with_incoming_serializes_round_trip() {
        use super::v1::{server_event, IncomingMsg, MessageBody, ServerEvent, TextBody};
        use super::v1::message_body;

        let evt = ServerEvent {
            wecom_account_id: "wxa1".into(),
            seq: 42,
            body: Some(server_event::Body::Incoming(IncomingMsg {
                conversation_id: "conv-1".into(),
                from_user_id:    "peer-1".into(),
                body: Some(MessageBody {
                    kind: Some(message_body::Kind::Text(TextBody { text: "hi".into() })),
                    reply_to: None,
                    mentions: vec![],
                }),
                sent_at_ms:    1_700_000_000_000,
                server_msg_id: "sm-1".into(),
                remote: None,
            })),
        };
        let json = serde_json::to_string(&evt).expect("serialize");
        let back: ServerEvent = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, evt);
    }

    #[test]
    fn server_event_with_system_kicked_serializes_round_trip() {
        use super::v1::{server_event, system_signal, ServerEvent, SystemSignal};
        let evt = ServerEvent {
            wecom_account_id: "wxa1".into(),
            seq: 100,
            body: Some(server_event::Body::System(SystemSignal {
                kind: system_signal::Kind::Kicked as i32,
                detail: "another device".into(),
            })),
        };
        let json = serde_json::to_string(&evt).expect("serialize");
        let back: ServerEvent = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, evt);
    }
```

- [ ] **Step 2.3: 跑测试**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo test -p chathub-proto
```

Expected: 6 个测试全过(原 4 个 Plan 2 测试 + 新 2 个)。

- [ ] **Step 2.4: clippy**

```bash
cargo clippy --workspace -- -D warnings
```

Expected: 0 warning。

- [ ] **Step 2.5: 提交**

```bash
git add backends/crates/chathub-proto/build.rs backends/crates/chathub-proto/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(chathub-proto): serde derive for Plan 3 cross-Tauri-boundary types

build.rs:
- 6 条新 type_attribute:ServerEvent / ServerEvent.Body / IncomingMsg /
  SystemSignal / SystemSignal.Kind / SendResponse(`hub:event` 事件 payload 与
  send_message 命令返回值)

src/lib.rs:
- 2 个 JSON 往返测试覆盖 oneof body 的两个 variant
EOF
)"
```

---

## Task 3: chathub-state V2 migration + SeqStore

**Files:**

- Create: `backends/crates/chathub-state/migrations/V2__seqs.sql`
- Create: `backends/crates/chathub-state/src/seqs.rs`
- Modify: `backends/crates/chathub-state/src/pool.rs`(`apply_migrations` 列表加 V2)
- Modify: `backends/crates/chathub-state/src/lib.rs`(导出 `SeqStore`)

为什么:`ConnectionManager` run_loop 收到 ServerEvent 后,需要把 `(wecom_account_id, last_seq)` 持久化,重连时拼成 `since_seqs` 让服务端补发。spec §5。

- [ ] **Step 3.1: 创建 `backends/crates/chathub-state/migrations/V2__seqs.sql`**

```sql
-- V2__seqs.sql — Plan 3:每账号 last_seq 持久化
-- ConnectionManager 的 SeqStore 用单条 UPSERT 写,WAL 模式下亚毫秒。
CREATE TABLE IF NOT EXISTS wecom_account_seqs (
    wecom_account_id TEXT    PRIMARY KEY,
    last_seq         INTEGER NOT NULL DEFAULT 0,
    updated_at_ms    INTEGER NOT NULL
);
```

- [ ] **Step 3.2: 修改 `backends/crates/chathub-state/src/pool.rs` 的 `apply_migrations`**

把第 41-52 行的 `apply_migrations` 函数(原来 `Migrations::new(vec![M::up(include_str!("../migrations/V1__init.sql"))])`)改为:

```rust
    async fn apply_migrations(&self) -> Result<(), StateError> {
        let conn = self.pool.get().await?;
        conn.interact(|c| {
            let migrations = Migrations::new(vec![
                M::up(include_str!("../migrations/V1__init.sql")),
                M::up(include_str!("../migrations/V2__seqs.sql")),
            ]);
            migrations
                .to_latest(c)
                .map_err(|e| StateError::Migration(e.to_string()))
        })
        .await??;
        Ok(())
    }
```

同时把 pool.rs 第 75-83 行的 `in_memory_pool_applies_v1_migration` 测试改名 + 表数升级:

```rust
    #[tokio::test]
    async fn in_memory_pool_applies_all_migrations() {
        let pool = SqlitePool::in_memory().await.expect("pool open");

        let conn = pool.pool().get().await.expect("get conn");
        let table_count: i64 = conn.interact(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('current_session', 'wecom_accounts', 'wecom_account_seqs')",
                [],
                |r| r.get(0),
            )
        }).await.expect("interact").expect("query");

        assert_eq!(table_count, 3, "V1+V2 migrations should create three tables");
    }
```

- [ ] **Step 3.3: 创建 `backends/crates/chathub-state/src/seqs.rs`**

```rust
//! SeqStore:每账号 last_seq 持久化(Plan 3)。
//! 单表 wecom_account_seqs;UPSERT 写在 ConnectionManager 热路径,
//! WAL+UPSERT 单条亚毫秒,YAGNI 不批量。

use crate::error::StateError;
use crate::pool::SqlitePool;
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone)]
pub struct SeqStore {
    pool: SqlitePool,
}

impl SeqStore {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// 读全部 (wecom_account_id, last_seq) 拼成 since_seqs map。
    /// 空表返回空 map。
    pub async fn read_all(&self) -> Result<HashMap<String, i64>, StateError> {
        let conn = self.pool.pool().get().await?;
        let map = conn
            .interact(|c| -> Result<HashMap<String, i64>, rusqlite::Error> {
                let mut stmt =
                    c.prepare("SELECT wecom_account_id, last_seq FROM wecom_account_seqs")?;
                let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
                let mut out = HashMap::new();
                for row in rows {
                    let (k, v) = row?;
                    out.insert(k, v);
                }
                Ok(out)
            })
            .await??;
        Ok(map)
    }

    /// UPSERT 单条:存在则覆盖 last_seq + updated_at_ms。
    pub async fn upsert(&self, account_id: &str, seq: i64) -> Result<(), StateError> {
        let now = now_ms();
        let aid = account_id.to_string();
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), rusqlite::Error> {
            c.execute(
                "INSERT INTO wecom_account_seqs(wecom_account_id, last_seq, updated_at_ms) \
                 VALUES (?1, ?2, ?3) \
                 ON CONFLICT(wecom_account_id) DO UPDATE SET \
                   last_seq = excluded.last_seq, \
                   updated_at_ms = excluded.updated_at_ms",
                rusqlite::params![aid, seq, now],
            )?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// 清空表。logout / 切租户使用。
    pub async fn clear(&self) -> Result<(), StateError> {
        let conn = self.pool.pool().get().await?;
        conn.interact(|c| -> Result<(), rusqlite::Error> {
            c.execute("DELETE FROM wecom_account_seqs", [])?;
            Ok(())
        })
        .await??;
        Ok(())
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn seq_store_upsert_then_read_all_round_trips() {
        let pool = SqlitePool::in_memory().await.expect("pool");
        let store = SeqStore::new(pool);

        store.upsert("wxa1", 10).await.expect("upsert wxa1");
        store.upsert("wxa2", 20).await.expect("upsert wxa2");
        store.upsert("wxa3", 30).await.expect("upsert wxa3");

        let map = store.read_all().await.expect("read_all");
        assert_eq!(map.get("wxa1"), Some(&10));
        assert_eq!(map.get("wxa2"), Some(&20));
        assert_eq!(map.get("wxa3"), Some(&30));
        assert_eq!(map.len(), 3);
    }

    #[tokio::test]
    async fn seq_store_upsert_overwrites_existing_account() {
        let pool = SqlitePool::in_memory().await.expect("pool");
        let store = SeqStore::new(pool);

        store.upsert("wxa1", 10).await.expect("upsert v1");
        store.upsert("wxa1", 25).await.expect("upsert v2");

        let map = store.read_all().await.expect("read_all");
        assert_eq!(map.get("wxa1"), Some(&25));
        assert_eq!(map.len(), 1);
    }

    #[tokio::test]
    async fn seq_store_clear_empties_table() {
        let pool = SqlitePool::in_memory().await.expect("pool");
        let store = SeqStore::new(pool);

        store.upsert("wxa1", 10).await.expect("upsert");
        store.upsert("wxa2", 20).await.expect("upsert");
        store.clear().await.expect("clear");

        let map = store.read_all().await.expect("read_all");
        assert!(map.is_empty(), "after clear: {map:?}");
    }

    #[tokio::test]
    async fn seq_store_in_memory_pool_works() {
        let pool = SqlitePool::in_memory().await.expect("pool");
        let store = SeqStore::new(pool);

        store.upsert("wxa1", 1).await.expect("ok");
        let map = store.read_all().await.expect("ok");
        assert_eq!(map.get("wxa1"), Some(&1));
    }
}
```

- [ ] **Step 3.4: 修改 `backends/crates/chathub-state/src/lib.rs`,导出 `SeqStore`**

把现有 lib.rs 的 `pub mod` 与 `pub use` 区段改成:

```rust
//! ChatHub local state:SQLite (deadpool-sqlite) + OS keychain (keyring)。
//!
//! 公共 API:
//!   - `KeyringTokenStore`:存 refresh_token + device_id 到 OS Keychain
//!   - `SessionStore`:存 UserProfile 与 WecomAccount 镜像到 SQLite
//!   - `SeqStore`:每账号 last_seq 持久化(Plan 3)
//!   - `SqlitePool`:WAL-mode SQLite 连接池,自动跑迁移
//!   - `StateError`:统一错误类型

pub mod error;
pub mod pool;
pub mod seqs;
pub mod session;
pub mod tokens;

pub use error::StateError;
pub use pool::SqlitePool;
pub use seqs::SeqStore;
pub use session::SessionStore;
pub use tokens::KeyringTokenStore;
```

- [ ] **Step 3.5: 跑 chathub-state 全部测试**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo test -p chathub-state
```

Expected: 12 个测试全过(原 8 个 + 新 4 个 SeqStore 测试)。

- [ ] **Step 3.6: clippy**

```bash
cargo clippy -p chathub-state -- -D warnings
```

Expected: 0 warning。

- [ ] **Step 3.7: 提交**

```bash
git add backends/crates/chathub-state/migrations/V2__seqs.sql \
        backends/crates/chathub-state/src/seqs.rs \
        backends/crates/chathub-state/src/pool.rs \
        backends/crates/chathub-state/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(chathub-state): SeqStore (V2 migration) for ConnectionManager since_seqs

- migrations/V2__seqs.sql: wecom_account_seqs(account_id PK, last_seq, updated_at_ms)
- src/seqs.rs: SeqStore::{new, read_all, upsert, clear};单条 UPSERT,YAGNI 不批量
- pool.rs: apply_migrations 列表加 V2;in_memory_pool_applies_all_migrations 改名 + 改断言为 3 表
- lib.rs: pub mod seqs + pub use SeqStore
- 4 个新单元测试覆盖 round-trip / overwrite / clear / in-memory
EOF
)"
```

---

## Task 4: chathub-net 加 uuid 依赖 + hub.rs 占位

**Files:**

- Modify: `backends/crates/chathub-net/Cargo.toml`(+`uuid`)
- Create: `backends/crates/chathub-net/src/hub.rs`(空骨架,只导出 `pub mod`)
- Modify: `backends/crates/chathub-net/src/lib.rs`(`pub mod hub; pub use hub::*;`)

为什么:后续 5-9 task 渐进往 hub.rs 填类型;先建空骨架让每个 task 的 diff 干净。`uuid` 已在 workspace.dependencies(Plan 2 的 chathub-state 用了),chathub-net 这里也启用 — 因为 send 命令需要生成 client_msg_id(Task 19 的 backends 用,但 chathub-net 内部测试也可能需要 fake UUID)。

- [ ] **Step 4.1: 修改 `backends/crates/chathub-net/Cargo.toml`,在 `[dependencies]` 加 `uuid`**

把 `[dependencies]` 段(在 `serde = { workspace = true }` 那行后)加一行:

```diff
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
+uuid        = { workspace = true }
+rand        = "0.8"
```

`rand` 用于 ExponentialBackoff 的 full jitter(Task 5)。

- [ ] **Step 4.2: 创建 `backends/crates/chathub-net/src/hub.rs`(占位)**

```rust
//! Hub client + ConnectionManager(Plan 3)。
//!
//! 公共 API(后续 task 渐进填充):
//!   - `HubClient`:Send + Subscribe(thin wrapper over tonic client)
//!   - `ConnectionManager`:状态机 + 后台 task + 事件总线
//!   - `ConnectionState`:Connecting / Subscribed / Disconnected{last_error}
//!   - `BackoffConfig` + `ExponentialBackoff`:重连退避配置与计算
//!   - `classify`:tonic Status → Action 路径分流

// 后续 Task 5-9 渐进填入。现在先放占位避免空 mod。
#[cfg(test)]
mod tests {
    #[test]
    fn placeholder() {}
}
```

- [ ] **Step 4.3: 修改 `backends/crates/chathub-net/src/lib.rs`,加 `pub mod hub; pub use hub::*;`**

把现有 lib.rs 的 `pub mod` / `pub use` 段改为:

```rust
//! ChatHub network layer:tonic gRPC client + TokenStore + AuthInterceptor + AuthApi + Hub。
//!
//! 公共 API:
//!   - `RELAY_URL`:编译期注入,CHATHUB_RELAY_URL env 提供
//!   - `build_endpoint(url)`:tonic Endpoint 配置(keep-alive、TLS、超时)
//!   - `TokenStore`:同步 RwLock + 后台 refresher task
//!   - `AuthInterceptor`:同步 Interceptor,注入 Bearer + 版本头
//!   - `AuthApi`:login/logout/try_resume_session 业务包装
//!   - `AuthError`:统一错误类型 + From<Status>
//!   - `HubClient` / `ConnectionManager` / `ConnectionState` / `BackoffConfig`(Plan 3)

pub mod auth;
pub mod channel;
pub mod error;
pub mod hub;
pub mod interceptor;
pub mod token;

pub use auth::{AuthApi, LoggedOutReason};
pub use channel::build_endpoint;
pub use error::AuthError;
pub use hub::*;
pub use interceptor::AuthInterceptor;
pub use token::{TokenState, TokenStore};

/// 编译期由 build.rs 注入。无 env 时为占位 https://relay.example.com。
pub const RELAY_URL: &str = env!("CHATHUB_RELAY_URL_RESOLVED");
```

- [ ] **Step 4.4: 编译 + 测试**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo build -p chathub-net
cargo test -p chathub-net --lib
```

Expected: 编译过;原 Plan 2 单元测试 + `placeholder` 测试全过。

- [ ] **Step 4.5: 提交**

```bash
git add backends/crates/chathub-net/Cargo.toml backends/crates/chathub-net/src/hub.rs backends/crates/chathub-net/src/lib.rs
git commit -m "$(cat <<'EOF'
chore(chathub-net): scaffold hub.rs + uuid/rand deps for Plan 3

- Cargo.toml: + uuid (workspace) + rand "0.8" (jitter for ExponentialBackoff)
- src/hub.rs: placeholder 模块,后续 Task 5-9 渐进填入
- src/lib.rs: pub mod hub; pub use hub::*;
EOF
)"
```

---

## Task 5: ExponentialBackoff + 单元测试

**Files:**

- Modify: `backends/crates/chathub-net/src/hub.rs`(添加 `BackoffConfig` + `ExponentialBackoff` + 测试)

为什么:run_loop 重连退避需要它。提前实现并独立测试,避免 ConnectionManager task 里混杂未验证的算法。

- [ ] **Step 5.1: 把 `backends/crates/chathub-net/src/hub.rs` 整体替换为下面内容**

```rust
//! Hub client + ConnectionManager(Plan 3)。
//!
//! 公共 API(后续 task 渐进填充):
//!   - `HubClient`:Send + Subscribe(thin wrapper over tonic client)
//!   - `ConnectionManager`:状态机 + 后台 task + 事件总线
//!   - `ConnectionState`:Connecting / Subscribed / Disconnected{last_error}
//!   - `BackoffConfig` + `ExponentialBackoff`:重连退避配置与计算
//!   - `classify`:tonic Status → Action 路径分流

use std::time::Duration;

/// 重连退避配置。生产默认 1s/2x/15s full jitter,测试通常用 10ms/2x/150ms 加速。
#[derive(Clone, Debug)]
pub struct BackoffConfig {
    pub base: Duration,
    pub factor: f64,
    pub cap: Duration,
}

impl Default for BackoffConfig {
    fn default() -> Self {
        Self {
            base: Duration::from_secs(1),
            factor: 2.0,
            cap: Duration::from_secs(15),
        }
    }
}

/// Full jitter 指数退避。`next()` 返回 `[0, min(cap, base * factor^attempt))` 的随机时长。
pub(crate) struct ExponentialBackoff {
    base: Duration,
    factor: f64,
    cap: Duration,
    attempt: u32,
}

impl ExponentialBackoff {
    pub fn new(cfg: &BackoffConfig) -> Self {
        Self {
            base: cfg.base,
            factor: cfg.factor,
            cap: cfg.cap,
            attempt: 0,
        }
    }

    /// 下一次退避时长。attempt 饱和加,不溢出。
    pub fn next(&mut self) -> Duration {
        let exp = self.factor.powi(self.attempt as i32);
        let raw_ms = (self.base.as_millis() as f64) * exp;
        let cap_ms = self.cap.as_millis() as f64;
        let bound_ms = raw_ms.min(cap_ms);
        // full jitter:[0, bound_ms)
        let jittered_ms = rand::random::<f64>() * bound_ms;
        self.attempt = self.attempt.saturating_add(1);
        Duration::from_millis(jittered_ms as u64)
    }

    pub fn reset(&mut self) {
        self.attempt = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fast_cfg() -> BackoffConfig {
        BackoffConfig {
            base: Duration::from_millis(10),
            factor: 2.0,
            cap: Duration::from_millis(150),
        }
    }

    #[test]
    fn exponential_backoff_first_call_within_1x_base() {
        let mut b = ExponentialBackoff::new(&fast_cfg());
        let d = b.next();
        // attempt=0 → bound = base * 2^0 = base = 10ms;jittered ∈ [0, 10ms)
        assert!(d <= Duration::from_millis(10), "got {d:?}");
    }

    #[test]
    fn exponential_backoff_caps_at_cap() {
        let mut b = ExponentialBackoff::new(&fast_cfg());
        // 跑 20 次,attempt 远超 cap 阈值;每次都应 ≤ cap
        for _ in 0..20 {
            let d = b.next();
            assert!(d <= Duration::from_millis(150), "got {d:?}");
        }
    }

    #[test]
    fn exponential_backoff_reset_zeroes_attempt() {
        let mut b = ExponentialBackoff::new(&fast_cfg());
        for _ in 0..5 {
            let _ = b.next();
        }
        b.reset();
        // reset 后 attempt=0,bound = base * 2^0 = 10ms
        let d = b.next();
        assert!(d <= Duration::from_millis(10), "got {d:?}");
    }

    #[test]
    fn placeholder() {}
}
```

(占位 `placeholder` test 保留 — 让 `cargo test` 输出不会因为只有几个测试而看起来奇怪;Task 6/7 会替换/扩展。)

- [ ] **Step 5.2: 跑测试**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo test -p chathub-net --lib hub::
```

Expected: `exponential_backoff_first_call_within_1x_base` / `caps_at_cap` / `reset_zeroes_attempt` / `placeholder` 4 个全过。

- [ ] **Step 5.3: clippy**

```bash
cargo clippy -p chathub-net -- -D warnings
```

Expected: 0 warning(`#[cfg(test)] use rand` 不会触发未用警告)。

- [ ] **Step 5.4: 提交**

```bash
git add backends/crates/chathub-net/src/hub.rs
git commit -m "$(cat <<'EOF'
feat(chathub-net): ExponentialBackoff + BackoffConfig

- BackoffConfig::default() = 1s / 2x / 15s(spec §6.4)
- ExponentialBackoff::next() = full jitter [0, min(cap, base * factor^attempt))
- reset() 归零 attempt;饱和加防溢出
- 3 个单元测试覆盖首次范围 / cap 边界 / reset
EOF
)"
```

---

## Task 6: ConnectionState enum + serde 测试

**Files:**

- Modify: `backends/crates/chathub-net/src/hub.rs`(添加 `ConnectionState` + 测试)

为什么:`watch::Sender<ConnectionState>` 是 ConnectionManager 对外契约的核心,先单独定义并验证 serde tag。前端通过 `hub:connection` 事件 listen 到的就是这个 JSON。

- [ ] **Step 6.1: 在 `backends/crates/chathub-net/src/hub.rs` 顶部 `use std::time::Duration;` 后追加 use 与新枚举**

把现有 hub.rs 的 imports 区段(`use std::time::Duration;`)替换为:

```rust
use crate::error::AuthError;
use serde::{Deserialize, Serialize};
use std::time::Duration;
```

并在 `BackoffConfig` 之前(或紧接 `BackoffConfig` impl 之后)加入下面的 `ConnectionState`:

```rust
/// 对前端暴露的 3 状态机。`hub:connection` 事件 payload 序列化此 enum。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum ConnectionState {
    Connecting,
    Subscribed,
    Disconnected {
        #[serde(skip_serializing_if = "Option::is_none")]
        last_error: Option<AuthError>,
    },
}
```

- [ ] **Step 6.2: 在 `mod tests` 内、`exponential_backoff_*` 之后添加 serde 测试(替换 `placeholder` test)**

```rust
    #[test]
    fn connection_state_connecting_serializes_kebab_case_tag() {
        let s = ConnectionState::Connecting;
        let json = serde_json::to_string(&s).expect("serialize");
        assert_eq!(json, r#"{"state":"connecting"}"#);
    }

    #[test]
    fn connection_state_subscribed_serializes() {
        let s = ConnectionState::Subscribed;
        let json = serde_json::to_string(&s).expect("serialize");
        assert_eq!(json, r#"{"state":"subscribed"}"#);
    }

    #[test]
    fn connection_state_disconnected_no_error_omits_field() {
        let s = ConnectionState::Disconnected { last_error: None };
        let json = serde_json::to_string(&s).expect("serialize");
        assert_eq!(json, r#"{"state":"disconnected"}"#);
    }

    #[test]
    fn connection_state_disconnected_with_error_includes_field() {
        let s = ConnectionState::Disconnected {
            last_error: Some(AuthError::Unauthenticated),
        };
        let json = serde_json::to_string(&s).expect("serialize");
        // AuthError 已 serde derive(kind=unauthenticated),嵌套即可
        assert!(json.contains(r#""state":"disconnected""#), "{json}");
        assert!(json.contains(r#""last_error""#), "{json}");
        assert!(json.contains(r#""kind":"unauthenticated""#), "{json}");
    }
```

(同时删除原 `fn placeholder() {}`。)

- [ ] **Step 6.3: 检查 `chathub-net/Cargo.toml` 的 dev-deps 已含 `serde_json`**

Plan 2 已经加过,验证一下:

```bash
grep -n 'serde_json' backends/crates/chathub-net/Cargo.toml
```

Expected: `[dev-dependencies]` 段含 `serde_json = "1"`。如果没有,在 dev-dependencies 加一行 `serde_json = "1"`。

- [ ] **Step 6.4: 跑测试**

```bash
cargo test -p chathub-net --lib hub::
```

Expected: 7 个 hub:: 测试全过(3 backoff + 4 connection_state)。

- [ ] **Step 6.5: clippy**

```bash
cargo clippy -p chathub-net -- -D warnings
```

Expected: 0 warning。

- [ ] **Step 6.6: 提交**

```bash
git add backends/crates/chathub-net/src/hub.rs
git commit -m "$(cat <<'EOF'
feat(chathub-net): ConnectionState enum (3 states + serde tag)

- ConnectionState: Connecting / Subscribed / Disconnected { last_error: Option<AuthError> }
- serde tag = "state",rename_all = "kebab-case"(spec §2 #2)
- last_error 用 skip_serializing_if = Option::is_none,disconnected 无错误时 payload 简洁
- 4 个 serde 测试覆盖三态 + 携带 AuthError 的 disconnected
EOF
)"
```

---

## Task 7: classify 函数 + 单元测试

**Files:**

- Modify: `backends/crates/chathub-net/src/hub.rs`(添加 `Action` + `classify` + 测试)

为什么:run_loop 的错误分流逻辑(spec §6.3)。先把这个纯函数独立出来并测,run_loop 内只 call 它。

- [ ] **Step 7.1: 在 `backends/crates/chathub-net/src/hub.rs` 的 `ConnectionState` 与 `BackoffConfig` 之间添加 `Action` + `classify`**

```rust
/// run_loop 收到错误后的动作分类(spec §6.3)。
#[derive(Debug, PartialEq)]
pub(crate) enum Action {
    /// Unauthenticated → force_refresh + 立即重连(不退避)
    ReactiveRefresh,
    /// Upgrade / Storage → 进入 Disconnected{last_error},task 退出
    Terminate,
    /// 其它 transient → 进入 Disconnected{last_error},退避后重连
    Backoff,
}

pub(crate) fn classify(err: &AuthError) -> Action {
    match err {
        AuthError::Unauthenticated         => Action::ReactiveRefresh,
        AuthError::UpgradeRequired { .. }  => Action::Terminate,
        AuthError::Network { .. }          => Action::Backoff,
        AuthError::Storage { .. }          => Action::Terminate,
        AuthError::Internal { .. }         => Action::Backoff,
    }
}
```

- [ ] **Step 7.2: 在 `mod tests` 末尾追加 4 个 classify 测试**

```rust
    #[test]
    fn classify_unauthenticated_returns_reactive_refresh() {
        let a = classify(&AuthError::Unauthenticated);
        assert_eq!(a, Action::ReactiveRefresh);
    }

    #[test]
    fn classify_upgrade_required_returns_terminate() {
        let a = classify(&AuthError::UpgradeRequired {
            min_version: "9.9.9".into(),
            download_url: "https://example.com/dl".into(),
        });
        assert_eq!(a, Action::Terminate);
    }

    #[test]
    fn classify_network_returns_backoff() {
        let a = classify(&AuthError::Network { message: "down".into() });
        assert_eq!(a, Action::Backoff);
    }

    #[test]
    fn classify_storage_returns_terminate() {
        let a = classify(&AuthError::Storage { message: "io".into() });
        assert_eq!(a, Action::Terminate);
    }

    #[test]
    fn classify_internal_returns_backoff() {
        let a = classify(&AuthError::Internal { message: "boom".into() });
        assert_eq!(a, Action::Backoff);
    }
```

- [ ] **Step 7.3: 跑测试**

```bash
cargo test -p chathub-net --lib hub::
```

Expected: 12 个 hub:: 测试全过(3 backoff + 4 connection_state + 5 classify)。

- [ ] **Step 7.4: clippy**

```bash
cargo clippy -p chathub-net -- -D warnings
```

Expected: 0 warning。

- [ ] **Step 7.5: 提交**

```bash
git add backends/crates/chathub-net/src/hub.rs
git commit -m "$(cat <<'EOF'
feat(chathub-net): classify (AuthError → run_loop Action)

- Action: ReactiveRefresh / Terminate / Backoff(spec §6.3)
- classify 纯函数:Unauthenticated → ReactiveRefresh;Upgrade/Storage → Terminate;
  Network/Internal → Backoff(PermissionDenied 现走 Internal→Backoff,Plan 4 改)
- 5 个单元测试覆盖每个 AuthError variant 的归类
EOF
)"
```

---

## Task 8: HubClient + send 方法

**Files:**

- Modify: `backends/crates/chathub-net/src/hub.rs`(添加 `HubClient`)

为什么:`HubClient` 是 thin RPC wrapper,被 send_message Tauri 命令直接用,也被 ConnectionManager 内部用。先实现 send,subscribe 留 Task 9。

- [ ] **Step 8.1: 在 `backends/crates/chathub-net/src/hub.rs` 顶部 imports 区段后添加 HubClient + 实现**

把 `use crate::error::AuthError;` 那段替换为下面的扩展 imports:

```rust
use crate::error::AuthError;
use crate::interceptor::AuthInterceptor;
use chathub_proto::v1::hub_client::HubClient as RawHubClient;
use chathub_proto::v1::{SendRequest, SendResponse};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tonic::codegen::InterceptedService;
use tonic::transport::Channel;
```

并在 `Action`/`classify` 之后(文件末尾 `#[cfg(test)] mod tests` 之前)添加:

```rust
/// HubClient — thin wrapper over tonic-generated HubClient + AuthInterceptor。
/// 内部 `inner` 是 `Clone`(Channel 内部 Arc),clone() 廉价。
#[derive(Clone)]
pub struct HubClient {
    inner: RawHubClient<InterceptedService<Channel, AuthInterceptor>>,
}

impl HubClient {
    pub fn new(channel: Channel, interceptor: AuthInterceptor) -> Self {
        let inner = RawHubClient::with_interceptor(channel, interceptor);
        Self { inner }
    }

    /// Unary Send。失败映射到 AuthError(同 Plan 2 路径)。
    pub async fn send(&self, req: SendRequest) -> Result<SendResponse, AuthError> {
        let mut client = self.inner.clone();
        let resp = client.send(tonic::Request::new(req)).await?;
        Ok(resp.into_inner())
    }
}
```

- [ ] **Step 8.2: 编译验证**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo build -p chathub-net
```

Expected: 编译过。`HubClient::send` 暂无 e2e(等 Task 18 加),lib 单元测试集仍是 12 个(hub::)+ Plan 2 测试。

- [ ] **Step 8.3: 跑全部 lib 单元测试**

```bash
cargo test -p chathub-net --lib
```

Expected: hub:: 12 + 现有 Plan 2 token/error/auth/interceptor/channel 单元测试,**全过**。

- [ ] **Step 8.4: clippy**

```bash
cargo clippy -p chathub-net -- -D warnings
```

Expected: 0 warning。

- [ ] **Step 8.5: 提交**

```bash
git add backends/crates/chathub-net/src/hub.rs
git commit -m "$(cat <<'EOF'
feat(chathub-net): HubClient + send (unary)

- HubClient wraps tonic HubClient<InterceptedService<Channel, AuthInterceptor>>
- HubClient::new(channel, interceptor) — 与 Plan 2 build_endpoint + AuthInterceptor 兼容
- HubClient::send(req): unary RPC,通过 channel + interceptor 自动注入 Bearer + 版本头
- inner Clone:Channel 内部 Arc,clone 廉价
- 暂无 e2e — 留给 Task 18(Send 场景)
EOF
)"
```

---

## Task 9: HubClient::subscribe 方法

**Files:**

- Modify: `backends/crates/chathub-net/src/hub.rs`(`HubClient` 加 `subscribe`)

为什么:Subscribe 是 server-streaming RPC,签名比 Send 复杂(`Streaming<ServerEvent>`),独立 task 写以便单独 review。

- [ ] **Step 9.1: 修改 `backends/crates/chathub-net/src/hub.rs`,在 imports 段补 `SubscribeRequest`/`ServerEvent`/`HashMap`**

把 `use chathub_proto::v1::{SendRequest, SendResponse};` 替换为:

```rust
use chathub_proto::v1::{ServerEvent, SubscribeRequest, SendRequest, SendResponse};
use std::collections::HashMap;
```

- [ ] **Step 9.2: 在 `impl HubClient` 内、`send` 之后添加 `subscribe` 方法**

```rust
    /// Server-streaming Subscribe。`since_seqs` 是 (wecom_account_id → last_seq) map,
    /// 仅供 ConnectionManager 用,不对外公开。
    pub(crate) async fn subscribe(
        &self,
        since_seqs: HashMap<String, i64>,
    ) -> Result<tonic::Streaming<ServerEvent>, AuthError> {
        let mut client = self.inner.clone();
        let req = SubscribeRequest { since_seqs };
        let resp = client.subscribe(tonic::Request::new(req)).await?;
        Ok(resp.into_inner())
    }
```

- [ ] **Step 9.3: 编译 + 测试**

```bash
cargo build -p chathub-net
cargo test -p chathub-net --lib
```

Expected: 编译过;现有 lib 单元测试不变。

- [ ] **Step 9.4: clippy**

```bash
cargo clippy -p chathub-net -- -D warnings
```

Expected: 0 warning。

- [ ] **Step 9.5: 提交**

```bash
git add backends/crates/chathub-net/src/hub.rs
git commit -m "$(cat <<'EOF'
feat(chathub-net): HubClient::subscribe (server-streaming)

- HubClient::subscribe(since_seqs) → tonic::Streaming<ServerEvent>
- pub(crate):仅供 ConnectionManager 内部用,不对前端暴露
- 与 Plan 2 AuthInterceptor 共享 channel,自动注入 Bearer + 版本头
EOF
)"
```

---

## Task 10: stub Hub 测试 fixture(start_stub_full + StubHub)

**Files:**

- Modify: `backends/crates/chathub-net/tests/common/stub_relay.rs`(加 StubHub + start_stub_full)
- Modify: `backends/crates/chathub-net/tests/common/mod.rs`(加 wait_for_state / push_event / push_status 辅助)

为什么:Plan 3 e2e 需要 stub Hub。同进程注册 `AuthServer + HubServer` 共用 SocketAddr;`start_stub` 签名向后兼容(转调 `start_stub_full` 后丢弃 hub_state),Plan 2 7 个 e2e 0 改动。

- [ ] **Step 10.1: 看 `backends/crates/chathub-net/tests/common/mod.rs` 当前内容**

```bash
cat backends/crates/chathub-net/tests/common/mod.rs
```

Expected: 大致是 `pub mod stub_relay;` + 几个 helper 函数(`unique_keyring_service` 等)。

- [ ] **Step 10.2: 把 `backends/crates/chathub-net/tests/common/stub_relay.rs` 整体扩展**

在文件末尾(原 `fn upgrade_required_status() -> Status { ... }` 之后)追加下面所有内容:

```rust
// ============================ Plan 3:StubHub ============================

use chathub_proto::v1::hub_server::{Hub, HubServer};
use chathub_proto::v1::{
    SendRequest, SendResponse, ServerEvent, SubscribeRequest,
};
use std::collections::HashMap;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

#[derive(Clone)]
pub enum SubscribeOutcome {
    /// 默认:接受 Subscribe,创建 mpsc + ReceiverStream,等测试 inject
    Stream,
    /// 拒绝 Subscribe(Reject 一次性,RPC 返回 Status 后会自动 reset 为 Stream)
    RejectOnce(Status),
    /// 持续拒绝(每次 Subscribe 都返回此 Status)
    RejectAlways(Status),
}

impl Default for SubscribeOutcome {
    fn default() -> Self {
        SubscribeOutcome::Stream
    }
}

#[derive(Clone)]
pub enum SendStubOutcome {
    Ok(SendResponse),
    Status(Status),
}

impl Default for SendStubOutcome {
    fn default() -> Self {
        SendStubOutcome::Ok(SendResponse {
            server_msg_id: "sm-default".into(),
            sent_at_ms: 0,
        })
    }
}

#[derive(Default)]
pub struct StubHubState {
    /// Subscribe RPC 被调用时,记录传入的 since_seqs(用于断言客户端续接行为)
    pub subscribes: Vec<HashMap<String, i64>>,
    /// 当前活跃 Subscribe stream 的 mpsc::Sender,测试代码用它推 event/status
    pub event_tx: Option<mpsc::Sender<Result<ServerEvent, Status>>>,
    /// Subscribe RPC 的初始结果策略
    pub subscribe_outcome: SubscribeOutcome,
    /// Send RPC 的固定结果
    pub send_outcome: SendStubOutcome,
    /// Send RPC 收到的全部请求(用于断言 client_msg_id 等)
    pub sends: Vec<SendRequest>,
}

pub struct StubHub {
    pub state: Arc<Mutex<StubHubState>>,
}

#[tonic::async_trait]
impl Hub for StubHub {
    type SubscribeStream = ReceiverStream<Result<ServerEvent, Status>>;

    async fn subscribe(
        &self,
        req: Request<SubscribeRequest>,
    ) -> Result<Response<Self::SubscribeStream>, Status> {
        let (tx, rx) = mpsc::channel(16);
        let mut s = self.state.lock().unwrap();
        s.subscribes.push(req.into_inner().since_seqs);
        match s.subscribe_outcome.clone() {
            SubscribeOutcome::Stream => {
                s.event_tx = Some(tx);
                Ok(Response::new(ReceiverStream::new(rx)))
            }
            SubscribeOutcome::RejectOnce(st) => {
                s.subscribe_outcome = SubscribeOutcome::Stream;
                Err(st)
            }
            SubscribeOutcome::RejectAlways(st) => Err(st),
        }
    }

    async fn send(
        &self,
        req: Request<SendRequest>,
    ) -> Result<Response<SendResponse>, Status> {
        let mut s = self.state.lock().unwrap();
        s.sends.push(req.into_inner());
        match s.send_outcome.clone() {
            SendStubOutcome::Ok(r) => Ok(Response::new(r)),
            SendStubOutcome::Status(st) => Err(st),
        }
    }
}

/// Plan 3 新版本:同进程注册 AuthServer + HubServer。
/// `start_stub` 转调本函数 + 丢弃 hub_state,Plan 2 测试 0 改动。
pub async fn start_stub_full() -> (
    SocketAddr,
    Arc<Mutex<StubState>>,
    Arc<Mutex<StubHubState>>,
    JoinHandle<()>,
) {
    let auth_state = Arc::new(Mutex::new(StubState::new_default_ttls()));
    let hub_state = Arc::new(Mutex::new(StubHubState::default()));
    let auth = StubAuth { state: auth_state.clone() };
    let hub  = StubHub  { state: hub_state.clone()  };
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("local_addr");
    let stream = TcpListenerStream::new(listener);
    let handle = tokio::spawn(async move {
        let _ = Server::builder()
            .add_service(AuthServer::new(auth))
            .add_service(HubServer::new(hub))
            .serve_with_incoming(stream)
            .await;
    });
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    (addr, auth_state, hub_state, handle)
}
```

- [ ] **Step 10.3: 把现有 `pub async fn start_stub() -> ...` 函数体改为转调 `start_stub_full`**

原 `start_stub` 函数(第 134-151 行,即 `pub async fn start_stub() -> (SocketAddr, Arc<Mutex<StubState>>, JoinHandle<()>) { ... }`)整体替换为:

```rust
/// Plan 2 兼容版本:返回 (addr, auth_state, handle),丢弃 hub_state。
pub async fn start_stub() -> (SocketAddr, Arc<Mutex<StubState>>, JoinHandle<()>) {
    let (addr, auth_state, _hub_state, handle) = start_stub_full().await;
    (addr, auth_state, handle)
}
```

- [ ] **Step 10.4: 修改 `backends/crates/chathub-net/tests/common/mod.rs`,加 wait_for_state / push_event / push_status / unique_keyring_service**

打开 `backends/crates/chathub-net/tests/common/mod.rs`,在文件末尾追加(如有同名 helper 跳过):

```rust
#![allow(dead_code)]

use crate::common::stub_relay::StubHubState;
use chathub_net::ConnectionState;
use chathub_proto::v1::ServerEvent;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::watch;
use tonic::Status;

/// 等到 ConnectionState 满足 pred,带超时。返回最后一次观察到的 state。
pub async fn wait_for_state(
    rx: &mut watch::Receiver<ConnectionState>,
    pred: impl Fn(&ConnectionState) -> bool,
    timeout: Duration,
) -> ConnectionState {
    let deadline = Instant::now() + timeout;
    {
        let cur = rx.borrow().clone();
        if pred(&cur) {
            return cur;
        }
    }
    while Instant::now() < deadline {
        let remaining = deadline - Instant::now();
        if tokio::time::timeout(remaining, rx.changed()).await.is_err() {
            break;
        }
        let cur = rx.borrow().clone();
        if pred(&cur) {
            return cur;
        }
    }
    panic!("wait_for_state timed out;last={:?}", rx.borrow());
}

/// 通过 stub 的当前活跃 mpsc::Sender 推一个 ServerEvent。
pub async fn push_event(stub: &Arc<Mutex<StubHubState>>, event: ServerEvent) {
    let tx = {
        stub.lock()
            .unwrap()
            .event_tx
            .clone()
            .expect("stub has no active event_tx — Subscribe not yet called")
    };
    tx.send(Ok(event)).await.expect("push_event send");
}

/// 通过 stub 的当前活跃 mpsc::Sender 推一个 Status(模拟 stream-level 错误)。
pub async fn push_status(stub: &Arc<Mutex<StubHubState>>, s: Status) {
    let tx = {
        stub.lock()
            .unwrap()
            .event_tx
            .clone()
            .expect("stub has no active event_tx — Subscribe not yet called")
    };
    tx.send(Err(s)).await.expect("push_status send");
}

/// 每个测试用唯一 keyring service,避免互相串扰(Plan 2 兼容名)。
pub fn unique_keyring_service() -> String {
    format!("chathub.test.{}", uuid::Uuid::new_v4().simple())
}
```

如果 `mod.rs` 已经有 `unique_keyring_service` / `pub mod stub_relay;`,确保只追加新 helper 不重复定义。

- [ ] **Step 10.5: 编译 + 跑 Plan 2 e2e 验证不破**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo build -p chathub-net --tests
cargo test -p chathub-net --test auth_e2e
```

Expected: 7 个 Plan 2 auth e2e 全过(`start_stub` 签名兼容)。

- [ ] **Step 10.6: clippy**

```bash
cargo clippy -p chathub-net --tests -- -D warnings
```

Expected: 0 warning。

- [ ] **Step 10.7: 提交**

```bash
git add backends/crates/chathub-net/tests/common/stub_relay.rs backends/crates/chathub-net/tests/common/mod.rs
git commit -m "$(cat <<'EOF'
test(chathub-net): stub Hub fixture + start_stub_full + helpers

- StubHub: Subscribe 创建 mpsc + ReceiverStream(SubscribeOutcome::Stream/RejectOnce/RejectAlways)
- StubHubState: 暴露 subscribes/since_seqs 历史 + event_tx + sends/SendRequest 历史 + 初始策略
- start_stub_full: 同进程 AuthServer + HubServer 共用 SocketAddr,返回两个 state Arc
- start_stub: 转调 start_stub_full + 丢弃 hub_state,Plan 2 测试 0 改动
- common/mod.rs: + wait_for_state(超时 + 谓词)+ push_event + push_status + unique_keyring_service
- 验证 Plan 2 7 个 e2e 仍 100% 绿
EOF
)"
```

---

## Task 11: ConnectionManager 骨架(start/stop + 占位 run_loop)

**Files:**

- Modify: `backends/crates/chathub-net/src/hub.rs`(添加 `Inner` + `ConnectionManager` + 占位 `run_loop`)

为什么:把 ConnectionManager 类型骨架建好,公共 API(`new`/`start`/`stop`/`state_subscribe`/`event_subscribe`)签名 ready;run_loop 先实现一个最简版本(进 Connecting 立即转 Disconnected{None} 退出),不调 hub.subscribe — Task 12 起渐进填实。

- [ ] **Step 11.1: 在 `backends/crates/chathub-net/src/hub.rs` imports 段补齐 ConnectionManager 需要的依赖**

把 hub.rs 顶部 use 段(从 `use crate::error::AuthError;` 开始)替换为:

```rust
use crate::error::AuthError;
use crate::interceptor::AuthInterceptor;
use crate::token::TokenStore;
use chathub_proto::v1::hub_client::HubClient as RawHubClient;
use chathub_proto::v1::{ServerEvent, SubscribeRequest, SendRequest, SendResponse};
use chathub_state::SeqStore;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{broadcast, watch};
use tokio::task::JoinHandle;
use tonic::codegen::InterceptedService;
use tonic::transport::Channel;
```

- [ ] **Step 11.2: 在 `HubClient` 之后(`#[cfg(test)] mod tests` 之前)添加 `Inner` + `ConnectionManager`**

```rust
struct Inner {
    hub: HubClient,
    token_store: Arc<TokenStore>,
    seq_store: SeqStore,
    backoff: BackoffConfig,
    state_tx: watch::Sender<ConnectionState>,
    event_tx: broadcast::Sender<ServerEvent>,
    task: tokio::sync::Mutex<Option<JoinHandle<()>>>,
}

#[derive(Clone)]
pub struct ConnectionManager {
    inner: Arc<Inner>,
}

impl ConnectionManager {
    /// 构造。`backoff` 测试通常传 fast(10ms/2x/150ms),生产传 `BackoffConfig::default()`。
    pub fn new(
        hub: HubClient,
        token_store: Arc<TokenStore>,
        seq_store: SeqStore,
        backoff: BackoffConfig,
    ) -> Self {
        let (state_tx, _) = watch::channel(ConnectionState::Disconnected { last_error: None });
        let (event_tx, _) = broadcast::channel(256);
        Self {
            inner: Arc::new(Inner {
                hub,
                token_store,
                seq_store,
                backoff,
                state_tx,
                event_tx,
                task: tokio::sync::Mutex::new(None),
            }),
        }
    }

    pub fn state_subscribe(&self) -> watch::Receiver<ConnectionState> {
        self.inner.state_tx.subscribe()
    }

    pub fn event_subscribe(&self) -> broadcast::Receiver<ServerEvent> {
        self.inner.event_tx.subscribe()
    }

    /// idempotent。已活则 no-op。
    pub async fn start(&self) {
        let mut guard = self.inner.task.lock().await;
        if guard.as_ref().is_some_and(|h| !h.is_finished()) {
            return;
        }
        // 必须先 subscribe LoggedOut 再 spawn,broadcast 只看后续事件
        let logged_out_rx = self.inner.token_store.logged_out_subscribe();
        let inner = Arc::clone(&self.inner);
        *guard = Some(tokio::spawn(async move {
            Inner::run_loop(inner, logged_out_rx).await;
        }));
    }

    /// idempotent。abort task,等 abort 真正生效后返回。
    /// abort 后 `JoinHandle::await` 立即得 `Err(JoinError::Cancelled)`,我们吞掉 —
    /// 等待是为了保证 stop 完成后 start 能可靠新建(否则 start 会见 `!is_finished()` no-op)。
    pub async fn stop(&self) {
        let mut guard = self.inner.task.lock().await;
        if let Some(h) = guard.take() {
            h.abort();
            let _ = h.await;
        }
        // state_tx 不主动改写;调用方需要立即"看到 Disconnected"时自行 wait_for_state。
    }
}

impl Inner {
    /// Plan 3 渐进式实现 — 当前是占位:进 Connecting 后立即转 Disconnected{None} 退出。
    /// Task 12 起开始填实 subscribe → Subscribed → select 循环。
    async fn run_loop(
        self: Arc<Inner>,
        mut _logged_out_rx: broadcast::Receiver<crate::token::LoggedOutReason>,
    ) {
        self.state_tx
            .send_replace(ConnectionState::Connecting);
        // 占位:Task 12 替换为真实 subscribe + select 循环
        self.state_tx
            .send_replace(ConnectionState::Disconnected { last_error: None });
    }
}
```

- [ ] **Step 11.3: 编译 + 跑 lib 单元测试**

```bash
cargo build -p chathub-net
cargo test -p chathub-net --lib
```

Expected: 编译过;现有 hub:: 12 个 + Plan 2 单元测试,**全过**。占位 run_loop 是 unreachable from lib tests(没有 e2e 调用 start/stop),所以不影响 lib 测试。

- [ ] **Step 11.4: 写第一个 e2e — connection_state_initial_is_disconnected**

创建 `backends/crates/chathub-net/tests/hub_e2e.rs`,内容:

```rust
//! Plan 3 e2e:HubClient + ConnectionManager 与 stub Relay 的端到端验证。
//! 9 个场景见 spec §9.2。本 task 先打 1 个最小烟雾测试。

mod common;

use chathub_net::{
    build_endpoint, AuthInterceptor, BackoffConfig, ConnectionManager, ConnectionState,
    HubClient, TokenStore,
};
use chathub_state::{KeyringTokenStore, SeqStore, SqlitePool};
use std::sync::Arc;
use std::time::Duration;

use common::stub_relay::start_stub_full;

fn fast_backoff() -> BackoffConfig {
    BackoffConfig {
        base: Duration::from_millis(10),
        factor: 2.0,
        cap: Duration::from_millis(150),
    }
}

async fn make_cm(
    addr: std::net::SocketAddr,
) -> (Arc<ConnectionManager>, Arc<TokenStore>, SeqStore) {
    let url = format!("http://{}", addr);
    let endpoint = build_endpoint(&url).expect("endpoint");
    let channel = endpoint.connect_lazy();

    let pool = SqlitePool::in_memory().await.expect("pool");
    let seq_store = SeqStore::new(pool.clone());
    let keyring = KeyringTokenStore::new(common::unique_keyring_service());
    let token_store = Arc::new(TokenStore::new(endpoint, keyring).expect("token store"));

    let interceptor = AuthInterceptor::new(token_store.clone());
    let hub = HubClient::new(channel, interceptor);
    let cm = Arc::new(ConnectionManager::new(
        hub,
        token_store.clone(),
        seq_store.clone(),
        fast_backoff(),
    ));
    (cm, token_store, seq_store)
}

#[tokio::test]
async fn connection_state_initial_is_disconnected() {
    let (addr, _auth_state, _hub_state, _h) = start_stub_full().await;
    let (cm, _ts, _ss) = make_cm(addr).await;
    // 不调 start —— 仅断言 new() 后初始 state 是 Disconnected{None}
    let s = cm.state_subscribe().borrow().clone();
    assert!(
        matches!(s, ConnectionState::Disconnected { last_error: None }),
        "got {:?}", s
    );
}
```

- [ ] **Step 11.5: 跑 e2e**

```bash
cargo test -p chathub-net --test hub_e2e
```

Expected: 1 个测试 `connection_state_initial_is_disconnected` 过。

- [ ] **Step 11.6: clippy**

```bash
cargo clippy -p chathub-net --tests -- -D warnings
```

Expected: 0 warning。

- [ ] **Step 11.7: 提交**

```bash
git add backends/crates/chathub-net/src/hub.rs backends/crates/chathub-net/tests/hub_e2e.rs
git commit -m "$(cat <<'EOF'
feat(chathub-net): ConnectionManager skeleton + 1st e2e

- Inner: hub/token_store/seq_store/backoff/state_tx/event_tx/task
- ConnectionManager(Arc<Inner>):new/start/stop/state_subscribe/event_subscribe
- start: 先 subscribe LoggedOut 再 spawn(broadcast 不丢);幂等
- stop: abort,不 await join;调用方自行 wait_for_state
- 占位 run_loop:Connecting → Disconnected{None} 退出(Task 12 起填实)
- 1 个 e2e:初始 state 是 Disconnected{None}
EOF
)"
```

---

## Task 12: run_loop happy path + e2e #1

**Files:**

- Modify: `backends/crates/chathub-net/src/hub.rs`(`Inner::run_loop` 实装 happy path)
- Modify: `backends/crates/chathub-net/tests/hub_e2e.rs`(加 e2e #1)

为什么:第一条真实 stream 路径:subscribe 成功 → 进 Subscribed → select 循环 → stream 推 ServerEvent → seq_store.upsert + event_tx.send。其它错误路径留 Task 13-17 渐进。

- [ ] **Step 12.1: 把 `backends/crates/chathub-net/src/hub.rs` 的 `Inner::run_loop` 替换为 happy path 实装**

把现有 `impl Inner { async fn run_loop(...) { ... } }` 函数体整体替换为:

```rust
impl Inner {
    async fn run_loop(
        self: Arc<Inner>,
        mut logged_out_rx: broadcast::Receiver<crate::token::LoggedOutReason>,
    ) {
        let mut backoff = ExponentialBackoff::new(&self.backoff);

        'reconnect: loop {
            self.state_tx
                .send_replace(ConnectionState::Connecting);

            let since_seqs = self.seq_store.read_all().await.unwrap_or_default();

            let mut stream = match self.hub.subscribe(since_seqs).await {
                Ok(s) => s,
                Err(err) => {
                    // 占位:Task 13-15 加 classify 分流;现在简单退避后重连
                    self.state_tx.send_replace(ConnectionState::Disconnected {
                        last_error: Some(err),
                    });
                    tokio::time::sleep(backoff.next()).await;
                    continue 'reconnect;
                }
            };

            self.state_tx
                .send_replace(ConnectionState::Subscribed);
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
                            // 占位:Task 13 加 server-close → backoff 重连
                            self.state_tx.send_replace(ConnectionState::Disconnected { last_error: None });
                            tokio::time::sleep(backoff.next()).await;
                            continue 'reconnect;
                        }
                        Err(_status) => {
                            // 占位:Task 13-15 加 classify 分流;现在简单退避
                            self.state_tx.send_replace(ConnectionState::Disconnected { last_error: None });
                            tokio::time::sleep(backoff.next()).await;
                            continue 'reconnect;
                        }
                    }
                }
            }
        }
    }
}
```

- [ ] **Step 12.2: 把 `backends/crates/chathub-net/tests/hub_e2e.rs` 加 e2e #1**

把 `connection_state_initial_is_disconnected` 之后追加(并简化原 helper):

```rust
use chathub_proto::v1::{server_event, IncomingMsg, MessageBody, ServerEvent, TextBody};
use chathub_proto::v1::message_body;
use common::{push_event, wait_for_state};

fn make_incoming(account: &str, seq: i64, text: &str) -> ServerEvent {
    ServerEvent {
        wecom_account_id: account.into(),
        seq,
        body: Some(server_event::Body::Incoming(IncomingMsg {
            conversation_id: "conv-1".into(),
            from_user_id:    "peer-1".into(),
            body: Some(MessageBody {
                kind: Some(message_body::Kind::Text(TextBody { text: text.into() })),
                reply_to: None,
                mentions: vec![],
            }),
            sent_at_ms:    1_700_000_000_000,
            server_msg_id: format!("sm-{seq}"),
            remote: None,
        })),
    }
}

/// 让 token_store 内部"看起来已登录" — 直接给一个 fake access token。
/// Plan 3 e2e 不走 Login RPC(那是 Plan 2 测的),直接造 TokenState 注入。
async fn force_login(token_store: &Arc<TokenStore>) {
    token_store.seed_user_id("u-test");
    // 通过 force_refresh 触发一次 refresh — stub Auth 默认 outcome=Ok 会立即给新 token
    // 但本 e2e 不需要真正的 Auth,只需要 interceptor 注入 Bearer。最简办法:
    // 不依赖 access token 是否新鲜 —— stub Hub 的 Subscribe/Send 不校验 token。
    // 因此 force_login 实际上是 no-op 占位,留作未来扩展点。
    let _ = token_store;
}

#[tokio::test]
async fn subscribe_success_streams_event() {
    let (addr, _auth, hub_state, _h) = start_stub_full().await;
    let (cm, token_store, _seq_store) = make_cm(addr).await;
    force_login(&token_store).await;

    cm.start().await;

    // 等到 Subscribed
    let mut state_rx = cm.state_subscribe();
    wait_for_state(
        &mut state_rx,
        |s| matches!(s, ConnectionState::Subscribed),
        Duration::from_secs(2),
    )
    .await;

    // 注入一个 IncomingMsg
    let mut event_rx = cm.event_subscribe();
    push_event(&hub_state, make_incoming("wxa1", 100, "hi")).await;

    // 验证 broadcast 收到
    let event = tokio::time::timeout(Duration::from_secs(2), event_rx.recv())
        .await
        .expect("recv timeout")
        .expect("recv ok");
    assert_eq!(event.wecom_account_id, "wxa1");
    assert_eq!(event.seq, 100);

    cm.stop().await;
}
```

(注意:文件顶部已有 `mod common;` + 各种 use,新增的 use 与 helper 加到对应区。)

- [ ] **Step 12.3: 跑 e2e**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo test -p chathub-net --test hub_e2e -- --test-threads=1
```

Expected: 2 个测试都过(`connection_state_initial_is_disconnected` + `subscribe_success_streams_event`)。`--test-threads=1` 避免端口冲突或 keyring 串扰(Plan 2 e2e 风格延续)。

- [ ] **Step 12.4: clippy**

```bash
cargo clippy -p chathub-net --tests -- -D warnings
```

Expected: 0 warning。

- [ ] **Step 12.5: 提交**

```bash
git add backends/crates/chathub-net/src/hub.rs backends/crates/chathub-net/tests/hub_e2e.rs
git commit -m "$(cat <<'EOF'
feat(chathub-net): run_loop happy path + e2e #1

- run_loop 实装:Connecting → subscribe → Subscribed → select{logged_out|stream}
- ServerEvent 收到后:seq_store.upsert(吞错) + event_tx.send
- Server-close + Subscribe 错误 + stream-Err 暂走简单退避(Task 13-15 加 classify)
- biased select 优先 logged_out_rx,防止 event 流量打盖 LoggedOut
- e2e #1 subscribe_success_streams_event:state Connecting→Subscribed,broadcast 收到 event
EOF
)"
```

---

## Task 13: run_loop transient backoff + e2e #4

**Files:**

- Modify: `backends/crates/chathub-net/src/hub.rs`(初始 subscribe 失败用 classify)
- Modify: `backends/crates/chathub-net/tests/hub_e2e.rs`(加 e2e #4)

为什么:Task 12 的 run_loop 在 subscribe 失败时还是简单退避;现在加上 classify 分流,把 Network/Internal 走 Backoff 与 Storage/Upgrade/Unauthenticated 区分开(Storage/Upgrade 留 Task 14-15,Unauthenticated 留 Task 14)。本 task 只验证 Backoff 路径(Unavailable)。

- [ ] **Step 13.1: 修改 `Inner::run_loop` 内 `Err(err) => ...`(初始 subscribe 失败分支)用 classify**

把上一 task 的 `Err(err) => { ... }` 整段替换为:

```rust
                Err(err) => match classify(&err) {
                    Action::ReactiveRefresh => {
                        // Task 14 实装:force_refresh + 立即重连
                        let _ = self.token_store.force_refresh().await;
                        backoff.reset();
                        continue 'reconnect;
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
                        tokio::time::sleep(backoff.next()).await;
                        continue 'reconnect;
                    }
                },
```

- [ ] **Step 13.2: 在 `tests/hub_e2e.rs` 末尾追加 e2e #4(Unavailable backoff)**

```rust
use common::stub_relay::{SubscribeOutcome};
use tonic::Status;

#[tokio::test]
async fn subscribe_unavailable_backoffs_and_reconnects() {
    let (addr, _auth, hub_state, _h) = start_stub_full().await;
    {
        let mut s = hub_state.lock().unwrap();
        s.subscribe_outcome = SubscribeOutcome::RejectOnce(Status::unavailable("relay down"));
    }
    let (cm, token_store, _ss) = make_cm(addr).await;
    force_login(&token_store).await;

    cm.start().await;

    let mut state_rx = cm.state_subscribe();
    // 第一次 Connecting → 收到 Unavailable → Disconnected{Network} → backoff → 第二次 Connecting → Subscribed
    wait_for_state(
        &mut state_rx,
        |s| matches!(s, ConnectionState::Subscribed),
        Duration::from_secs(3),
    )
    .await;

    // 断言 stub 至少被 subscribe 过 2 次(第一次拒,第二次成功)
    let count = hub_state.lock().unwrap().subscribes.len();
    assert!(count >= 2, "expected ≥2 subscribe attempts, got {count}");

    cm.stop().await;
}
```

- [ ] **Step 13.3: 跑 e2e**

```bash
cargo test -p chathub-net --test hub_e2e -- --test-threads=1
```

Expected: 3 个测试全过(原 2 + 新 1)。

- [ ] **Step 13.4: clippy**

```bash
cargo clippy -p chathub-net --tests -- -D warnings
```

Expected: 0 warning。

- [ ] **Step 13.5: 提交**

```bash
git add backends/crates/chathub-net/src/hub.rs backends/crates/chathub-net/tests/hub_e2e.rs
git commit -m "$(cat <<'EOF'
feat(chathub-net): subscribe-error classify (initial RPC) + e2e #4

- run_loop 初始 subscribe 失败:走 classify,Backoff/Terminate/ReactiveRefresh 分流
- ReactiveRefresh 暂调 force_refresh 后 reset backoff(Task 14 加 e2e 验证)
- e2e #4 subscribe_unavailable_backoffs_and_reconnects:RejectOnce(Unavailable) → 退避 → 第二次 Subscribed,subscribe count ≥2
EOF
)"
```

---

## Task 14: run_loop reactive refresh + e2e #3

**Files:**

- Modify: `backends/crates/chathub-net/tests/hub_e2e.rs`(加 e2e #3)

为什么:Task 13 的 run_loop 已经在 ReactiveRefresh 分支调 `force_refresh`;本 task 验证它在 Unauthenticated 场景下能正确"立即重连"(不退避)。

- [ ] **Step 14.1: 在 `tests/hub_e2e.rs` 末尾追加 e2e #3**

```rust
#[tokio::test]
async fn subscribe_unauthenticated_triggers_force_refresh() {
    let (addr, auth_state, hub_state, _h) = start_stub_full().await;
    // 让 stub Hub 第一次返回 Unauthenticated,第二次接受
    {
        let mut s = hub_state.lock().unwrap();
        s.subscribe_outcome = SubscribeOutcome::RejectOnce(Status::unauthenticated("expired"));
    }
    let (cm, token_store, _ss) = make_cm(addr).await;
    force_login(&token_store).await;

    cm.start().await;

    let mut state_rx = cm.state_subscribe();
    wait_for_state(
        &mut state_rx,
        |s| matches!(s, ConnectionState::Subscribed),
        Duration::from_secs(3),
    )
    .await;

    // 断言 force_refresh 被触发过(stub Auth.refresh_count >= 1)
    let refresh_count = auth_state.lock().unwrap().refresh_count;
    assert!(refresh_count >= 1, "expected refresh_count ≥1, got {refresh_count}");

    // 断言 stub 至少被 subscribe 过 2 次(第一次 Unauthenticated,第二次 Stream)
    let sub_count = hub_state.lock().unwrap().subscribes.len();
    assert!(sub_count >= 2, "expected ≥2 subscribes, got {sub_count}");

    cm.stop().await;
}
```

- [ ] **Step 14.2: 跑 e2e**

```bash
cargo test -p chathub-net --test hub_e2e -- --test-threads=1
```

Expected: 4 个测试全过(原 3 + 新 1)。

- [ ] **Step 14.3: clippy**

```bash
cargo clippy -p chathub-net --tests -- -D warnings
```

Expected: 0 warning。

- [ ] **Step 14.4: 提交**

```bash
git add backends/crates/chathub-net/tests/hub_e2e.rs
git commit -m "$(cat <<'EOF'
test(chathub-net): e2e #3 — Unauthenticated triggers force_refresh

- 验证 RejectOnce(Unauthenticated) → run_loop 走 ReactiveRefresh → force_refresh
- 断言 refresh_count ≥1 + subscribe 重试 ≥2 次
- 不依赖退避计时(reactive 路径不退避)
EOF
)"
```

---

## Task 15: run_loop terminate (Upgrade) + e2e #5

**Files:**

- Modify: `backends/crates/chathub-net/tests/hub_e2e.rs`(加 e2e #5)

为什么:Task 13 的 run_loop 已经在 Terminate 分支退出 task;本 task 验证 UpgradeRequired 场景下:state→Disconnected{Some(UpgradeRequired)} + task 退出且不再变。

- [ ] **Step 15.1: 在 `tests/hub_e2e.rs` 末尾追加 e2e #5**

```rust
fn upgrade_required_status() -> Status {
    use chathub_proto::v1::{error_detail, ErrorDetail, UpgradeRequired};
    use prost::Message;
    let detail = ErrorDetail {
        body: Some(error_detail::Body::Upgrade(UpgradeRequired {
            min_client_version: "9.9.9".into(),
            download_url: "https://example.com/dl".into(),
        })),
    };
    Status::with_details(
        tonic::Code::FailedPrecondition,
        "upgrade required",
        detail.encode_to_vec().into(),
    )
}

#[tokio::test]
async fn subscribe_upgrade_required_terminates() {
    use chathub_net::AuthError;

    let (addr, _auth, hub_state, _h) = start_stub_full().await;
    {
        let mut s = hub_state.lock().unwrap();
        s.subscribe_outcome = SubscribeOutcome::RejectAlways(upgrade_required_status());
    }
    let (cm, token_store, _ss) = make_cm(addr).await;
    force_login(&token_store).await;

    cm.start().await;

    let mut state_rx = cm.state_subscribe();
    let final_state = wait_for_state(
        &mut state_rx,
        |s| matches!(s, ConnectionState::Disconnected { last_error: Some(AuthError::UpgradeRequired { .. }) }),
        Duration::from_secs(3),
    )
    .await;

    match final_state {
        ConnectionState::Disconnected { last_error: Some(AuthError::UpgradeRequired { min_version, .. }) } => {
            assert_eq!(min_version, "9.9.9");
        }
        other => panic!("wrong final state: {other:?}"),
    }

    // 等 200ms,断言 task 已退出 + state 不再变
    tokio::time::sleep(Duration::from_millis(200)).await;
    // subscribe 计数应 ≤ 2(初始 + 可能内部一次重试),而不是无限重连
    let sub_count = hub_state.lock().unwrap().subscribes.len();
    assert!(sub_count <= 3, "task should have terminated, got {sub_count} subscribes");

    cm.stop().await;
}
```

- [ ] **Step 15.2: 跑 e2e**

```bash
cargo test -p chathub-net --test hub_e2e -- --test-threads=1
```

Expected: 5 个测试全过。

- [ ] **Step 15.3: clippy**

```bash
cargo clippy -p chathub-net --tests -- -D warnings
```

Expected: 0 warning。

- [ ] **Step 15.4: 提交**

```bash
git add backends/crates/chathub-net/tests/hub_e2e.rs
git commit -m "$(cat <<'EOF'
test(chathub-net): e2e #5 — UpgradeRequired terminates task

- 验证 RejectAlways(FailedPrecondition + UpgradeRequired details) → run_loop Terminate
- 最终 state = Disconnected{Some(UpgradeRequired{min_version="9.9.9"})}
- sleep 200ms 后断言 subscribe 计数 ≤3(确认无限重连未发生)
EOF
)"
```

---

## Task 16: run_loop logged_out + e2e #6 + token_store 测试 helper

**Files:**

- Modify: `backends/crates/chathub-net/src/token.rs`(加 `_emit_logged_out_for_test`,`#[cfg(test)]` 与 `pub(crate)` gated)
- Modify: `backends/crates/chathub-net/tests/hub_e2e.rs`(加 e2e #6)

为什么:run_loop 已经在 select 里监听 logged_out_rx(Task 12),本 task 加 e2e 验证。需要一个能"主动发 LoggedOut"的 helper —— 在 token.rs 里加。

注意:`_emit_logged_out_for_test` 用 `pub(crate)` + `#[cfg(test)]` 限制可见,生产代码不可见。**但** 测试位于 `tests/` 目录(integration test crate),无法访问 `pub(crate)`;所以加 helper 时用 `pub` + `#[doc(hidden)]` 或 `#[cfg(any(test, feature = "test-utils"))]`。最简方式:加一个 `__internal-test-utils` 标志名空间的 `pub fn`,通过 cargo feature gate。或者更简单 —— 在 token.rs 暴露 `pub fn _emit_logged_out_for_test(...)` 但加 `#[doc(hidden)]`。

- [ ] **Step 16.1: 在 `backends/crates/chathub-net/src/token.rs` 的 `impl TokenStore { ... }` 块末尾(`seed_user_id` 之后)添加 helper**

```rust
    /// **测试 only** —— 主动 emit 一个 LoggedOut 给所有订阅者,模拟 refresher 失败。
    /// 不清 keyring,不改 state;仅 broadcast。
    /// `#[doc(hidden)]` 让 rustdoc 不展示;不删除 access state,以便测试可断言"task 退出后"的行为。
    #[doc(hidden)]
    pub fn _emit_logged_out_for_test(&self, reason: LoggedOutReason) {
        let _ = self.logged_out_tx.send(reason);
    }
```

- [ ] **Step 16.2: 在 `tests/hub_e2e.rs` 末尾追加 e2e #6**

```rust
use chathub_net::LoggedOutReason;

#[tokio::test]
async fn logged_out_during_subscribe_terminates_task() {
    let (addr, _auth, hub_state, _h) = start_stub_full().await;
    let (cm, token_store, _ss) = make_cm(addr).await;
    force_login(&token_store).await;

    cm.start().await;

    // 等到 Subscribed
    let mut state_rx = cm.state_subscribe();
    wait_for_state(
        &mut state_rx,
        |s| matches!(s, ConnectionState::Subscribed),
        Duration::from_secs(2),
    )
    .await;

    // 主动 emit LoggedOut
    token_store._emit_logged_out_for_test(LoggedOutReason::RefreshFailed);

    // 等到 Disconnected{None}
    wait_for_state(
        &mut state_rx,
        |s| matches!(s, ConnectionState::Disconnected { last_error: None }),
        Duration::from_secs(2),
    )
    .await;

    // sleep 200ms 验证 task 不再重连
    tokio::time::sleep(Duration::from_millis(200)).await;
    let sub_count = hub_state.lock().unwrap().subscribes.len();
    // 仅一次 subscribe(LoggedOut 后 task 退出,不应重连)
    assert_eq!(sub_count, 1, "task should not reconnect after LoggedOut");

    cm.stop().await;
}
```

- [ ] **Step 16.3: 跑 e2e**

```bash
cargo test -p chathub-net --test hub_e2e -- --test-threads=1
```

Expected: 6 个测试全过。

- [ ] **Step 16.4: 跑 Plan 2 auth e2e 不破**

```bash
cargo test -p chathub-net --test auth_e2e -- --test-threads=1
```

Expected: 7 个 Plan 2 auth e2e 全过。

- [ ] **Step 16.5: clippy**

```bash
cargo clippy -p chathub-net --tests -- -D warnings
```

Expected: 0 warning。

- [ ] **Step 16.6: 提交**

```bash
git add backends/crates/chathub-net/src/token.rs backends/crates/chathub-net/tests/hub_e2e.rs
git commit -m "$(cat <<'EOF'
test(chathub-net): e2e #6 — LoggedOut during Subscribe terminates task

- token.rs: _emit_logged_out_for_test(reason)(#[doc(hidden)] pub),仅供测试主动 emit
- run_loop biased select 已在 Task 12 实装,本 task 加 e2e 验证
- 验证 Subscribed → emit LoggedOut(RefreshFailed) → Disconnected{None} → task 退出
- 200ms 后 subscribe 计数 = 1(无重连)
EOF
)"
```

---

## Task 17: run_loop KICKED + since_seqs resume + e2e #2 / #7

**Files:**

- Modify: `backends/crates/chathub-net/src/hub.rs`(stream message 路径加 KICKED 识别 + Err(status) 走 classify)
- Modify: `backends/crates/chathub-net/tests/hub_e2e.rs`(加 e2e #2 + #7)

为什么:Task 12 的 stream-Err 分支还是简单退避;现在加 classify 分流(同 Task 13 初始 subscribe 失败),并识别 SystemSignal::KICKED → state→Disconnected{None} + task 退出。e2e #2 验证 since_seqs 续接(stop/start 后第二次 subscribe 拿到正确的 since_seqs)。

- [ ] **Step 17.1: 修改 `backends/crates/chathub-net/src/hub.rs` 的 `Inner::run_loop`,把 `Ok(Some(event))` 与 `Err(_status)` 分支替换**

把 happy-path 的 inner select 中的 `msg = stream.message() => match msg { ... }` 整段替换为:

```rust
                    msg = stream.message() => match msg {
                        Ok(Some(event)) => {
                            if let Err(e) = self.seq_store.upsert(&event.wecom_account_id, event.seq).await {
                                tracing::warn!(?e, "seq_store upsert failed, ignored on hot path");
                            }
                            // 检测 SystemSignal::KICKED:emit 后立即终止
                            let is_kicked = matches!(
                                &event.body,
                                Some(chathub_proto::v1::server_event::Body::System(s))
                                    if s.kind == chathub_proto::v1::system_signal::Kind::Kicked as i32
                            );
                            let _ = self.event_tx.send(event);
                            if is_kicked {
                                self.state_tx.send_replace(ConnectionState::Disconnected { last_error: None });
                                return;
                            }
                        }
                        Ok(None) => {
                            // server-close 无错误 → 退避重连
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
                                    self.state_tx.send_replace(ConnectionState::Disconnected {
                                        last_error: Some(err),
                                    });
                                    return;
                                }
                                Action::Backoff => {
                                    self.state_tx.send_replace(ConnectionState::Disconnected {
                                        last_error: Some(err),
                                    });
                                    tokio::time::sleep(backoff.next()).await;
                                    continue 'reconnect;
                                }
                            }
                        }
                    }
```

- [ ] **Step 17.2: 在 `tests/hub_e2e.rs` 末尾追加 e2e #2 和 e2e #7**

```rust
use chathub_proto::v1::{system_signal, SystemSignal};

#[tokio::test]
async fn subscribe_resumes_with_since_seqs() {
    let (addr, _auth, hub_state, _h) = start_stub_full().await;
    let (cm, token_store, _ss) = make_cm(addr).await;
    force_login(&token_store).await;

    cm.start().await;

    let mut state_rx = cm.state_subscribe();
    wait_for_state(
        &mut state_rx,
        |s| matches!(s, ConnectionState::Subscribed),
        Duration::from_secs(2),
    )
    .await;

    // 推一个 event(seq=10),让 SeqStore 持久化
    let mut event_rx = cm.event_subscribe();
    push_event(&hub_state, make_incoming("wxa1", 10, "first")).await;
    let _ = tokio::time::timeout(Duration::from_secs(1), event_rx.recv())
        .await
        .expect("recv timeout")
        .expect("recv ok");

    // 给 SQLite 一点时间持久化(亚毫秒级,但稳一些)
    tokio::time::sleep(Duration::from_millis(50)).await;

    // 停 → 启,断言第二次 subscribe 收到 since_seqs={"wxa1":10}
    // stop().await 已等 task 真停(abort + JoinHandle::await),start 能可靠新建
    cm.stop().await;
    cm.start().await;

    // 等到第二次 Subscribed
    wait_for_state(
        &mut state_rx,
        |s| matches!(s, ConnectionState::Subscribed),
        Duration::from_secs(2),
    )
    .await;

    let subs = hub_state.lock().unwrap().subscribes.clone();
    assert!(subs.len() >= 2, "expected ≥2 subscribes, got {}", subs.len());
    let last = subs.last().expect("at least one");
    assert_eq!(last.get("wxa1"), Some(&10), "since_seqs not resumed correctly: {last:?}");

    cm.stop().await;
}

#[tokio::test]
async fn subscribe_kicked_emits_event_then_terminates() {
    let (addr, _auth, hub_state, _h) = start_stub_full().await;
    let (cm, token_store, _ss) = make_cm(addr).await;
    force_login(&token_store).await;

    cm.start().await;

    let mut state_rx = cm.state_subscribe();
    wait_for_state(
        &mut state_rx,
        |s| matches!(s, ConnectionState::Subscribed),
        Duration::from_secs(2),
    )
    .await;

    let mut event_rx = cm.event_subscribe();

    // 推一个 SystemSignal::KICKED
    let kicked_event = ServerEvent {
        wecom_account_id: "wxa1".into(),
        seq: 999,
        body: Some(server_event::Body::System(SystemSignal {
            kind: system_signal::Kind::Kicked as i32,
            detail: "another device".into(),
        })),
    };
    push_event(&hub_state, kicked_event.clone()).await;

    // 验证 broadcast 收到 KICKED event
    let event = tokio::time::timeout(Duration::from_secs(2), event_rx.recv())
        .await
        .expect("recv timeout")
        .expect("recv ok");
    assert_eq!(event.seq, 999);
    assert!(matches!(&event.body, Some(server_event::Body::System(s)) if s.kind == system_signal::Kind::Kicked as i32));

    // 验证 state → Disconnected{None}
    wait_for_state(
        &mut state_rx,
        |s| matches!(s, ConnectionState::Disconnected { last_error: None }),
        Duration::from_secs(2),
    )
    .await;

    // 200ms 后断言不再重连
    tokio::time::sleep(Duration::from_millis(200)).await;
    let sub_count = hub_state.lock().unwrap().subscribes.len();
    assert_eq!(sub_count, 1, "task should terminate after KICKED, got {sub_count}");

    cm.stop().await;
}
```

- [ ] **Step 17.3: 跑全部 e2e**

```bash
cargo test -p chathub-net --test hub_e2e -- --test-threads=1
```

Expected: 8 个测试全过(原 6 + 新 2)。

- [ ] **Step 17.4: 跑 Plan 2 auth e2e 不破**

```bash
cargo test -p chathub-net --test auth_e2e -- --test-threads=1
```

Expected: 7 个全过。

- [ ] **Step 17.5: clippy**

```bash
cargo clippy -p chathub-net --tests -- -D warnings
```

Expected: 0 warning。

- [ ] **Step 17.6: 提交**

```bash
git add backends/crates/chathub-net/src/hub.rs backends/crates/chathub-net/tests/hub_e2e.rs
git commit -m "$(cat <<'EOF'
feat(chathub-net): stream-Err classify + KICKED detection + e2e #2/#7

- run_loop stream.message Err(status) → classify → ReactiveRefresh/Terminate/Backoff
- Ok(Some(event)) 在 emit 后检测 SystemSignal::KICKED → state→Disconnected{None} + task 退出
- e2e #2 subscribe_resumes_with_since_seqs:event seq=10 → stop/start → 第二次 subscribe 收到 since_seqs={wxa1:10}
- e2e #7 subscribe_kicked_emits_event_then_terminates:KICKED → broadcast 收到 + state→Disconnected,200ms 后无重连
EOF
)"
```

---

## Task 18: Send e2e #8 + #9

**Files:**

- Modify: `backends/crates/chathub-net/tests/hub_e2e.rs`(加 e2e #8 + #9)

为什么:Send 是 unary RPC,与 ConnectionManager 解耦,直接通过 channel + interceptor 调。本 task 验证两条路径:成功返回 SendResponse,Unavailable 返回 AuthError::Network。

- [ ] **Step 18.1: 在 `tests/hub_e2e.rs` 末尾追加 e2e #8 + #9**

```rust
use chathub_proto::v1::SendRequest;
use chathub_net::AuthError;
use common::stub_relay::{SendStubOutcome};
use chathub_proto::v1::SendResponse;

fn make_send_req(account: &str, conv: &str, msg_id: &str, text: &str) -> SendRequest {
    SendRequest {
        wecom_account_id: account.into(),
        conversation_id:  conv.into(),
        client_msg_id:    msg_id.into(),
        body: Some(MessageBody {
            kind: Some(message_body::Kind::Text(TextBody { text: text.into() })),
            reply_to: None,
            mentions: vec![],
        }),
    }
}

#[tokio::test]
async fn send_success_returns_server_msg_id() {
    let (addr, _auth, hub_state, _h) = start_stub_full().await;
    {
        let mut s = hub_state.lock().unwrap();
        s.send_outcome = SendStubOutcome::Ok(SendResponse {
            server_msg_id: "sm-xyz".into(),
            sent_at_ms:    1_700_000_000_000,
        });
    }

    // 复用 make_cm 的依赖装配,从中取 hub
    let url = format!("http://{}", addr);
    let endpoint = build_endpoint(&url).expect("endpoint");
    let channel = endpoint.connect_lazy();
    let pool = SqlitePool::in_memory().await.expect("pool");
    let _seq_store = SeqStore::new(pool);
    let keyring = KeyringTokenStore::new(common::unique_keyring_service());
    let token_store = Arc::new(TokenStore::new(endpoint, keyring).expect("ts"));
    let interceptor = AuthInterceptor::new(token_store.clone());
    let hub = HubClient::new(channel, interceptor);

    let req = make_send_req("wxa1", "conv-1", "msg-id-uuid-fake", "hello");
    let resp = hub.send(req).await.expect("send ok");

    assert_eq!(resp.server_msg_id, "sm-xyz");
    assert_eq!(resp.sent_at_ms, 1_700_000_000_000);

    // 断言 stub 收到的 client_msg_id 是 "msg-id-uuid-fake"(测试本身写死)
    let sends = hub_state.lock().unwrap().sends.clone();
    assert_eq!(sends.len(), 1);
    assert_eq!(sends[0].client_msg_id, "msg-id-uuid-fake");
    assert_eq!(sends[0].wecom_account_id, "wxa1");
}

#[tokio::test]
async fn send_unavailable_returns_network_error() {
    let (addr, _auth, hub_state, _h) = start_stub_full().await;
    {
        let mut s = hub_state.lock().unwrap();
        s.send_outcome = SendStubOutcome::Status(Status::unavailable("relay down"));
    }

    let url = format!("http://{}", addr);
    let endpoint = build_endpoint(&url).expect("endpoint");
    let channel = endpoint.connect_lazy();
    let keyring = KeyringTokenStore::new(common::unique_keyring_service());
    let token_store = Arc::new(TokenStore::new(endpoint, keyring).expect("ts"));
    let interceptor = AuthInterceptor::new(token_store.clone());
    let hub = HubClient::new(channel, interceptor);

    let req = make_send_req("wxa1", "conv-1", "msg-id", "hello");
    let err = hub.send(req).await.expect_err("should fail");

    assert!(matches!(err, AuthError::Network { .. }), "got {err:?}");
}
```

- [ ] **Step 18.2: 跑 e2e**

```bash
cargo test -p chathub-net --test hub_e2e -- --test-threads=1
```

Expected: 10 个测试全过(原 8 + 新 2)。

合计: hub_e2e 现在覆盖 spec §9.2 全部 9 个场景 + 1 个初始 state 烟雾测试 = 10 个。

- [ ] **Step 18.3: 跑 Plan 2 auth e2e 不破**

```bash
cargo test -p chathub-net --test auth_e2e -- --test-threads=1
```

Expected: 7 个全过。

- [ ] **Step 18.4: clippy**

```bash
cargo clippy -p chathub-net --tests -- -D warnings
```

Expected: 0 warning。

- [ ] **Step 18.5: 提交**

```bash
git add backends/crates/chathub-net/tests/hub_e2e.rs
git commit -m "$(cat <<'EOF'
test(chathub-net): e2e #8/#9 — Send unary path

- e2e #8 send_success_returns_server_msg_id:
  · stub 配 SendStubOutcome::Ok(...) → HubClient::send 返回 server_msg_id="sm-xyz"
  · 断言 stub 收到的 client_msg_id 与 wecom_account_id 一致
- e2e #9 send_unavailable_returns_network_error:
  · stub 配 SendStubOutcome::Status(Unavailable) → AuthError::Network
- Send 路径与 ConnectionManager 完全解耦,共享 channel + interceptor
EOF
)"
```

---

## Task 19: backends 拼装 + send_message + hub_state Tauri 命令

**Files:**

- Modify: `backends/Cargo.toml`(`+uuid`)
- Modify: `backends/src/lib.rs`(setup 拼装 + 新命令 + login/logout 串接)

为什么:把 chathub-net 的 ConnectionManager + HubClient 接到 Tauri 应用。本 task 只做"拼装 + 命令",事件桥接留 Task 20。

- [ ] **Step 19.1: 修改 `backends/Cargo.toml`,在 `[dependencies]` 加 `uuid`**

```diff
 [dependencies]
 ...
 chathub-proto = { path = "crates/chathub-proto" }
 chathub-state = { path = "crates/chathub-state" }
 chathub-net   = { path = "crates/chathub-net" }
+uuid = { workspace = true }
```

`uuid` 已在 root `Cargo.toml` 的 `[workspace.dependencies]`(Plan 2 加过),这里只在 backends 启用。

- [ ] **Step 19.2: 修改 `backends/src/lib.rs`,在 imports 段加 chathub-net 的 ConnectionManager / HubClient / ConnectionState / BackoffConfig + chathub-proto 的相关 types**

把 lib.rs 顶部 use 段(从 `use chathub_net::{AuthApi, AuthError, LoggedOutReason, TokenStore};` 那行)替换为:

```rust
use chathub_net::{
    AuthApi, AuthError, AuthInterceptor, BackoffConfig, ConnectionManager, ConnectionState,
    HubClient, LoggedOutReason, TokenStore,
};
use chathub_proto::v1::{
    message_body, server_event, system_signal, MessageBody, SendRequest, SendResponse,
    ServerEvent, SystemSignal, TextBody, UserProfile,
};
use chathub_state::{KeyringTokenStore, SeqStore, SessionStore, SqlitePool};
```

- [ ] **Step 19.3: 在 `setup` 闭包内,把 Plan 2 的 auth_api 拼装段(`let auth_api = tauri::async_runtime::block_on(...)`)整体替换为同时拼装 auth_api + hub_client + conn_manager**

把 lib.rs 中 setup 闭包内现有的(对应行号 130-146 附近):

```rust
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
            }).map_err(Box::<dyn std::error::Error>::from)?;
            let auth_api = Arc::new(auth_api);
            app.manage(Arc::clone(&auth_api));
```

替换为:

```rust
            let (auth_api, hub_client, conn_manager) = tauri::async_runtime::block_on(async {
                std::fs::create_dir_all(&app_data).ok();
                let pool = SqlitePool::open(app_data.join("state.sqlite"))
                    .await.map_err(|e| e.to_string())?;
                let session_store = SessionStore::new(pool.clone());
                let seq_store = SeqStore::new(pool);
                let keyring = KeyringTokenStore::new(KEYRING_SERVICE);
                let endpoint = chathub_net::build_endpoint(chathub_net::RELAY_URL)
                    .map_err(|e| format!("endpoint: {e}"))?;
                let channel = endpoint.connect_lazy();
                let token_store = Arc::new(TokenStore::new(endpoint, keyring)
                    .map_err(|e| format!("token_store: {e}"))?);
                let interceptor = AuthInterceptor::new(token_store.clone());
                let hub_client = HubClient::new(channel, interceptor);
                let conn_manager = Arc::new(ConnectionManager::new(
                    hub_client.clone(),
                    token_store.clone(),
                    seq_store,
                    BackoffConfig::default(),
                ));
                let auth_api = AuthApi::new(token_store, session_store);
                Ok::<_, String>((auth_api, hub_client, conn_manager))
            }).map_err(Box::<dyn std::error::Error>::from)?;
            let auth_api = Arc::new(auth_api);
            app.manage(Arc::clone(&auth_api));
            app.manage(hub_client);
            app.manage(Arc::clone(&conn_manager));
```

- [ ] **Step 19.4: 修改 `try_resume` 段,resume 成功后调 cm.start()**

把现有 lib.rs 中:

```rust
            // 启动时 try_resume(后台 task,不阻塞 setup)
            let api_for_resume = Arc::clone(&auth_api);
            tauri::async_runtime::spawn(async move {
                match api_for_resume.try_resume_session().await {
                    Ok(Some(p)) => info!(target: "chathub::auth", user_id = %p.user_id, "resumed session"),
                    Ok(None)    => info!(target: "chathub::auth", "no session to resume"),
                    Err(e)      => tracing::warn!(target: "chathub::auth", error = %e, "try_resume_session failed"),
                }
            });
```

替换为:

```rust
            // 启动时 try_resume(后台 task,不阻塞 setup);成功后启动 ConnectionManager
            let api_for_resume = Arc::clone(&auth_api);
            let cm_for_resume = Arc::clone(&conn_manager);
            tauri::async_runtime::spawn(async move {
                match api_for_resume.try_resume_session().await {
                    Ok(Some(p)) => {
                        info!(target: "chathub::auth", user_id = %p.user_id, "resumed session");
                        cm_for_resume.start().await;
                    }
                    Ok(None)    => info!(target: "chathub::auth", "no session to resume"),
                    Err(e)      => tracing::warn!(target: "chathub::auth", error = %e, "try_resume_session failed"),
                }
            });
```

- [ ] **Step 19.5: 修改 Plan 2 的 `login` / `logout` 命令,串 cm.start/stop**

把 lib.rs 中:

```rust
#[tauri::command]
async fn login(
    state: State<'_, Arc<AuthApi>>,
    username: String,
    password: String,
) -> Result<UserProfile, AuthError> {
    state.login(&username, &password).await
}

#[tauri::command]
async fn logout(state: State<'_, Arc<AuthApi>>) -> Result<(), AuthError> {
    state.logout().await
}
```

替换为:

```rust
#[tauri::command]
async fn login(
    state: State<'_, Arc<AuthApi>>,
    cm: State<'_, Arc<ConnectionManager>>,
    username: String,
    password: String,
) -> Result<UserProfile, AuthError> {
    let profile = state.login(&username, &password).await?;
    cm.start().await;
    Ok(profile)
}

#[tauri::command]
async fn logout(
    state: State<'_, Arc<AuthApi>>,
    cm: State<'_, Arc<ConnectionManager>>,
) -> Result<(), AuthError> {
    cm.stop().await;
    state.logout().await
}
```

- [ ] **Step 19.6: 在 `current_session` 命令之后加新命令 `send_message` + `hub_state`**

```rust
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
            reply_to: None,
            mentions: vec![],
        }),
    };
    hub.send(req).await
}

#[tauri::command]
async fn hub_state(cm: State<'_, Arc<ConnectionManager>>) -> ConnectionState {
    cm.state_subscribe().borrow().clone()
}
```

- [ ] **Step 19.7: 在 `invoke_handler` 注册新命令**

```rust
        .invoke_handler(tauri::generate_handler![
            greet, take_screenshot,
            login, logout, current_session,
            send_message, hub_state,
        ])
```

- [ ] **Step 19.8: 编译 backends**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo build -p chathub
```

Expected: 编译过。如有 error 通常是 import 漏了 — 检查 use 段。

- [ ] **Step 19.9: 跑 workspace 测试**

```bash
cargo test --workspace
```

Expected: 全部过。

- [ ] **Step 19.10: clippy**

```bash
cargo clippy --workspace -- -D warnings
```

Expected: 0 warning。

- [ ] **Step 19.11: 提交**

```bash
git add backends/Cargo.toml backends/src/lib.rs Cargo.lock
git commit -m "$(cat <<'EOF'
feat(backends): wire ConnectionManager + send_message/hub_state commands

- backends/Cargo.toml: + uuid (workspace)
- setup:同时拼装 auth_api / hub_client / conn_manager,manage 三个 state
- login: 成功后调 cm.start()
- logout: 先 cm.stop() 再 auth.logout()
- try_resume_session 复活成功后调 cm.start()
- 新命令 send_message:client_msg_id = UUIDv4 由 backends 生成
- 新命令 hub_state:借 watch::Receiver::borrow().clone() 同步返回当前态
- 桥接 task(hub:event/hub:connection)留 Task 20
EOF
)"
```

---

## Task 20: backends 桥接 task + KICKED→logout + Lagged 节流

**Files:**

- Modify: `backends/src/lib.rs`(加 spawn_hub_event_bridge / spawn_hub_connection_bridge)

为什么:把 ConnectionManager 的 broadcast<ServerEvent> 与 watch<ConnectionState> 桥接成 Tauri 事件 `hub:event` / `hub:connection`,前端 listen。同时识别 SystemSignal::KICKED 调 `auth_api.logout()`,实现 spec §8.3 / §8.4 / §11 #1 的全部要求。

- [ ] **Step 20.1: 在 `backends/src/lib.rs` 顶部 imports 段补**

加入:

```rust
use std::time::{Duration, Instant};
use tokio::sync::broadcast as tokio_broadcast;
```

(`broadcast::error::RecvError` 用 `tokio::sync::broadcast::error::RecvError`。)

- [ ] **Step 20.2: 在 setup 闭包中,LoggedOut 桥接(Plan 2 已有)之后,追加两个新桥接**

把 lib.rs 中 setup 闭包内的 LoggedOut 桥接(`let mut rx = auth_api.logged_out_subscribe();` 那段)之后插入:

```rust
            // ---- Plan 3:hub:event 桥接(broadcast<ServerEvent> → app.emit) ----
            let cm_for_event = Arc::clone(&conn_manager);
            let auth_for_kicked = Arc::clone(&auth_api);
            let app_for_hub_event = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                let mut rx = cm_for_event.event_subscribe();
                let last_lag_reconnect: Arc<tokio::sync::Mutex<Option<Instant>>> =
                    Arc::new(tokio::sync::Mutex::new(None));
                loop {
                    match rx.recv().await {
                        Ok(event) => {
                            // 检查是否是 KICKED:在 emit 前先抓住 enum 信息
                            let is_kicked = matches!(
                                &event.body,
                                Some(server_event::Body::System(s))
                                    if s.kind == system_signal::Kind::Kicked as i32
                            );
                            let _ = app_for_hub_event.emit("hub:event", &event);
                            if is_kicked {
                                tracing::warn!(target: "chathub::hub", "KICKED received, logging out");
                                let _ = auth_for_kicked.logout().await;
                                let _ = app_for_hub_event.emit(
                                    "auth:logged_out",
                                    serde_json::json!({ "reason": "kicked" }),
                                );
                            }
                        }
                        Err(tokio_broadcast::error::RecvError::Lagged(n)) => {
                            let mut last = last_lag_reconnect.lock().await;
                            let now = Instant::now();
                            if last.map_or(true, |t| now.duration_since(t) > Duration::from_secs(5)) {
                                tracing::warn!(target: "chathub::hub", skipped = n, "hub event lag, requesting reconnect");
                                cm_for_event.stop().await;
                                cm_for_event.start().await;
                                *last = Some(now);
                            } else {
                                tracing::warn!(target: "chathub::hub", skipped = n, "hub event lag throttled");
                            }
                        }
                        Err(tokio_broadcast::error::RecvError::Closed) => break,
                    }
                }
            });

            // ---- Plan 3:hub:connection 桥接(watch<ConnectionState> → app.emit) ----
            let cm_for_state = Arc::clone(&conn_manager);
            let app_for_state = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                let mut rx = cm_for_state.state_subscribe();
                // 主动 emit 一次初始态(watch::Receiver::changed 不会 fire 第一次值)
                let _ = app_for_state.emit("hub:connection", &*rx.borrow());
                while rx.changed().await.is_ok() {
                    let s = rx.borrow().clone();
                    let _ = app_for_state.emit("hub:connection", &s);
                }
            });
```

- [ ] **Step 20.3: 编译 backends**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo build -p chathub
```

Expected: 编译过。

- [ ] **Step 20.4: 跑 workspace 测试**

```bash
cargo test --workspace
```

Expected: 全部过。

- [ ] **Step 20.5: clippy**

```bash
cargo clippy --workspace -- -D warnings
```

Expected: 0 warning。

- [ ] **Step 20.6: 提交**

```bash
git add backends/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(backends): hub:event + hub:connection bridges + KICKED→logout

- hub:event 桥接 task:broadcast<ServerEvent> → app.emit("hub:event", &event)
  · 识别 SystemSignal::KICKED → auth.logout() + emit auth:logged_out{reason:"kicked"}
  · Lagged 错误:5s 节流 cm.stop() + cm.start() 触发重连补漏(via since_seqs)
  · Closed 错误:break 退出 task(进程关闭路径)
- hub:connection 桥接 task:watch<ConnectionState> → app.emit("hub:connection", &state)
  · 主动 emit 一次初始态(watch::Receiver::changed 不 fire 首值)
  · while changed().await.is_ok(),每次 state 变都 emit
EOF
)"
```

---

## Task 21: 全套验证 + DOD 验收

**Files:**

- 无文件修改;只跑命令 + 检查

为什么:对照 spec §10 的 DOD 8 项逐一验证。任何一项不过,**STOP** 并回查 — 不要伪装"差不多就行"。

- [ ] **Step 21.1: cargo build --workspace**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo build --workspace
```

Expected: 全绿,无 warning。

- [ ] **Step 21.2: cargo test -p chathub-proto**

```bash
cargo test -p chathub-proto
```

Expected: 6 个测试全过(原 4 + Plan 3 加的 2)。**DOD #1 满足。**

- [ ] **Step 21.3: cargo test -p chathub-state**

```bash
cargo test -p chathub-state
```

Expected: 12 个测试全过。**DOD #2 满足。**

- [ ] **Step 21.4: cargo test -p chathub-net --lib**

```bash
cargo test -p chathub-net --lib
```

Expected: hub:: 12(3 backoff + 4 connection_state + 5 classify)+ Plan 2 现有单元测试 ≥ 8(error.rs 5 + token.rs 7 等)= 至少 20 个全过。**DOD #3 满足。**

- [ ] **Step 21.5: cargo test -p chathub-net --test hub_e2e**

```bash
cargo test -p chathub-net --test hub_e2e -- --test-threads=1
```

Expected: 10 个测试全过(spec §9.2 9 个场景 + 1 个 connection_state_initial_is_disconnected)。**DOD #4 满足(9 e2e 场景全覆盖)。**

- [ ] **Step 21.6: cargo test -p chathub-net --test auth_e2e**

```bash
cargo test -p chathub-net --test auth_e2e -- --test-threads=1
```

Expected: 7 个测试全过(Plan 2 不破)。**DOD #5 满足。**

- [ ] **Step 21.7: cargo build -p chathub(backends 含命令 + 桥接)**

```bash
cargo build -p chathub
```

Expected: 全绿。**DOD #6 满足。**

- [ ] **Step 21.8: cargo clippy --workspace -- -D warnings**

```bash
cargo clippy --workspace -- -D warnings
```

Expected: 0 warning。**DOD #7 满足。**

- [ ] **Step 21.9: 检查 Cargo.lock diff 仅含合理变化**

```bash
git diff main -- Cargo.lock | head -100
```

Expected: 只看到 `+ uuid` 在 backends 启用相关、新增的 `rand` 0.8 与依赖、其它 diff 应来自 Plan 2 已经引入但 lockfile 已有的。无重大版本回退。**DOD #8 满足。**

- [ ] **Step 21.10: 验证 hub_e2e 9 个场景与 spec §9.2 一一对应(人工 review)**

```bash
grep -nE '^#\[tokio::test\]' backends/crates/chathub-net/tests/hub_e2e.rs
```

Expected:看到 10 个 `#[tokio::test]`(spec §9.2 9 个场景 + 1 个初始态烟雾)。逐个核对名字:

| 测试名                                             | spec §9.2 场景              |
| -------------------------------------------------- | --------------------------- |
| `connection_state_initial_is_disconnected`         | (Task 11 烟雾,非 spec 场景) |
| `subscribe_success_streams_event`                  | #1                          |
| `subscribe_unavailable_backoffs_and_reconnects`    | #4                          |
| `subscribe_unauthenticated_triggers_force_refresh` | #3                          |
| `subscribe_upgrade_required_terminates`            | #5                          |
| `logged_out_during_subscribe_terminates_task`      | #6                          |
| `subscribe_resumes_with_since_seqs`                | #2                          |
| `subscribe_kicked_emits_event_then_terminates`     | #7                          |
| `send_success_returns_server_msg_id`               | #8                          |
| `send_unavailable_returns_network_error`           | #9                          |

10 个全到位。

- [ ] **Step 21.11: 总结 commit(可选 —— 大多数 task 已 commit,本步只是确认无未提交改动)**

```bash
git status
```

Expected: `nothing to commit, working tree clean`。如有未提交文件,审查并 commit 或 stash。

- [ ] **Step 21.12: 列出本 plan 的全部 commit**

```bash
git log --oneline main..HEAD
```

Expected: 看到 ~21 个 commit,从 Task 1 (proto) 到 Task 20 (桥接)。每个 commit 对应一个 task。

---

## Self-Review Checklist(本计划完整性)

执行完最后一个 task 后,对照 spec 的 §10 DOD 逐项打勾:

- [ ] **DOD #1** proto 加 Send + IncomingMsg + SystemSignal — Task 1 + 2
- [ ] **DOD #2** chathub-state V2 migration + SeqStore + 12 测试绿 — Task 3
- [ ] **DOD #3** chathub-net hub.rs(HubClient + ConnectionManager + ExponentialBackoff + classify)+ 单元测试 ≥ 20 — Task 4-9 + Task 11(skeleton)+ Task 17(stream-Err 分流)
- [ ] **DOD #4** 9 个 e2e 全绿 — Task 11(烟雾)+ Task 12(#1)+ Task 13(#4)+ Task 14(#3)+ Task 15(#5)+ Task 16(#6)+ Task 17(#2 + #7)+ Task 18(#8 + #9)
- [ ] **DOD #5** Plan 2 的 7 个 auth e2e 不破 — Task 10(start_stub 转调)+ 每 task 跑一次 auth_e2e 验证
- [ ] **DOD #6** backends 加 send_message + hub_state + 桥接 + KICKED→logout — Task 19 + 20
- [ ] **DOD #7** clippy 全绿 — 每 task 末尾跑 + Task 21.8
- [ ] **DOD #8** Cargo.lock diff 合理 — Task 21.9

如有任何项未通过,**回查对应 task** 修复后重新跑 cargo test --workspace + clippy。

---

## 与 Plan 4+ 的连接点(本 plan 已为后续做的铺垫)

落地后:

- `proto/chathub/v1/{event,hub}.proto`:Plan 4 加 RPC(Recall/AckRead/FetchHistory)与 ServerEvent kind(MessageRecalled/ReadReceipt/AccountStatus/PresenceChange/MessageStatusChange)是 wire-compat 的(只增不删)
- `HubClient::send` / `HubClient::subscribe` 签名稳定;Plan 4 加 `recall/ack_read/fetch_history` 在同一 struct 上加 method
- `ConnectionManager` 公共 API(`new/start/stop/state_subscribe/event_subscribe`)稳定;Plan 6 加可靠性增强是 ConnectionManager 内部演化
- `SeqStore` 公共 API 稳定;V3 migration 可加列不删 V2 列
- `BackoffConfig::default()` 数值即生产值,改需 SemVer major bump
- backends 命令 `send_message / hub_state` 签名稳定;Plan 4 加新命令(如 `recall_message`)在 invoke_handler 末尾追加

---

End of plan.
