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

/// 上游消息方向 → 本地约定。本地:1=入站(in),2=出站(out)。
/// 上游:1=发送方,2=客户/接收方,3=多端同步方。
pub(crate) fn to_local_direction(direction: i64) -> i32 {
    match direction {
        1 | 3 => 2,
        _ => 1,
    }
}

fn str_or_empty(v: &serde_json::Value, key: &str) -> String {
    v.get(key)
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string()
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

/// 把一个 `MESSAGE_UPSERT` 事件 Value 解码为 `MessageRow`(含方向收敛)。
/// 必填:`message.localMessageId` / `message.sortKey` / 事件级 `conversationId` 非空。
/// 缺失 → None(调用者走兜底)。`employee_id` 来自 batch,不在 payload。
fn decode_message_row(ev: &serde_json::Value, employee_id: &str) -> Option<MessageRow> {
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
    // 缺省按客户/接收方处理,避免缺方向时误画成我方发送。
    let direction = msg
        .get("messageDirection")
        .and_then(|v| v.as_i64())
        .unwrap_or(2);
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
        message_direction: to_local_direction(direction),
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
                    if let Err(e) = self
                        .extend_window_newest(&employee_id, &conv_id, &sort_key, freshness)
                        .await
                    {
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
        // `~` 开头是出站乐观气泡的本地排序键,绝不能污染窗口真实 newest 位置。
        if sort_key.starts_with('~') {
            return Ok(());
        }
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

/// 收集兜底会话定位,按 conv_id 去重(同一 batch 内同会话只兜底一次)。
fn push_fallback(acc: &mut Vec<(String, String, String)>, ev: &serde_json::Value, conv_id: &str) {
    let acct = ev
        .get("wecomAccountId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let ext = ev
        .get("externalUserId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if !acc.iter().any(|(c, _, _)| c == conv_id) {
        acc.push((conv_id.to_string(), acct, ext));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn full_event(conv: &str, direction: i64) -> serde_json::Value {
        serde_json::json!({
            "eventType": "MESSAGE_UPSERT",
            "eventReason": "CUSTOMER_MESSAGE_RECEIVED",
            "conversationId": conv,
            "wecomAccountId": "wa-1",
            "externalUserId": "ext-1",
            "message": {
                "localMessageId": "LM_A",
                "messageDirection": direction,
                "messageType": 1,
                "sendStatus": 3,
                "sortKey": format!("1770000000000:{direction}:00000000000000002001:LM_A"),
                "messageTime": "2026-05-14 10:30:00",
                "contentText": "你好",
                "contentSummary": "你好",
                "attachments": []
            }
        })
    }

    #[test]
    fn decode_full_payload_translates_customer_direction_to_in() {
        let ev = full_event("c1", 2); // 2 = 客户/接收方
        let r = decode_message_row(&ev, "42").expect("full payload decodes");
        assert_eq!(r.local_message_id, "LM_A");
        assert_eq!(r.conversation_id, "c1");
        assert_eq!(r.employee_id, "42", "employee_id 来自 batch,不在 payload");
        assert_eq!(r.message_direction, 1, "2=客户/接收方 → 本地 1(in)");
        assert_eq!(r.content_text, "你好");
        assert!(r.message_time_ms > 0);
    }

    #[test]
    fn decode_translates_sender_and_sync_to_out() {
        assert_eq!(
            decode_message_row(&full_event("c1", 1), "42")
                .unwrap()
                .message_direction,
            2,
            "1=发送方 → 本地 2(out)"
        );
        assert_eq!(
            decode_message_row(&full_event("c1", 3), "42")
                .unwrap()
                .message_direction,
            2,
            "3=多端同步方 → 本地 2(out)"
        );
    }

    #[test]
    fn decode_missing_required_returns_none() {
        let mut ev = full_event("c1", 2);
        ev["message"]
            .as_object_mut()
            .unwrap()
            .remove("localMessageId");
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
        let missing = serde_json::json!({});
        assert!(
            !attachments_transferring(&missing),
            "无 attachments 键 → 不算转存中"
        );
    }

    // 以下类型经 `use super::*` 已在作用域内:MessageRow, MessagesStore, MessageSync,
    // PushBatchOut, ChangeNotice, ChangeScope, ChangeTopic, broadcast, Arc。仅补充测试专用导入。
    use crate::hub::HubClient;
    use chathub_state::{MessageWindow, SqlitePool};

    // lazy channel 指向死地址;本任务测试只走直接 upsert / 冷会话路径,绝不触发兜底拨号。
    async fn applier_with_store() -> (
        MessageEventApplier,
        MessagesStore,
        broadcast::Receiver<ChangeNotice>,
    ) {
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
        store
            .upsert_window(seed_window("c1", "42", "0000000000000:1:a"))
            .await
            .unwrap();

        applier
            .apply_push_batch(&batch(serde_json::json!([full_event("c1", 2)]), 42, 10))
            .await;

        let rows = store.list_recent("42", "c1", 10).await.unwrap();
        assert_eq!(rows.len(), 1, "气泡已落库");
        assert_eq!(rows[0].local_message_id, "LM_A");
        assert_eq!(rows[0].message_direction, 1, "客户消息 → in");
        assert_eq!(rows[0].content_text, "你好");

        let w = store.get_window("42", "c1").await.unwrap().unwrap();
        assert_eq!(
            w.newest_sort_key, "1770000000000:2:00000000000000002001:LM_A",
            "窗口 newest 扩界"
        );

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
        assert!(
            store.list_recent("42", "c1", 10).await.unwrap().is_empty(),
            "不落气泡"
        );
        assert!(
            store.get_window("42", "c1").await.unwrap().is_none(),
            "不建孤儿窗口"
        );
        assert!(rx.try_recv().is_err(), "无通知");
    }

    #[tokio::test]
    async fn send_confirmed_updates_same_bubble_not_duplicate() {
        let (applier, store, _rx) = applier_with_store().await;
        store
            .upsert_window(seed_window("c1", "42", "0000000000000:1:a"))
            .await
            .unwrap();
        // 先来一条 sendStatus=2(发送中)
        let mut ev = full_event("c1", 1);
        ev["eventReason"] = serde_json::json!("SEND_PENDING_CREATED");
        ev["message"]["sendStatus"] = serde_json::json!(2);
        applier
            .apply_push_batch(&batch(serde_json::json!([ev]), 42, 10))
            .await;
        // 再来 SEND_CONFIRMED 同 localMessageId,sendStatus=3
        let mut ev2 = full_event("c1", 1);
        ev2["eventReason"] = serde_json::json!("SEND_CONFIRMED");
        ev2["message"]["sendStatus"] = serde_json::json!(3);
        applier
            .apply_push_batch(&batch(serde_json::json!([ev2]), 42, 11))
            .await;

        let rows = store.list_recent("42", "c1", 10).await.unwrap();
        assert_eq!(rows.len(), 1, "同 localMessageId 不新增第二条");
        assert_eq!(rows[0].send_status, 3, "send_status 被刷新");
    }

    #[tokio::test]
    async fn non_message_event_is_noop() {
        let (applier, store, mut rx) = applier_with_store().await;
        store
            .upsert_window(seed_window("c1", "42", "0000000000000:1:a"))
            .await
            .unwrap();
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
}
