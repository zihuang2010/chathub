# 出站失败气泡持久化 — 后端持久化（Plan A）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让出站失败消息落本地 SQLite（带与服务端同构的 sort_key），重启不丢、按时间归位，并与服务端权威行幂等收敛。

**Architecture:** 新增前端可调的两个 Tauri 命令 `persist_outbox_failure`（写失败行 + recents 展示列 + ChangeNotice）/`clear_outbox_row`（重发前删本地失败行）；`upsert_messages` 加「仅删 send_status=4」的 request_message_id 去重；reconcile Replace 与 trim LRU 对未收敛失败行保活；新增部分索引迁移。纯后端 Rust，独立 `cargo test` 可验。

**Tech Stack:** Rust / Tauri / rusqlite / deadpool-sqlite / rusqlite_migration。设计依据：`docs/superpowers/specs/2026-06-05-outbox-failed-bubble-design.md`（§1/§3/§4/§5/§7）。

**前置约定：**

- 分支 `feat/outbox-failed-bubble`。
- 本计划只动后端 crate `chathub-state`、`chathub-net`、`backends/src/lib.rs`，**不碰 `frontends/`**（避开并发 WIP）。
- 改任一既有符号前，按项目规范先跑 `gitnexus_impact({target, direction:"upstream"})` 报爆炸半径（index 若 stale 先 `npx gitnexus analyze`）。
- 所有 `cargo` 命令 cwd = `backends/`。

---

## File Structure

| 文件                                                                 | 职责                                                                                                                   | 改动      |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------- |
| `backends/crates/chathub-state/migrations/V24__idx_hub_msgs_req.sql` | request_message_id 部分索引                                                                                            | 新建      |
| `backends/crates/chathub-state/src/pool.rs`                          | 迁移注册                                                                                                               | 追加 1 行 |
| `backends/crates/chathub-state/src/messages.rs`                      | `upsert_messages` 去重；新增 `insert_failed_outbox`/`clear_outbox_row`/`list_failed_outbox`；`trim_conversations` 豁免 | 改+增     |
| `backends/crates/chathub-net/src/message_sync.rs`                    | reconcile Replace 保活（pure helper + 接线）                                                                           | 改+增     |
| `backends/src/lib.rs`                                                | 两个 Tauri 命令 + 注册                                                                                                 | 增        |

---

## Task 1: 迁移 V24 — request_message_id 部分索引

**Files:**

- Create: `backends/crates/chathub-state/migrations/V24__idx_hub_msgs_req.sql`
- Modify: `backends/crates/chathub-state/src/pool.rs:73-75`

- [ ] **Step 1: 写迁移 SQL**

Create `backends/crates/chathub-state/migrations/V24__idx_hub_msgs_req.sql`:

```sql
-- V24__idx_hub_msgs_req.sql — 出站失败气泡去重/保活用的 request_message_id 索引
--
-- upsert_messages 的「仅删 send_status=4」去重 DELETE 与 reconcile/trim 保活都按
-- (employee_id, request_message_id) 过滤。部分索引只覆盖非空 request_message_id
-- (出站行才有,= 客户端 client_msg_id),避免大量空串 inbound 行膨胀索引。
-- SQLite 3.46.1 支持 partial index(WHERE 子句)。
CREATE INDEX IF NOT EXISTS idx_hub_msgs_req
    ON hub_conversation_messages (employee_id, request_message_id)
    WHERE request_message_id <> '';
```

- [ ] **Step 2: 注册迁移**

In `backends/crates/chathub-state/src/pool.rs`, the migrations vec ends at V23 (lines 73-75). Add V24 right after the V23 entry, before the closing `]`:

```rust
                M::up(include_str!(
                    "../migrations/V23__recents_local_last_sent.sql"
                )),
                M::up(include_str!("../migrations/V24__idx_hub_msgs_req.sql")),
```

- [ ] **Step 3: 编译验证迁移加载**

Run: `cd backends && cargo build -p chathub-state`
Expected: 编译通过（`include_str!` 找到新文件即证明路径正确）。

- [ ] **Step 4: Commit**

```bash
git add backends/crates/chathub-state/migrations/V24__idx_hub_msgs_req.sql backends/crates/chathub-state/src/pool.rs
git commit -m "feat(state): V24 迁移 request_message_id 部分索引(支撑 outbox 去重/保活)"
```

---

## Task 2: `upsert_messages` 去重 DELETE（仅删 send_status=4）

防「重发成功后旧失败行与新 server 行并存」，且**绝不误删服务端多态行**（同 reqid 的 PENDING+CONFIRMED 共存于一页时）。

**Files:**

- Modify: `backends/crates/chathub-state/src/messages.rs:83-131`（事务循环内）
- Test: `backends/crates/chathub-state/src/messages.rs`（`#[cfg(test)]`）

- [ ] **Step 1: 写失败测试**

在 `messages.rs` 的 `#[cfg(test)] mod tests` 里追加（沿用本文件已有的 `sample_row` / in-memory pool 范式；下方 `row()` 是本测试自带的最小构造器）：

```rust
    fn row(local: &str, reqid: &str, status: i32) -> MessageRow {
        MessageRow {
            local_message_id: local.into(),
            conversation_id: "c1".into(),
            employee_id: "E".into(),
            wecom_account_id: "wa".into(),
            sort_key: format!("1780000000000_00000000000000000000_{local}"),
            message_time_ms: 1_780_000_000_000,
            message_direction: 2,
            message_type: 1,
            content_text: "hi".into(),
            send_status: status,
            attachments_json: "[]".into(),
            gmt_modified_time: String::new(),
            revoked: false,
            fail_reason: String::new(),
            request_message_id: reqid.into(),
            updated_at_ms: 0,
        }
    }

    #[tokio::test]
    async fn dedup_collapses_failed_client_row_into_server_confirmed_row() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = MessagesStore::new(pool);
        // 先写 client 键失败行(local=req=cid, status=4)
        store.upsert_messages(&[row("cid", "cid", 4)]).await.unwrap();
        // 再写 server CONFIRMED 行(local=server-1, 同 reqid=cid, status=3)
        store.upsert_messages(&[row("server-1", "cid", 3)]).await.unwrap();
        let got = store.list_conversation_asc("E", "c1").await.unwrap();
        let ids: Vec<_> = got.iter().map(|r| r.local_message_id.as_str()).collect();
        assert_eq!(ids, ["server-1"], "失败行应被同 reqid 的 server 行塌缩");
    }

    #[tokio::test]
    async fn dedup_never_deletes_server_multistate_rows_same_reqid() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = MessagesStore::new(pool);
        // 同一页含同 reqid 的 PENDING(2)+CONFIRMED(3) 两条 server 行,local 不同
        store
            .upsert_messages(&[row("server-pending", "cid", 2), row("server-confirmed", "cid", 3)])
            .await
            .unwrap();
        let got = store.list_conversation_asc("E", "c1").await.unwrap();
        assert_eq!(got.len(), 2, "server 多态行(status≠4)绝不能被去重 DELETE 误删");
    }
```

> 注：`list_conversation_asc` 是本 store 已有的「升序读」方法（命令层 `load_conversation_messages` 用它，见 `messages.rs:160` 附近 `ORDER BY sort_key`）。若实际方法名不同，按本文件现有升序读方法替换（搜 `ORDER BY sort_key` 确认）。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backends && cargo test -p chathub-state dedup_ -- --nocapture`
Expected: `dedup_collapses_...` FAIL（当前 `upsert_messages` 无去重，两行都在 → ids = ["cid","server-1"]）。

- [ ] **Step 3: 实现去重 DELETE**

In `messages.rs`, inside `upsert_messages`'s transaction loop (`for r in &rows { ... }`, 当前 `tx.execute("INSERT ... ON CONFLICT ...")` 之后、`}` 之前)，追加：

```rust
                // 去重:把同一逻辑消息(request_message_id 相同)的「client 键失败行」塌缩进刚入库的
                // server 行。仅删 send_status=4,绝不碰 server 多态行(PENDING/CONFIRMED 同 reqid 共存)。
                // request_message_id 空(inbound/老行)跳过,防空串互删。
                if !r.request_message_id.is_empty() {
                    tx.execute(
                        "DELETE FROM hub_conversation_messages \
                         WHERE employee_id = ?1 AND request_message_id = ?2 \
                           AND request_message_id <> '' AND send_status = 4 \
                           AND local_message_id <> ?3",
                        rusqlite::params![r.employee_id, r.request_message_id, r.local_message_id],
                    )?;
                }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd backends && cargo test -p chathub-state dedup_`
Expected: 两测 PASS。

- [ ] **Step 5: 跑全量 state 测试确认无回归**

Run: `cd backends && cargo test -p chathub-state`
Expected: 全绿（尤其 `upsert_messages_merges_send_status_without_regression` 等既有测）。

- [ ] **Step 6: Commit**

```bash
git add backends/crates/chathub-state/src/messages.rs
git commit -m "feat(state): upsert_messages 去重 client 键失败行(仅删 send_status=4,不碰 server 多态行)"
```

---

## Task 3: `MessagesStore::insert_failed_outbox` — 写失败行

**Files:**

- Modify: `backends/crates/chathub-state/src/messages.rs`（`impl MessagesStore` 内新增方法）
- Test: 同文件 `#[cfg(test)]`

- [ ] **Step 1: 写失败测试**

```rust
    #[tokio::test]
    async fn insert_failed_outbox_writes_client_keyed_failed_row() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = MessagesStore::new(pool);
        store
            .insert_failed_outbox(
                "E", "c1", "wa", "ext-1", "local-uuid-1", 1_780_000_000_000, 1, "你好",
                "网络断开", "[]",
            )
            .await
            .unwrap();
        let got = store.list_conversation_asc("E", "c1").await.unwrap();
        assert_eq!(got.len(), 1);
        let r = &got[0];
        assert_eq!(r.local_message_id, "local-uuid-1");
        assert_eq!(r.request_message_id, "local-uuid-1");
        assert_eq!(r.send_status, 4);
        assert_eq!(r.message_direction, 2, "出站方向必须写列(下划线 sort_key 不兜底方向)");
        assert_eq!(r.message_time_ms, 1_780_000_000_000, "message_time_ms 须 == 乐观 sentAt 同源");
        assert_eq!(r.fail_reason, "网络断开");
        // sort_key 下划线三段:13位ms_20位零_id
        assert_eq!(r.sort_key, "1780000000000_00000000000000000000_local-uuid-1");
    }
```

- [ ] **Step 2: 运行确认失败**

Run: `cd backends && cargo test -p chathub-state insert_failed_outbox_`
Expected: 编译失败 / FAIL（`insert_failed_outbox` 未定义）。

- [ ] **Step 3: 实现方法**

In `impl MessagesStore`（紧挨 `upsert_messages` 之后）新增：

```rust
    /// 写一条出站失败气泡行(send_status=4)。client_msg_id 同时作 local_message_id 与
    /// request_message_id(收敛桥)。sort_key 复刻服务端失败态形态:13位ms_20位零_id(下划线三段);
    /// 方向写列 2(out)——新 sort_key 不含 direction 段。先 ensure_window 保证有落脚窗口。
    /// 不 bump window.newest(避免扰动会话水位门)。
    #[allow(clippy::too_many_arguments)]
    pub async fn insert_failed_outbox(
        &self,
        employee_id: &str,
        conversation_id: &str,
        wecom_account_id: &str,
        external_user_id: &str,
        client_msg_id: &str,
        sent_at_ms: i64,
        message_type: i32,
        content_text: &str,
        fail_reason: &str,
        attachments_json: &str,
    ) -> Result<(), StateError> {
        self.ensure_window(employee_id, conversation_id, wecom_account_id, external_user_id)
            .await?;
        let row = MessageRow {
            local_message_id: client_msg_id.to_string(),
            conversation_id: conversation_id.to_string(),
            employee_id: employee_id.to_string(),
            wecom_account_id: wecom_account_id.to_string(),
            sort_key: format!("{:013}_{:020}_{}", sent_at_ms, 0, client_msg_id),
            message_time_ms: sent_at_ms,
            message_direction: 2,
            message_type,
            content_text: content_text.to_string(),
            send_status: 4,
            attachments_json: attachments_json.to_string(),
            gmt_modified_time: String::new(),
            revoked: false,
            fail_reason: fail_reason.to_string(),
            request_message_id: client_msg_id.to_string(),
            updated_at_ms: 0,
        };
        self.upsert_messages(&[row]).await
    }
```

- [ ] **Step 4: 运行确认通过**

Run: `cd backends && cargo test -p chathub-state insert_failed_outbox_`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add backends/crates/chathub-state/src/messages.rs
git commit -m "feat(state): insert_failed_outbox 写出站失败行(下划线 sort_key/direction 列/同源 ms)"
```

---

## Task 4: `MessagesStore::clear_outbox_row` + `list_failed_outbox`

`clear_outbox_row` 供重发前删本地失败行；`list_failed_outbox` 供 reconcile/trim 保活查询。

**Files:**

- Modify: `backends/crates/chathub-state/src/messages.rs`
- Test: 同文件

- [ ] **Step 1: 写失败测试**

```rust
    #[tokio::test]
    async fn clear_outbox_row_deletes_only_that_local_id() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = MessagesStore::new(pool);
        store.insert_failed_outbox("E","c1","wa","x","m1",1_780_000_000_000,1,"a","r","[]").await.unwrap();
        store.insert_failed_outbox("E","c1","wa","x","m2",1_780_000_000_001,1,"b","r","[]").await.unwrap();
        store.clear_outbox_row("E", "m1").await.unwrap();
        let got = store.list_conversation_asc("E", "c1").await.unwrap();
        let ids: Vec<_> = got.iter().map(|r| r.local_message_id.as_str()).collect();
        assert_eq!(ids, ["m2"]);
    }

    #[tokio::test]
    async fn list_failed_outbox_returns_only_failed_outbound_rows() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = MessagesStore::new(pool);
        store.insert_failed_outbox("E","c1","wa","x","f1",1_780_000_000_000,1,"a","r","[]").await.unwrap();
        store.upsert_messages(&[row("server-1", "", 3)]).await.unwrap(); // 正常 server 行,reqid 空
        let failed = store.list_failed_outbox("E", "c1").await.unwrap();
        let ids: Vec<_> = failed.iter().map(|r| r.local_message_id.as_str()).collect();
        assert_eq!(ids, ["f1"]);
    }
```

- [ ] **Step 2: 运行确认失败**

Run: `cd backends && cargo test -p chathub-state outbox_row_ list_failed_outbox_`
Expected: 编译失败（方法未定义）。

- [ ] **Step 3: 实现两个方法**

In `impl MessagesStore`：

```rust
    /// 删一条本地行(重发前清掉失败行,让气泡回纯乐观 sending)。按 employee_id 校验防越权。
    pub async fn clear_outbox_row(
        &self,
        employee_id: &str,
        local_message_id: &str,
    ) -> Result<(), StateError> {
        let employee_id = employee_id.to_string();
        let local_message_id = local_message_id.to_string();
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            c.execute(
                "DELETE FROM hub_conversation_messages \
                 WHERE employee_id = ?1 AND local_message_id = ?2",
                rusqlite::params![employee_id, local_message_id],
            )?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// 列某会话未收敛的本地失败行(send_status=4 且 request_message_id 非空)。供 reconcile/trim 保活。
    pub async fn list_failed_outbox(
        &self,
        employee_id: &str,
        conversation_id: &str,
    ) -> Result<Vec<MessageRow>, StateError> {
        let employee_id = employee_id.to_string();
        let conversation_id = conversation_id.to_string();
        let conn = self.pool.pool().get().await?;
        let rows = conn
            .interact(move |c| -> Result<Vec<MessageRow>, StateError> {
                let mut stmt = c.prepare(
                    "SELECT local_message_id, conversation_id, employee_id, wecom_account_id, \
                            sort_key, message_time_ms, message_direction, message_type, \
                            content_text, send_status, attachments_json, gmt_modified_time, \
                            revoked, fail_reason, request_message_id, updated_at_ms \
                     FROM hub_conversation_messages \
                     WHERE employee_id = ?1 AND conversation_id = ?2 \
                       AND send_status = 4 AND request_message_id <> ''",
                )?;
                let rows = stmt
                    .query_map(rusqlite::params![employee_id, conversation_id], map_row)?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .await??;
        Ok(rows)
    }
```

> `map_row` 是本文件已有的行映射闭包/函数（`messages.rs:441` 附近，`map_row` 把 `&rusqlite::Row` → `MessageRow`）。若它是 `fn map_row(r: &rusqlite::Row) -> rusqlite::Result<MessageRow>`，上面 `.query_map(params, map_row)` 直接可用；若签名不同按其形态适配。

- [ ] **Step 4: 运行确认通过**

Run: `cd backends && cargo test -p chathub-state outbox_row_ list_failed_outbox_`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add backends/crates/chathub-state/src/messages.rs
git commit -m "feat(state): clear_outbox_row + list_failed_outbox(重发清行/保活查询)"
```

---

## Task 5: reconcile Replace 保活失败行（pure helper + 接线）

Replace 会 `delete_conversation` 清库 → 必须先捞「服务端首页不含同 reqid」的失败行，删后补回。

**Files:**

- Modify: `backends/crates/chathub-net/src/message_sync.rs`（新增 pure helper + 改 Replace 分支 251-276）
- Test: 同文件 `#[cfg(test)]`

- [ ] **Step 1: 写 pure helper 失败测试**

在 `message_sync.rs` 的 `#[cfg(test)] mod tests` 追加：

```rust
    fn failed_row(local: &str, reqid: &str) -> chathub_state::MessageRow {
        chathub_state::MessageRow {
            local_message_id: local.into(), conversation_id: "c1".into(), employee_id: "E".into(),
            wecom_account_id: "wa".into(), sort_key: format!("1780000000000_00000000000000000000_{local}"),
            message_time_ms: 1_780_000_000_000, message_direction: 2, message_type: 1,
            content_text: "x".into(), send_status: 4, attachments_json: "[]".into(),
            gmt_modified_time: String::new(), revoked: false, fail_reason: "r".into(),
            request_message_id: reqid.into(), updated_at_ms: 0,
        }
    }

    #[test]
    fn preserve_failed_keeps_only_rows_not_in_server_page_reqids() {
        let failed = vec![failed_row("f1", "f1"), failed_row("f2", "f2")];
        let mut page = std::collections::HashSet::new();
        page.insert("f2".to_string()); // 服务端首页已含 f2 的 reqid(已收敛) → 不保活
        let kept = preserve_failed(failed, &page);
        let ids: Vec<_> = kept.iter().map(|r| r.local_message_id.as_str()).collect();
        assert_eq!(ids, ["f1"], "服务端已知 reqid 的失败行不保活,未知的保活");
    }
```

- [ ] **Step 2: 运行确认失败**

Run: `cd backends && cargo test -p chathub-net preserve_failed_`
Expected: 编译失败（`preserve_failed` 未定义）。

- [ ] **Step 3: 实现 pure helper**

在 `message_sync.rs` 顶部（与 `classify_reconcile` 同区，模块级 `pub fn`）：

```rust
/// 从未收敛失败行中筛出「服务端首页 reqid 集合不含」的那些 —— 它们是服务端尚不知情的本地失败,
/// Replace 清库后必须补回。已被服务端回显(reqid 在页中)的不保活,由 server 行取代。
/// 按 reqid(非 local_message_id)判定,确保补回行与 server 行不同 reqid → 去重 DELETE 不交叉。
pub fn preserve_failed(
    failed: Vec<chathub_state::MessageRow>,
    page_reqids: &std::collections::HashSet<String>,
) -> Vec<chathub_state::MessageRow> {
    failed
        .into_iter()
        .filter(|r| !r.request_message_id.is_empty() && !page_reqids.contains(&r.request_message_id))
        .collect()
}
```

- [ ] **Step 4: 运行确认 helper 通过**

Run: `cd backends && cargo test -p chathub-net preserve_failed_`
Expected: PASS。

- [ ] **Step 5: 接线进 Replace 分支**

In `message_sync.rs` `reconcile_newest` 的 `ReconcileMode::Replace => { ... }`（251-276）。改成（在 `delete_conversation` 前捞、`upsert_messages(&rows)` 后补回）：

```rust
            ReconcileMode::Replace => {
                // 保活:Replace 会清库,先捞服务端首页不含其 reqid 的本地失败行,删后补回。
                let page_reqids: std::collections::HashSet<String> =
                    rows.iter().map(|r| r.request_message_id.clone()).collect();
                let preserved = preserve_failed(
                    self.store
                        .list_failed_outbox(employee_id, conversation_id)
                        .await
                        .map_err(state_err)?,
                    &page_reqids,
                );
                self.store
                    .delete_conversation(employee_id, conversation_id)
                    .await
                    .map_err(state_err)?;
                self.store.upsert_messages(&rows).await.map_err(state_err)?;
                if !preserved.is_empty() {
                    self.store.upsert_messages(&preserved).await.map_err(state_err)?;
                }
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
                        newest_message_time_ms: page_newest_ms,
                        last_accessed_ms: now,
                        reconciled_at_ms: now,
                        updated_at_ms: now,
                    })
                    .await
                    .map_err(state_err)?;
                true
            }
```

> 仅在 `delete_conversation`/`upsert_messages(&rows)` 两行之间插入保活逻辑，window upsert 段原样保留（上面已含完整段，照抄即可）。

- [ ] **Step 6: 运行全量 net 测试**

Run: `cd backends && cargo test -p chathub-net`
Expected: 全绿（既有 reconcile 测 `classify_*` 等不受影响）。

- [ ] **Step 7: Commit**

```bash
git add backends/crates/chathub-net/src/message_sync.rs
git commit -m "feat(net): reconcile Replace 保活未收敛失败行(按 reqid-not-in-page,不反噬 server 行)"
```

---

## Task 6: `trim_conversations` 豁免含失败行的会话

LRU 整会话淘汰时，含未收敛失败行的会话不进 victim 名单（不破坏成对删除）。

**Files:**

- Modify: `backends/crates/chathub-state/src/messages.rs:381-390`（victim 选取 SQL）
- Test: 同文件

- [ ] **Step 1: 写失败测试**

```rust
    #[tokio::test]
    async fn trim_exempts_conversations_with_failed_outbox_rows() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = MessagesStore::new(pool);
        // 冷会话 cFail:有失败行,last_accessed 最旧(最该被淘汰)
        store.insert_failed_outbox("E","cFail","wa","x","f1",1,1,"a","r","[]").await.unwrap();
        store.touch_accessed("E", "cFail", 1).await.unwrap();
        // 热会话 cHot:无失败行,last_accessed 最新
        store.ensure_window("E","cHot","wa","x").await.unwrap();
        store.touch_accessed("E", "cHot", 999).await.unwrap();
        // 上限=1 → 正常会淘汰最旧的 cFail,但它有失败行应豁免
        store.trim_conversations("E", 1).await.unwrap();
        let failed = store.list_failed_outbox("E", "cFail").await.unwrap();
        assert_eq!(failed.len(), 1, "含失败行的会话必须豁免 LRU 淘汰");
    }
```

> 注：`row("h1","",3)` 的 conversation_id 固定为 `c1`，与本测试无关，可保留或删；关键是 `cFail` 有失败行 + 最旧 last_accessed。`touch_accessed` 是本 store 已有方法（`messages.rs:330` 附近 UPDATE last_accessed_ms）。若签名不同按现有调整。

- [ ] **Step 2: 运行确认失败**

Run: `cd backends && cargo test -p chathub-state trim_exempts_`
Expected: FAIL（当前 trim 把 cFail 整删，失败行没了 → len = 0）。

- [ ] **Step 3: 改 victim 选取 SQL**

In `messages.rs` `trim_conversations` 的 victim 子查询（当前）：

```rust
                let mut stmt = tx.prepare(
                    "SELECT conversation_id FROM hub_conversation_message_window \
                     WHERE employee_id = ?1 \
                     ORDER BY last_accessed_ms DESC LIMIT -1 OFFSET ?2",
                )?;
```

改成（排除含失败行的会话）：

```rust
                let mut stmt = tx.prepare(
                    "SELECT conversation_id FROM hub_conversation_message_window \
                     WHERE employee_id = ?1 \
                       AND conversation_id NOT IN ( \
                         SELECT DISTINCT conversation_id FROM hub_conversation_messages \
                         WHERE employee_id = ?1 AND send_status = 4 AND request_message_id <> '' \
                       ) \
                     ORDER BY last_accessed_ms DESC LIMIT -1 OFFSET ?2",
                )?;
```

- [ ] **Step 4: 运行确认通过**

Run: `cd backends && cargo test -p chathub-state trim_exempts_`
Expected: PASS。

- [ ] **Step 5: 跑既有 trim 测试确认无回归**

Run: `cd backends && cargo test -p chathub-state trim`
Expected: 全绿（既有 `trim_conversations_evicts_coldest_whole` 等仍通过——它们的会话无失败行，不受豁免影响）。

- [ ] **Step 6: Commit**

```bash
git add backends/crates/chathub-state/src/messages.rs
git commit -m "feat(state): trim_conversations 豁免含未收敛失败行的会话(防 LRU 整删丢失败行)"
```

---

## Task 7: Tauri 命令 `persist_outbox_failure` + `clear_outbox_row` + 注册

**Files:**

- Modify: `backends/src/lib.rs`（新增两个 `#[tauri::command]` + `generate_handler!` 注册）

- [ ] **Step 1: 写两个命令**

In `backends/src/lib.rs`，紧接 `send_message`/`summary_preview` 之后新增（State 注入照抄 `send_message` 既有写法）：

```rust
/// 前端任一 markFailed 落地一条出站失败气泡到本地库(send_status=4),并乐观写接待列表预览
/// (复用 mark_local_sent:只动展示列 local_last_sent_at_ms,不抬水位键)。随后广播
/// ConversationMessages + RecentSessions ChangeNotice 触发重读。employee_id 走 session 防串台。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn persist_outbox_failure(
    messages_store: State<'_, MessagesStore>,
    recents_store: State<'_, RecentSessionsStore>,
    change_tx: State<'_, tokio_broadcast::Sender<ChangeNotice>>,
    auth_api: State<'_, Arc<AuthApi>>,
    conversation_id: String,
    wecom_account_id: String,
    external_user_id: String,
    client_msg_id: String,
    sent_at_ms: i64,
    message_type: i32,
    content_text: String,
    fail_reason: String,
    attachments_json: String,
) -> Result<(), AuthError> {
    let employee_id = auth_api
        .current_session()
        .await?
        .ok_or(AuthError::Unauthenticated)?
        .user_id;
    messages_store
        .insert_failed_outbox(
            &employee_id,
            &conversation_id,
            &wecom_account_id,
            &external_user_id,
            &client_msg_id,
            sent_at_ms,
            message_type,
            &content_text,
            &fail_reason,
            &attachments_json,
        )
        .await
        .map_err(AuthError::from)?;
    // 接待列表展示列乐观写(方向取出站原始值 1,与 send_message 成功路径一致);新会话 no-op。
    let summary = summary_preview(message_type, &content_text, None);
    if let Err(e) = recents_store
        .mark_local_sent(&employee_id, &conversation_id, &summary, message_type, 1, now_unix_ms())
        .await
    {
        tracing::warn!(error = %e, "persist_outbox_failure: mark_local_sent 失败(不阻塞)");
    }
    let _ = change_tx.send(ChangeNotice::command_upsert(
        ChangeTopic::ConversationMessages,
        ChangeScope {
            employee_id: employee_id.clone(),
            conversation_id: Some(conversation_id.clone()),
            ..Default::default()
        },
    ));
    let _ = change_tx.send(ChangeNotice::command_upsert(
        ChangeTopic::RecentSessions,
        ChangeScope {
            employee_id,
            conversation_id: Some(conversation_id),
            ..Default::default()
        },
    ));
    Ok(())
}

/// 重发前删本地失败行(让气泡回纯乐观 sending);发完 ChangeNotice 让打开着的会话重读。
#[tauri::command]
async fn clear_outbox_row(
    messages_store: State<'_, MessagesStore>,
    change_tx: State<'_, tokio_broadcast::Sender<ChangeNotice>>,
    auth_api: State<'_, Arc<AuthApi>>,
    conversation_id: String,
    client_msg_id: String,
) -> Result<(), AuthError> {
    let employee_id = auth_api
        .current_session()
        .await?
        .ok_or(AuthError::Unauthenticated)?
        .user_id;
    messages_store
        .clear_outbox_row(&employee_id, &client_msg_id)
        .await
        .map_err(AuthError::from)?;
    let _ = change_tx.send(ChangeNotice::command_upsert(
        ChangeTopic::ConversationMessages,
        ChangeScope {
            employee_id,
            conversation_id: Some(conversation_id),
            ..Default::default()
        },
    ));
    Ok(())
}
```

> 若 `AuthError` 没有 `From<StateError>`，用 `send_message` 同款转换（搜 `state_err` 或 `AuthError::` 在 lib.rs 的既有用法，照抄其 StateError→AuthError 路径替换 `.map_err(AuthError::from)`）。

- [ ] **Step 2: 注册命令**

In `backends/src/lib.rs` 的 `tauri::generate_handler![ ... ]`（1758-1768），在 `send_message, upload_attachment,` 同区追加：

```rust
            send_message, upload_attachment, persist_outbox_failure, clear_outbox_row,
```

- [ ] **Step 3: 编译验证**

Run: `cd backends && cargo build`
Expected: 编译通过。

- [ ] **Step 4: 跑后端全量测试**

Run: `cd backends && cargo test`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add backends/src/lib.rs
git commit -m "feat(app): persist_outbox_failure + clear_outbox_row 命令(前端落库失败气泡/重发清行)"
```

---

## 验收（Plan A 完成判定）

- [ ] `cd backends && cargo test` 全绿。
- [ ] `cd backends && cargo clippy --all-targets -- -D warnings` 无新增告警。
- [ ] 手验迁移：删本地 `state.sqlite` 后启动一次，确认 V24 迁移执行无错（或新装即建索引）。
- [ ] 契约对齐备忘（供 Plan B）：前端 `persist_outbox_failure` 入参 = `{conversationId, wecomAccountId, externalUserId, clientMsgId, sentAtMs, messageType, contentText, failReason, attachmentsJson}`；`clear_outbox_row` = `{conversationId, clientMsgId}`。Tauri 自动 snake_case↔camelCase。

## 不在本计划（Plan B/C）

- 前端 `failBubble`/IPC 接线、attachments_json 构造与 attachmentType 映射、never-uploaded 重发拦截、STRINGS 文案 → Plan B。
- `replaceAuthoritative` 排序修正 + 两个红测 → Plan C。

---

## 补遗（二轮计划验证后 / 4 agent 结论：可落地）

二轮 fan-out 对真实代码逐行核过：迁移注册、去重 DELETE 借用、reconcile 保活变量作用域、State 注册、签名匹配、测试红绿全部成立，无致命/高危。补两个中等缺口 + 记低级提示。

### Task 8: `RecentSessionsStore::mark_local_failed`（recents 失败态，补 §5 `last_send_status=4`）

原 Task 7 命令复用 `mark_local_sent` 不写 `last_send_status` → 接待列表无「发送失败」标记。新增一个只多写失败态的变体（仍**不碰** `last_message_sort_key_ms`，保证服务端 SESSION_SUMMARY 经 `apply_summary` 4→3 能收敛回正）。

**Files:** Modify `backends/crates/chathub-state/src/recent_sessions.rs`（新增方法 + 测试）

- [ ] **Step 1: 写失败测试**（模仿既有 `mark_local_sent_updates_local_cols_only`@recent_sessions.rs:2025 的 seed 范式：`E` 是测试常量 employee、`sample_remote`/`upsert_remote_many`/`list_top` 均为本测试模块既有助手）

```rust
    #[tokio::test]
    async fn mark_local_failed_sets_status_4_without_touching_version_key() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        store.upsert_remote_many(&[sample_remote("c1", "wa-1", 500, 0)]).await.unwrap(); // status=3, sort_key=500
        let hit = store.mark_local_failed(E, "c1", "发失败的消息", 1, 1, 9999).await.unwrap();
        assert!(hit);
        let got = store.list_top(E, None, 10).await.unwrap();
        assert_eq!(got[0].last_message_summary, "发失败的消息");
        assert_eq!(got[0].last_send_status, 4, "失败态必须写 last_send_status=4");
        assert_eq!(got[0].local_last_sent_at_ms, 9999);
        assert_eq!(got[0].last_message_sort_key_ms, 500, "绝不动版本/水位键(否则破坏 apply_summary 回正)");
    }
```

- [ ] **Step 2: 运行确认失败** — `cd backends && cargo test -p chathub-state mark_local_failed_`（方法未定义 → 编译失败/FAIL）

- [ ] **Step 3: 实现**（紧挨 `mark_local_sent` 之后；SET 比 `mark_local_sent` 只多 `last_send_status = 4`）

```rust
    /// 出站发送失败的接待列表乐观写:与 mark_local_sent 同款只动展示列,额外写 last_send_status=4。
    /// **不动 last_message_sort_key_ms**(水位/版本键),故随后服务端 SESSION_SUMMARY 经 apply_summary
    /// 不倒退 CASE(4→3 允许)可把状态收敛回正。会话不在 recents 则 no-op(返 false)。
    pub async fn mark_local_failed(
        &self,
        employee_id: &str,
        conversation_id: &str,
        last_message_summary: &str,
        last_message_type: i32,
        last_message_direction: i32,
        now_ms: i64,
    ) -> Result<bool, StateError> {
        let employee_id = employee_id.to_string();
        let id = conversation_id.to_string();
        let summary = last_message_summary.to_string();
        let conn = self.pool.pool().get().await?;
        let changed = conn
            .interact(move |c| -> Result<bool, StateError> {
                let n = c.execute(
                    "UPDATE hub_conversation_recents SET \
                       last_message_summary   = ?1, \
                       last_message_type      = ?2, \
                       last_message_direction = ?3, \
                       local_last_sent_at_ms  = ?4, \
                       last_send_status       = 4 \
                     WHERE employee_id = ?5 AND conversation_id = ?6",
                    rusqlite::params![
                        summary,
                        last_message_type as i64,
                        last_message_direction as i64,
                        now_ms,
                        employee_id,
                        id,
                    ],
                )?;
                Ok(n > 0)
            })
            .await??;
        Ok(changed)
    }
```

- [ ] **Step 4: 运行确认通过** — `cd backends && cargo test -p chathub-state mark_local_failed_`

- [ ] **Step 5: 接进命令** — 把原 Task 7 `persist_outbox_failure` 命令里的
      `recents_store.mark_local_sent(&employee_id, &conversation_id, &summary, message_type, 1, now_unix_ms())`
      改为 `recents_store.mark_local_failed(&employee_id, &conversation_id, &summary, message_type, 1, now_unix_ms())`（参数完全一致）。

- [ ] **Step 6: Commit** — `git add backends/crates/chathub-state/src/recent_sessions.rs backends/src/lib.rs && git commit -m "feat(state): mark_local_failed 写接待列表失败态(last_send_status=4,不碰版本键)"`

### Task 5 追加：方向恢复读回测试（补 §1「测试覆盖方向恢复」）

下划线 sort_key 让 `normalize_local_direction_from_sort_key`(message_sync.rs:114) 的 `split(':')` 失效 → 回落 stored 列。加护栏测，防将来改回落逻辑时失败行方向静默翻 in。

**Files:** Modify `backends/crates/chathub-net/src/message_sync.rs`（`#[cfg(test)] mod tests` 追加）

- [ ] **Step: 加测试并确认通过**（实现无关，纯护栏；当前即应 PASS）

```rust
    #[test]
    fn row_to_history_recovers_out_direction_from_underscore_sort_key() {
        let r = chathub_state::MessageRow {
            local_message_id: "m1".into(), conversation_id: "c1".into(), employee_id: "E".into(),
            wecom_account_id: "wa".into(),
            sort_key: "1780000000000_00000000000000000000_m1".into(), // 下划线三段,无冒号
            message_time_ms: 1_780_000_000_000, message_direction: 2, message_type: 1,
            content_text: "x".into(), send_status: 4, attachments_json: "[]".into(),
            gmt_modified_time: String::new(), revoked: false, fail_reason: "r".into(),
            request_message_id: "m1".into(), updated_at_ms: 0,
        };
        // split(':') 失效 → 回落 stored direction=2(out)。HistoryMessage.message_direction=2 即出站。
        assert_eq!(row_to_history(&r).message_direction, 2);
    }
```

Run: `cd backends && cargo test -p chathub-net row_to_history_recovers_out_`（应 PASS）。Commit 随 Task 5。

### 低级提示（不阻塞，落地时知悉）

- 失败的**文件**类消息：`persist_outbox_failure` 给 `summary_preview(.., None)` → recents 预览显示 `[文件]` 而非文件名（成功路径传真名）。可接受；如要对齐需给命令加 `file_name` 入参透传。
- V24 与 V14 既有索引不同名无冲突；`CREATE INDEX IF NOT EXISTS` 幂等。
- §4 Stitch 不删失败行：行为天然安全（保活只接进 Replace），可选补一条护栏测，非必须。
- Rust 下「方法未定义」是编译错误（非单测 FAIL），会令同文件 test target 整体编不过——逐 Task 实现即可，属 TDD 固有现象。
