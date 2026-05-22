//! 好友(客户)事件应用器:Subscribe 流里 FRIEND_* 事件 → 推进 notifySeq 水位 + 广播 ChangeNotice。
//!
//! 客户列表已退役本地全量镜像,改纯 cursor 滚动(`list_friends` 直接透传业务后台 keyset 分页)。
//! 因此 FRIEND_* 事件不再写本地行存 —— 只需:
//!   1. 推进 per-resource watermark(取大不取小,应对 relay redelivery);
//!   2. emit ChangeNotice → 前端 useResource 重拉首页。新增好友按 `add_time DESC` 天然浮顶,
//!      删除好友首页重拉后消失,信息变更同理。无需在客户端区分 reason / patch 单行。
//!
//! scope 选择:本批事件仅涉单账号 → scoped Upsert(其他账号订阅者不被打扰);
//! 涉多账号 → employee 维度广义 Upsert。

use crate::change_notice::{ChangeNotice, ChangeScope, ChangeTopic};
use chathub_proto::v1::PushBatchOut;
use chathub_state::FriendsStore;
use std::collections::HashSet;
use tokio::sync::broadcast;
use tracing::warn;

#[derive(Clone)]
pub struct FriendEventApplier {
    /// 仅用于推进 per-resource watermark;客户列表已无本地行存。
    store: FriendsStore,
    /// 统一变更通知通道。
    change_notice_tx: broadcast::Sender<ChangeNotice>,
}

impl FriendEventApplier {
    pub fn new(store: FriendsStore, change_notice_tx: broadcast::Sender<ChangeNotice>) -> Self {
        Self {
            store,
            change_notice_tx,
        }
    }

    /// 处理一批 `PushBatchOut`(对照 `AccountEventApplier::apply_push_batch`)。
    pub async fn apply_push_batch(&self, batch: &PushBatchOut) {
        let employee_id = batch.employee_id.to_string();

        let events: Vec<serde_json::Value> = match serde_json::from_slice(&batch.events_json) {
            Ok(arr) => arr,
            Err(e) => {
                warn!(
                    target: "chathub_net::friend_event",
                    ?e,
                    "events_json parse failed, skipping"
                );
                return;
            }
        };

        // 只关心 FRIEND_* 事件涉及的账号集合;具体 reason 不再分支(纯 refetch 语义)。
        let mut accounts_in_batch: HashSet<String> = HashSet::new();
        let mut friend_event_seen = false;
        for ev in &events {
            let event_type = ev.get("eventType").and_then(|v| v.as_str()).unwrap_or("");
            if event_type != "FRIEND_BINDING_CHANGE" && event_type != "FRIEND_STATUS_CHANGE" {
                continue;
            }
            friend_event_seen = true;
            if let Some(acct) = ev.get("wecomAccountId").and_then(|v| v.as_str()) {
                accounts_in_batch.insert(acct.to_string());
            }
        }

        if !friend_event_seen {
            return;
        }

        if let Err(e) = self
            .store
            .advance_watermark(&batch.client_id, &employee_id, batch.notify_seq)
            .await
        {
            warn!(target: "chathub_net::friend_event", ?e, "advance_watermark failed");
        }

        // 单账号 → scoped;多账号 → employee 维度广义。
        let scope_account = if accounts_in_batch.len() == 1 {
            accounts_in_batch.into_iter().next()
        } else {
            None
        };
        let _ = self.change_notice_tx.send(ChangeNotice::server_upsert(
            ChangeTopic::Friends,
            ChangeScope {
                employee_id,
                wecom_account_id: scope_account,
                ..Default::default()
            },
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chathub_proto::v1::PushBatchOut;
    use chathub_state::{FriendsStore, SqlitePool};

    async fn applier() -> (FriendEventApplier, broadcast::Receiver<ChangeNotice>) {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = FriendsStore::new(pool);
        let (tx, rx) = broadcast::channel(16);
        (FriendEventApplier::new(store, tx), rx)
    }

    fn batch(events: serde_json::Value, notify_seq: u64) -> PushBatchOut {
        PushBatchOut {
            notify_seq,
            client_id: "c-1".into(),
            employee_id: 42,
            batch_id: "c-1:42:0".into(),
            batch_time: "2026-05-21 10:00:00".into(),
            device_id: "dev-test".into(),
            events_json: serde_json::to_vec(&events).unwrap().into(),
        }
    }

    #[tokio::test]
    async fn single_account_friend_event_emits_scoped_upsert() {
        let (applier, mut rx) = applier().await;
        let b = batch(
            serde_json::json!([{
                "eventType": "FRIEND_BINDING_CHANGE",
                "eventReason": "FRIEND_ADDED",
                "wecomAccountId": "wa-1",
                "externalUserId": "wo-1"
            }]),
            10,
        );
        applier.apply_push_batch(&b).await;
        let notice = rx.try_recv().expect("a ChangeNotice should be emitted");
        assert_eq!(notice.topic, ChangeTopic::Friends);
        assert_eq!(notice.scope.employee_id, "42");
        assert_eq!(notice.scope.wecom_account_id.as_deref(), Some("wa-1"));
        assert_eq!(applier.store.get_watermark("c-1", "42").await.unwrap(), 10);
    }

    #[tokio::test]
    async fn multi_account_friend_event_emits_employee_scope() {
        let (applier, mut rx) = applier().await;
        let b = batch(
            serde_json::json!([
                {"eventType": "FRIEND_BINDING_CHANGE", "eventReason": "FRIEND_ADDED", "wecomAccountId": "wa-1", "externalUserId": "wo-1"},
                {"eventType": "FRIEND_BINDING_CHANGE", "eventReason": "FRIEND_REMOVED", "wecomAccountId": "wa-2", "externalUserId": "wo-2"}
            ]),
            11,
        );
        applier.apply_push_batch(&b).await;
        let notice = rx.try_recv().expect("a ChangeNotice should be emitted");
        assert!(
            notice.scope.wecom_account_id.is_none(),
            "multi-account → employee scope"
        );
    }

    #[tokio::test]
    async fn non_friend_batch_emits_nothing() {
        let (applier, mut rx) = applier().await;
        let b = batch(
            serde_json::json!([{"eventType": "ACCOUNT_STATUS_CHANGE", "wecomAccountId": "wa-1"}]),
            12,
        );
        applier.apply_push_batch(&b).await;
        assert!(rx.try_recv().is_err(), "no friend event → no notice");
        // watermark 也不应推进(本 applier 只对自己的事件负责)
        assert_eq!(applier.store.get_watermark("c-1", "42").await.unwrap(), 0);
    }
}
