//! 好友(客户)事件应用器:Subscribe 流里 FRIEND_* 事件 → 本地 SQLite 行存 + 广播给 Tauri 层。
//!
//! 分发约定(占位,联调时按业务后台契约校正):
//!   - `FRIEND_BINDING_CHANGE` 3 个 reason:`FRIEND_ADDED` / `FRIEND_UPDATED` / `FRIEND_REMOVED`
//!     → 各自映射到 [`FriendBindingAction`]。
//!   - `FRIEND_STATUS_CHANGE`:reason 列表 TBD,先一律走 fallback(全量重拉该账号)。
//!   - 任一事件 payload 缺关键字段 → fallback。
//!
//! Fallback 走 `HubClient::list_all_friends_for_account(wecom_account_id)` 全量拉一次 +
//! `FriendsStore::replace_all_for_account`。即使业务后台 payload 慢慢补齐过程中,
//! 客户端不会停摆 —— 数据最终一致,只是多一次远程往返。
//!
//! 幂等性:`FriendsStore::apply_binding` 内 SQL 都自然幂等;watermark 走"取大不取小"。
//! 同 notify_seq 重投不会重复处理。
//!
//! 跟 `account_event.rs` 同构,只是 store / action 类型不同。

use crate::error::AuthError;
use crate::hub::HubClient;
use chathub_proto::v1::PushBatchOut;
use chathub_state::{FriendBindingAction, FriendsStore, WecomFriendRow};
use tokio::sync::broadcast;
use tracing::warn;

/// 广播给上层(backends/src/lib.rs)的"好友缓存有变化"信号。前端 listen 后可以
/// 按 `wecom_account_id` 决定要不要 refetch(本地行存已被 applier 更新,通常只需 refetch UI)。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FriendChanged {
    /// 受影响 employee 的 String 形态 ID(= UserProfile.user_id)。
    pub employee_id: String,
    /// 受影响的账号 ID。`None` 表示无法定位到具体账号(fallback 重拉所有受影响账号)。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wecom_account_id: Option<String>,
}

#[derive(Clone)]
pub struct FriendEventApplier {
    store: FriendsStore,
    hub: HubClient,
    event_tx: broadcast::Sender<FriendChanged>,
}

impl FriendEventApplier {
    pub fn new(store: FriendsStore, hub: HubClient) -> Self {
        let (tx, _) = broadcast::channel(64);
        Self {
            store,
            hub,
            event_tx: tx,
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<FriendChanged> {
        self.event_tx.subscribe()
    }

    /// 处理一批 PushBatchOut(对照 `AccountEventApplier::apply_push_batch`)。
    pub async fn apply_push_batch(&self, batch: &PushBatchOut) {
        let employee_id_str = batch.employee_id.to_string();

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

        let mut friend_event_seen = false;
        // 收集所有触发 fallback 的 wecom_account_id;批结束后逐个全量重拉,避免同一账号
        // 在同批多个事件里被重拉多次。
        let mut fallback_accounts: std::collections::HashSet<String> =
            std::collections::HashSet::new();
        let mut applied = 0usize;

        for ev in &events {
            let event_type = ev.get("eventType").and_then(|v| v.as_str()).unwrap_or("");
            if event_type != "FRIEND_BINDING_CHANGE" && event_type != "FRIEND_STATUS_CHANGE" {
                continue;
            }
            friend_event_seen = true;
            let reason = ev.get("eventReason").and_then(|v| v.as_str()).unwrap_or("");
            match decode_action(event_type, reason, ev) {
                Decoded::Action(action) => {
                    if let Err(e) = self.store.apply_binding(action).await {
                        warn!(
                            target: "chathub_net::friend_event",
                            ?e,
                            "apply_binding failed, scheduling fallback"
                        );
                        if let Some(acct) = ev.get("wecomAccountId").and_then(|v| v.as_str()) {
                            fallback_accounts.insert(acct.to_string());
                        }
                    } else {
                        applied += 1;
                    }
                }
                Decoded::Fallback(detail) => {
                    warn!(
                        target: "chathub_net::friend_event",
                        event_type,
                        reason,
                        detail,
                        "incomplete/unsupported friend event, scheduling fallback refetch"
                    );
                    if let Some(acct) = ev.get("wecomAccountId").and_then(|v| v.as_str()) {
                        fallback_accounts.insert(acct.to_string());
                    }
                }
            }
        }

        if !friend_event_seen {
            return;
        }

        // 逐个 fallback 重拉,失败仅 log;watermark 仍前进,等下一批事件 / 下次手动刷新兜
        for acct in &fallback_accounts {
            if let Err(e) = self.fallback_refetch_account(acct, &employee_id_str).await {
                warn!(
                    target: "chathub_net::friend_event",
                    wecom_account_id = %acct,
                    ?e,
                    "fallback list_all_friends_for_account failed"
                );
            }
        }

        if let Err(e) = self
            .store
            .advance_watermark(&batch.client_id, &employee_id_str, batch.notify_seq)
            .await
        {
            warn!(target: "chathub_net::friend_event", ?e, "advance_watermark failed");
        }

        // 广播:applied 成功的全部用 wecom_account_id=None 一次广播即可,前端按需 refetch UI;
        // fallback 影响的账号单独广播(让前端可选择性高亮"该账号已刷新")。
        if applied > 0 && fallback_accounts.is_empty() {
            let _ = self.event_tx.send(FriendChanged {
                employee_id: employee_id_str.clone(),
                wecom_account_id: None,
            });
        }
        for acct in fallback_accounts {
            let _ = self.event_tx.send(FriendChanged {
                employee_id: employee_id_str.clone(),
                wecom_account_id: Some(acct),
            });
        }
    }

    async fn fallback_refetch_account(
        &self,
        wecom_account_id: &str,
        employee_id: &str,
    ) -> Result<(), AuthError> {
        let friends = self
            .hub
            .list_all_friends_for_account(wecom_account_id)
            .await?;
        let rows: Vec<WecomFriendRow> = friends
            .into_iter()
            .map(|f| friend_to_row(f, wecom_account_id))
            .collect();
        let total = rows.len() as u64;
        self.store
            .replace_all_for_account(wecom_account_id, &rows)
            .await
            .map_err(|e| AuthError::Internal {
                message: format!("friends replace_all failed: {e}"),
            })?;
        self.store
            .mark_synced(wecom_account_id, employee_id, total)
            .await
            .map_err(|e| AuthError::Internal {
                message: format!("friends mark_synced failed: {e}"),
            })?;
        Ok(())
    }
}

/// 把 API 响应的 `WecomFriend`(20 字段)+ 查询时的 `wecom_account_id` 归属,
/// 转成行存 `WecomFriendRow`(21 字段)。
pub fn friend_to_row(f: crate::hub::WecomFriend, wecom_account_id: &str) -> WecomFriendRow {
    WecomFriendRow {
        wecom_account_id: wecom_account_id.to_string(),
        external_user_id: f.external_user_id,
        external_name: f.external_name,
        external_position: f.external_position,
        external_avatar: f.external_avatar,
        external_corp_name: f.external_corp_name,
        external_corp_full_name: f.external_corp_full_name,
        external_type: f.external_type,
        external_gender: f.external_gender,
        external_mobile: f.external_mobile,
        follow_remark: f.follow_remark,
        follow_description: f.follow_description,
        remark_corp_name: f.remark_corp_name,
        add_time: f.add_time,
        add_way: f.add_way,
        follow_state: f.follow_state,
        wechat_channels_nickname: f.wechat_channels_nickname,
        wechat_channels_source: f.wechat_channels_source,
        last_sync_time: f.last_sync_time,
        sync_status: f.sync_status,
    }
}

// 临时返回值:由 decode_action 产出后立即 match 消费,从不存进集合 / clone。
// 大 variant 在栈上一过性,Box 化只会给好友事件热路径加一次堆分配换零收益。
#[allow(clippy::large_enum_variant)]
enum Decoded {
    Action(FriendBindingAction),
    Fallback(&'static str),
}

fn decode_action(event_type: &str, reason: &str, ev: &serde_json::Value) -> Decoded {
    if event_type == "FRIEND_STATUS_CHANGE" {
        return Decoded::Fallback("FRIEND_STATUS_CHANGE reason map TBD by backend");
    }
    // FRIEND_BINDING_CHANGE
    let wecom_account_id = match ev.get("wecomAccountId").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return Decoded::Fallback("missing wecomAccountId"),
    };
    match reason {
        "FRIEND_ADDED" => match decode_full_row(ev, &wecom_account_id) {
            Some(row) => Decoded::Action(FriendBindingAction::Added(row)),
            None => Decoded::Fallback("FRIEND_ADDED missing required field(s)"),
        },
        "FRIEND_UPDATED" => match decode_full_row(ev, &wecom_account_id) {
            Some(row) => Decoded::Action(FriendBindingAction::Updated(row)),
            None => Decoded::Fallback("FRIEND_UPDATED missing required field(s)"),
        },
        "FRIEND_REMOVED" => {
            let external_user_id = match ev.get("externalUserId").and_then(|v| v.as_str()) {
                Some(s) => s.to_string(),
                None => return Decoded::Fallback("FRIEND_REMOVED missing externalUserId"),
            };
            Decoded::Action(FriendBindingAction::Removed {
                wecom_account_id,
                external_user_id,
            })
        }
        _ => Decoded::Fallback("unknown FRIEND_BINDING_CHANGE reason"),
    }
}

fn decode_full_row(ev: &serde_json::Value, wecom_account_id: &str) -> Option<WecomFriendRow> {
    Some(WecomFriendRow {
        wecom_account_id: wecom_account_id.to_string(),
        external_user_id: ev.get("externalUserId")?.as_str()?.to_string(),
        external_name: ev.get("externalName")?.as_str()?.to_string(),
        external_position: ev
            .get("externalPosition")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        external_avatar: ev
            .get("externalAvatar")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        external_corp_name: ev
            .get("externalCorpName")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        external_corp_full_name: ev
            .get("externalCorpFullName")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        external_type: ev.get("externalType")?.as_i64()? as i32,
        external_gender: ev
            .get("externalGender")
            .and_then(|v| v.as_i64())
            .unwrap_or(0) as i32,
        external_mobile: ev
            .get("externalMobile")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        follow_remark: ev
            .get("followRemark")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        follow_description: ev
            .get("followDescription")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        remark_corp_name: ev
            .get("remarkCorpName")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        add_time: ev
            .get("addTime")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        add_way: ev.get("addWay").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
        follow_state: ev
            .get("followState")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        wechat_channels_nickname: ev
            .get("wechatChannelsNickname")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        wechat_channels_source: ev
            .get("wechatChannelsSource")
            .and_then(|v| v.as_i64())
            .unwrap_or(0) as i32,
        last_sync_time: ev
            .get("lastSyncTime")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        sync_status: ev.get("syncStatus").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn full_added_event() -> serde_json::Value {
        serde_json::json!({
            "eventType": "FRIEND_BINDING_CHANGE",
            "eventReason": "FRIEND_ADDED",
            "wecomAccountId": "wa-1",
            "externalUserId": "wo-1",
            "externalName": "张三",
            "externalPosition": "产品",
            "externalAvatar": "https://example.com/a.png",
            "externalCorpName": "某科技",
            "externalCorpFullName": "某科技有限公司",
            "externalType": 1,
            "externalGender": 1,
            "externalMobile": "138****0001",
            "followRemark": "",
            "followDescription": "",
            "remarkCorpName": "",
            "addTime": "2025-01-01 09:00:00",
            "addWay": 1,
            "followState": "channel_state_001",
            "wechatChannelsNickname": "",
            "wechatChannelsSource": 0,
            "lastSyncTime": "2025-01-01 09:00:00",
            "syncStatus": 1
        })
    }

    #[test]
    fn friend_added_decodes_to_action() {
        let ev = full_added_event();
        match decode_action("FRIEND_BINDING_CHANGE", "FRIEND_ADDED", &ev) {
            Decoded::Action(FriendBindingAction::Added(row)) => {
                assert_eq!(row.wecom_account_id, "wa-1");
                assert_eq!(row.external_user_id, "wo-1");
                assert_eq!(row.external_name, "张三");
            }
            _ => panic!("expected Added action"),
        }
    }

    #[test]
    fn friend_updated_decodes_to_action() {
        let mut ev = full_added_event();
        ev["eventReason"] = serde_json::Value::String("FRIEND_UPDATED".into());
        ev["followRemark"] = serde_json::Value::String("已成交".into());
        match decode_action("FRIEND_BINDING_CHANGE", "FRIEND_UPDATED", &ev) {
            Decoded::Action(FriendBindingAction::Updated(row)) => {
                assert_eq!(row.follow_remark, "已成交");
            }
            _ => panic!("expected Updated action"),
        }
    }

    #[test]
    fn friend_removed_decodes_to_action() {
        let ev = serde_json::json!({
            "eventType": "FRIEND_BINDING_CHANGE",
            "eventReason": "FRIEND_REMOVED",
            "wecomAccountId": "wa-1",
            "externalUserId": "wo-1"
        });
        match decode_action("FRIEND_BINDING_CHANGE", "FRIEND_REMOVED", &ev) {
            Decoded::Action(FriendBindingAction::Removed {
                wecom_account_id,
                external_user_id,
            }) => {
                assert_eq!(wecom_account_id, "wa-1");
                assert_eq!(external_user_id, "wo-1");
            }
            _ => panic!("expected Removed action"),
        }
    }

    #[test]
    fn friend_added_missing_required_fallbacks() {
        let mut ev = full_added_event();
        ev.as_object_mut().unwrap().remove("externalUserId");
        assert!(matches!(
            decode_action("FRIEND_BINDING_CHANGE", "FRIEND_ADDED", &ev),
            Decoded::Fallback(_)
        ));
    }

    #[test]
    fn friend_removed_missing_external_user_id_fallbacks() {
        let ev = serde_json::json!({
            "eventType": "FRIEND_BINDING_CHANGE",
            "eventReason": "FRIEND_REMOVED",
            "wecomAccountId": "wa-1"
        });
        assert!(matches!(
            decode_action("FRIEND_BINDING_CHANGE", "FRIEND_REMOVED", &ev),
            Decoded::Fallback(_)
        ));
    }

    #[test]
    fn unknown_friend_reason_fallbacks() {
        let ev = serde_json::json!({
            "eventType": "FRIEND_BINDING_CHANGE",
            "eventReason": "FRIEND_FUTURE_TYPE",
            "wecomAccountId": "wa-1"
        });
        assert!(matches!(
            decode_action("FRIEND_BINDING_CHANGE", "FRIEND_FUTURE_TYPE", &ev),
            Decoded::Fallback(_)
        ));
    }

    #[test]
    fn missing_wecom_account_id_fallbacks() {
        let ev = serde_json::json!({
            "eventType": "FRIEND_BINDING_CHANGE",
            "eventReason": "FRIEND_REMOVED",
            "externalUserId": "wo-1"
        });
        assert!(matches!(
            decode_action("FRIEND_BINDING_CHANGE", "FRIEND_REMOVED", &ev),
            Decoded::Fallback(_)
        ));
    }

    #[test]
    fn status_change_event_fallbacks_for_now() {
        let ev = serde_json::json!({
            "eventType": "FRIEND_STATUS_CHANGE",
            "eventReason": "WHATEVER",
            "wecomAccountId": "wa-1"
        });
        assert!(matches!(
            decode_action("FRIEND_STATUS_CHANGE", "WHATEVER", &ev),
            Decoded::Fallback(_)
        ));
    }
}
