# 消息页本地持久化 + 水位 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给消息页单会话消息流增加本地 SQLite 持久化缓存,实现切会话秒开 / 离线可读 / 减少重复拉取,并为推送落地备好 ingest 接口。

**Architecture:** Rust `chathub-state` 新增 `MessagesStore`(两张表:消息行 + 每会话连续性"水位"行);`chathub-net` 新增 `MessageSync` 编排"缓存优先 + 后台重对齐"(单连续窗口,缝合则扩、遇洞则丢旧重置);Tauri 命令缓存优先返回 + 后台 spawn 重对齐,经既有 `hub:change` 总线通知前端;前端 `useMessageHistory` 改为缓存优先 + 订阅总线(stale-while-revalidate)。

**Tech Stack:** Rust(rusqlite / deadpool-sqlite / rusqlite_migration / tokio broadcast / tonic)、Tauri 命令、React + TypeScript(既有 ChangeBus)。

**设计依据:** `docs/superpowers/specs/2026-05-20-message-persistence-design.md`

**关键命名(跨任务保持一致):**

- 迁移:`V13__conversation_messages.sql`,表 `hub_conversation_messages` / `hub_conversation_message_window`
- Store:`chathub-state/src/messages.rs` → `MessagesStore`、`MessageRow`、`MessageWindow`、常量 `MESSAGE_HOT_CONVERSATIONS_LIMIT`
- 编排:`chathub-net/src/message_sync.rs` → `MessageSync`、`ReconcileMode`、`classify_reconcile`、`history_to_row`、`row_to_history`
- ChangeTopic:Rust `ConversationMessages`(序列化 `"conversation-messages"`)、TS union 同名
- 命令:`load_conversation_messages`、`load_older_messages`

---

## Phase 1 — 迁移 + MessagesStore(纯本地,可独立测试)

### Task 1: V13 迁移建表

**Files:**

- Create: `backends/crates/chathub-state/migrations/V13__conversation_messages.sql`
- Modify: `backends/crates/chathub-state/src/pool.rs:44-57`(迁移列表)、`:90-107`(表计数测试)

- [ ] **Step 1: 写迁移 SQL**

Create `backends/crates/chathub-state/migrations/V13__conversation_messages.sql`:

```sql
-- V13__conversation_messages.sql — 消息页单会话消息流本地持久化
--
-- 两张表:
--   hub_conversation_messages        消息行(日志本体),local_message_id 为 PK
--   hub_conversation_message_window  每会话一行,即"连续性水位"
--                                    (newest/oldest_sort_key + older_cursor + has_more_older)
--
-- 与 hub_recent_session_watermark(推送流 notify_seq)正交:那个管"事件处理到第几条",
-- 本表 window 管"本地这段缓存覆盖哪到哪、能否继续往老翻"。
-- 设计见 docs/superpowers/specs/2026-05-20-message-persistence-design.md
CREATE TABLE hub_conversation_messages (
    local_message_id   TEXT    NOT NULL PRIMARY KEY,
    conversation_id    TEXT    NOT NULL,
    employee_id        TEXT    NOT NULL,
    wecom_account_id   TEXT    NOT NULL DEFAULT '',
    sort_key           TEXT    NOT NULL DEFAULT '',
    message_time_ms    INTEGER NOT NULL DEFAULT 0,
    message_direction  INTEGER NOT NULL DEFAULT 0,
    message_type       INTEGER NOT NULL DEFAULT 0,
    content_text       TEXT    NOT NULL DEFAULT '',
    send_status        INTEGER NOT NULL DEFAULT 0,
    attachments_json   TEXT    NOT NULL DEFAULT '[]',
    gmt_modified_time  TEXT    NOT NULL DEFAULT '',
    updated_at_ms      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_hub_msgs_conv_sort
    ON hub_conversation_messages (conversation_id, sort_key);
CREATE INDEX idx_hub_msgs_employee
    ON hub_conversation_messages (employee_id);

CREATE TABLE hub_conversation_message_window (
    conversation_id   TEXT    NOT NULL PRIMARY KEY,
    employee_id       TEXT    NOT NULL,
    wecom_account_id  TEXT    NOT NULL DEFAULT '',
    external_user_id  TEXT    NOT NULL DEFAULT '',
    newest_sort_key   TEXT    NOT NULL DEFAULT '',
    oldest_sort_key   TEXT    NOT NULL DEFAULT '',
    older_cursor      TEXT    NOT NULL DEFAULT '',
    has_more_older    INTEGER NOT NULL DEFAULT 0,
    last_accessed_ms  INTEGER NOT NULL DEFAULT 0,
    reconciled_at_ms  INTEGER NOT NULL DEFAULT 0,
    updated_at_ms     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_hub_msg_window_employee
    ON hub_conversation_message_window (employee_id);
```

- [ ] **Step 2: 注册迁移**

In `backends/crates/chathub-state/src/pool.rs`, add after the V12 line (currently line 56):

```rust
                M::up(include_str!("../migrations/V12__recents_muted.sql")),
                M::up(include_str!("../migrations/V13__conversation_messages.sql")),
            ]);
```

- [ ] **Step 3: 更新表计数测试**

In `backends/crates/chathub-state/src/pool.rs`, update `in_memory_pool_applies_all_migrations`: add the two new table names to the `IN (...)` list and change the expected count from `10` to `12`:

```rust
                c.query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN (\
                   'hub_current_session', 'hub_wecom_accounts', 'hub_wecom_account_watermark', \
                   'hub_secrets', 'hub_settings', \
                   'hub_wecom_friends', 'hub_wecom_friend_sync_state', 'hub_wecom_friend_watermark', \
                   'hub_conversation_recents', 'hub_recent_session_watermark', \
                   'hub_conversation_messages', 'hub_conversation_message_window'\
                 )",
                    [],
                    |r| r.get(0),
                )
```

```rust
        assert_eq!(
            table_count, 12,
            "V1-V13 跑完应剩 12 张 hub_ 前缀业务表"
        );
```

- [ ] **Step 4: 跑迁移测试**

Run: `cd backends && cargo test -p chathub-state pool::tests -- --nocapture`
Expected: PASS（`in_memory_pool_applies_all_migrations` + `in_memory_pool_supports_repeated_open`）。

- [ ] **Step 5: Commit**

```bash
git add backends/crates/chathub-state/migrations/V13__conversation_messages.sql backends/crates/chathub-state/src/pool.rs
git commit -m "feat(messages): V13 迁移建消息行 + 连续性水位表"
```

---

### Task 2: MessagesStore 类型 + 行读写

**Files:**

- Create: `backends/crates/chathub-state/src/messages.rs`
- Modify: `backends/crates/chathub-state/src/lib.rs:16-35`（模块声明 + 导出）

- [ ] **Step 1: 建模块骨架 + 类型 + 失败测试**

Create `backends/crates/chathub-state/src/messages.rs`:

```rust
//! MessagesStore:消息页单会话消息流的本地持久化。
//!
//! 两张表(见 V13 迁移):
//!   - `hub_conversation_messages`:消息行,`local_message_id` PK。
//!     UPSERT 只刷可变列(send_status / content / attachments / gmt_modified),
//!     位置列(sort_key / message_time_ms / 方向 / 类型)不动。
//!   - `hub_conversation_message_window`:每会话一行 = 连续性"水位"。
//!     `[oldest_sort_key, newest_sort_key] + older_cursor + has_more_older` 完整描述
//!     单连续窗口(详见 spec §4)。
//!
//! 所有读写都 `WHERE employee_id = ?` 兜底(防御性多员工隔离,抄 recent_sessions 纪律)。

use crate::error::StateError;
use crate::pool::SqlitePool;
use serde::{Deserialize, Serialize};

/// per-employee 热会话数上限。超出按 last_accessed_ms 整会话 LRU 淘汰(不切单会话尾)。
pub const MESSAGE_HOT_CONVERSATIONS_LIMIT: usize = 40;

/// 单条缓存消息行。JSON camelCase 直接喂前端。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRow {
    pub local_message_id: String,
    pub conversation_id: String,
    pub employee_id: String,
    pub wecom_account_id: String,
    pub sort_key: String,
    pub message_time_ms: i64,
    pub message_direction: i32,
    pub message_type: i32,
    pub content_text: String,
    pub send_status: i32,
    /// 附件元数据 JSON 数组串(不下载二进制)。
    pub attachments_json: String,
    pub gmt_modified_time: String,
    pub updated_at_ms: i64,
}

/// 每会话连续性水位行。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageWindow {
    pub conversation_id: String,
    pub employee_id: String,
    pub wecom_account_id: String,
    pub external_user_id: String,
    pub newest_sort_key: String,
    pub oldest_sort_key: String,
    pub older_cursor: String,
    pub has_more_older: bool,
    pub last_accessed_ms: i64,
    pub reconciled_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Clone)]
pub struct MessagesStore {
    pool: SqlitePool,
}

impl MessagesStore {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

pub(crate) fn now_unix_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_row(conv: &str, lid: &str, sk: &str, ts: i64) -> MessageRow {
        MessageRow {
            local_message_id: lid.into(),
            conversation_id: conv.into(),
            employee_id: "u-1".into(),
            wecom_account_id: "wa-1".into(),
            sort_key: sk.into(),
            message_time_ms: ts,
            message_direction: 1,
            message_type: 1,
            content_text: "hi".into(),
            send_status: 3,
            attachments_json: "[]".into(),
            gmt_modified_time: "".into(),
            updated_at_ms: 0,
        }
    }

    #[tokio::test]
    async fn upsert_then_list_recent_desc() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = MessagesStore::new(pool);
        store
            .upsert_messages(&[
                sample_row("c1", "m1", "sort_0001", 100),
                sample_row("c1", "m2", "sort_0002", 200),
                sample_row("c1", "m3", "sort_0003", 300),
            ])
            .await
            .unwrap();
        // list_recent 返回 newest→oldest(server 同序),limit 截断保留最新
        let got = store.list_recent("u-1", "c1", 2).await.unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].local_message_id, "m3");
        assert_eq!(got[1].local_message_id, "m2");
    }
}
```

In `backends/crates/chathub-state/src/lib.rs`, add module + exports:

```rust
pub mod messages;
```

（放在 `pub mod local_token;` 之后，按字母序在 `pub mod notify_seq;` 之前亦可。）

```rust
pub use messages::{MessageRow, MessageWindow, MessagesStore, MESSAGE_HOT_CONVERSATIONS_LIMIT};
```

（放在 `pub use local_token::LocalTokenStore;` 之后。）

- [ ] **Step 2: 跑测试看失败**

Run: `cd backends && cargo test -p chathub-state messages::tests::upsert_then_list_recent_desc`
Expected: 编译失败 / FAIL — `upsert_messages` / `list_recent` 未定义。

- [ ] **Step 3: 实现 upsert_messages + list_recent**

In `messages.rs`, add inside `impl MessagesStore`:

```rust
    /// 批量 UPSERT 消息行。`ON CONFLICT(local_message_id)` 只刷可变列
    /// (send_status / content_text / attachments_json / gmt_modified_time / updated_at_ms);
    /// 位置列(sort_key / message_time_ms / 方向 / 类型)与 employee/account/conversation 不动。
    pub async fn upsert_messages(&self, rows: &[MessageRow]) -> Result<(), StateError> {
        if rows.is_empty() {
            return Ok(());
        }
        let rows = rows.to_vec();
        let now = now_unix_ms();
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            let tx = c.transaction()?;
            for r in &rows {
                tx.execute(
                    "INSERT INTO hub_conversation_messages ( \
                       local_message_id, conversation_id, employee_id, wecom_account_id, sort_key, \
                       message_time_ms, message_direction, message_type, content_text, send_status, \
                       attachments_json, gmt_modified_time, updated_at_ms \
                     ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13) \
                     ON CONFLICT(local_message_id) DO UPDATE SET \
                       content_text      = excluded.content_text, \
                       send_status       = excluded.send_status, \
                       attachments_json  = excluded.attachments_json, \
                       gmt_modified_time = excluded.gmt_modified_time, \
                       updated_at_ms     = excluded.updated_at_ms",
                    rusqlite::params![
                        r.local_message_id, r.conversation_id, r.employee_id, r.wecom_account_id,
                        r.sort_key, r.message_time_ms, r.message_direction as i64,
                        r.message_type as i64, r.content_text, r.send_status as i64,
                        r.attachments_json, r.gmt_modified_time, now,
                    ],
                )?;
            }
            tx.commit()?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// 读最新 `limit` 条,返回 **newest→oldest**(与 server message/history records 同序,
    /// 前端复用 adaptHistoryRecords 反转成升序)。`employee_id` 强制过滤。
    pub async fn list_recent(
        &self,
        employee_id: &str,
        conversation_id: &str,
        limit: usize,
    ) -> Result<Vec<MessageRow>, StateError> {
        let employee_id = employee_id.to_string();
        let conversation_id = conversation_id.to_string();
        let limit = limit as i64;
        let conn = self.pool.pool().get().await?;
        let rows = conn
            .interact(move |c| -> Result<Vec<MessageRow>, StateError> {
                let mut stmt = c.prepare(
                    "SELECT local_message_id, conversation_id, employee_id, wecom_account_id, sort_key, \
                            message_time_ms, message_direction, message_type, content_text, send_status, \
                            attachments_json, gmt_modified_time, updated_at_ms \
                     FROM hub_conversation_messages \
                     WHERE employee_id = ?1 AND conversation_id = ?2 \
                     ORDER BY sort_key DESC LIMIT ?3",
                )?;
                let rows = stmt
                    .query_map(rusqlite::params![employee_id, conversation_id, limit], map_row)?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .await??;
        Ok(rows)
    }
```

Add the row mapper at module level (after `now_unix_ms` or before tests):

```rust
fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MessageRow> {
    Ok(MessageRow {
        local_message_id: row.get(0)?,
        conversation_id: row.get(1)?,
        employee_id: row.get(2)?,
        wecom_account_id: row.get(3)?,
        sort_key: row.get(4)?,
        message_time_ms: row.get(5)?,
        message_direction: row.get::<_, i64>(6)? as i32,
        message_type: row.get::<_, i64>(7)? as i32,
        content_text: row.get(8)?,
        send_status: row.get::<_, i64>(9)? as i32,
        attachments_json: row.get(10)?,
        gmt_modified_time: row.get(11)?,
        updated_at_ms: row.get(12)?,
    })
}
```

- [ ] **Step 4: 跑测试看通过**

Run: `cd backends && cargo test -p chathub-state messages::tests::upsert_then_list_recent_desc`
Expected: PASS

- [ ] **Step 5: 加 UPSERT 只刷可变列的测试**

In `messages.rs` tests module:

```rust
    #[tokio::test]
    async fn upsert_updates_mutable_keeps_position() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = MessagesStore::new(pool);
        store.upsert_messages(&[sample_row("c1", "m1", "sort_0001", 100)]).await.unwrap();
        // 同 id 再来一次:改 send_status/content,但 sort_key 传一个不同值验证位置不动
        let mut updated = sample_row("c1", "m1", "sort_DIFFERENT", 999);
        updated.send_status = 4;
        updated.content_text = "edited".into();
        store.upsert_messages(&[updated]).await.unwrap();
        let got = store.list_recent("u-1", "c1", 10).await.unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].send_status, 4, "可变列被刷新");
        assert_eq!(got[0].content_text, "edited");
        assert_eq!(got[0].sort_key, "sort_0001", "位置列 sort_key 不动");
        assert_eq!(got[0].message_time_ms, 100, "位置列 message_time_ms 不动");
    }
```

Run: `cd backends && cargo test -p chathub-state messages::tests`
Expected: PASS（两个测试）。

- [ ] **Step 6: Commit**

```bash
git add backends/crates/chathub-state/src/messages.rs backends/crates/chathub-state/src/lib.rs
git commit -m "feat(messages): MessagesStore 行 UPSERT + list_recent"
```

---

### Task 3: 水位行读写（get_window / upsert_window / touch_accessed）

**Files:**

- Modify: `backends/crates/chathub-state/src/messages.rs`

- [ ] **Step 1: 失败测试**

In `messages.rs` tests:

```rust
    fn sample_window(conv: &str) -> MessageWindow {
        MessageWindow {
            conversation_id: conv.into(),
            employee_id: "u-1".into(),
            wecom_account_id: "wa-1".into(),
            external_user_id: "ext-1".into(),
            newest_sort_key: "sort_0003".into(),
            oldest_sort_key: "sort_0001".into(),
            older_cursor: "cur-1".into(),
            has_more_older: true,
            last_accessed_ms: 0,
            reconciled_at_ms: 0,
            updated_at_ms: 0,
        }
    }

    #[tokio::test]
    async fn window_upsert_get_round_trip() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = MessagesStore::new(pool);
        assert!(store.get_window("u-1", "c1").await.unwrap().is_none());
        store.upsert_window(sample_window("c1")).await.unwrap();
        let w = store.get_window("u-1", "c1").await.unwrap().expect("exists");
        assert_eq!(w.newest_sort_key, "sort_0003");
        assert_eq!(w.older_cursor, "cur-1");
        assert!(w.has_more_older);
        // 错员工读不到
        assert!(store.get_window("u-other", "c1").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn touch_accessed_updates_only_existing() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = MessagesStore::new(pool);
        // 不存在 → no-op,不报错
        store.touch_accessed("u-1", "c1", 555).await.unwrap();
        assert!(store.get_window("u-1", "c1").await.unwrap().is_none());
        store.upsert_window(sample_window("c1")).await.unwrap();
        store.touch_accessed("u-1", "c1", 555).await.unwrap();
        let w = store.get_window("u-1", "c1").await.unwrap().unwrap();
        assert_eq!(w.last_accessed_ms, 555);
    }
```

- [ ] **Step 2: 跑测试看失败**

Run: `cd backends && cargo test -p chathub-state messages::tests::window_upsert_get_round_trip`
Expected: 编译失败 — `upsert_window` / `get_window` / `touch_accessed` 未定义。

- [ ] **Step 3: 实现**

In `impl MessagesStore`:

```rust
    /// 整行 UPSERT 水位(boundary 全量替换)。重对齐 / load_older 算好新 window 后调。
    pub async fn upsert_window(&self, w: MessageWindow) -> Result<(), StateError> {
        let now = now_unix_ms();
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            c.execute(
                "INSERT INTO hub_conversation_message_window ( \
                   conversation_id, employee_id, wecom_account_id, external_user_id, \
                   newest_sort_key, oldest_sort_key, older_cursor, has_more_older, \
                   last_accessed_ms, reconciled_at_ms, updated_at_ms \
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11) \
                 ON CONFLICT(conversation_id) DO UPDATE SET \
                   employee_id      = excluded.employee_id, \
                   wecom_account_id = excluded.wecom_account_id, \
                   external_user_id = excluded.external_user_id, \
                   newest_sort_key  = excluded.newest_sort_key, \
                   oldest_sort_key  = excluded.oldest_sort_key, \
                   older_cursor     = excluded.older_cursor, \
                   has_more_older   = excluded.has_more_older, \
                   reconciled_at_ms = excluded.reconciled_at_ms, \
                   updated_at_ms    = excluded.updated_at_ms",
                rusqlite::params![
                    w.conversation_id, w.employee_id, w.wecom_account_id, w.external_user_id,
                    w.newest_sort_key, w.oldest_sort_key, w.older_cursor, w.has_more_older as i64,
                    w.last_accessed_ms, w.reconciled_at_ms, now,
                ],
            )?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// 读水位(employee_id 过滤;不存在返 None)。
    pub async fn get_window(
        &self,
        employee_id: &str,
        conversation_id: &str,
    ) -> Result<Option<MessageWindow>, StateError> {
        let employee_id = employee_id.to_string();
        let conversation_id = conversation_id.to_string();
        let conn = self.pool.pool().get().await?;
        let w = conn
            .interact(move |c| -> Result<Option<MessageWindow>, StateError> {
                let res = c.query_row(
                    "SELECT conversation_id, employee_id, wecom_account_id, external_user_id, \
                            newest_sort_key, oldest_sort_key, older_cursor, has_more_older, \
                            last_accessed_ms, reconciled_at_ms, updated_at_ms \
                     FROM hub_conversation_message_window \
                     WHERE employee_id = ?1 AND conversation_id = ?2",
                    rusqlite::params![employee_id, conversation_id],
                    map_window,
                );
                match res {
                    Ok(w) => Ok(Some(w)),
                    Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                    Err(e) => Err(e.into()),
                }
            })
            .await??;
        Ok(w)
    }

    /// 刷新 last_accessed_ms(行不存在则 no-op)。打开会话时 bump 热度。
    pub async fn touch_accessed(
        &self,
        employee_id: &str,
        conversation_id: &str,
        now_ms: i64,
    ) -> Result<(), StateError> {
        let employee_id = employee_id.to_string();
        let conversation_id = conversation_id.to_string();
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            c.execute(
                "UPDATE hub_conversation_message_window SET last_accessed_ms = ?1 \
                 WHERE employee_id = ?2 AND conversation_id = ?3",
                rusqlite::params![now_ms, employee_id, conversation_id],
            )?;
            Ok(())
        })
        .await??;
        Ok(())
    }
```

Add window mapper at module level:

```rust
fn map_window(row: &rusqlite::Row<'_>) -> rusqlite::Result<MessageWindow> {
    Ok(MessageWindow {
        conversation_id: row.get(0)?,
        employee_id: row.get(1)?,
        wecom_account_id: row.get(2)?,
        external_user_id: row.get(3)?,
        newest_sort_key: row.get(4)?,
        oldest_sort_key: row.get(5)?,
        older_cursor: row.get(6)?,
        has_more_older: row.get::<_, i64>(7)? != 0,
        last_accessed_ms: row.get(8)?,
        reconciled_at_ms: row.get(9)?,
        updated_at_ms: row.get(10)?,
    })
}
```

- [ ] **Step 4: 跑测试看通过**

Run: `cd backends && cargo test -p chathub-state messages::tests`
Expected: PASS（4 个测试）。

- [ ] **Step 5: Commit**

```bash
git add backends/crates/chathub-state/src/messages.rs
git commit -m "feat(messages): 水位行 get/upsert/touch"
```

---

### Task 4: 删会话 + LRU 淘汰 + clear_for_employee

**Files:**

- Modify: `backends/crates/chathub-state/src/messages.rs`

- [ ] **Step 1: 失败测试**

In `messages.rs` tests:

```rust
    #[tokio::test]
    async fn delete_conversation_drops_rows_and_window() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = MessagesStore::new(pool);
        store.upsert_messages(&[sample_row("c1", "m1", "sort_0001", 100)]).await.unwrap();
        store.upsert_window(sample_window("c1")).await.unwrap();
        store.delete_conversation("u-1", "c1").await.unwrap();
        assert!(store.list_recent("u-1", "c1", 10).await.unwrap().is_empty());
        assert!(store.get_window("u-1", "c1").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn trim_conversations_evicts_coldest_whole() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = MessagesStore::new(pool);
        // 3 个会话,各 1 条消息 + window;last_accessed: c1=10 c2=20 c3=30
        for (conv, acc) in [("c1", 10i64), ("c2", 20), ("c3", 30)] {
            store.upsert_messages(&[sample_row(conv, &format!("{conv}-m"), "sort_0001", 100)]).await.unwrap();
            let mut w = sample_window(conv);
            w.last_accessed_ms = acc;
            store.upsert_window(w).await.unwrap();
        }
        // 限 2 → 删最冷的 c1(整会话:消息 + window)
        store.trim_conversations("u-1", 2).await.unwrap();
        assert!(store.get_window("u-1", "c1").await.unwrap().is_none());
        assert!(store.list_recent("u-1", "c1", 10).await.unwrap().is_empty());
        assert!(store.get_window("u-1", "c2").await.unwrap().is_some());
        assert!(store.get_window("u-1", "c3").await.unwrap().is_some());
    }

    #[tokio::test]
    async fn clear_for_employee_isolates() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = MessagesStore::new(pool);
        let mut other = sample_row("cB", "mB", "sort_0001", 100);
        other.employee_id = "u-2".into();
        store.upsert_messages(&[sample_row("cA", "mA", "sort_0001", 100), other]).await.unwrap();
        store.clear_for_employee("u-1").await.unwrap();
        assert!(store.list_recent("u-1", "cA", 10).await.unwrap().is_empty());
        assert_eq!(store.list_recent("u-2", "cB", 10).await.unwrap().len(), 1);
    }
```

- [ ] **Step 2: 跑测试看失败**

Run: `cd backends && cargo test -p chathub-state messages::tests::delete_conversation_drops_rows_and_window`
Expected: 编译失败 — 方法未定义。

- [ ] **Step 3: 实现**

In `impl MessagesStore`:

```rust
    /// 删除某会话的全部消息行 + 水位行(遇洞丢旧 / LRU 淘汰共用)。employee_id 过滤防越权。
    pub async fn delete_conversation(
        &self,
        employee_id: &str,
        conversation_id: &str,
    ) -> Result<(), StateError> {
        let employee_id = employee_id.to_string();
        let conversation_id = conversation_id.to_string();
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            let tx = c.transaction()?;
            tx.execute(
                "DELETE FROM hub_conversation_messages WHERE employee_id = ?1 AND conversation_id = ?2",
                rusqlite::params![employee_id, conversation_id],
            )?;
            tx.execute(
                "DELETE FROM hub_conversation_message_window WHERE employee_id = ?1 AND conversation_id = ?2",
                rusqlite::params![employee_id, conversation_id],
            )?;
            tx.commit()?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// 整会话 LRU:per-employee 保留 last_accessed_ms 最大的 `max` 个会话,其余整会话删
    /// (消息 + window)。不切单会话尾(方案 A)。
    pub async fn trim_conversations(
        &self,
        employee_id: &str,
        max: usize,
    ) -> Result<(), StateError> {
        let employee_id = employee_id.to_string();
        let max = max as i64;
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            let tx = c.transaction()?;
            // 待删会话:按 last_accessed_ms DESC 排序后 OFFSET max 之外的。
            let victims: Vec<String> = {
                let mut stmt = tx.prepare(
                    "SELECT conversation_id FROM hub_conversation_message_window \
                     WHERE employee_id = ?1 \
                     ORDER BY last_accessed_ms DESC LIMIT -1 OFFSET ?2",
                )?;
                let v = stmt
                    .query_map(rusqlite::params![employee_id, max], |r| r.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                v
            };
            for conv in &victims {
                tx.execute(
                    "DELETE FROM hub_conversation_messages WHERE employee_id = ?1 AND conversation_id = ?2",
                    rusqlite::params![employee_id, conv],
                )?;
                tx.execute(
                    "DELETE FROM hub_conversation_message_window WHERE employee_id = ?1 AND conversation_id = ?2",
                    rusqlite::params![employee_id, conv],
                )?;
            }
            tx.commit()?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// 登出 / 切员工:删该 employee 的全部消息行 + 水位行。
    pub async fn clear_for_employee(&self, employee_id: &str) -> Result<(), StateError> {
        let employee_id = employee_id.to_string();
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            let tx = c.transaction()?;
            tx.execute(
                "DELETE FROM hub_conversation_messages WHERE employee_id = ?1",
                rusqlite::params![employee_id],
            )?;
            tx.execute(
                "DELETE FROM hub_conversation_message_window WHERE employee_id = ?1",
                rusqlite::params![employee_id],
            )?;
            tx.commit()?;
            Ok(())
        })
        .await??;
        Ok(())
    }
```

- [ ] **Step 4: 跑测试看通过**

Run: `cd backends && cargo test -p chathub-state messages::tests`
Expected: PASS（7 个测试）。

- [ ] **Step 5: Commit**

```bash
git add backends/crates/chathub-state/src/messages.rs
git commit -m "feat(messages): 删会话 + 整会话 LRU + clear_for_employee"
```

---

## Phase 2 — 重对齐编排 + Tauri 命令 + 接线

### Task 5: ChangeTopic 新增 ConversationMessages（Rust + TS）

**Files:**

- Modify: `backends/crates/chathub-net/src/change_notice.rs:24-28`
- Modify: `frontends/lib/data/types.ts:5`

- [ ] **Step 1: Rust 加枚举值 + 序列化测试**

In `change_notice.rs`, extend `ChangeTopic`:

```rust
pub enum ChangeTopic {
    Accounts,
    Friends,
    RecentSessions,
    ConversationMessages,
}
```

Add to the tests module:

```rust
    #[test]
    fn serialize_conversation_messages_topic() {
        let n = ChangeNotice::server_upsert(
            ChangeTopic::ConversationMessages,
            ChangeScope {
                employee_id: "u-1".into(),
                conversation_id: Some("c1".into()),
                ..Default::default()
            },
        );
        let json = serde_json::to_string(&n).unwrap();
        assert!(json.contains("\"topic\":\"conversation-messages\""));
        assert!(json.contains("\"conversationId\":\"c1\""));
    }
```

- [ ] **Step 2: 跑测试**

Run: `cd backends && cargo test -p chathub-net change_notice::tests`
Expected: PASS

- [ ] **Step 3: TS union 同步**

In `frontends/lib/data/types.ts:5`:

```ts
export type ChangeTopic = "accounts" | "friends" | "recent-sessions" | "conversation-messages";
```

- [ ] **Step 4: Commit**

```bash
git add backends/crates/chathub-net/src/change_notice.rs frontends/lib/data/types.ts
git commit -m "feat(messages): ChangeTopic 增 conversation-messages"
```

---

### Task 6: classify_reconcile 纯函数 + 映射

**Files:**

- Create: `backends/crates/chathub-net/src/message_sync.rs`
- Modify: `backends/crates/chathub-net/src/lib.rs`（模块声明 + 导出）

- [ ] **Step 1: 建模块 + classify + 映射 + 失败测试**

Create `backends/crates/chathub-net/src/message_sync.rs`:

```rust
//! MessageSync:消息页"缓存优先 + 后台重对齐"编排(单连续窗口,缝合则扩、遇洞则丢旧)。
//!
//! 与 recent_session_event.rs 同构:持有 store + hub + change_notice_tx。
//! 设计见 docs/superpowers/specs/2026-05-20-message-persistence-design.md §4-§5。

use crate::change_notice::{ChangeNotice, ChangeScope, ChangeTopic};
use crate::error::AuthError;
use crate::hub::{FetchMessageHistoryRequest, HistoryAttachment, HistoryMessage, HubClient};
use chathub_state::{MessageRow, MessageWindow, MessagesStore, MESSAGE_HOT_CONVERSATIONS_LIMIT};
use tokio::sync::broadcast;
use tracing::warn;

/// 重对齐三态(纯函数判定,见 spec §4.2)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReconcileMode {
    /// 首页空 → 不动缓存(防止瞬时异常清空)。
    NoOp,
    /// 冷启动 / 遇洞 → 丢旧重置:删全部 + 首页落库 + 新 window。
    Replace,
    /// 能缝合 → UPSERT 首页,仅扩 newest 上界。
    Stitch,
}

/// 纯判定:`window` = 现有水位(可空);`page_oldest_sort_key` = 新拉首页里**最老**一条
/// 的 sort_key(server 首页 records 倒序,末条即最老;空页传 None)。
pub fn classify_reconcile(
    window: Option<&MessageWindow>,
    page_oldest_sort_key: Option<&str>,
) -> ReconcileMode {
    let page_oldest = match page_oldest_sort_key {
        Some(s) if !s.is_empty() => s,
        _ => return ReconcileMode::NoOp,
    };
    match window {
        Some(w) if !w.newest_sort_key.is_empty() => {
            // 首页最老 ≤ 缓存最新 → 首页向下够到缓存顶,连续 → 缝合;否则中间有洞 → 丢旧。
            if page_oldest <= w.newest_sort_key.as_str() {
                ReconcileMode::Stitch
            } else {
                ReconcileMode::Replace
            }
        }
        _ => ReconcileMode::Replace,
    }
}

/// `HistoryMessage`(API 形态)→ `MessageRow`(行存)。附件序列化成 JSON 串。
pub fn history_to_row(
    h: &HistoryMessage,
    conversation_id: &str,
    employee_id: &str,
    wecom_account_id: &str,
) -> MessageRow {
    MessageRow {
        local_message_id: h.local_message_id.clone(),
        conversation_id: conversation_id.to_string(),
        employee_id: employee_id.to_string(),
        wecom_account_id: wecom_account_id.to_string(),
        sort_key: h.sort_key.clone(),
        message_time_ms: parse_server_time_to_ms(&h.message_time),
        message_direction: h.message_direction,
        message_type: h.message_type,
        content_text: h.content_text.clone(),
        send_status: h.send_status,
        attachments_json: serde_json::to_string(&h.attachments).unwrap_or_else(|_| "[]".into()),
        gmt_modified_time: h.gmt_modified_time.clone(),
        updated_at_ms: 0,
    }
}

/// `MessageRow`(行存)→ `HistoryMessage`(API 形态;读命令返给前端,复用既有适配器)。
pub fn row_to_history(r: &MessageRow) -> HistoryMessage {
    HistoryMessage {
        local_message_id: r.local_message_id.clone(),
        message_direction: r.message_direction,
        message_type: r.message_type,
        content_text: r.content_text.clone(),
        send_status: r.send_status,
        message_time: String::new(), // 占位:Step 2 换成 ms_to_server_time(r.message_time_ms)
        sort_key: r.sort_key.clone(),
        attachments: serde_json::from_str::<Vec<HistoryAttachment>>(&r.attachments_json)
            .unwrap_or_default(),
        gmt_modified_time: r.gmt_modified_time.clone(),
    }
}

/// "yyyy-MM-dd HH:mm:ss"(服务端本地,假设 UTC+8)→ epoch ms。解析失败返 0。
fn parse_server_time_to_ms(s: &str) -> i64 {
    // 形如 "2026-05-17 10:01:23",定长 19 字节。复用 days_from_civil(见 recent_session_event)。
    if s.len() < 19 {
        return 0;
    }
    let b = s.as_bytes();
    if b[4] != b'-' || b[7] != b'-' || b[10] != b' ' || b[13] != b':' || b[16] != b':' {
        return 0;
    }
    let take = |start: usize, len: usize| -> Option<i64> {
        std::str::from_utf8(&b[start..start + len]).ok()?.parse::<i64>().ok()
    };
    let (y, mo, d, h, mi, se) = match (
        take(0, 4), take(5, 2), take(8, 2), take(11, 2), take(14, 2), take(17, 2),
    ) {
        (Some(y), Some(mo), Some(d), Some(h), Some(mi), Some(se)) => (y, mo, d, h, mi, se),
        _ => return 0,
    };
    if !(1970..=9999).contains(&y) || !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return 0;
    }
    // 服务端 UTC+8:转 UTC 要减 8 小时。
    let utc_ms = crate::message_sync::days_from_civil(y as i32, mo as i32, d as i32) * 86_400_000
        + h * 3_600_000 + mi * 60_000 + se * 1_000
        - 8 * 3_600_000;
    utc_ms
}

/// Howard Hinnant 公历日数(epoch 起天数,可为负)。
fn days_from_civil(y: i32, m: i32, d: i32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as i64;
    let doy = (153 * (m as i64 + if m > 2 { -3 } else { 9 }) + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era as i64 * 146097 + doe - 719468
}

#[cfg(test)]
mod tests {
    use super::*;

    fn win(newest: &str) -> MessageWindow {
        MessageWindow {
            conversation_id: "c1".into(),
            employee_id: "u-1".into(),
            wecom_account_id: "wa-1".into(),
            external_user_id: "ext".into(),
            newest_sort_key: newest.into(),
            oldest_sort_key: "sort_0001".into(),
            older_cursor: "cur".into(),
            has_more_older: true,
            last_accessed_ms: 0,
            reconciled_at_ms: 0,
            updated_at_ms: 0,
        }
    }

    #[test]
    fn classify_no_window_is_replace() {
        assert_eq!(classify_reconcile(None, Some("sort_0009")), ReconcileMode::Replace);
    }

    #[test]
    fn classify_empty_page_is_noop() {
        assert_eq!(classify_reconcile(Some(&win("sort_0005")), None), ReconcileMode::NoOp);
        assert_eq!(classify_reconcile(Some(&win("sort_0005")), Some("")), ReconcileMode::NoOp);
    }

    #[test]
    fn classify_overlap_is_stitch() {
        // 首页最老 sort_0004 ≤ 缓存最新 sort_0005 → 缝合
        assert_eq!(classify_reconcile(Some(&win("sort_0005")), Some("sort_0004")), ReconcileMode::Stitch);
        // 恰好相等也算缝合
        assert_eq!(classify_reconcile(Some(&win("sort_0005")), Some("sort_0005")), ReconcileMode::Stitch);
    }

    #[test]
    fn classify_gap_is_replace() {
        // 首页最老 sort_0008 > 缓存最新 sort_0005 → 有洞 → 丢旧
        assert_eq!(classify_reconcile(Some(&win("sort_0005")), Some("sort_0008")), ReconcileMode::Replace);
    }

    #[test]
    fn parse_server_time_known() {
        // 2026-05-17 10:01:23 (UTC+8) → 减 8h 的 UTC ms
        let got = parse_server_time_to_ms("2026-05-17 10:01:23");
        let expected = days_from_civil(2026, 5, 17) * 86_400_000
            + 10 * 3_600_000 + 1 * 60_000 + 23 * 1_000 - 8 * 3_600_000;
        assert_eq!(got, expected);
    }

    #[test]
    fn parse_server_time_invalid_zero() {
        assert_eq!(parse_server_time_to_ms(""), 0);
        assert_eq!(parse_server_time_to_ms("2026/05/17 10:01:23"), 0);
    }
}
```

> 注意:上面 `row_to_history` 的 `message_time` 字段先写了占位表达式,Step 3 修正。先让结构编译。

In `backends/crates/chathub-net/src/lib.rs`, add module declaration and re-exports (匹配现有 `pub mod` / `pub use` 风格;参考 `recent_session_event` 的导出行):

```rust
pub mod message_sync;
```

```rust
pub use message_sync::{classify_reconcile, history_to_row, row_to_history, MessageSync, ReconcileMode};
```

> `MessageSync` 在 Task 7 定义;本步先只用到 `classify_reconcile` / 映射。若 `pub use` 引用未定义的 `MessageSync` 导致编译失败,本步**先只导出已存在的项**:
>
> ```rust
> pub use message_sync::{classify_reconcile, history_to_row, row_to_history, ReconcileMode};
> ```
>
> Task 7 定义 `MessageSync` 后再补 `MessageSync` 到这行。

- [ ] **Step 2: 修正 row_to_history 的 message_time**

In `message_sync.rs`, replace the placeholder line inside `row_to_history`:

```rust
        message_time: String::new(), // 占位:Step 2 换成 ms_to_server_time(r.message_time_ms)
```

with:

```rust
        message_time: ms_to_server_time(r.message_time_ms),
```

And add the helper at module level:

```rust
/// epoch ms → "yyyy-MM-dd HH:mm:ss"(UTC+8,与 server 形态一致;前端适配器按 +08:00 解析)。
fn ms_to_server_time(ms: i64) -> String {
    if ms <= 0 {
        return String::new();
    }
    let local = ms + 8 * 3_600_000; // 转回 UTC+8 墙钟
    let days = local.div_euclid(86_400_000);
    let rem = local.rem_euclid(86_400_000);
    let (y, mo, d) = civil_from_days(days);
    let h = rem / 3_600_000;
    let mi = (rem % 3_600_000) / 60_000;
    let se = (rem % 60_000) / 1_000;
    format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{se:02}")
}

/// days_from_civil 的逆:epoch 天数 → (year, month, day)。
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}
```

Add a round-trip test in the tests module:

```rust
    #[test]
    fn server_time_round_trip() {
        let ms = parse_server_time_to_ms("2026-05-17 10:01:23");
        assert_eq!(ms_to_server_time(ms), "2026-05-17 10:01:23");
    }
```

- [ ] **Step 3: 跑测试**

Run: `cd backends && cargo test -p chathub-net message_sync::tests`
Expected: PASS（classify 4 个 + 时间 3 个）。

- [ ] **Step 4: Commit**

```bash
git add backends/crates/chathub-net/src/message_sync.rs backends/crates/chathub-net/src/lib.rs
git commit -m "feat(messages): classify_reconcile + History↔Row 映射"
```

---

### Task 7: MessageSync 编排（reconcile_newest / load_older）

**Files:**

- Modify: `backends/crates/chathub-net/src/message_sync.rs`
- Modify: `backends/crates/chathub-net/src/lib.rs`（补 `MessageSync` 导出，若 Task 6 未加）

- [ ] **Step 1: 定义 MessageSync 结构 + 结果类型**

In `message_sync.rs`, add after the mapping functions:

```rust
/// load_older 结果:本次新增的更老消息(newest→oldest)+ 翻完后是否还有更老。
#[derive(Debug, Clone)]
pub struct LoadOlderResult {
    pub records: Vec<HistoryMessage>,
    pub has_more_older: bool,
}

#[derive(Clone)]
pub struct MessageSync {
    store: MessagesStore,
    hub: HubClient,
    change_notice_tx: broadcast::Sender<ChangeNotice>,
}

impl MessageSync {
    pub fn new(
        store: MessagesStore,
        hub: HubClient,
        change_notice_tx: broadcast::Sender<ChangeNotice>,
    ) -> Self {
        Self { store, hub, change_notice_tx }
    }
}
```

> 若 Task 6 Step 1 因 `MessageSync` 未定义而临时缩减了 `pub use`,现在把 `MessageSync` 加回:
> `pub use message_sync::{classify_reconcile, history_to_row, row_to_history, LoadOlderResult, MessageSync, ReconcileMode};`
> （`LoadOlderResult` 也一并导出。）

- [ ] **Step 2: 实现 reconcile_newest**

In `impl MessageSync`:

```rust
    /// 后台重对齐(朝最新方向)。拉首页 → classify → 缝合 / 丢旧重置 → upsert window →
    /// 发 ChangeNotice 让前端重读。`page_size` 建议 20。
    pub async fn reconcile_newest(
        &self,
        conversation_id: &str,
        wecom_account_id: &str,
        external_user_id: &str,
        employee_id: &str,
        page_size: u32,
    ) -> Result<(), AuthError> {
        let resp = self
            .hub
            .fetch_message_history(FetchMessageHistoryRequest {
                size: page_size,
                wecom_account_id: wecom_account_id.to_string(),
                external_user_id: external_user_id.to_string(),
                cursor: String::new(),
                direction: "before".to_string(),
            })
            .await?;

        // server records 倒序(新→旧):first=最新,last=最老。
        let page_newest = resp.records.first().map(|r| r.sort_key.clone());
        let page_oldest = resp.records.last().map(|r| r.sort_key.clone());

        let window = self
            .store
            .get_window(employee_id, conversation_id)
            .await
            .map_err(state_err)?;
        let mode = classify_reconcile(window.as_ref(), page_oldest.as_deref());

        let rows: Vec<MessageRow> = resp
            .records
            .iter()
            .map(|h| history_to_row(h, conversation_id, employee_id, wecom_account_id))
            .collect();

        match mode {
            ReconcileMode::NoOp => return Ok(()),
            ReconcileMode::Replace => {
                self.store
                    .delete_conversation(employee_id, conversation_id)
                    .await
                    .map_err(state_err)?;
                self.store.upsert_messages(&rows).await.map_err(state_err)?;
                let now = now_ms();
                self.store
                    .upsert_window(MessageWindow {
                        conversation_id: conversation_id.to_string(),
                        employee_id: employee_id.to_string(),
                        wecom_account_id: wecom_account_id.to_string(),
                        external_user_id: external_user_id.to_string(),
                        newest_sort_key: page_newest.unwrap_or_default(),
                        oldest_sort_key: page_oldest.unwrap_or_default(),
                        older_cursor: resp.next_cursor.clone(),
                        has_more_older: resp.has_more,
                        last_accessed_ms: now,
                        reconciled_at_ms: now,
                        updated_at_ms: now,
                    })
                    .await
                    .map_err(state_err)?;
            }
            ReconcileMode::Stitch => {
                self.store.upsert_messages(&rows).await.map_err(state_err)?;
                // 只扩 newest 上界,下界 / older_cursor / has_more_older 不动。
                if let (Some(mut w), Some(newest)) = (window, page_newest) {
                    w.newest_sort_key = newest;
                    w.reconciled_at_ms = now_ms();
                    w.last_accessed_ms = now_ms();
                    self.store.upsert_window(w).await.map_err(state_err)?;
                }
            }
        }

        let _ = self.change_notice_tx.send(ChangeNotice::server_upsert(
            ChangeTopic::ConversationMessages,
            ChangeScope {
                employee_id: employee_id.to_string(),
                conversation_id: Some(conversation_id.to_string()),
                ..Default::default()
            },
        ));
        Ok(())
    }
```

Add helpers at module level:

```rust
fn state_err(e: chathub_state::StateError) -> AuthError {
    AuthError::Internal { message: format!("messages store: {e}") }
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}
```

> `chathub_state::StateError` 需要可见:确认 `chathub-state` 已 `pub use error::StateError`(Task 2 已用 `crate::error::StateError`,跨 crate 用 `chathub_state::StateError`)。已在 lib.rs 导出。

- [ ] **Step 3: 实现 load_older**

In `impl MessageSync`:

```rust
    /// 往更老翻一页(同步返回新增)。无 window 或 has_more_older=false → 返回空。
    pub async fn load_older(
        &self,
        conversation_id: &str,
        employee_id: &str,
        page_size: u32,
    ) -> Result<LoadOlderResult, AuthError> {
        let window = match self.store.get_window(employee_id, conversation_id).await.map_err(state_err)? {
            Some(w) if w.has_more_older && !w.older_cursor.is_empty() => w,
            _ => return Ok(LoadOlderResult { records: Vec::new(), has_more_older: false }),
        };
        let resp = self
            .hub
            .fetch_message_history(FetchMessageHistoryRequest {
                size: page_size,
                wecom_account_id: window.wecom_account_id.clone(),
                external_user_id: window.external_user_id.clone(),
                cursor: window.older_cursor.clone(),
                direction: "before".to_string(),
            })
            .await?;
        if resp.records.is_empty() {
            // 服务端没有更老了:仅翻 has_more_older=false。
            let mut w = window;
            w.has_more_older = false;
            w.updated_at_ms = now_ms();
            self.store.upsert_window(w).await.map_err(state_err)?;
            return Ok(LoadOlderResult { records: Vec::new(), has_more_older: false });
        }
        let rows: Vec<MessageRow> = resp
            .records
            .iter()
            .map(|h| history_to_row(h, conversation_id, employee_id, &window.wecom_account_id))
            .collect();
        self.store.upsert_messages(&rows).await.map_err(state_err)?;
        // 推进下界(本页最老 = records.last)+ 游标 + has_more。
        let new_oldest = resp.records.last().map(|r| r.sort_key.clone()).unwrap_or(window.oldest_sort_key.clone());
        let mut w = window;
        w.oldest_sort_key = new_oldest;
        w.older_cursor = resp.next_cursor.clone();
        w.has_more_older = resp.has_more;
        w.updated_at_ms = now_ms();
        self.store.upsert_window(w).await.map_err(state_err)?;
        Ok(LoadOlderResult { records: resp.records, has_more_older: resp.has_more })
    }
```

- [ ] **Step 4: 编译检查**

Run: `cd backends && cargo build -p chathub-net`
Expected: 编译通过（无 warning-as-error）。`message_sync` 既有单测仍 PASS:
`cargo test -p chathub-net message_sync::tests`

- [ ] **Step 5: Commit**

```bash
git add backends/crates/chathub-net/src/message_sync.rs backends/crates/chathub-net/src/lib.rs
git commit -m "feat(messages): MessageSync reconcile_newest + load_older 编排"
```

---

### Task 8: Tauri 命令 + run() 接线

**Files:**

- Modify: `backends/src/lib.rs`（imports、命令、`run()` 构造 + manage、`generate_handler!`）

- [ ] **Step 1: 引入类型**

In `backends/src/lib.rs`, extend the `chathub_net` use (line 8-14) and `chathub_state` use (line 16-20):

```rust
use chathub_net::{
    friend_to_row, record_to_remote, row_to_history, AccountEventApplier, AuthApi, AuthError,
    AuthInterceptor, BackoffConfig, ChangeNotice, ChangeScope, ChangeTopic, ConnectionManager,
    ConnectionState, FetchMessageHistoryRequest, FetchMessageHistoryResp, FriendEventApplier,
    HistoryMessage, HubClient, ListAccountsFilter, ListAccountsItem, ListRecentFriendsRequest,
    ListRecentFriendsResp, LoggedOutReason, MessageSync, RecentSessionEventApplier, TokenStore,
};
use chathub_state::{
    AccountCacheStore, FriendsStore, LocalTokenStore, MessagesStore, NotifySeqStore,
    RecentSessionRow, RecentSessionsStore, SessionStore, SqlitePool, WecomAccountRow,
    WecomFriendRow, MESSAGE_HOT_CONVERSATIONS_LIMIT, RECENT_SESSIONS_GLOBAL_LIMIT,
    RECENT_SESSIONS_PER_ACCOUNT_LIMIT,
};
```

- [ ] **Step 2: 加两个命令 + 响应类型**

In `backends/src/lib.rs`, after the `fetch_message_history` command (around line 338), add:

```rust
/// 单会话消息读取首屏 page size（对齐前端 DEFAULT_PAGE_SIZE）。
const MESSAGE_PAGE_SIZE: u32 = 20;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CachedMessagesResp {
    /// newest→oldest(与 server records 同序;前端 adaptHistoryRecords 反转成升序)。
    records: Vec<HistoryMessage>,
    has_more_older: bool,
}

/// 缓存优先读单会话消息:立即返回本地连续窗口最新 `limit` 条,同时后台 spawn 重对齐。
/// 未登录返空,不报错(同 list_recent_friends)。
#[tauri::command]
async fn load_conversation_messages(
    store: State<'_, MessagesStore>,
    sync: State<'_, MessageSync>,
    auth_api: State<'_, Arc<AuthApi>>,
    conversation_id: String,
    wecom_account_id: String,
    external_user_id: String,
    limit: usize,
) -> Result<CachedMessagesResp, AuthError> {
    let employee_id = match auth_api.current_session().await? {
        Some(p) => p.user_id,
        None => return Ok(CachedMessagesResp { records: Vec::new(), has_more_older: false }),
    };

    let now = chrono_now_ms();
    let _ = store.touch_accessed(&employee_id, &conversation_id, now).await;
    if let Err(e) = store.trim_conversations(&employee_id, MESSAGE_HOT_CONVERSATIONS_LIMIT).await {
        tracing::warn!(target: "chathub::messages", ?e, "trim_conversations failed; ignoring");
    }

    let rows = store
        .list_recent(&employee_id, &conversation_id, limit)
        .await
        .map_err(|e| AuthError::Internal { message: format!("messages list_recent: {e}") })?;
    let window = store
        .get_window(&employee_id, &conversation_id)
        .await
        .map_err(|e| AuthError::Internal { message: format!("messages get_window: {e}") })?;
    // 无 window(从没缓存过)→ 假定还有更老,让 UI 允许上拉(重对齐很快会建窗)。
    let has_more_older = window.map(|w| w.has_more_older).unwrap_or(true);

    // 后台重对齐:不阻塞首屏返回。
    let sync2 = sync.inner().clone();
    let (conv, acct, ext, emp) =
        (conversation_id.clone(), wecom_account_id.clone(), external_user_id.clone(), employee_id.clone());
    tauri::async_runtime::spawn(async move {
        if let Err(e) = sync2.reconcile_newest(&conv, &acct, &ext, &emp, MESSAGE_PAGE_SIZE).await {
            tracing::warn!(target: "chathub::messages", ?e, "reconcile_newest failed");
        }
    });

    Ok(CachedMessagesResp {
        records: rows.iter().map(row_to_history).collect(),
        has_more_older,
    })
}

/// 上拉加载更老一页(网络,同步返回新增)。无窗口 / 无更老 → 空。
#[tauri::command]
async fn load_older_messages(
    sync: State<'_, MessageSync>,
    auth_api: State<'_, Arc<AuthApi>>,
    conversation_id: String,
) -> Result<CachedMessagesResp, AuthError> {
    let employee_id = match auth_api.current_session().await? {
        Some(p) => p.user_id,
        None => return Ok(CachedMessagesResp { records: Vec::new(), has_more_older: false }),
    };
    let res = sync.load_older(&conversation_id, &employee_id, MESSAGE_PAGE_SIZE).await?;
    Ok(CachedMessagesResp { records: res.records, has_more_older: res.has_more_older })
}

fn chrono_now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}
```

- [ ] **Step 3: run() 构造 MessagesStore + MessageSync 并 manage**

In `backends/src/lib.rs` `run()`, inside the `block_on` tuple (around line 591-644):

构造（在 `let recents_store = ...;` 之后加）:

```rust
                let messages_store = MessagesStore::new(pool.clone());
```

（注意:`let local_store = LocalTokenStore::new(pool);` 这一行会 move `pool`;把 `messages_store` 的构造放在它**之前**,与 recents_store 相邻。）

在 `recent_applier` 构造之后加 `MessageSync`:

```rust
                let message_sync = MessageSync::new(
                    messages_store.clone(),
                    hub_client.clone(),
                    change_notice_tx.clone(),
                );
```

把 `messages_store` 和 `message_sync` 加进 `block_on` 闭包的返回元组,并相应扩展外层 `let (...) =` 解构:

```rust
                Ok::<_, String>((auth_api, hub_client, conn_manager, account_cache, friends_store, recents_store, messages_store, message_sync, change_notice_tx))
```

```rust
            let (auth_api, hub_client, conn_manager, account_cache, friends_store, recents_store, messages_store, message_sync, change_notice_tx) = tauri::async_runtime::block_on(async {
```

manage（在 `app.manage(recents_store);` 之后）:

```rust
            app.manage(messages_store);
            app.manage(message_sync);
```

- [ ] **Step 4: 注册命令到 generate_handler!**

In `backends/src/lib.rs` `generate_handler!`（line 777-785），在 `fetch_message_history,` 后加:

```rust
            fetch_message_history,
            load_conversation_messages, load_older_messages,
```

- [ ] **Step 5: 编译**

Run: `cd backends && cargo build`
Expected: 编译通过。

- [ ] **Step 6: Commit**

```bash
git add backends/src/lib.rs
git commit -m "feat(messages): load_conversation_messages / load_older_messages 命令 + 接线"
```

---

### Task 9: 登出 / 切员工清理消息缓存

**Files:**

- Modify: `backends/src/lib.rs`（logout 命令或 try_resume/employee 切换处）

- [ ] **Step 1: 定位 recents 清理点**

Run: `cd backends && grep -n "clear_for_employee\|RecentSessionsStore\|fn logout" src/lib.rs`
Expected: 找到 `logout` 命令与/或 recents `clear_for_employee` 调用点。

- [ ] **Step 2: 在同一处加 MessagesStore 清理**

判定与改法二选一(按 Step 1 结果):

**情况 A — `logout` 命令已调用某 store 的 `clear_for_employee`:** 在其旁加 `MessagesStore` 参数与清理调用。示例(把 `messages_store: State<'_, MessagesStore>` 加进 `logout` 签名,并在拿到 employee_id 后):

```rust
    if let Err(e) = messages_store.clear_for_employee(&employee_id).await {
        tracing::warn!(target: "chathub::messages", ?e, "clear_for_employee failed");
    }
```

**情况 B — 现有代码登出时未按 employee 清理 store(整库依赖删除/覆盖):** 则消息表沿用同策略,本步**不加**额外清理,仅在计划中记录:消息表与 recents 表生命周期一致,无需单独处理。跳到 Step 4。

- [ ] **Step 3:（仅情况 A）把 messages_store 传给 logout**

确保 `logout` 命令已 `app.manage(messages_store)`(Task 8 已 manage),命令签名加 `messages_store: State<'_, MessagesStore>` 即可注入。

- [ ] **Step 4: 编译 + Commit**

Run: `cd backends && cargo build`
Expected: 通过。

```bash
git add backends/src/lib.rs
git commit -m "feat(messages): 登出按 employee 清理消息缓存"
```

---

## Phase 3 — 前端缓存优先 + 订阅

### Task 10: messageHistory.ts 加缓存命令 invoker

**Files:**

- Modify: `frontends/lib/api/messageHistory.ts`

- [ ] **Step 1: 加类型 + invoker**

In `frontends/lib/api/messageHistory.ts`, after `fetchMessageHistory`（line 64），add:

```ts
/** Rust `load_conversation_messages` / `load_older_messages` 命令响应。 */
export interface CachedMessagesResp {
  /** newest→oldest(与 server 同序;adaptHistoryRecords 反转成升序)。 */
  records: HistoryMessage[];
  hasMoreOlder: boolean;
}

/** 缓存优先读单会话消息:立即返回本地窗口,Rust 后台重对齐后经 hub:change 通知重读。 */
export async function loadConversationMessages(args: {
  conversationId: string;
  wecomAccountId: string;
  externalUserId: string;
  limit: number;
}): Promise<CachedMessagesResp> {
  return invoke<CachedMessagesResp>("load_conversation_messages", {
    conversationId: args.conversationId,
    wecomAccountId: args.wecomAccountId,
    externalUserId: args.externalUserId,
    limit: args.limit,
  });
}

/** 上拉加载更老一页(网络)。 */
export async function loadOlderMessages(args: {
  conversationId: string;
}): Promise<CachedMessagesResp> {
  return invoke<CachedMessagesResp>("load_older_messages", {
    conversationId: args.conversationId,
  });
}
```

- [ ] **Step 2: 类型检查**

Run: `cd frontends && npx tsc --noEmit`
Expected: 无新增错误。

- [ ] **Step 3: Commit**

```bash
git add frontends/lib/api/messageHistory.ts
git commit -m "feat(messages): 前端缓存命令 invoker"
```

---

### Task 11: useMessageHistory 改缓存优先 + 订阅总线

**Files:**

- Modify: `frontends/lib/api/useMessageHistory.ts`（整文件重写,保持公共接口不变）

- [ ] **Step 1: 重写 hook**

Replace the entire contents of `frontends/lib/api/useMessageHistory.ts` with:

```ts
// useMessageHistory — 缓存优先 + 订阅变更总线(stale-while-revalidate)。
//
// 数据流:
//   - mount + (wecomAccountId, externalUserId, conversationId) 变化:调
//     load_conversation_messages → 立即拿本地连续窗口渲染(秒开)。Rust 后台重对齐,
//     完成后经 hub:change(topic=conversation-messages, scope.conversationId)通知 → 重读缓存。
//   - loadMore():调 load_older_messages 网络拉更老页(Rust 落库),返回新增 prepend。
//
// 与旧版差异:旧版每会话直拉 fetch_message_history、不订阅 ChangeBus。现改为缓存优先 + 订阅
//(spec §5)。公共接口 UseMessageHistoryResult 保持不变,ChatArea / useChatMessages 无需改。

import { useCallback, useEffect, useRef, useState } from "react";

import type { Message } from "@/components/workbench/messages/data";
import { changeBus } from "@/lib/data/changeBus";
import { useCurrentEmployeeId } from "@/lib/data/useCurrentEmployeeId";

import { adaptHistoryRecords, loadConversationMessages, loadOlderMessages } from "./messageHistory";

const DEFAULT_PAGE_SIZE = 20;

export interface UseMessageHistoryOptions {
  wecomAccountId: string;
  externalUserId: string;
  conversationId: string;
  enabled?: boolean;
  pageSize?: number;
}

export interface UseMessageHistoryResult {
  messages: Message[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => Promise<void>;
  retry: () => void;
}

interface HistoryState {
  targetKey: string;
  messages: Message[];
  hasMore: boolean;
  error: string | null;
}

function errorMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}

export function useMessageHistory(opts: UseMessageHistoryOptions): UseMessageHistoryResult {
  const {
    wecomAccountId,
    externalUserId,
    conversationId,
    enabled = true,
    pageSize = DEFAULT_PAGE_SIZE,
  } = opts;
  const employeeId = useCurrentEmployeeId();

  const activeTargetKey =
    enabled && wecomAccountId && externalUserId ? `${wecomAccountId}::${externalUserId}` : "";
  const [state, setState] = useState<HistoryState>({
    targetKey: activeTargetKey,
    messages: [],
    hasMore: false,
    error: null,
  });
  const [loading, setLoading] = useState(false);
  if (state.targetKey !== activeTargetKey) {
    setState({ targetKey: activeTargetKey, messages: [], hasMore: false, error: null });
  }

  const messages = state.targetKey === activeTargetKey ? state.messages : [];
  const hasMore = state.targetKey === activeTargetKey ? state.hasMore : false;
  const error = state.targetKey === activeTargetKey ? state.error : null;

  // 切会话后丢弃过期 in-flight 响应(保留旧版防护)。
  const targetKeyRef = useRef<string>("");

  // 读缓存(load_conversation_messages):立即渲染本地窗口。
  const readCache = useCallback(async () => {
    if (!enabled || !wecomAccountId || !externalUserId) return;
    const requestKey = `${wecomAccountId}::${externalUserId}`;
    setLoading(true);
    try {
      const resp = await loadConversationMessages({
        conversationId,
        wecomAccountId,
        externalUserId,
        limit: pageSize,
      });
      if (targetKeyRef.current !== requestKey) return;
      const page = adaptHistoryRecords(resp.records, conversationId);
      setState((current) =>
        current.targetKey === requestKey
          ? { targetKey: requestKey, messages: page, hasMore: resp.hasMoreOlder, error: null }
          : current,
      );
    } catch (e) {
      if (targetKeyRef.current !== requestKey) return;
      setState((current) =>
        current.targetKey === requestKey ? { ...current, error: errorMessage(e) } : current,
      );
    } finally {
      setLoading(false);
    }
  }, [enabled, wecomAccountId, externalUserId, conversationId, pageSize]);

  // mount / 切会话:读缓存。
  useEffect(() => {
    if (!enabled || !wecomAccountId || !externalUserId) {
      targetKeyRef.current = "";
      return;
    }
    targetKeyRef.current = `${wecomAccountId}::${externalUserId}`;
    void readCache();
  }, [enabled, wecomAccountId, externalUserId, conversationId, readCache]);

  // 订阅变更总线:Rust 后台重对齐完成 → 重读缓存。
  useEffect(() => {
    if (!enabled || !employeeId || !conversationId) return;
    const unsub = changeBus.subscribe(
      "conversation-messages",
      { employeeId, conversationId },
      () => {
        void readCache();
      },
    );
    return unsub;
  }, [enabled, employeeId, conversationId, readCache]);

  const loadMore = useCallback(async () => {
    if (!hasMore || loading) return;
    if (!wecomAccountId || !externalUserId) return;
    const requestKey = `${wecomAccountId}::${externalUserId}`;
    setLoading(true);
    try {
      const resp = await loadOlderMessages({ conversationId });
      if (targetKeyRef.current !== requestKey) return;
      const older = adaptHistoryRecords(resp.records, conversationId);
      setState((current) =>
        current.targetKey === requestKey
          ? {
              ...current,
              messages: [...older, ...current.messages],
              hasMore: resp.hasMoreOlder,
            }
          : current,
      );
    } catch (e) {
      if (targetKeyRef.current !== requestKey) return;
      setState((current) =>
        current.targetKey === requestKey ? { ...current, error: errorMessage(e) } : current,
      );
    } finally {
      setLoading(false);
    }
  }, [hasMore, loading, wecomAccountId, externalUserId, conversationId]);

  const retry = useCallback(() => {
    setState((current) => ({ ...current, error: null }));
    void readCache();
  }, [readCache]);

  return { messages, loading, error, hasMore, loadMore, retry };
}
```

- [ ] **Step 2: 类型检查 + 既有测试**

Run: `cd frontends && npx tsc --noEmit`
Expected: 无新增错误。

Run: `cd frontends && npx vitest run components/workbench/messages/ChatArea.test.tsx`
Expected: 既有 ChatArea 测试通过（接口未变；若测试 mock 了 `fetch_message_history`，按下一步调整）。

- [ ] **Step 3: 调整受影响的前端测试 mock**

Run: `cd frontends && grep -rln "fetch_message_history\|useMessageHistory\|fetchMessageHistory" components lib --include=*.test.* --include=*.test.tsx`
对命中的测试:把对 `fetch_message_history` 的 invoke mock 改为 `load_conversation_messages`(返回 `{ records, hasMoreOlder }`)。每个文件改完单独跑:
Run: `cd frontends && npx vitest run <file>`
Expected: PASS。

- [ ] **Step 4: Commit**

```bash
git add frontends/lib/api/useMessageHistory.ts frontends/components frontends/lib
git commit -m "feat(messages): useMessageHistory 缓存优先 + 订阅 conversation-messages"
```

---

### Task 12: 手动联调（mock downstream）

**Files:** 无（验证）。

- [ ] **Step 1: 起 mock + app**

参照 `run` skill / 项目既有方式启动 mock downstream + Tauri dev。打开消息页,切到一个有历史的会话。

- [ ] **Step 2: 验证秒开 + 重对齐**

- 首次打开会话:可能空(无缓存)→ 极快出现首页(重对齐落库 + hub:change 重读)。
- 切走再切回**同一会话**:应**立即**出现上次缓存(无 loading 闪烁),随后后台对齐。
- 上拉:出现更老消息;拉到底 `hasMore` 变 false 不再拉。

- [ ] **Step 3: 验证离线可读**

断开 mock(或断网),切回已缓存会话:仍能看到缓存消息(重对齐失败被吞,不清空)。

- [ ] **Step 4: 验证遇洞丢旧(可选,需 mock 配合)**

若 mock 能构造"窗口与最新页不重叠"的场景:重对齐后本地应重置为最新页(旧段被丢)。
观察日志 `chathub::messages`。

> 本任务是人工验证,不产生 commit。发现问题回到对应 Task 修。

---

## Phase 4 — 推送落地（依赖后端推送消息体契约,延后）

> **前置依赖:** 消息级推送的事件 payload 契约(单条消息是否携带 `sort_key`、全字段)由后端确定后才能接线。下列任务在契约确定前**不实现**,仅登记。

### Task 13:（延后）推送 ingest 接线

**Files（预期）:**

- Modify: `backends/crates/chathub-net/src/message_sync.rs`（加 `ingest_pushed(...)`）
- Modify: `backends/crates/chathub-net/src/recent_session_event.rs` 或新 applier（订阅回路调用）

**预期做法（spec §4.4):**

- 新消息 `sort_key > newest_sort_key` 且贴着上界 → `upsert_messages` 追加 + 推进 `newest_sort_key`（仅当会话已缓存,即 `get_window` 非空)。
- 检测到可能漏（流不连续 / 引用了本地没有的更老)→ 调 `reconcile_newest`,由"遇洞丢旧"兜底。
- 会话未缓存 → 忽略消息日志(列表 summary 仍由 `RecentSessionEventApplier` 更新)。
- 落库后发 `ChangeNotice(ConversationMessages, scope.conversationId)`。

> 契约明确后,本任务再展开为完整 TDD 切片(失败测试 → 实现 → 验证 → commit)。

---

## 附:验收清单（对照 spec)

- [ ] §3 Schema:两张表 + 索引 + employee_id 隔离(Task 1-4)
- [ ] §4.1 单连续窗口不变式 + §4.2 缝合/丢旧/冷启动(Task 6-7)
- [ ] §4.3 load older 推进下界/游标(Task 7)
- [ ] §5 缓存优先命令 + 后台重对齐 + ChangeNotice + 前端订阅(Task 8, 10, 11)
- [ ] §6 整会话 LRU(N=40)+ clear_for_employee(Task 4, 8, 9)
- [ ] §7 sort_key 假设(字典序比较)— 实现已采用;**联调时验证真实后端格式**(Task 12)
- [ ] §4.4 推送落地接口预留(Task 13,延后)
