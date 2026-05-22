# 客户端接收消息流程 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让客户端把实时 `MESSAGE_UPSERT` 推送直接落成单会话消息气泡（规范 §8.3），并新增对接测试证明「业务推送 → relay fan-out → 客户端落气泡」端到端可用。

**Architecture:** 新增第 4 个 applier `MessageEventApplier`（与 friend/recent 同构），消费 `PushBatchOut` 中的 `MESSAGE_UPSERT`，热会话直接 upsert 气泡到 `MessagesStore` 并扩窗 + 发 `ConversationMessages` 通知；瘦 payload 走 `MessageSync.reconcile_newest` 兜底。`RecentSessionEventApplier` 继续只管列表摘要，二者正交。

**Tech Stack:** Rust（tokio、tonic、rusqlite/deadpool、serde_json）、axum（relay）、现有 broadcast `ChangeNotice` 管线。

**Spec:** `docs/superpowers/specs/2026-05-22-receive-message-flow-design.md`

---

## File Structure

- **Create** `backends/crates/chathub-net/src/message_event.rs` — `MessageEventApplier` + 纯解码/方向翻译/节流 helper + 单元测试。单一职责：把 `MESSAGE_UPSERT` 落成气泡。
- **Modify** `backends/crates/chathub-net/src/message_sync.rs` — 把 `parse_server_time_to_ms` 提升为 `pub(crate)` 供复用。
- **Modify** `backends/crates/chathub-net/src/lib.rs` — `pub mod message_event;` + `pub use message_event::MessageEventApplier;`。
- **Modify** `backends/crates/chathub-net/src/hub.rs` — `Inner` 加 `message_event_applier` 字段；`ConnectionManager::new` 加第 4 个 applier 参数；dispatch loop 调用。
- **Modify** `backends/src/lib.rs` — 构造 `MessageEventApplier` 并传入 `ConnectionManager::new`。
- **Create** `backends/crates/chathub-net/tests/message_e2e.rs` — `ConnectionManager` ↔ `stub_relay` 对接 e2e。

---

## Task 1: 纯解码 + 方向翻译 helper（无网络、可单测）

**Files:**

- Modify: `backends/crates/chathub-net/src/message_sync.rs`（`parse_server_time_to_ms` → `pub(crate)`）
- Create: `backends/crates/chathub-net/src/message_event.rs`
- Modify: `backends/crates/chathub-net/src/lib.rs`（声明模块）

- [ ] **Step 1: 暴露时间解析 helper**

在 `backends/crates/chathub-net/src/message_sync.rs` 把私有函数签名改为 `pub(crate)`（函数体不变）：

```rust
/// "yyyy-MM-dd HH:mm:ss"(服务端本地,假设 UTC+8)→ epoch ms(UTC)。解析失败返 0。
pub(crate) fn parse_server_time_to_ms(s: &str) -> i64 {
```

- [ ] **Step 2: 在 lib.rs 声明新模块**

在 `backends/crates/chathub-net/src/lib.rs` 模块声明区（`pub mod message_sync;` 附近）加一行：

```rust
pub mod message_event;
```

并在导出区（`pub use message_sync::{...};` 附近）加：

```rust
pub use message_event::MessageEventApplier;
```

- [ ] **Step 3: 写失败的解码/翻译单元测试（先建文件，仅 helper + 测试）**

创建 `backends/crates/chathub-net/src/message_event.rs`：

```rust
//! 消息气泡事件应用器:Subscribe 流里 `MESSAGE_UPSERT` 事件 → 本地 `hub_conversation_messages`
//! 气泡 upsert(规范 §8.3)。与 `recent_session_event.rs` 正交:recents 管列表摘要,本模块管气泡。
//!
//! Hybrid:热会话(本地有窗口)直接 upsert payload 快照;瘦 payload / 解码失败 / 附件转存中
//! → `MessageSync.reconcile_newest` 兜底(全局 1s 节流)。冷会话(无窗口)跳过,绝不建孤儿气泡。

use crate::change_notice::{ChangeNotice, ChangeScope, ChangeTopic};
use crate::message_sync::{parse_server_time_to_ms, MessageSync};
use crate::recent_session_event::split_sort_key_ms;
use chathub_proto::v1::PushBatchOut;
use chathub_state::{MessageRow, MessagesStore};
use std::collections::HashSet;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use tokio::sync::broadcast;
use tracing::warn;

/// 兜底拉首页 page size(同 message_sync 约定)。
const FALLBACK_PAGE_SIZE: u32 = 20;
/// 兜底节流窗口:1 秒内多次兜底合并为一次(同 RecentSessionEventApplier)。
const FALLBACK_THROTTLE_MS: i64 = 1000;

/// spec messageDirection → 本地约定。本地: 2=出站(out), 其余=入站(in)。
/// spec: 1=我方发送, 2=客户消息, 3=多端同步(=我方)。集中单点,便于将来统一约定时切换。
fn to_local_direction(spec_dir: i64) -> i32 {
    match spec_dir {
        1 | 3 => 2,
        _ => 1,
    }
}

fn str_or_empty(v: &serde_json::Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

/// 附件是否仍在转存中(任一附件 transferStatus==1)。转存中 → 走兜底,等转存完成后权威字段齐。
fn attachments_transferring(msg: &serde_json::Value) -> bool {
    msg.get("attachments")
        .and_then(|a| a.as_array())
        .map(|arr| {
            arr.iter()
                .any(|a| a.get("transferStatus").and_then(|t| t.as_i64()) == Some(1))
        })
        .unwrap_or(false)
}

/// 把一个 `MESSAGE_UPSERT` 事件 Value 解码为 `MessageRow`(含方向翻译)。
/// 必填:`message.localMessageId` / `message.sortKey` / 事件级 `conversationId` 非空。
/// 缺失 → None(调用者走兜底)。`employee_id` 来自 batch,不在 payload。
pub(crate) fn decode_message_row(ev: &serde_json::Value, employee_id: &str) -> Option<MessageRow> {
    let conversation_id = ev.get("conversationId").and_then(|v| v.as_str())?;
    if conversation_id.is_empty() {
        return None;
    }
    let msg = ev.get("message")?;
    let local_message_id = msg.get("localMessageId").and_then(|v| v.as_str())?;
    if local_message_id.is_empty() {
        return None;
    }
    let sort_key = msg.get("sortKey").and_then(|v| v.as_str())?;
    if sort_key.is_empty() {
        return None;
    }
    let message_time = str_or_empty(msg, "messageTime");
    let spec_dir = msg.get("messageDirection").and_then(|v| v.as_i64()).unwrap_or(2);
    let attachments_json = msg
        .get("attachments")
        .map(|a| a.to_string())
        .unwrap_or_else(|| "[]".to_string());
    let freshness = split_sort_key_ms(sort_key).max(parse_server_time_to_ms(&message_time));
    Some(MessageRow {
        local_message_id: local_message_id.to_string(),
        conversation_id: conversation_id.to_string(),
        employee_id: employee_id.to_string(),
        wecom_account_id: str_or_empty(ev, "wecomAccountId"),
        sort_key: sort_key.to_string(),
        message_time_ms: freshness,
        message_direction: to_local_direction(spec_dir),
        message_type: msg.get("messageType").and_then(|v| v.as_i64()).unwrap_or(1) as i32,
        content_text: str_or_empty(msg, "contentText"),
        send_status: msg.get("sendStatus").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
        attachments_json,
        gmt_modified_time: str_or_empty(msg, "gmtModifiedTime"),
        updated_at_ms: 0,
    })
}

fn now_unix_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn full_event(conv: &str, spec_dir: i64) -> serde_json::Value {
        serde_json::json!({
            "eventType": "MESSAGE_UPSERT",
            "eventReason": "CUSTOMER_MESSAGE_RECEIVED",
            "conversationId": conv,
            "wecomAccountId": "wa-1",
            "externalUserId": "ext-1",
            "message": {
                "localMessageId": "LM_A",
                "messageDirection": spec_dir,
                "messageType": 1,
                "sendStatus": 3,
                "sortKey": "1770000000000:2:00000000000000002001:LM_A",
                "messageTime": "2026-05-14 10:30:00",
                "contentText": "你好",
                "contentSummary": "你好",
                "attachments": []
            }
        })
    }

    #[test]
    fn decode_full_payload_translates_customer_direction_to_in() {
        let ev = full_event("c1", 2); // spec 2 = 客户消息
        let r = decode_message_row(&ev, "42").expect("full payload decodes");
        assert_eq!(r.local_message_id, "LM_A");
        assert_eq!(r.conversation_id, "c1");
        assert_eq!(r.employee_id, "42", "employee_id 来自 batch,不在 payload");
        assert_eq!(r.message_direction, 1, "spec 2(客户) → 本地 1(in)");
        assert_eq!(r.content_text, "你好");
        assert!(r.message_time_ms > 0);
    }

    #[test]
    fn decode_translates_our_send_and_sync_to_out() {
        assert_eq!(
            decode_message_row(&full_event("c1", 1), "42").unwrap().message_direction,
            2,
            "spec 1(我方发送) → 本地 2(out)"
        );
        assert_eq!(
            decode_message_row(&full_event("c1", 3), "42").unwrap().message_direction,
            2,
            "spec 3(多端同步=我方) → 本地 2(out)"
        );
    }

    #[test]
    fn decode_missing_required_returns_none() {
        let mut ev = full_event("c1", 2);
        ev["message"].as_object_mut().unwrap().remove("localMessageId");
        assert!(decode_message_row(&ev, "42").is_none(), "缺 localMessageId");

        let mut ev = full_event("c1", 2);
        ev["message"].as_object_mut().unwrap().remove("sortKey");
        assert!(decode_message_row(&ev, "42").is_none(), "缺 sortKey");

        let mut ev = full_event("c1", 2);
        ev.as_object_mut().unwrap().remove("conversationId");
        assert!(decode_message_row(&ev, "42").is_none(), "缺 conversationId");

        let mut ev = full_event("c1", 2);
        ev.as_object_mut().unwrap().remove("message");
        assert!(decode_message_row(&ev, "42").is_none(), "缺 message 快照");
    }

    #[test]
    fn attachments_transferring_detects_pending() {
        let pending = serde_json::json!({ "attachments": [{ "transferStatus": 1 }] });
        assert!(attachments_transferring(&pending));
        let done = serde_json::json!({ "attachments": [{ "transferStatus": 2 }] });
        assert!(!attachments_transferring(&done));
        let none = serde_json::json!({ "attachments": [] });
        assert!(!attachments_transferring(&none));
    }
}
```

- [ ] **Step 4: 运行测试,确认编译并通过**

Run: `cargo test -p chathub-net message_event:: -- --nocapture`
Expected: 4 个测试 PASS（`decode_full_payload_translates_customer_direction_to_in`、`decode_translates_our_send_and_sync_to_out`、`decode_missing_required_returns_none`、`attachments_transferring_detects_pending`）。

- [ ] **Step 5: Commit**

```bash
git add backends/crates/chathub-net/src/message_event.rs \
        backends/crates/chathub-net/src/message_sync.rs \
        backends/crates/chathub-net/src/lib.rs
git commit -m "feat(net): MESSAGE_UPSERT 解码 + 方向翻译 helper"
```

---

## Task 2: MessageEventApplier（apply_push_batch + store 行为）

**Files:**

- Modify: `backends/crates/chathub-net/src/message_event.rs`（加 struct + impl + 测试）

- [ ] **Step 1: 写失败的 applier 行为测试**

在 `backends/crates/chathub-net/src/message_event.rs` 的 `mod tests` 内追加（与 Step 3 的测试并存）：

```rust
    // 以下类型经 `use super::*` 已在作用域内:MessageRow, MessagesStore, MessageSync,
    // PushBatchOut, ChangeNotice, ChangeScope, ChangeTopic, broadcast, Arc。仅补充测试专用导入。
    use chathub_state::{MessageWindow, SqlitePool};
    use crate::hub::HubClient;

    // lazy channel 指向死地址;本任务测试只走直接 upsert / 冷会话路径,绝不触发兜底拨号。
    async fn applier_with_store() -> (MessageEventApplier, MessagesStore, broadcast::Receiver<ChangeNotice>) {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = MessagesStore::new(pool.clone());
        let ep = crate::channel::build_endpoint("http://127.0.0.1:1").expect("ep");
        let channel = ep.connect_lazy();
        let token_store = std::sync::Arc::new(crate::token::TokenStore::new(
            ep,
            chathub_state::LocalTokenStore::new(pool.clone()),
            "dev-test".into(),
        ));
        let interceptor = crate::interceptor::AuthInterceptor::new(token_store);
        let hub = HubClient::new(channel, interceptor);
        let (tx, rx) = broadcast::channel(16);
        let sync = MessageSync::new(store.clone(), hub, tx.clone());
        let applier = MessageEventApplier::new(store.clone(), sync, tx);
        (applier, store, rx)
    }

    fn batch(events: serde_json::Value, employee_id: i64, notify_seq: u64) -> PushBatchOut {
        PushBatchOut {
            notify_seq,
            client_id: "rh_wxchat".into(),
            employee_id,
            batch_id: format!("rh_wxchat:{employee_id}:{notify_seq}"),
            batch_time: "2026-05-14 10:30:00".into(),
            device_id: "dev-test".into(),
            events_json: serde_json::to_vec(&events).unwrap().into(),
        }
    }

    fn seed_window(conv: &str, employee_id: &str, newest_sort_key: &str) -> MessageWindow {
        MessageWindow {
            conversation_id: conv.into(),
            employee_id: employee_id.into(),
            wecom_account_id: "wa-1".into(),
            external_user_id: "ext-1".into(),
            newest_sort_key: newest_sort_key.into(),
            oldest_sort_key: "0000000000000:1:a".into(),
            older_cursor: "cur".into(),
            has_more_older: true,
            newest_message_time_ms: 1,
            last_accessed_ms: 0,
            reconciled_at_ms: 0,
            updated_at_ms: 0,
        }
    }

    #[tokio::test]
    async fn hot_conversation_inserts_bubble_and_emits_notice() {
        let (applier, store, mut rx) = applier_with_store().await;
        store.upsert_window(seed_window("c1", "42", "0000000000000:1:a")).await.unwrap();

        applier
            .apply_push_batch(&batch(serde_json::json!([full_event("c1", 2)]), 42, 10))
            .await;

        let rows = store.list_recent("42", "c1", 10).await.unwrap();
        assert_eq!(rows.len(), 1, "气泡已落库");
        assert_eq!(rows[0].local_message_id, "LM_A");
        assert_eq!(rows[0].message_direction, 1, "客户消息 → in");
        assert_eq!(rows[0].content_text, "你好");

        let w = store.get_window("42", "c1").await.unwrap().unwrap();
        assert_eq!(w.newest_sort_key, "1770000000000:2:00000000000000002001:LM_A", "窗口 newest 扩界");

        let notice = rx.try_recv().expect("ConversationMessages 通知");
        assert_eq!(notice.topic, ChangeTopic::ConversationMessages);
        assert_eq!(notice.scope.conversation_id.as_deref(), Some("c1"));
        assert_eq!(notice.scope.employee_id, "42");
    }

    #[tokio::test]
    async fn cold_conversation_skips_no_orphan() {
        let (applier, store, mut rx) = applier_with_store().await;
        // 不预置窗口 → 冷会话
        applier
            .apply_push_batch(&batch(serde_json::json!([full_event("c1", 2)]), 42, 10))
            .await;
        assert!(store.list_recent("42", "c1", 10).await.unwrap().is_empty(), "不落气泡");
        assert!(store.get_window("42", "c1").await.unwrap().is_none(), "不建孤儿窗口");
        assert!(rx.try_recv().is_err(), "无通知");
    }

    #[tokio::test]
    async fn send_confirmed_updates_same_bubble_not_duplicate() {
        let (applier, store, _rx) = applier_with_store().await;
        store.upsert_window(seed_window("c1", "42", "0000000000000:1:a")).await.unwrap();
        // 先来一条 sendStatus=2(发送中)
        let mut ev = full_event("c1", 1);
        ev["eventReason"] = serde_json::json!("SEND_PENDING_CREATED");
        ev["message"]["sendStatus"] = serde_json::json!(2);
        applier.apply_push_batch(&batch(serde_json::json!([ev]), 42, 10)).await;
        // 再来 SEND_CONFIRMED 同 localMessageId,sendStatus=3
        let mut ev2 = full_event("c1", 1);
        ev2["eventReason"] = serde_json::json!("SEND_CONFIRMED");
        ev2["message"]["sendStatus"] = serde_json::json!(3);
        applier.apply_push_batch(&batch(serde_json::json!([ev2]), 42, 11)).await;

        let rows = store.list_recent("42", "c1", 10).await.unwrap();
        assert_eq!(rows.len(), 1, "同 localMessageId 不新增第二条");
        assert_eq!(rows[0].send_status, 3, "send_status 被刷新");
    }

    #[tokio::test]
    async fn non_message_event_is_noop() {
        let (applier, store, mut rx) = applier_with_store().await;
        store.upsert_window(seed_window("c1", "42", "0000000000000:1:a")).await.unwrap();
        applier
            .apply_push_batch(&batch(
                serde_json::json!([{ "eventType": "ACCOUNT_STATUS_CHANGE", "wecomAccountId": "wa-1" }]),
                42,
                10,
            ))
            .await;
        assert!(store.list_recent("42", "c1", 10).await.unwrap().is_empty());
        assert!(rx.try_recv().is_err());
    }
```

- [ ] **Step 2: 运行测试,确认失败(类型/方法未定义)**

Run: `cargo test -p chathub-net message_event:: 2>&1 | head -30`
Expected: 编译失败，`cannot find type MessageEventApplier` / `no method apply_push_batch`。

- [ ] **Step 3: 实现 MessageEventApplier**

在 `backends/crates/chathub-net/src/message_event.rs` 的 helper 之后、`#[cfg(test)]` 之前插入（注意：`use` 已在文件顶部声明，此处只加类型与 impl）：

```rust
#[derive(Clone)]
pub struct MessageEventApplier {
    store: MessagesStore,
    /// 兜底复用:reconcile_newest(fetch → classify → stitch/replace → upsert window → 发通知)。
    sync: MessageSync,
    change_notice_tx: broadcast::Sender<ChangeNotice>,
    /// 全局兜底节流(同 RecentSessionEventApplier)。
    last_fallback_ms: Arc<AtomicI64>,
}

impl MessageEventApplier {
    pub fn new(
        store: MessagesStore,
        sync: MessageSync,
        change_notice_tx: broadcast::Sender<ChangeNotice>,
    ) -> Self {
        Self {
            store,
            sync,
            change_notice_tx,
            last_fallback_ms: Arc::new(AtomicI64::new(0)),
        }
    }

    /// 处理一批 `PushBatchOut`(对照 `RecentSessionEventApplier::apply_push_batch`)。
    /// 只管气泡;列表摘要由 RecentSessionEventApplier 负责。best-effort,绝不 panic。
    pub async fn apply_push_batch(&self, batch: &PushBatchOut) {
        let employee_id = batch.employee_id.to_string();

        let events: Vec<serde_json::Value> = match serde_json::from_slice(&batch.events_json) {
            Ok(arr) => arr,
            Err(e) => {
                warn!(target: "chathub_net::message_event", ?e, "events_json parse failed, skipping");
                return;
            }
        };

        let mut applied_convs: HashSet<String> = HashSet::new();
        // 需要兜底的会话:(conv, acct, ext)。
        let mut fallback_convs: Vec<(String, String, String)> = Vec::new();
        let mut seen_message_event = false;

        for ev in &events {
            if ev.get("eventType").and_then(|v| v.as_str()) != Some("MESSAGE_UPSERT") {
                continue;
            }
            seen_message_event = true;

            let conv_id = match ev.get("conversationId").and_then(|v| v.as_str()) {
                Some(s) if !s.is_empty() => s.to_string(),
                _ => continue, // 无会话定位,无法落气泡
            };

            // 热会话门控:无窗口 → 冷会话,跳过(recents + 打开时 reconcile 负责)。
            let has_window = match self.store.get_window(&employee_id, &conv_id).await {
                Ok(w) => w.is_some(),
                Err(e) => {
                    warn!(target: "chathub_net::message_event", ?e, conv_id, "get_window failed; skip");
                    continue;
                }
            };
            if !has_window {
                continue;
            }

            let msg = ev.get("message");
            let transferring = msg.map(attachments_transferring).unwrap_or(false);

            match (decode_message_row(ev, &employee_id), transferring) {
                (Some(row), false) => {
                    let sort_key = row.sort_key.clone();
                    let freshness = row.message_time_ms;
                    if let Err(e) = self.store.upsert_messages(&[row]).await {
                        warn!(target: "chathub_net::message_event", ?e, conv_id, "upsert_messages failed; schedule fallback");
                        push_fallback(&mut fallback_convs, ev, &conv_id);
                        continue;
                    }
                    if let Err(e) = self.extend_window_newest(&employee_id, &conv_id, &sort_key, freshness).await {
                        warn!(target: "chathub_net::message_event", ?e, conv_id, "extend_window_newest failed");
                    }
                    applied_convs.insert(conv_id);
                }
                _ => push_fallback(&mut fallback_convs, ev, &conv_id),
            }
        }

        if !seen_message_event {
            return;
        }

        // 直接 upsert 成功的会话各发一条 ConversationMessages 通知。
        for conv in &applied_convs {
            let _ = self.change_notice_tx.send(ChangeNotice::server_upsert(
                ChangeTopic::ConversationMessages,
                ChangeScope {
                    employee_id: employee_id.clone(),
                    conversation_id: Some(conv.clone()),
                    ..Default::default()
                },
            ));
        }

        // 兜底:节流后逐会话 reconcile(reconcile 自己发通知)。
        if !fallback_convs.is_empty() && self.should_run_fallback() {
            for (conv, acct, ext) in &fallback_convs {
                if let Err(e) = self
                    .sync
                    .reconcile_newest(conv, acct, ext, &employee_id, FALLBACK_PAGE_SIZE)
                    .await
                {
                    warn!(target: "chathub_net::message_event", ?e, conv, "reconcile_newest fallback failed");
                }
            }
        }
    }

    /// 扩窗 newest 上界。用真实 sort_key(不被 `~` 出站键污染);只升不降。
    async fn extend_window_newest(
        &self,
        employee_id: &str,
        conversation_id: &str,
        sort_key: &str,
        freshness_ms: i64,
    ) -> Result<(), chathub_state::StateError> {
        if let Some(mut w) = self.store.get_window(employee_id, conversation_id).await? {
            let now = now_unix_ms();
            if sort_key > w.newest_sort_key.as_str() {
                w.newest_sort_key = sort_key.to_string();
            }
            w.newest_message_time_ms = w.newest_message_time_ms.max(freshness_ms);
            w.last_accessed_ms = now;
            w.updated_at_ms = now;
            self.store.upsert_window(w).await?;
        }
        Ok(())
    }

    /// 节流:同一窗口(1s)内多次兜底合并为一次。
    fn should_run_fallback(&self) -> bool {
        let now = now_unix_ms();
        let last = self.last_fallback_ms.load(Ordering::Relaxed);
        if now.saturating_sub(last) < FALLBACK_THROTTLE_MS {
            return false;
        }
        self.last_fallback_ms
            .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok()
    }
}

/// 收集兜底会话定位(去重由后续 reconcile 幂等保证;此处简单 push)。
fn push_fallback(acc: &mut Vec<(String, String, String)>, ev: &serde_json::Value, conv_id: &str) {
    let acct = ev.get("wecomAccountId").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let ext = ev.get("externalUserId").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if !acc.iter().any(|(c, _, _)| c == conv_id) {
        acc.push((conv_id.to_string(), acct, ext));
    }
}
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `cargo test -p chathub-net message_event:: -- --nocapture`
Expected: 全部 PASS（含 Task 1 的 4 个 + 本任务 4 个：`hot_conversation_inserts_bubble_and_emits_notice`、`cold_conversation_skips_no_orphan`、`send_confirmed_updates_same_bubble_not_duplicate`、`non_message_event_is_noop`）。

- [ ] **Step 5: Commit**

```bash
git add backends/crates/chathub-net/src/message_event.rs
git commit -m "feat(net): MessageEventApplier 落气泡 + 扩窗 + 兜底"
```

---

## Task 3: 接线进 ConnectionManager + Tauri 层

**Files:**

- Modify: `backends/crates/chathub-net/src/hub.rs`（`Inner` 字段 + `new` 参数 + dispatch）
- Modify: `backends/src/lib.rs`（构造 applier + 传参）

- [ ] **Step 1: 编辑前跑 impact 分析(CLAUDE.md 强制)**

用 GitNexus MCP 跑 `impact({ target: "ConnectionManager::new", direction: "upstream", repo: "chathub" })`（或 `target: "new", file_path: "backends/crates/chathub-net/src/hub.rs"`）。预期：唯一生产调用点 `backends/src/lib.rs`。若返回 HIGH/CRITICAL，先向用户报告再继续。

- [ ] **Step 2: hub.rs 加 Inner 字段**

在 `backends/crates/chathub-net/src/hub.rs` 的 `struct Inner` 内，`recent_session_event_applier` 字段后加：

```rust
    /// 阶段 4:Subscribe 流里 MESSAGE_UPSERT → 本地消息气泡行存 + broadcast。
    /// 与前三个 applier 并列;PushBatchOut 来时四者都调一次,各自按 eventType 筛分支。
    message_event_applier: Option<Arc<MessageEventApplier>>,
```

并在文件顶部 use 区加：

```rust
use crate::message_event::MessageEventApplier;
```

- [ ] **Step 3: hub.rs 加 new 参数 + 初始化字段**

在 `ConnectionManager::new` 参数列表中，`recent_session_event_applier` 之后、`change_notice_tx` 之前加：

```rust
        message_event_applier: Option<Arc<MessageEventApplier>>,
```

在 `Inner { ... }` 构造里，`recent_session_event_applier,` 之后加：

```rust
                message_event_applier,
```

- [ ] **Step 4: hub.rs dispatch loop 调用 applier**

在 dispatch loop 里，`recent_session_event_applier` 调用块之后（推进 `notify_seq_store` 之前）加：

```rust
                                // 阶段 4:消息气泡(MESSAGE_UPSERT)→ 本地 hub_conversation_messages。
                                // 内部按 eventType 过滤,非命中直接返回。
                                if let Some(applier) = &self.message_event_applier {
                                    applier.apply_push_batch(pb).await;
                                }
```

- [ ] **Step 5: backends/src/lib.rs 构造 applier 并传参**

在 `backends/src/lib.rs` 的 `use chathub_net::{...}` 导入里加 `MessageEventApplier`。

在 `recent_applier` 构造之后（`ConnectionManager::new` 调用之前）加：

```rust
                // 阶段 4:Subscribe 流里 MESSAGE_UPSERT → MessagesStore 气泡 + broadcast。
                let message_applier = Arc::new(MessageEventApplier::new(
                    messages_store.clone(),
                    message_sync.clone(),
                    change_notice_tx.clone(),
                ));
```

在 `ConnectionManager::new(...)` 调用里，`Some(recent_applier),` 之后、`change_notice_tx.clone(),` 之前加：

```rust
                    Some(message_applier),
```

- [ ] **Step 6: 编译 + 全量单测**

Run: `cargo build -p chathub-net -p chathub && cargo test -p chathub-net`
Expected: 编译通过；现有 + 新增测试全绿。

- [ ] **Step 7: Commit**

```bash
git add backends/crates/chathub-net/src/hub.rs backends/src/lib.rs
git commit -m "feat: 接线 MessageEventApplier 进 ConnectionManager 与 Tauri setup"
```

---

## Task 4: ConnectionManager 对接 e2e

**Files:**

- Create: `backends/crates/chathub-net/tests/message_e2e.rs`

- [ ] **Step 1: 写 e2e 测试(先失败)**

创建 `backends/crates/chathub-net/tests/message_e2e.rs`：

```rust
//! 对接回复消息流程 e2e:ConnectionManager ↔ stub_relay。
//! 注入 MESSAGE_UPSERT 帧 → 断言气泡落进 MessagesStore(热会话直接 upsert 路径)。

mod common;

use chathub_net::change_notice::ChangeNotice;
use chathub_net::hub::ConnectionState;
use chathub_net::{
    AuthInterceptor, BackoffConfig, ConnectionManager, HubClient, MessageEventApplier, MessageSync,
    TokenStore,
};
use chathub_proto::v1::{server_event::Body, PushBatchOut, ServerEvent};
use chathub_state::{LocalTokenStore, MessageWindow, MessagesStore, NotifySeqStore, SqlitePool};
use common::stub_relay::start_stub_full;
use common::{push_event, wait_for_state};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast;

fn message_upsert_event(conv: &str) -> serde_json::Value {
    serde_json::json!({
        "eventType": "MESSAGE_UPSERT",
        "eventReason": "CUSTOMER_MESSAGE_RECEIVED",
        "conversationId": conv,
        "wecomAccountId": "wa-1",
        "externalUserId": "ext-1",
        "message": {
            "localMessageId": "LM_E2E",
            "messageDirection": 2,
            "messageType": 1,
            "sendStatus": 3,
            "sortKey": "1770000000000:2:00000000000000009001:LM_E2E",
            "messageTime": "2026-05-14 10:30:00",
            "contentText": "在吗",
            "contentSummary": "在吗",
            "attachments": []
        }
    })
}

#[tokio::test]
async fn message_upsert_lands_bubble_via_connection_manager() {
    let (addr, _auth_state, hub_state, _h) = start_stub_full().await;

    let ep = chathub_net::build_endpoint(format!("http://{addr}")).expect("ep");
    let channel = ep.connect_lazy();
    let pool = SqlitePool::in_memory().await.unwrap();
    let local = LocalTokenStore::new(pool.clone());
    let token_store = Arc::new(TokenStore::new(ep, local, "dev-1".into()));
    token_store.login("alice", "pwd").await.expect("login");

    let interceptor = AuthInterceptor::new(token_store.clone());
    let hub = HubClient::new(channel, interceptor);

    let messages_store = MessagesStore::new(pool.clone());
    let notify_seq_store = NotifySeqStore::new(pool.clone());
    let (change_tx, mut change_rx) = broadcast::channel::<ChangeNotice>(64);
    let sync = MessageSync::new(messages_store.clone(), hub.clone(), change_tx.clone());
    let message_applier = Arc::new(MessageEventApplier::new(
        messages_store.clone(),
        sync,
        change_tx.clone(),
    ));

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
        Some(message_applier),
        change_tx.clone(),
    ));

    // 预置热会话窗口(employee 42 与推送 batch 对齐)。
    messages_store
        .upsert_window(MessageWindow {
            conversation_id: "c-e2e".into(),
            employee_id: "42".into(),
            wecom_account_id: "wa-1".into(),
            external_user_id: "ext-1".into(),
            newest_sort_key: "0000000000000:1:seed".into(),
            oldest_sort_key: "0000000000000:1:seed".into(),
            older_cursor: "cur".into(),
            has_more_older: true,
            newest_message_time_ms: 1,
            last_accessed_ms: 0,
            reconciled_at_ms: 0,
            updated_at_ms: 0,
        })
        .await
        .unwrap();

    cm.start().await;
    let mut state_rx = cm.state_subscribe();
    wait_for_state(
        &mut state_rx,
        |s| matches!(s, ConnectionState::Subscribed),
        Duration::from_secs(5),
    )
    .await;

    // 注入 MESSAGE_UPSERT 帧。
    let events = serde_json::json!([message_upsert_event("c-e2e")]);
    let pb = PushBatchOut {
        notify_seq: 1,
        client_id: "rh_wxchat".into(),
        employee_id: 42,
        batch_id: "rh_wxchat:42:1".into(),
        batch_time: "2026-05-14 10:30:00".into(),
        device_id: "dev-1".into(),
        events_json: serde_json::to_vec(&events).unwrap().into(),
    };
    push_event(
        &hub_state,
        ServerEvent { body: Some(Body::PushBatch(pb)) },
    )
    .await;

    // 轮询直到气泡出现(applier 异步处理)。
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        let rows = messages_store.list_recent("42", "c-e2e", 10).await.unwrap();
        if let Some(r) = rows.iter().find(|r| r.local_message_id == "LM_E2E") {
            assert_eq!(r.content_text, "在吗");
            assert_eq!(r.message_direction, 1, "spec 2(客户) → 本地 1(in)");
            assert_eq!(r.sort_key, "1770000000000:2:00000000000000009001:LM_E2E");
            break;
        }
        if std::time::Instant::now() > deadline {
            panic!("bubble did not land within 5s");
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // 应至少收到一条 ConversationMessages 通知。
    let mut saw_notice = false;
    while let Ok(n) = change_rx.try_recv() {
        if matches!(n.topic, chathub_net::change_notice::ChangeTopic::ConversationMessages)
            && n.scope.conversation_id.as_deref() == Some("c-e2e")
        {
            saw_notice = true;
        }
    }
    assert!(saw_notice, "应发出 ConversationMessages 通知");

    cm.stop().await;
}
```

- [ ] **Step 2: 运行 e2e,确认通过**

Run: `cargo test -p chathub-net --test message_e2e -- --nocapture`
Expected: `message_upsert_lands_bubble_via_connection_manager` PASS。

> 若编译报 `ConnectionState` / `BackoffConfig` / `MessageSync` 等未导出：确认 `chathub-net/src/lib.rs` 的 `pub use hub::*;` 已覆盖（`ConnectionManager`/`HubClient`/`ConnectionState`/`BackoffConfig` 来自 hub）；`MessageSync`/`TokenStore`/`AuthInterceptor`/`MessageEventApplier` 来自 lib.rs 顶层 `pub use`。`change_notice` 为 `pub mod`，路径 `chathub_net::change_notice::*` 可用。

- [ ] **Step 3: Commit**

```bash
git add backends/crates/chathub-net/tests/message_e2e.rs
git commit -m "test(net): MESSAGE_UPSERT 落气泡对接 e2e"
```

---

## Task 5: 收尾 — detect_changes + 全量验证

- [ ] **Step 1: 跑 GitNexus detect_changes(CLAUDE.md 强制,提交前)**

`detect_changes({ repo: "chathub", scope: "all" })`，确认受影响符号/流程仅限：`MessageEventApplier`、`ConnectionManager::new`、hub dispatch、Tauri setup、message_sync 时间 helper。无意外波及报告给用户。

- [ ] **Step 2: 全量构建 + 测试**

Run: `cargo build && cargo test -p chathub-net -p chathub`
Expected: 编译通过；全测试绿（含既有 friend/recent/relay 用例无回归）。

- [ ] **Step 3: clippy**

Run: `cargo clippy -p chathub-net -- -D warnings`
Expected: 无告警（注意未用 import / `too_many_arguments` —— `ConnectionManager::new` 已有 `#[allow(clippy::too_many_arguments)]`）。

- [ ] **Step 4: 最终确认无遗漏**

确认验收清单（spec §9）：客户回复落气泡（in）、SEND_CONFIRMED 更新原气泡、冷会话不落、瘦 payload 兜底、单元 + e2e 全绿。

---

## Self-Review notes

- **Spec coverage**：MessageEventApplier（spec §4）✓；Hybrid + 热会话门控（§4）✓；方向翻译（§3）✓；接线 blast radius（§7）✓；单元 + CM e2e（§8）✓；revoke/delete 非目标，未建任务（符合 §2）✓。
- **Type 一致性**：`MessageRow`/`MessageWindow`/`PushBatchOut`/`ChangeScope`/`ChangeTopic::ConversationMessages` 均与现有定义对齐；`reconcile_newest(conv, acct, ext, employee, page_size)` 参数顺序与 `message_sync.rs` 一致；`ConnectionManager::new` 第 4 个 applier 插在 recent 之后、change_notice 之前，两处调用点（Tauri setup + e2e）参数顺序一致。
- **Placeholder**：Step 草稿里的 `dead_hub`/`dummy_local_token_store` 已在 Task 2 Step 3 明确要求删除，最终代码不引用。
