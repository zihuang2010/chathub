//! 账号事件应用器:Subscribe 流里 ACCOUNT_* 事件 → 本地 SQLite 缓存 + 广播给 Tauri 层。
//!
//! 分发约定(后台 2026-05-17 口径):
//!   - `ACCOUNT_BINDING_CHANGE` 4 个 reason:`ACCOUNT_ADDED` / `ACCOUNT_DISABLED` /
//!     `ACCOUNT_TRANSFERRED` / `ACCOUNT_ALIAS_CHANGED` → 各自映射到 [`BindingAction`]。
//!   - `ACCOUNT_STATUS_CHANGE`:reason 列表 TBD,先一律走 fallback(全量重拉)。
//!   - 任一事件 payload 缺关键字段 → fallback。
//!
//! Fallback 走 `HubClient::list_accounts(...)` 全量拉一次 +
//! `AccountCacheStore::replace_all_for_employee`。这样后台 payload 慢慢补齐过程中,
//! 客户端不会因此停摆 —— 数据最终一致,只是多一次远程往返。
//!
//! 幂等性:`AccountCacheStore::apply_binding` 内 SQL 都自然幂等(INSERT OR REPLACE / UPDATE /
//! DELETE),同 notify_seq 重投不会产生副作用。连接级续点由 NotifySeqStore 负责。

use crate::change_notice::{ChangeNotice, ChangeScope, ChangeTopic};
use crate::error::AuthError;
use crate::hub::{HubClient, ListAccountsFilter, ListAccountsItem};
use chathub_proto::v1::PushBatchOut;
use chathub_state::{AccountCacheStore, BindingAction, WecomAccountRow};
use std::collections::HashSet;
use tokio::sync::broadcast;
use tracing::warn;

// C6 拆双发:`AccountChanged` 类型已删除。所有变更通知统一走 ChangeNotice + hub:change。

#[derive(Clone)]
pub struct AccountEventApplier {
    cache_store: AccountCacheStore,
    hub_client: HubClient,
    /// 统一变更通知通道。C6 后单一通道。
    change_notice_tx: broadcast::Sender<ChangeNotice>,
}

impl AccountEventApplier {
    pub fn new(
        cache_store: AccountCacheStore,
        hub_client: HubClient,
        change_notice_tx: broadcast::Sender<ChangeNotice>,
    ) -> Self {
        Self {
            cache_store,
            hub_client,
            change_notice_tx,
        }
    }

    /// 处理一批 PushBatchOut。
    ///
    /// 流程:
    ///   1. 解析 `events_json` 数组;
    ///   2. 逐条按 `eventType` + `eventReason` 分发到 `BindingAction` 或 fallback;
    ///   3. 任一 fallback 触发后,**当前 employee** 走一次全量 `list_accounts` 替换缓存;
    ///   4. 广播 `AccountChanged`(applied 或 fallback 任一发生)。
    pub async fn apply_push_batch(&self, batch: &PushBatchOut) {
        let events: Vec<serde_json::Value> = match serde_json::from_slice(&batch.events_json) {
            Ok(arr) => arr,
            Err(e) => {
                warn!(target: "chathub_net::account_event", ?e, "events_json parse failed, skipping");
                return;
            }
        };
        self.apply_parsed(batch.employee_id, &events).await;
    }

    /// 应用已解析好的事件数组。SyncEngine 每帧只解析一次 events_json,四个 applier 复用同一份,
    /// 避免每帧重复多次 JSON 解析;`apply_push_batch` 作为薄壳供单测直接喂字节。
    pub(crate) async fn apply_parsed(&self, employee_id: i64, events: &[serde_json::Value]) {
        let employee_id_str = employee_id.to_string();

        let mut applied = 0usize;
        let mut needs_fallback = false;
        let mut account_event_seen = false;
        // 聚合本批涉及的 wecom_account_id:若只 1 个,ChangeNotice scope 可带;否则不带(广义)。
        let mut accounts_in_batch: HashSet<String> = HashSet::new();

        for ev in events {
            let event_type = ev.get("eventType").and_then(|v| v.as_str()).unwrap_or("");
            if event_type != "ACCOUNT_BINDING_CHANGE" && event_type != "ACCOUNT_STATUS_CHANGE" {
                continue;
            }
            account_event_seen = true;
            if let Some(acct) = ev.get("wecomAccountId").and_then(|v| v.as_str()) {
                accounts_in_batch.insert(acct.to_string());
            }
            let reason = ev.get("eventReason").and_then(|v| v.as_str()).unwrap_or("");
            match decode_action(event_type, reason, ev, &employee_id_str) {
                Decoded::Action(action) => {
                    if let Err(e) = self.cache_store.apply_binding(action).await {
                        warn!(target: "chathub_net::account_event", ?e, "apply_binding failed");
                        needs_fallback = true;
                    } else {
                        applied += 1;
                    }
                }
                Decoded::Fallback(detail) => {
                    warn!(
                        target: "chathub_net::account_event",
                        event_type,
                        reason,
                        detail,
                        "incomplete/unsupported account event, scheduling fallback refetch"
                    );
                    needs_fallback = true;
                }
            }
        }

        if !account_event_seen {
            return; // 这批没有 ACCOUNT_*,啥都不做
        }

        if needs_fallback {
            if let Err(e) = self.fallback_full_refetch(&employee_id_str).await {
                warn!(target: "chathub_net::account_event", ?e, "fallback list_accounts failed");
            }
        }

        // C6 单发:ChangeNotice 是唯一通道。
        let scope_account = if accounts_in_batch.len() == 1 {
            accounts_in_batch.into_iter().next()
        } else {
            None
        };
        let scope = ChangeScope {
            employee_id: employee_id_str,
            wecom_account_id: scope_account,
            ..Default::default()
        };
        let notice = if needs_fallback {
            ChangeNotice::server_bulk(ChangeTopic::Accounts, scope)
        } else {
            ChangeNotice::server_upsert(ChangeTopic::Accounts, scope)
        };
        let _ = self.change_notice_tx.send(notice);

        let _ = applied; // applied 计数用于日志/调试,目前不强制使用
    }

    async fn fallback_full_refetch(&self, employee_id: &str) -> Result<(), AuthError> {
        let items = self
            .hub_client
            .list_accounts(ListAccountsFilter { enabled: None })
            .await?;
        let rows: Vec<WecomAccountRow> = items
            .into_iter()
            .map(|it| to_row(it, employee_id))
            .collect();
        self.cache_store
            .replace_all_for_employee(employee_id, &rows)
            .await
            .map_err(|e| AuthError::Internal {
                message: format!("cache replace_all failed: {e}"),
            })?;
        Ok(())
    }
}

fn to_row(item: ListAccountsItem, employee_id: &str) -> WecomAccountRow {
    WecomAccountRow {
        wecom_account_id: item.wecom_account_id,
        employee_id: employee_id.to_string(),
        wecom_name: item.wecom_name,
        wecom_account: item.wecom_account,
        wecom_alias: item.wecom_alias,
        wecom_avatar: item.wecom_avatar,
        wecom_status: item.wecom_status,
        gender: item.gender,
        position: item.position,
    }
}

enum Decoded {
    Action(BindingAction),
    Fallback(&'static str),
}

fn decode_action(
    event_type: &str,
    reason: &str,
    ev: &serde_json::Value,
    current_employee_id: &str,
) -> Decoded {
    if event_type == "ACCOUNT_STATUS_CHANGE" {
        return Decoded::Fallback("ACCOUNT_STATUS_CHANGE reason map TBD by backend");
    }

    // ACCOUNT_BINDING_CHANGE
    let wecom_account_id = match ev.get("wecomAccountId").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return Decoded::Fallback("missing wecomAccountId"),
    };
    match reason {
        "ACCOUNT_ADDED" => match decode_full_row(ev, current_employee_id) {
            Some(row) => Decoded::Action(BindingAction::Added(row)),
            None => Decoded::Fallback("ACCOUNT_ADDED missing required field(s)"),
        },
        "ACCOUNT_DISABLED" => Decoded::Action(BindingAction::Disabled { wecom_account_id }),
        "ACCOUNT_TRANSFERRED" => Decoded::Action(BindingAction::Transferred {
            wecom_account_id,
            employee_id: current_employee_id.to_string(),
        }),
        "ACCOUNT_ALIAS_CHANGED" => match ev.get("wecomAlias").and_then(|v| v.as_str()) {
            Some(a) => Decoded::Action(BindingAction::AliasChanged {
                wecom_account_id,
                wecom_alias: a.to_string(),
            }),
            None => Decoded::Fallback("ACCOUNT_ALIAS_CHANGED missing wecomAlias"),
        },
        _ => Decoded::Fallback("unknown ACCOUNT_BINDING_CHANGE reason"),
    }
}

fn decode_full_row(ev: &serde_json::Value, employee_id: &str) -> Option<WecomAccountRow> {
    Some(WecomAccountRow {
        wecom_account_id: ev.get("wecomAccountId")?.as_str()?.to_string(),
        employee_id: employee_id.to_string(),
        wecom_name: ev.get("wecomName")?.as_str()?.to_string(),
        wecom_account: ev.get("wecomAccount")?.as_str()?.to_string(),
        wecom_alias: ev.get("wecomAlias")?.as_str()?.to_string(),
        wecom_avatar: ev.get("wecomAvatar")?.as_str()?.to_string(),
        wecom_status: ev.get("wecomStatus")?.as_i64()? as i32,
        gender: ev.get("gender")?.as_i64()? as i32,
        position: ev.get("position")?.as_str()?.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn full_added_event() -> serde_json::Value {
        serde_json::json!({
            "eventType": "ACCOUNT_BINDING_CHANGE",
            "eventReason": "ACCOUNT_ADDED",
            "wecomAccountId": "wa-1",
            "wecomName": "张三",
            "wecomAccount": "zhangsan",
            "wecomAlias": "zhangsan_alias",
            "wecomAvatar": "https://example.com/avatar.png",
            "wecomStatus": 1,
            "gender": 1,
            "position": "工程师"
        })
    }

    #[test]
    fn account_added_decodes_to_action() {
        let ev = full_added_event();
        match decode_action("ACCOUNT_BINDING_CHANGE", "ACCOUNT_ADDED", &ev, "u-1") {
            Decoded::Action(BindingAction::Added(row)) => {
                assert_eq!(row.wecom_account_id, "wa-1");
                assert_eq!(row.employee_id, "u-1");
                assert_eq!(row.wecom_name, "张三");
                assert_eq!(row.wecom_status, 1);
            }
            other => panic!(
                "expected Added action, got {}",
                match other {
                    Decoded::Action(_) => "Action(other variant)",
                    Decoded::Fallback(d) => d,
                }
            ),
        }
    }

    #[test]
    fn account_added_missing_field_fallbacks() {
        let mut ev = full_added_event();
        ev.as_object_mut().unwrap().remove("wecomName");
        assert!(matches!(
            decode_action("ACCOUNT_BINDING_CHANGE", "ACCOUNT_ADDED", &ev, "u-1"),
            Decoded::Fallback(_)
        ));
    }

    #[test]
    fn account_disabled_decodes_with_minimal_payload() {
        let ev = serde_json::json!({
            "eventType": "ACCOUNT_BINDING_CHANGE",
            "eventReason": "ACCOUNT_DISABLED",
            "wecomAccountId": "wa-1"
        });
        match decode_action("ACCOUNT_BINDING_CHANGE", "ACCOUNT_DISABLED", &ev, "u-1") {
            Decoded::Action(BindingAction::Disabled { wecom_account_id }) => {
                assert_eq!(wecom_account_id, "wa-1");
            }
            _ => panic!("expected Disabled action"),
        }
    }

    #[test]
    fn account_transferred_uses_current_employee_id() {
        let ev = serde_json::json!({
            "eventType": "ACCOUNT_BINDING_CHANGE",
            "eventReason": "ACCOUNT_TRANSFERRED",
            "wecomAccountId": "wa-1"
        });
        match decode_action(
            "ACCOUNT_BINDING_CHANGE",
            "ACCOUNT_TRANSFERRED",
            &ev,
            "u-current",
        ) {
            Decoded::Action(BindingAction::Transferred {
                wecom_account_id,
                employee_id,
            }) => {
                assert_eq!(wecom_account_id, "wa-1");
                assert_eq!(employee_id, "u-current"); // 用当前登录员工,而非 event 里的(避免误删别人的 cache)
            }
            _ => panic!("expected Transferred action"),
        }
    }

    #[test]
    fn account_alias_changed_carries_new_alias() {
        let ev = serde_json::json!({
            "eventType": "ACCOUNT_BINDING_CHANGE",
            "eventReason": "ACCOUNT_ALIAS_CHANGED",
            "wecomAccountId": "wa-1",
            "wecomAlias": "renamed"
        });
        match decode_action(
            "ACCOUNT_BINDING_CHANGE",
            "ACCOUNT_ALIAS_CHANGED",
            &ev,
            "u-1",
        ) {
            Decoded::Action(BindingAction::AliasChanged {
                wecom_account_id,
                wecom_alias,
            }) => {
                assert_eq!(wecom_account_id, "wa-1");
                assert_eq!(wecom_alias, "renamed");
            }
            _ => panic!("expected AliasChanged action"),
        }
    }

    #[test]
    fn account_alias_changed_missing_alias_fallbacks() {
        let ev = serde_json::json!({
            "eventType": "ACCOUNT_BINDING_CHANGE",
            "eventReason": "ACCOUNT_ALIAS_CHANGED",
            "wecomAccountId": "wa-1"
        });
        assert!(matches!(
            decode_action(
                "ACCOUNT_BINDING_CHANGE",
                "ACCOUNT_ALIAS_CHANGED",
                &ev,
                "u-1"
            ),
            Decoded::Fallback(_)
        ));
    }

    #[test]
    fn unknown_reason_fallbacks() {
        let ev = serde_json::json!({
            "eventType": "ACCOUNT_BINDING_CHANGE",
            "eventReason": "ACCOUNT_FUTURE_TYPE",
            "wecomAccountId": "wa-1"
        });
        assert!(matches!(
            decode_action("ACCOUNT_BINDING_CHANGE", "ACCOUNT_FUTURE_TYPE", &ev, "u-1"),
            Decoded::Fallback(_)
        ));
    }

    #[test]
    fn status_change_event_fallbacks_for_now() {
        let ev = serde_json::json!({
            "eventType": "ACCOUNT_STATUS_CHANGE",
            "eventReason": "WHATEVER",
            "wecomAccountId": "wa-1"
        });
        assert!(matches!(
            decode_action("ACCOUNT_STATUS_CHANGE", "WHATEVER", &ev, "u-1"),
            Decoded::Fallback(_)
        ));
    }

    #[test]
    fn missing_wecom_account_id_fallbacks() {
        let ev = serde_json::json!({
            "eventType": "ACCOUNT_BINDING_CHANGE",
            "eventReason": "ACCOUNT_DISABLED"
        });
        assert!(matches!(
            decode_action("ACCOUNT_BINDING_CHANGE", "ACCOUNT_DISABLED", &ev, "u-1"),
            Decoded::Fallback(_)
        ));
    }
}
