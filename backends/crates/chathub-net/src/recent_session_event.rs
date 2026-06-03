//! 接待好友列表(消息页)事件应用器:Subscribe 流里 `SESSION_SUMMARY_UPSERT` 事件 →
//! 本地 `hub_conversation_recents` 行存 + 广播给 Tauri 层。
//!
//! 规范 §8:`MESSAGE_UPSERT` 只更新消息气泡(由 `MessageEventApplier` 落),**不更新**最近接待
//! 列表;摘要变化由同 batch 的 `SESSION_SUMMARY_UPSERT` 表达。故本 applier 只消费后者。
//!
//! 应用策略 —— 纯 UPSERT(事件路径**不**回拉 recentFriends):
//!
//!   1. **已知 conversation_id → 分字段部分更新**:`decode_summary` 解 `sessionSummary{}`
//!      (规范 §9.2),`store.apply_summary` 只覆盖摘要列与非空资料列(§9.3「用服务端
//!      sessionSummary 覆盖本地同字段」)。`wecomName/externalMobile` 等摘要不携带的展示
//!      字段、以及 pinned/local_draft_at_ms 等本地列一律保留不动(写入纪律,见 V7 migration)。
//!
//!   2. **未知 conversation_id → 直接 INSERT**:用事件顶层身份(conversationId/wecomAccountId/
//!      externalUserId)+ sessionSummary,并从本地账号缓存(`AccountCacheStore`)补
//!      `wecomName/wecomAccount/wecomAlias`,拼整行 `upsert_remote_one` 入库。客户名/头像/手机号
//!      事件没带就先留空,由后续 `FRIEND_UPSERT`/`SUMMARY_PROFILE_CHANGED`/刷新补齐。
//!      离线期新会话经 backfill 补回的 `SESSION_SUMMARY_UPSERT` 即走此路,无需拉首页。
//!
//!   3. **瘦 payload**(无 conversationId 或无 sessionSummary)→ skip + 日志;粗粒度对齐交给
//!      连接级 resync / 用户刷新,事件路径不再为此回拉。

use crate::change_notice::{ChangeNotice, ChangeScope, ChangeTopic};
use crate::hub::RecentFriendRecord;
// D3:复用 message_sync 的 pub(crate) 公历日数助手,去掉本模块重复 days_from_civil 副本。
use crate::message_sync::{days_from_civil, parse_server_time_to_ms};
use chathub_proto::v1::PushBatchOut;
use chathub_state::{
    AccountCacheStore, RecentSessionRemote, RecentSessionSummary, RecentSessionsStore,
    WecomAccountRow,
};
use std::collections::HashSet;
use tokio::sync::broadcast;
use tracing::warn;

// C6 拆双发:`RecentFriendsChanged` 类型已删除。统一走 ChangeNotice + hub:change。

#[derive(Clone)]
pub struct RecentSessionEventApplier {
    store: RecentSessionsStore,
    /// 新会话 INSERT 时补 `wecom_name/account/alias`(事件不带、本地账号缓存有)。
    accounts: AccountCacheStore,
    /// 统一变更通知通道。
    change_notice_tx: broadcast::Sender<ChangeNotice>,
}

impl RecentSessionEventApplier {
    pub fn new(
        store: RecentSessionsStore,
        accounts: AccountCacheStore,
        change_notice_tx: broadcast::Sender<ChangeNotice>,
    ) -> Self {
        Self {
            store,
            accounts,
            change_notice_tx,
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
        // 新会话 INSERT 时补企微展示字段;懒读一次(本批确有未知会话才读账号缓存)。
        let mut accounts_cache: Option<Vec<WecomAccountRow>> = None;
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
            // 真实 payload:业务体(conversationId/wecomAccountId 等)全在 sessionSummary{} 内部。
            // $ref 事件(UNREAD_CHANGED 第3条)无 sessionSummary 实体 → 跳过(get 返 None)。
            let ss = match ev.get("sessionSummary") {
                Some(v) => v,
                None => continue,
            };
            let acct_for_scope = json_id(ss, "wecomAccountId");
            if !acct_for_scope.is_empty() {
                accounts_in_batch.insert(acct_for_scope);
            }

            // 必备:conversationId(sessionSummary 内定位,可能是数字)非空。缺失 = 瘦 payload/$ref,
            // 无法入库 → skip(事件路径不回拉,交给 resync/刷新)。
            let conv_id_owned = json_id(ss, "conversationId");
            if conv_id_owned.is_empty() {
                continue;
            }
            let conv_id = conv_id_owned.as_str();

            // MARK_READ 特判:已读上报后未读清零。MARK_READ 的 lastMessageSortKey 与上条消息同值,
            // 仅靠 gmtModifiedTime 决胜,实测有"同 sortKey 且 gmt 不前进 → 版本门拒绝 → 未读清不掉"
            // 的真实风险。故绕过 decode_summary/apply_summary 版本门,直接 clear_unread 保证清零;
            // 未读清零与消息位置正交,不走 insert。仍计入 applied 以触发末尾统一 ChangeNotice。
            if ev.get("eventReason").and_then(|v| v.as_str()) == Some("MARK_READ") {
                match self.store.clear_unread(&employee_id_str, conv_id).await {
                    Ok(()) => applied += 1,
                    Err(e) => warn!(
                        target: "chathub_net::recent_session_event",
                        ?e, conv_id, "clear_unread(MARK_READ) failed"
                    ),
                }
                continue;
            }

            let summary = match decode_summary(ev, &employee_id_str) {
                Some(s) => s,
                None => continue,
            };

            // 纯 UPSERT:有则更新(保留展示列),无则从事件 + 账号缓存新增。
            let exists = match self.store.exists(&employee_id_str, conv_id).await {
                Ok(b) => b,
                Err(e) => {
                    // 存在性未知:跳过,避免误把已有行的展示列 UPSERT 抹空。
                    warn!(
                        target: "chathub_net::recent_session_event",
                        ?e, conv_id, "store.exists failed; skip"
                    );
                    continue;
                }
            };

            if exists {
                // 已存在:分字段部分更新(只覆盖摘要列与非空资料列,保留展示字段)。
                match self.store.apply_summary(summary).await {
                    Ok(true) => applied += 1,
                    Ok(false) => {
                        // 版本门拒绝的 stale 摘要 → no-op。
                    }
                    Err(e) => warn!(
                        target: "chathub_net::recent_session_event",
                        ?e, conv_id, "apply_summary failed"
                    ),
                }
            } else {
                // 新会话:事件顶层身份 + 账号缓存补企微展示字段 → 整行 INSERT。
                if accounts_cache.is_none() {
                    accounts_cache = Some(
                        self.accounts
                            .read_for_employee(&employee_id_str)
                            .await
                            .unwrap_or_default(),
                    );
                }
                // 真实 payload:身份字段在 sessionSummary{} 内部。
                let acct_id = json_id(ss, "wecomAccountId");
                let acct_id = acct_id.as_str();
                let (wecom_name, wecom_account, cache_alias) = accounts_cache
                    .as_ref()
                    .and_then(|v| v.iter().find(|a| a.wecom_account_id == acct_id))
                    .map(|a| {
                        (
                            a.wecom_name.clone(),
                            a.wecom_account.clone(),
                            a.wecom_alias.clone(),
                        )
                    })
                    .unwrap_or_default();
                let remote = RecentSessionRemote {
                    conversation_id: conv_id.to_string(),
                    wecom_account_id: acct_id.to_string(),
                    employee_id: employee_id_str.clone(),
                    wecom_name,
                    wecom_account,
                    // 别名:事件带的更新,否则用账号缓存。
                    wecom_alias: if summary.wecom_alias.is_empty() {
                        cache_alias
                    } else {
                        summary.wecom_alias.clone()
                    },
                    external_user_id: str_or_empty(ss, "externalUserId"),
                    external_name: summary.external_name.clone(),
                    external_avatar: summary.external_avatar.clone(),
                    // 事件不带手机号 → 留空,后续 FRIEND_UPSERT/刷新补。
                    external_mobile: String::new(),
                    last_local_message_id: summary.last_local_message_id.clone(),
                    last_message_type: summary.last_message_type,
                    last_message_direction: summary.last_message_direction,
                    last_send_status: summary.last_send_status,
                    last_message_summary: summary.last_message_summary.clone(),
                    last_message_time_ms: summary.last_message_time_ms,
                    unread_count: summary.unread_count,
                    has_unread: summary.has_unread,
                    last_message_sort_key_ms: summary.last_message_sort_key_ms,
                    gmt_modified_time: summary.gmt_modified_time.clone(),
                };
                match self.store.upsert_remote_one(remote).await {
                    Ok(()) => applied += 1,
                    Err(e) => warn!(
                        target: "chathub_net::recent_session_event",
                        ?e, conv_id, "upsert_remote_one(insert) failed"
                    ),
                }
            }
        }

        if !seen {
            return;
        }

        // C6 单发:ChangeNotice 唯一通道。纯 UPSERT,统一发 Upsert。
        // 单 account 批 → scope 带 account_id(精准 match);多 account → scope 不带。
        if applied > 0 {
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
            let _ = self.change_notice_tx.send(ChangeNotice::server_upsert(
                ChangeTopic::RecentSessions,
                scope,
            ));
        }
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
/// 真实 payload:`conversationId`/`gmtModifiedTime` 等业务体字段全在 `sessionSummary{}` **内部**
/// (旧规范误从事件顶层读)。`conversationId` 多为**数字**(MARK_READ 又是字符串),用 `json_id`
/// 统一成字符串。排序键多数叫 `lastSortKey`,**MARK_READ 里叫 `lastMessageSortKey`**,双键兜底。
/// UNREAD_CHANGED 第3事件是 `{"$ref":"$.events[1].sessionSummary"}`(serde 不解引用)→ 跳过,
/// 数据由同 batch 的 `LAST_MESSAGE_CHANGED` 兄弟事件承载。
/// 必备:`sessionSummary.conversationId` 与排序键非空 → 缺失返 `None`(调用者按瘦 payload 跳过)。
/// `employee_id` 来自事件批 `PushBatchOut.employee_id`,不在 payload 里。
fn decode_summary(ev: &serde_json::Value, employee_id: &str) -> Option<RecentSessionSummary> {
    let ss = ev.get("sessionSummary")?;
    // `$ref` 事件(UNREAD_CHANGED 第3条)不携带真实数据,serde 也不解引用 → 跳过。
    if ss.get("$ref").is_some() {
        return None;
    }
    // 会话定位在 sessionSummary 内部,可能是数字 → json_id 统一成字符串;空则瘦 payload。
    let conv_id = json_id(ss, "conversationId");
    if conv_id.is_empty() {
        return None;
    }
    // 排序键:多数 `lastSortKey`,MARK_READ 是 `lastMessageSortKey`;双键兜底,空则瘦 payload。
    let last_sort_key = ss
        .get("lastSortKey")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .or_else(|| ss.get("lastMessageSortKey").and_then(|v| v.as_str()))
        .unwrap_or("");
    if last_sort_key.is_empty() {
        return None;
    }
    // sortKey 首段即该消息 epoch-ms;再 max 服务端时间串防 sortKey 异常。
    let sort_ms = split_sort_key_ms(last_sort_key);
    let time_ms = sort_ms.max(parse_server_time_to_ms(&str_or_empty(
        ss,
        "lastMessageTime",
    )));
    Some(RecentSessionSummary {
        conversation_id: conv_id,
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
        // gmt 次版本:真实 payload 在 sessionSummary 内部读;缺省空串(版本门主键用 sort_key_ms,gmt 仅同值时 tiebreak)。
        gmt_modified_time: str_or_empty(ss, "gmtModifiedTime"),
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

/// 解析排序键首段为 epoch-ms;缺省 / 非法返 0。
/// 真实 payload 排序键用 `_` 分隔(如 `"1780390520611_000..._206..."`),历史 recentFriends
/// 路径用 `:` 分隔(如 `"1715836200000:xxxx"`),纯数字串亦兼容。统一取**前导连续数字串**再 parse,
/// 既适配两种分隔符也不依赖具体分隔符。首段为该会话单调 epoch-ms;LWW 主版本。
pub fn split_sort_key_ms(s: &str) -> i64 {
    s.bytes()
        .take_while(|b| b.is_ascii_digit())
        .map(|b| b as char)
        .collect::<String>()
        .parse::<i64>()
        .unwrap_or(0)
}

/// 读取 number-or-string 形态的 id 字段为字符串。
/// 真实 payload 里 `conversationId` 多为**数字**(MARK_READ 又是字符串),需统一成字符串
/// 以与本地预建行(`open_friend_conversation` 写入的字符串 id)逐字一致。
/// 字符串优先;数字用 `as_i64`/`as_u64`(**禁 `as_f64`**:防大整数精度丢失);其余返空串。
fn json_id(v: &serde_json::Value, key: &str) -> String {
    match v.get(key) {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(n) if n.is_i64() => n.as_i64().map(|x| x.to_string()).unwrap_or_default(),
        Some(n) if n.is_u64() => n.as_u64().map(|x| x.to_string()).unwrap_or_default(),
        _ => String::new(),
    }
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

    /// 真实 payload 形态:身份字段(conversationId/wecomAccountId/externalUserId)与摘要字段
    /// 全部嵌在 `sessionSummary{}` 内;排序键叫 `lastSortKey`,用 `_` 分隔。
    /// sortKey 前缀取 1_900_000_000_000(大于 lastMessageTime 解析值),便于断言 lastSortKey 被解析。
    fn full_session_summary_event(conv: &str, acct: &str) -> serde_json::Value {
        serde_json::json!({
            "eventType": "SESSION_SUMMARY_UPSERT",
            "eventReason": "LAST_MESSAGE_CHANGED",
            "sessionSummary": {
                "conversationId": conv,
                "wecomAccountId": acct,
                "externalUserId": format!("ext_{conv}"),
                "lastLocalMessageId": "LM_A",
                "lastMessageType": 1,
                "lastMessageDirection": 2,
                "lastSendStatus": 0,
                "lastMessageSummary": "你好",
                "lastMessageTime": "2026-05-14 10:30:00",
                "lastSortKey": "1900000000000_00000000000000002001_LM_A",
                "unreadCount": 2,
                "hasUnread": true
            }
        })
    }

    #[test]
    fn decode_summary_reads_nested_session_summary() {
        let ev = full_session_summary_event("cv-1", "wa-1");
        let s = decode_summary(&ev, "u-test").expect("full payload should decode");
        // 会话定位来自 sessionSummary{} 内部(真实 payload)。
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
        // 缺 sessionSummary.conversationId
        let mut ev = full_session_summary_event("cv-1", "wa-1");
        ev["sessionSummary"]
            .as_object_mut()
            .unwrap()
            .remove("conversationId");
        assert!(decode_summary(&ev, "u-test").is_none(), "缺 conversationId");
        // 缺整个 sessionSummary
        let mut ev = full_session_summary_event("cv-1", "wa-1");
        ev.as_object_mut().unwrap().remove("sessionSummary");
        assert!(decode_summary(&ev, "u-test").is_none(), "缺 sessionSummary");
        // 缺 sessionSummary 的两个排序键(lastSortKey + lastMessageSortKey 兜底均无)
        let mut ev = full_session_summary_event("cv-1", "wa-1");
        ev["sessionSummary"]
            .as_object_mut()
            .unwrap()
            .remove("lastSortKey");
        assert!(decode_summary(&ev, "u-test").is_none(), "缺排序键");
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

    // ─── apply_push_batch 纯 UPSERT 行为(无 hub:applier 已不持有 HubClient,天然不回拉)─────

    use chathub_proto::v1::PushBatchOut;
    use chathub_state::SqlitePool;

    const EMP: &str = "42"; // 对齐 batch() 里的 employee_id=42

    async fn applier_with_stores() -> (
        RecentSessionEventApplier,
        RecentSessionsStore,
        AccountCacheStore,
        broadcast::Receiver<ChangeNotice>,
    ) {
        let pool = SqlitePool::in_memory().await.expect("pool");
        let store = RecentSessionsStore::new(pool.clone());
        let accounts = AccountCacheStore::new(pool.clone());
        let (tx, rx) = broadcast::channel(16);
        let applier = RecentSessionEventApplier::new(store.clone(), accounts.clone(), tx);
        (applier, store, accounts, rx)
    }

    fn batch(events: serde_json::Value) -> PushBatchOut {
        PushBatchOut {
            notify_seq: 1,
            client_id: "c-1".into(),
            employee_id: 42,
            batch_id: "c-1:42:0".into(),
            batch_time: "2026-05-21 10:00:00".into(),
            device_id: "dev-test".into(),
            events_json: serde_json::to_vec(&events).unwrap().into(),
        }
    }

    fn account_row(acct: &str, name: &str) -> WecomAccountRow {
        WecomAccountRow {
            wecom_account_id: acct.into(),
            employee_id: EMP.into(),
            wecom_name: name.into(),
            wecom_account: format!("acc_{acct}"),
            wecom_alias: format!("alias_{acct}"),
            wecom_avatar: String::new(),
            wecom_status: 1,
            gender: 0,
            position: String::new(),
        }
    }

    fn seed_remote(conv: &str, acct: &str, sort_ms: i64) -> RecentSessionRemote {
        RecentSessionRemote {
            conversation_id: conv.into(),
            wecom_account_id: acct.into(),
            employee_id: EMP.into(),
            wecom_name: "已存在客服".into(),
            wecom_account: "acc_old".into(),
            wecom_alias: "alias_old".into(),
            external_user_id: format!("ext_{conv}"),
            external_name: "老客户".into(),
            external_avatar: "av_old".into(),
            external_mobile: "138****0000".into(),
            last_local_message_id: "LM_OLD".into(),
            last_message_type: 1,
            last_message_direction: 1,
            last_send_status: 3,
            last_message_summary: "旧摘要".into(),
            last_message_time_ms: sort_ms,
            unread_count: 0,
            has_unread: false,
            last_message_sort_key_ms: sort_ms,
            gmt_modified_time: String::new(),
        }
    }

    #[tokio::test]
    async fn known_conversation_updates_and_preserves_display_fields() {
        let (applier, store, _accounts, mut rx) = applier_with_stores().await;
        // 预置已有行(低 sortKey,保证事件版本更新),带客户名/手机号等展示字段。
        store
            .upsert_remote_one(seed_remote("cv-1", "wa-1", 1_000_000_000_000))
            .await
            .unwrap();

        // 事件不带任何客户资料字段、sortKey 更高 → 只更新摘要列,保留展示字段。
        applier
            .apply_push_batch(&batch(serde_json::json!([full_session_summary_event(
                "cv-1", "wa-1"
            )])))
            .await;

        let rows = store.list_top(EMP, None, 50).await.unwrap();
        let row = rows.iter().find(|r| r.conversation_id == "cv-1").unwrap();
        assert_eq!(row.last_message_summary, "你好", "摘要被更新");
        assert_eq!(row.last_message_sort_key_ms, 1_900_000_000_000);
        assert_eq!(row.external_name, "老客户", "展示字段保留(事件未带不抹空)");
        assert_eq!(row.external_mobile, "138****0000", "手机号保留");

        let notice = rx.try_recv().expect("应发 ChangeNotice");
        assert_eq!(notice.topic, ChangeTopic::RecentSessions);
        assert_eq!(notice.scope.employee_id, EMP);
        assert_eq!(notice.scope.wecom_account_id.as_deref(), Some("wa-1"));
    }

    #[tokio::test]
    async fn unknown_conversation_inserts_from_event_with_account_display() {
        let (applier, store, accounts, mut rx) = applier_with_stores().await;
        // 账号缓存里有 wa-1 展示信息;新会话 INSERT 据此补 wecom_*。
        accounts
            .replace_all_for_employee(EMP, &[account_row("wa-1", "客服A")])
            .await
            .unwrap();

        // 任意 reason(此处 LAST_MESSAGE_CHANGED,非 SUMMARY_CREATED)的未知会话也直接 INSERT。
        applier
            .apply_push_batch(&batch(serde_json::json!([full_session_summary_event(
                "cv-new", "wa-1"
            )])))
            .await;

        assert!(
            store.exists(EMP, "cv-new").await.unwrap(),
            "未知会话事件应直接 INSERT 入库"
        );
        let rows = store.list_top(EMP, None, 50).await.unwrap();
        let row = rows.iter().find(|r| r.conversation_id == "cv-new").unwrap();
        assert_eq!(row.wecom_account_id, "wa-1");
        assert_eq!(row.wecom_name, "客服A", "企微展示名从账号缓存补上");
        assert_eq!(row.wecom_account, "acc_wa-1");
        assert_eq!(row.external_user_id, "ext_cv-new", "外部 id 取自事件顶层");
        assert_eq!(row.last_message_summary, "你好");
        assert_eq!(row.unread_count, 2);
        assert_eq!(row.external_mobile, "", "事件不带手机号 → 暂空,后续补");

        let notice = rx.try_recv().expect("应发 ChangeNotice");
        assert_eq!(notice.topic, ChangeTopic::RecentSessions);
        assert_eq!(notice.scope.wecom_account_id.as_deref(), Some("wa-1"));
    }

    #[tokio::test]
    async fn thin_payload_without_conversation_id_is_skipped() {
        let (applier, store, _accounts, mut rx) = applier_with_stores().await;
        let mut ev = full_session_summary_event("cv-x", "wa-1");
        // 真实 payload:conversationId 在 sessionSummary 内部;移除即瘦 payload。
        ev["sessionSummary"]
            .as_object_mut()
            .unwrap()
            .remove("conversationId");

        applier
            .apply_push_batch(&batch(serde_json::json!([ev])))
            .await;

        assert!(rx.try_recv().is_err(), "瘦 payload 不应发 ChangeNotice");
        let rows = store.list_top(EMP, None, 50).await.unwrap();
        assert!(rows.is_empty(), "瘦 payload 不应入库");
    }

    #[test]
    fn split_sort_key_ms_handles_underscore_colon_and_plain() {
        // 真实 payload 用 `_` 分隔。
        assert_eq!(
            split_sort_key_ms("1780390520611_00000000000000000000_2061733392617046016"),
            1_780_390_520_611
        );
        // 历史 recentFriends 路径用 `:` 分隔(回归保护)。
        assert_eq!(split_sort_key_ms("1715836200000:xxxx"), 1_715_836_200_000);
        // 纯数字串。
        assert_eq!(split_sort_key_ms("1900000000000"), 1_900_000_000_000);
        // 无前导数字 / 空串 → 0。
        assert_eq!(split_sort_key_ms(""), 0);
        assert_eq!(split_sort_key_ms("_123"), 0);
        assert_eq!(split_sort_key_ms("abc"), 0);
    }

    #[test]
    fn decode_summary_parses_numeric_conversation_id() {
        // 真实 payload:conversationId 为数字;decode 用 as_i64/as_u64 转字符串,
        // 必须与本地预建行(open_friend_conversation 写入的字符串 id)逐字一致。
        let ev = serde_json::json!({
            "eventType": "SESSION_SUMMARY_UPSERT",
            "eventReason": "SUMMARY_CREATED",
            "sessionSummary": {
                "conversationId": 2061726528261062656i64,
                "wecomAccountId": "GuoHeZuZi",
                "externalUserId": "ext_x",
                "lastMessageSummary": "你好",
                "lastMessageTime": "2026-06-02T16:28:28.348",
                "lastSortKey": "1900000000000_0000_LM_A",
                "unreadCount": 0,
                "hasUnread": false
            }
        });
        let s = decode_summary(&ev, "u-test").expect("numeric conversationId should decode");
        assert_eq!(
            s.conversation_id, "2061726528261062656",
            "数字 conversationId 应转成无小数点的字符串"
        );
    }

    #[test]
    fn decode_summary_ref_event_is_skipped() {
        // UNREAD_CHANGED 第3事件:sessionSummary 是 {"$ref":...},serde 不解引用 → decode 返 None。
        let ev = serde_json::json!({
            "eventType": "SESSION_SUMMARY_UPSERT",
            "eventReason": "UNREAD_CHANGED",
            "sessionSummary": { "$ref": "$.events[1].sessionSummary" }
        });
        assert!(
            decode_summary(&ev, "u-test").is_none(),
            "$ref 事件应被跳过(数据由兄弟事件承载)"
        );
    }

    #[test]
    fn decode_summary_falls_back_to_last_message_sort_key() {
        // MARK_READ 形态:无 lastSortKey,排序键叫 lastMessageSortKey → 双键兜底仍可解析。
        let mut ev = full_session_summary_event("cv-1", "wa-1");
        let ss = ev["sessionSummary"].as_object_mut().unwrap();
        ss.remove("lastSortKey");
        ss.insert(
            "lastMessageSortKey".into(),
            serde_json::json!("1780389010559_00000001780389010559_206"),
        );
        let s = decode_summary(&ev, "u-test").expect("lastMessageSortKey 兜底应可解码");
        assert_eq!(s.last_message_sort_key_ms, 1_780_389_010_559);
    }

    #[tokio::test]
    async fn mark_read_clears_unread_via_clear_unread() {
        let (applier, store, _accounts, mut rx) = applier_with_stores().await;
        // 预置一行 unread=3(模拟入站后未读)。
        let mut seeded = seed_remote("cv-1", "wa-1", 1_000_000_000_000);
        seeded.unread_count = 3;
        seeded.has_unread = true;
        store.upsert_remote_one(seeded).await.unwrap();
        let rows = store.list_top(EMP, None, 50).await.unwrap();
        assert_eq!(
            rows.iter()
                .find(|r| r.conversation_id == "cv-1")
                .unwrap()
                .unread_count,
            3,
            "预置未读应为 3"
        );

        // MARK_READ 事件(conversationId 在真实 payload 里是字符串,排序键叫 lastMessageSortKey)。
        let ev = serde_json::json!({
            "eventType": "SESSION_SUMMARY_UPSERT",
            "eventReason": "MARK_READ",
            "sessionSummary": {
                "conversationId": "cv-1",
                "wecomAccountId": "wa-1",
                "externalUserId": "ext_cv-1",
                "gmtModifiedTime": "2026-06-02 16:30:10",
                "hasUnread": false,
                "lastMessageSortKey": "1000000000000_0000_LM_OLD",
                "lastMessageSummary": "旧摘要",
                "lastMessageTime": "2026-06-02 16:30:11",
                "unreadCount": 0
            }
        });
        applier
            .apply_push_batch(&batch(serde_json::json!([ev])))
            .await;

        let rows = store.list_top(EMP, None, 50).await.unwrap();
        let row = rows.iter().find(|r| r.conversation_id == "cv-1").unwrap();
        assert_eq!(row.unread_count, 0, "MARK_READ 应清零未读(绕过版本门)");
        assert!(!row.has_unread, "has_unread 应被清零");

        let notice = rx.try_recv().expect("MARK_READ 仍应发 ChangeNotice");
        assert_eq!(notice.topic, ChangeTopic::RecentSessions);
    }
}
