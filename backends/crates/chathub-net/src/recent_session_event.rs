//! 接待好友列表(消息页)事件应用器:Subscribe 流里 `SESSION_SUMMARY_UPSERT` 事件 →
//! 本地 `hub_conversation_recents` 行存 + 广播给 Tauri 层。
//!
//! 规范 §8:`MESSAGE_UPSERT` 只更新消息气泡(由 `MessageEventApplier` 落),**不更新**最近接待
//! 列表;摘要变化由同 batch 的 `SESSION_SUMMARY_UPSERT` 表达。故本 applier 只消费后者。
//!
//! 应用策略:
//!
//!   1. **已知 conversation_id → 分字段部分更新**:`decode_summary` 解 `sessionSummary{}`
//!      (规范 §9.2),`store.apply_summary` 只覆盖摘要列与非空资料列(§9.3「用服务端
//!      sessionSummary 覆盖本地同字段」)。`wecomName/externalMobile` 等摘要不携带的展示
//!      字段、以及 pinned/local_draft_at_ms 等本地列一律保留不动(写入纪律,见 V7 migration)。
//!
//!   2. **未知 conversation_id / 瘦 payload → fallback**:拉一次 `list_recent_friends` 首页
//!      (cursor="",无筛选)对齐,由服务端权威补齐展示字段(§9.3「静默调用 recentFriends」)。
//!      服务端按 last_message_time 倒序保证新会话出现在头部。
//!
//!   3. **throttle**:同一秒内多次 fallback 合并为一次,避免事件风暴时多次拉首页。

use crate::change_notice::{ChangeNotice, ChangeScope, ChangeTopic};
use crate::error::AuthError;
use crate::hub::{HubClient, ListRecentFriendsRequest, RecentFriendRecord};
use crate::message_sync::parse_server_time_to_ms;
use chathub_proto::v1::PushBatchOut;
use chathub_state::{RecentSessionRemote, RecentSessionSummary, RecentSessionsStore};
use std::collections::HashSet;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use tokio::sync::broadcast;
use tracing::warn;

/// fallback 拉首页时使用的 page size。固定 20,服务端文档示例值。
const FALLBACK_PAGE_SIZE: u32 = 20;

/// fallback 节流窗口:1 秒内多次 fallback 合并为一次。
const FALLBACK_THROTTLE_MS: i64 = 1000;

// C6 拆双发:`RecentFriendsChanged` 类型已删除。统一走 ChangeNotice + hub:change。

#[derive(Clone)]
pub struct RecentSessionEventApplier {
    store: RecentSessionsStore,
    hub: HubClient,
    /// 统一变更通知通道。
    change_notice_tx: broadcast::Sender<ChangeNotice>,
    /// 最近一次 fallback 触发的 unix ms;throttle 用。
    last_fallback_ms: Arc<AtomicI64>,
}

impl RecentSessionEventApplier {
    pub fn new(
        store: RecentSessionsStore,
        hub: HubClient,
        change_notice_tx: broadcast::Sender<ChangeNotice>,
    ) -> Self {
        Self {
            store,
            hub,
            change_notice_tx,
            last_fallback_ms: Arc::new(AtomicI64::new(0)),
        }
    }

    /// 处理一批 `PushBatchOut`(对照 `FriendEventApplier::apply_push_batch`)。
    pub async fn apply_push_batch(&self, batch: &PushBatchOut) {
        let employee_id_str = batch.employee_id.to_string();

        let events: Vec<serde_json::Value> = match serde_json::from_slice(&batch.events_json) {
            Ok(arr) => arr,
            Err(e) => {
                warn!(
                    target: "chathub_net::recent_session_event",
                    ?e,
                    "events_json parse failed, skipping"
                );
                return;
            }
        };

        let mut seen = false;
        let mut applied = 0usize;
        let mut needs_fallback = false;
        // 聚合本批涉及的 wecom_account_id,用于 ChangeNotice scope。
        let mut accounts_in_batch: HashSet<String> = HashSet::new();

        for ev in &events {
            let event_type = ev.get("eventType").and_then(|v| v.as_str()).unwrap_or("");
            if event_type != "MESSAGE_UPSERT" && event_type != "SESSION_SUMMARY_UPSERT" {
                continue;
            }
            seen = true;
            // 规范 §8:MESSAGE_UPSERT 只更新气泡(MessageEventApplier 负责),不更新最近接待列表;
            // 摘要变化由同 batch 的 SESSION_SUMMARY_UPSERT 表达。此处只认后者。
            if event_type != "SESSION_SUMMARY_UPSERT" {
                continue;
            }
            if let Some(acct) = ev.get("wecomAccountId").and_then(|v| v.as_str()) {
                accounts_in_batch.insert(acct.to_string());
            }

            // 必备字段:conversationId(摘要字段在 sessionSummary{} 里,由 decode_summary 解)
            let conv_id = match ev.get("conversationId").and_then(|v| v.as_str()) {
                Some(s) if !s.is_empty() => s,
                _ => {
                    needs_fallback = true;
                    continue;
                }
            };

            // 未知 conversation_id → fallback(不尝试 INSERT,见模块注释 / §9.3)
            let exists = match self.store.exists(&employee_id_str, conv_id).await {
                Ok(b) => b,
                Err(e) => {
                    warn!(
                        target: "chathub_net::recent_session_event",
                        ?e, conv_id, "store.exists failed; will fallback"
                    );
                    needs_fallback = true;
                    continue;
                }
            };
            if !exists {
                needs_fallback = true;
                continue;
            }

            // 已存在:解 sessionSummary,分字段部分更新(只覆盖摘要列与非空资料列,保留展示字段)。
            match decode_summary(ev, &employee_id_str) {
                Some(summary) => match self.store.apply_summary(summary).await {
                    Ok(true) => applied += 1,
                    Ok(false) => {
                        // 版本门拒绝的 stale 摘要 → no-op,不需 fallback。
                    }
                    Err(e) => {
                        warn!(
                            target: "chathub_net::recent_session_event",
                            ?e, conv_id, "apply_summary failed; scheduling fallback"
                        );
                        needs_fallback = true;
                    }
                },
                None => {
                    needs_fallback = true;
                }
            }
        }

        if !seen {
            return;
        }

        if needs_fallback && self.should_run_fallback() {
            if let Err(e) = self.fallback_first_page(&employee_id_str).await {
                warn!(
                    target: "chathub_net::recent_session_event",
                    ?e, "fallback list_recent_friends first page failed"
                );
            }
        }

        // C6 单发:ChangeNotice 唯一通道。
        // 策略:fallback 时 BulkInvalidate(前端最好整体重拉);否则 Upsert。
        // 单 account 批 → scope 带 account_id(精准 match);多 account → scope 不带。
        if applied > 0 || needs_fallback {
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
                ChangeNotice::server_bulk(ChangeTopic::RecentSessions, scope)
            } else {
                ChangeNotice::server_upsert(ChangeTopic::RecentSessions, scope)
            };
            let _ = self.change_notice_tx.send(notice);
        }
    }

    /// 节流:同一窗口(1s)内多次 fallback 合并为一次。
    fn should_run_fallback(&self) -> bool {
        let now = now_unix_ms();
        let last = self.last_fallback_ms.load(Ordering::Relaxed);
        if now.saturating_sub(last) < FALLBACK_THROTTLE_MS {
            return false;
        }
        // 用 compare_exchange 防多 task 同时进入(broadcast 单消费者场景下其实串行,但保险)
        self.last_fallback_ms
            .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok()
    }

    /// fallback:拉一次首页(无筛选),把结果 UPSERT 到本地表。
    /// `employee_id` 由事件 batch 携带,所有写入的 RecentSessionRemote 都打上这个 employee。
    async fn fallback_first_page(&self, employee_id: &str) -> Result<(), AuthError> {
        let resp = self
            .hub
            .list_recent_friends(ListRecentFriendsRequest {
                size: FALLBACK_PAGE_SIZE,
                cursor: String::new(),
                external_name: String::new(),
                external_mobile: String::new(),
                wecom_account_id: String::new(),
                only_unread: false,
            })
            .await?;
        let rows: Vec<RecentSessionRemote> = resp
            .records
            .into_iter()
            .map(|r| record_to_remote(r, employee_id))
            .collect();
        self.store
            .upsert_remote_many(&rows)
            .await
            .map_err(|e| AuthError::Internal {
                message: format!("recents upsert_remote_many failed: {e}"),
            })?;
        Ok(())
    }
}

/// `RecentFriendRecord`(API 形态)→ `RecentSessionRemote`(行存远端列)。
/// 公开导出供 Tauri command 复用。`employee_id` 由调用方注入(从当前会话获取)。
pub fn record_to_remote(r: RecentFriendRecord, employee_id: &str) -> RecentSessionRemote {
    let time_ms = parse_iso_to_ms(&r.last_message_time);
    RecentSessionRemote {
        conversation_id: r.conversation_id,
        wecom_account_id: r.wecom_account_id,
        employee_id: employee_id.to_string(),
        wecom_name: r.wecom_name,
        wecom_account: r.wecom_account,
        wecom_alias: r.wecom_alias,
        external_user_id: r.external_user_id,
        external_name: r.external_name,
        external_avatar: r.external_avatar,
        external_mobile: r.external_mobile,
        last_local_message_id: r.last_local_message_id,
        last_message_type: r.last_message_type,
        last_message_direction: r.last_message_direction,
        last_send_status: r.last_send_status,
        last_message_summary: r.last_message_summary,
        last_message_time_ms: time_ms,
        unread_count: r.unread_count,
        has_unread: r.has_unread,
        // 版本主键回退:sortKey 缺省时用消息时间(同为 epoch-ms,可比)。
        last_message_sort_key_ms: split_sort_key_ms(&r.last_message_sort_key).max(time_ms),
        gmt_modified_time: r.gmt_modified_time,
    }
}

/// 把 `SESSION_SUMMARY_UPSERT` 事件解码为 [`RecentSessionSummary`](规范 §9.2)。
///
/// 会话定位(`conversationId`)在事件**顶层**;摘要字段在 `sessionSummary{}` 内,排序键叫
/// `lastSortKey`(注意:不是 `recentFriends.records.lastMessageSortKey`)。
/// 必备:`conversationId` 与 `sessionSummary.lastSortKey` 非空 → 缺失返 `None`(调用者走 fallback)。
/// `employee_id` 来自事件批 `PushBatchOut.employee_id`,不在 payload 里。
fn decode_summary(ev: &serde_json::Value, employee_id: &str) -> Option<RecentSessionSummary> {
    let conv_id = ev.get("conversationId")?.as_str()?;
    if conv_id.is_empty() {
        return None;
    }
    let ss = ev.get("sessionSummary")?;
    let last_sort_key = ss.get("lastSortKey").and_then(|v| v.as_str()).unwrap_or("");
    if last_sort_key.is_empty() {
        return None;
    }
    // sortKey 首段即该消息 epoch-ms;再 max 服务端时间串(空格格式 "yyyy-MM-dd HH:mm:ss")防 sortKey 异常。
    let sort_ms = split_sort_key_ms(last_sort_key);
    let time_ms = sort_ms.max(parse_server_time_to_ms(&str_or_empty(
        ss,
        "lastMessageTime",
    )));
    Some(RecentSessionSummary {
        conversation_id: conv_id.to_string(),
        employee_id: employee_id.to_string(),
        last_local_message_id: str_or_empty(ss, "lastLocalMessageId"),
        last_message_type: int_or_zero(ss, "lastMessageType"),
        last_message_direction: int_or_zero(ss, "lastMessageDirection"),
        last_send_status: int_or_zero(ss, "lastSendStatus"),
        last_message_summary: str_or_empty(ss, "lastMessageSummary"),
        last_message_time_ms: time_ms,
        unread_count: ss.get("unreadCount").and_then(|v| v.as_i64()).unwrap_or(0),
        has_unread: ss
            .get("hasUnread")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        last_message_sort_key_ms: sort_ms.max(time_ms),
        // gmt 次版本:摘要事件一般不带,缺省空串(版本门主键用 sort_key_ms,gmt 仅同值时 tiebreak)。
        gmt_modified_time: str_or_empty(ev, "gmtModifiedTime"),
        // 可选资料字段:仅"资料变化时"返回,非空才覆盖本地(apply_summary 负责保留逻辑)。
        external_name: str_or_empty(ss, "externalName"),
        external_avatar: str_or_empty(ss, "externalAvatar"),
        wecom_alias: str_or_empty(ss, "wecomAlias"),
    })
}

fn str_or_empty(ev: &serde_json::Value, key: &str) -> String {
    ev.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn int_or_zero(ev: &serde_json::Value, key: &str) -> i32 {
    ev.get(key).and_then(|v| v.as_i64()).unwrap_or(0) as i32
}

/// 解析 `lastMessageSortKey` 首段(`:` 前)为 epoch-ms;缺省 / 非法返 0。
/// 形如 `"1715836200000:xxxx"`,首段为该会话单调 epoch-ms;LWW 主版本。
pub fn split_sort_key_ms(s: &str) -> i64 {
    s.split(':')
        .next()
        .unwrap_or("")
        .parse::<i64>()
        .unwrap_or(0)
}

/// 极简 RFC3339(`YYYY-MM-DDTHH:MM:SSZ`)解析:成功返 epoch ms,失败返 0。
/// 业务端返回此格式;若以后加 offset / 分秒,需要换 `time` crate。
fn parse_iso_to_ms(s: &str) -> i64 {
    // 形如 "2026-05-18T10:28:36Z",定长 20 字节,只支持 UTC `Z` 结尾。
    if s.len() < 20 || !s.ends_with('Z') {
        return 0;
    }
    let bytes = s.as_bytes();
    let take = |start: usize, len: usize| -> Option<i64> {
        std::str::from_utf8(&bytes[start..start + len])
            .ok()?
            .parse::<i64>()
            .ok()
    };
    if bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return 0;
    }
    let (y, mo, d, h, mi, se) = match (
        take(0, 4),
        take(5, 2),
        take(8, 2),
        take(11, 2),
        take(14, 2),
        take(17, 2),
    ) {
        (Some(y), Some(mo), Some(d), Some(h), Some(mi), Some(se)) => (y, mo, d, h, mi, se),
        _ => return 0,
    };
    if !(1970..=9999).contains(&y) || !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return 0;
    }
    days_from_civil(y as i32, mo as i32, d as i32) * 86_400_000
        + h * 3_600_000
        + mi * 60_000
        + se * 1_000
}

/// Howard Hinnant 公历日数算法:返回 epoch(1970-01-01)起的天数,可为负。
fn days_from_civil(y: i32, m: i32, d: i32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as i64;
    let doy = (153 * (m as i64 + if m > 2 { -3 } else { 9 }) + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era as i64 * 146097 + doe - 719468
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

    #[test]
    fn parse_iso_to_ms_known_value() {
        // 2026-05-18T10:28:36Z → 1779438516000 ms
        // 验证:2026-05-18 距 epoch 的天数 × 86400000 + 时分秒
        let got = parse_iso_to_ms("2026-05-18T10:28:36Z");
        // 用同一算法反推,确认 round-trip。
        let expected =
            days_from_civil(2026, 5, 18) * 86_400_000 + 10 * 3_600_000 + 28 * 60_000 + 36 * 1_000;
        assert_eq!(got, expected);
        assert!(got > 1_700_000_000_000, "must be 2024+ in ms");
    }

    #[test]
    fn parse_iso_to_ms_epoch_zero() {
        assert_eq!(parse_iso_to_ms("1970-01-01T00:00:00Z"), 0);
    }

    #[test]
    fn parse_iso_to_ms_invalid_returns_zero() {
        assert_eq!(parse_iso_to_ms(""), 0);
        assert_eq!(parse_iso_to_ms("not-an-iso-date"), 0);
        assert_eq!(parse_iso_to_ms("2026-05-18T10:28:36"), 0); // 无 Z
        assert_eq!(parse_iso_to_ms("2026-05-18T10:28:36+08:00"), 0); // offset 不支持
        assert_eq!(parse_iso_to_ms("2026/05/18T10:28:36Z"), 0); // 分隔符错
    }

    #[test]
    fn parse_iso_to_ms_monotonic_within_day() {
        let a = parse_iso_to_ms("2026-05-18T10:00:00Z");
        let b = parse_iso_to_ms("2026-05-18T11:00:00Z");
        assert_eq!(b - a, 3_600_000);
    }

    /// 规范 §9 形态:摘要字段嵌套在 `sessionSummary{}` 内,排序键叫 `lastSortKey`。
    /// sortKey 前缀取 1_900_000_000_000(大于 lastMessageTime 解析值),便于断言 lastSortKey 被解析。
    fn full_session_summary_event(conv: &str, acct: &str) -> serde_json::Value {
        serde_json::json!({
            "eventType": "SESSION_SUMMARY_UPSERT",
            "eventReason": "LAST_MESSAGE_CHANGED",
            "conversationId": conv,
            "wecomAccountId": acct,
            "externalUserId": format!("ext_{conv}"),
            "eventTime": "2026-05-14 10:30:00",
            "sessionSummary": {
                "lastLocalMessageId": "LM_A",
                "lastMessageType": 1,
                "lastMessageDirection": 2,
                "lastSendStatus": 0,
                "lastMessageSummary": "你好",
                "lastMessageTime": "2026-05-14 10:30:00",
                "lastSortKey": "1900000000000:2:00000000000000002001:LM_A",
                "unreadCount": 2,
                "hasUnread": true
            }
        })
    }

    #[test]
    fn decode_summary_reads_nested_session_summary() {
        let ev = full_session_summary_event("cv-1", "wa-1");
        let s = decode_summary(&ev, "u-test").expect("full payload should decode");
        // 会话定位来自事件顶层。
        assert_eq!(s.conversation_id, "cv-1");
        assert_eq!(
            s.employee_id, "u-test",
            "employee_id 来自 batch,不在 payload"
        );
        // 摘要字段来自 sessionSummary{},不是顶层。
        assert_eq!(s.last_local_message_id, "LM_A");
        assert_eq!(s.last_message_summary, "你好");
        assert_eq!(s.last_message_direction, 2);
        assert_eq!(s.unread_count, 2);
        assert!(s.has_unread);
        // lastSortKey(非 lastMessageSortKey)被解析:前缀 1.9e12 > lastMessageTime 解析值。
        assert_eq!(s.last_message_sort_key_ms, 1_900_000_000_000);
        assert!(s.last_message_time_ms > 0);
    }

    #[test]
    fn decode_summary_top_level_fields_are_ignored() {
        // 旧 bug 形态:摘要字段平铺在顶层、无 sessionSummary{} → 现在必须解不出来(返 None)。
        let ev = serde_json::json!({
            "eventType": "SESSION_SUMMARY_UPSERT",
            "conversationId": "cv-1",
            "wecomAccountId": "wa-1",
            "externalUserId": "ext_cv-1",
            "lastMessageTime": "2026-05-14 10:30:00",
            "lastMessageSortKey": "1900000000000:2:x",
            "lastMessageSummary": "你好",
            "unreadCount": 2,
            "hasUnread": true
        });
        assert!(
            decode_summary(&ev, "u-test").is_none(),
            "顶层平铺(无 sessionSummary)不应再被解析"
        );
    }

    #[test]
    fn decode_summary_missing_required_returns_none() {
        // 缺 conversationId
        let mut ev = full_session_summary_event("cv-1", "wa-1");
        ev.as_object_mut().unwrap().remove("conversationId");
        assert!(decode_summary(&ev, "u-test").is_none(), "缺 conversationId");
        // 缺整个 sessionSummary
        let mut ev = full_session_summary_event("cv-1", "wa-1");
        ev.as_object_mut().unwrap().remove("sessionSummary");
        assert!(decode_summary(&ev, "u-test").is_none(), "缺 sessionSummary");
        // 缺 sessionSummary.lastSortKey
        let mut ev = full_session_summary_event("cv-1", "wa-1");
        ev["sessionSummary"]
            .as_object_mut()
            .unwrap()
            .remove("lastSortKey");
        assert!(decode_summary(&ev, "u-test").is_none(), "缺 lastSortKey");
    }

    #[test]
    fn decode_summary_optional_profile_missing_defaults_empty() {
        // 资料字段(externalName/externalAvatar/wecomAlias)摘要事件常不带 → 解码为空串,
        // 由 store.apply_summary 负责"空串不覆盖本地"。
        let ev = full_session_summary_event("cv-1", "wa-1");
        let s = decode_summary(&ev, "u-test").expect("optional missing OK");
        assert_eq!(s.external_name, "");
        assert_eq!(s.external_avatar, "");
        assert_eq!(s.wecom_alias, "");
    }
}
