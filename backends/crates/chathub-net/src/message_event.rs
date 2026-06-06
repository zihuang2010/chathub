//! 消息气泡事件应用器:Subscribe 流里 `MESSAGE_UPSERT` 事件 → 本地 `hub_conversation_messages`
//! 气泡 upsert(规范 §8.3)。与 `recent_session_event.rs` 正交:recents 管列表摘要,本模块管气泡。
//!
//! Hybrid:热会话(本地有窗口)直接 upsert payload 快照;瘦 payload / 解码失败 / 附件转存中
//! → `MessageSync.reconcile_newest` 兜底(全局 1s 节流)。冷会话(无窗口)跳过,绝不建孤儿气泡。

use crate::change_notice::{ChangeNotice, ChangeScope, ChangeTopic};
// D3:复用 message_sync 的 pub(crate) 时间助手(now_ms),去掉本模块重复 now_unix_ms 副本。
use crate::message_sync::{now_ms, parse_server_time_to_ms, MessageSync};
use crate::recent_session_event::split_sort_key_ms;
use chathub_proto::v1::PushBatchOut;
use chathub_state::{MessageRow, MessagesStore, QuarantinedEventsStore};
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
pub fn to_local_direction(direction: i64) -> i32 {
    match direction {
        1 | 3 => 2,
        _ => 1,
    }
}

/// 多端同步消息(上游 `messageDirection==3`,新 `MULTI_DEVICE_SYNC` 事件承载)的 send_status 归一。
/// 多端同步是「已在他端发出的成品消息」,不存在「发送中」语义;但上游对其 `sendStatus` 给 0(未置位)。
/// 若原样落库,出站气泡走前端 `mapSendStatus(0)` 会判成「发送中」→ 永久转圈(同 type99 出站误判一类)。
/// 故 `direction==3` 且 `sendStatus` 未置位(0)时归一为成功(3);上游已明确的非 0 终态(含 4=失败)
/// 一律尊重原值,不臆改。direction 1/2 完全不动(发送方走正常 send→PENDING(2)→CONFIRMED(3) 生命周期)。
pub fn normalize_sync_send_status(source_direction: i64, raw_send_status: i32) -> i32 {
    if source_direction == 3 && raw_send_status == 0 {
        3 // SEND_STATUS 成功
    } else {
        raw_send_status
    }
}

fn str_or_empty(v: &serde_json::Value, key: &str) -> String {
    v.get(key)
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string()
}

/// 读取一个"可能是字符串、也可能是数字"的 id 字段为字符串。
/// 真实 payload 里 conversationId 多为数字(大整数,如 2060260503288029184),
/// 必须用 `as_i64`/`as_u64` 整型转换,**禁止 `as_f64`**(浮点会丢大整数精度,
/// 导致与预建会话行的字符串 id 逐字不一致)。非字符串非整数 → 空串。
fn json_id(v: &serde_json::Value, key: &str) -> String {
    match v.get(key) {
        Some(x) if x.is_string() => x.as_str().unwrap_or("").to_string(),
        Some(x) => {
            if let Some(i) = x.as_i64() {
                i.to_string()
            } else if let Some(u) = x.as_u64() {
                u.to_string()
            } else {
                String::new()
            }
        }
        None => String::new(),
    }
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
/// 真实 payload 把业务体放在 `message{}` 内部:`conversationId`/`wecomAccountId`/
/// `externalUserId` 都在 message 里,且 `conversationId` 多为数字;消息类型字段是
/// `chatMessageType`(部分入站事件仍用 `messageType`);时间 `messageTime` 是 ISO-T+毫秒,
/// 还可能带数字型 `messageTimeMillis`(epoch-ms)。
/// 必填:`message{}` 存在、`message.conversationId` 非空、`message.localMessageId` 非空、
/// `message.sortKey` 非空。缺失 → None(调用者走兜底)。`employee_id` 来自 batch,不在 payload。
fn decode_message_row(ev: &serde_json::Value, employee_id: &str) -> Option<MessageRow> {
    let msg = ev.get("message")?;
    let conversation_id = json_id(msg, "conversationId");
    if conversation_id.is_empty() {
        return None;
    }
    let local_message_id = msg.get("localMessageId").and_then(|v| v.as_str())?;
    if local_message_id.is_empty() {
        return None;
    }
    let sort_key = msg.get("sortKey").and_then(|v| v.as_str())?;
    if sort_key.is_empty() {
        return None;
    }
    let message_time = str_or_empty(msg, "messageTime");
    let millis = msg
        .get("messageTimeMillis")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    // 缺省按客户/接收方处理,避免缺方向时误画成我方发送。
    let direction = msg
        .get("messageDirection")
        .and_then(|v| v.as_i64())
        .unwrap_or(2);
    // 多端同步(direction==3)的 sendStatus 上游给 0(未置位):归一为成功,杜绝出站气泡永久转圈。
    let send_status = normalize_sync_send_status(
        direction,
        msg.get("sendStatus").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
    );
    let attachments_json = msg
        .get("attachments")
        .map(|a| a.to_string())
        .unwrap_or_else(|| "[]".to_string());
    // 类型:chatMessageType 优先,messageType 兜底(入站事件偶用后者);缺省 1(文本)。
    let message_type = msg
        .get("chatMessageType")
        .or_else(|| msg.get("messageType"))
        .and_then(|v| v.as_i64())
        .unwrap_or(1) as i32;
    // 新鲜度取三源最大:sortKey 前导 ms、messageTime(ISO-T)、messageTimeMillis。
    let freshness = split_sort_key_ms(sort_key)
        .max(parse_server_time_to_ms(&message_time))
        .max(millis);
    Some(MessageRow {
        local_message_id: local_message_id.to_string(),
        conversation_id,
        employee_id: employee_id.to_string(),
        wecom_account_id: json_id(msg, "wecomAccountId"),
        sort_key: sort_key.to_string(),
        message_time_ms: freshness,
        message_direction: to_local_direction(direction),
        // 持久化上游原始方向(1/2/3,含 MULTI_DEVICE_SYNC=3),供读路径派生方向 + 多端同步标记。
        source_direction: direction as i32,
        message_type,
        content_text: str_or_empty(msg, "contentText"),
        send_status,
        attachments_json,
        gmt_modified_time: str_or_empty(msg, "gmtModifiedTime"),
        revoked: ev.get("eventReason").and_then(|v| v.as_str()) == Some("MESSAGE_REVOKED"),
        fail_reason: str_or_empty(msg, "failReason"),
        request_message_id: str_or_empty(msg, "requestMessageId"),
        updated_at_ms: 0,
    })
}

/// 判定一条 `MESSAGE_UPSERT` 事件是否「语义矛盾」(明显错误的上游推送)。命中返回隔离原因,
/// 调用方据此把整条事件丢进异常库、不入正常消息库。
///
/// 当前唯一指纹(四者同时成立才算脏,读**原始 push 字段**,非 to_local_direction 之后的本地值):
///   - messageType==99(`chatMessageType` 优先,`messageType` 兜底,与 decode 同口径) → 未知类型
///   - messageDirection==1                                                          → 上游标「发送方」
///   - eventReason=="CUSTOMER_MESSAGE_RECEIVED"                                      → 实为入站客户消息
///   - sendStatus==0                                                                → 入站无 send_status
///
/// 入站却被标成发送方 ⇒ 落库会被判成出站 + 永久「发送中」转圈。指纹刻意收窄,避免误伤正常消息。
fn semantic_conflict_reason(ev: &serde_json::Value) -> Option<&'static str> {
    let msg = ev.get("message")?;
    let message_type = msg
        .get("chatMessageType")
        .or_else(|| msg.get("messageType"))
        .and_then(|v| v.as_i64())?;
    let direction = msg.get("messageDirection").and_then(|v| v.as_i64())?;
    let send_status = msg.get("sendStatus").and_then(|v| v.as_i64()).unwrap_or(0);
    let event_reason = ev.get("eventReason").and_then(|v| v.as_str()).unwrap_or("");
    if message_type == 99
        && direction == 1
        && event_reason == "CUSTOMER_MESSAGE_RECEIVED"
        && send_status == 0
    {
        Some("semantic_conflict_in_as_out")
    } else {
        None
    }
}

#[derive(Clone)]
pub struct MessageEventApplier {
    store: MessagesStore,
    /// 兜底复用:reconcile_newest(fetch → classify → stitch/replace → upsert window → 发通知)。
    sync: MessageSync,
    /// 异常库:语义矛盾的脏事件落库前被拦截,改入此库供后续排查(见 `semantic_conflict_reason`)。
    quarantine: QuarantinedEventsStore,
    change_notice_tx: broadcast::Sender<ChangeNotice>,
    /// 全局兜底节流(同 RecentSessionEventApplier)。
    last_fallback_ms: Arc<AtomicI64>,
}

impl MessageEventApplier {
    pub fn new(
        store: MessagesStore,
        sync: MessageSync,
        quarantine: QuarantinedEventsStore,
        change_notice_tx: broadcast::Sender<ChangeNotice>,
    ) -> Self {
        Self {
            store,
            sync,
            quarantine,
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

            // 真实 payload:conversationId 在 message{} 内、且多为数字。
            let conv_id = match ev.get("message") {
                Some(msg) => {
                    let id = json_id(msg, "conversationId");
                    if id.is_empty() {
                        continue; // 无会话定位,无法落气泡
                    }
                    id
                }
                None => continue, // 无 message 快照
            };

            // 语义矛盾脏事件网关:入站客户消息却被上游标成发送方(messageDirection=1)+ 未知类型
            // (messageType=99)+ 无 send_status(0)。若入正常库会被 to_local_direction(1→2) 判成
            // 出站、send_status=0 永远算「发送中」→ 前端无限转圈。拦截:写异常库 + 丢弃,绝不入正常
            // 消息库、也不进 fallback(避免 reconcile_newest 从上游把同一脏消息再拉回)。
            if let Some(reason) = semantic_conflict_reason(ev) {
                let local_id = ev
                    .get("message")
                    .and_then(|m| m.get("localMessageId"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if let Err(e) = self
                    .quarantine
                    .insert_event(&employee_id, &conv_id, local_id, reason, &ev.to_string())
                    .await
                {
                    warn!(target: "chathub_net::message_event", ?e, conv_id, "quarantine insert failed");
                }
                continue;
            }

            // 热会话门控:无窗口 → 冷会话,跳过(recents + 打开时 reconcile 负责)。
            let has_window = match self.store.get_window(&employee_id, &conv_id).await {
                Ok(w) => w.is_some(),
                Err(e) => {
                    warn!(target: "chathub_net::message_event", ?e, conv_id, "get_window failed; skip");
                    continue;
                }
            };
            if !has_window {
                // 冷会话:不建孤儿气泡,但**已落库**的行(如转存中→成功)仍要就地刷新 + 通知。
                // 只 UPDATE 已存在行(绝不 INSERT);真有变化(且非回退)才计入通知集合,避免空通知。
                // 这修复「转存完成事件到达时会话非热 → 整条被跳过 → 永久卡在转存中」的根因。
                if let Some(row) = decode_message_row(ev, &employee_id) {
                    match self
                        .store
                        .update_message_attachments_if_exists(
                            &employee_id,
                            &row.local_message_id,
                            &row.attachments_json,
                        )
                        .await
                    {
                        Ok(true) => {
                            applied_convs.insert(conv_id);
                        }
                        Ok(false) => {}
                        Err(e) => {
                            warn!(target: "chathub_net::message_event", ?e, conv_id, "cold-conv attachment update failed");
                        }
                    }
                }
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
            let now = now_ms();
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
        let now = now_ms();
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
/// 真实 payload:wecomAccountId/externalUserId 在 `message{}` 内部。
fn push_fallback(acc: &mut Vec<(String, String, String)>, ev: &serde_json::Value, conv_id: &str) {
    let msg = ev.get("message");
    let acct = msg
        .map(|m| json_id(m, "wecomAccountId"))
        .unwrap_or_default();
    let ext = msg
        .and_then(|m| m.get("externalUserId"))
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

    /// 真实形态的 MESSAGE_UPSERT 事件:业务体全在 `message{}` 内,conversationId 为数字,
    /// 类型字段 `chatMessageType`,sortKey 用 `_` 分隔,messageTime 用 ISO-T+毫秒,
    /// 并带数字型 `messageTimeMillis` 作为跨格式新鲜度兜底(真实入站样例形态)。
    /// `conv` 形参是会话 id 的数字字符串(如 "2060260503288029184")。
    fn full_event(conv: &str, direction: i64) -> serde_json::Value {
        let conv_num: i64 = conv.parse().expect("conv 必须是数字字符串");
        serde_json::json!({
            "eventType": "MESSAGE_UPSERT",
            "eventReason": "CUSTOMER_MESSAGE_RECEIVED",
            "message": {
                "conversationId": conv_num,
                "wecomAccountId": "GuoHeZuZi",
                "externalUserId": "wmITqmBgAAZg4SntYu9tFAcrFp1GZrKg",
                "localMessageId": "LM_A",
                "messageDirection": direction,
                "chatMessageType": 1,
                "sendStatus": 3,
                "sortKey": "1780390520611_00000000000000000000_2061733392617046016",
                "messageTime": "2026-06-02T16:55:20.611",
                "messageTimeMillis": 1780390520611i64,
                "contentText": "你好",
                "attachments": []
            }
        })
    }

    #[test]
    fn json_id_reads_number_and_string() {
        // 大整数 conversationId(超 f64 安全整数)必须逐字保真。
        let big = serde_json::json!({ "conversationId": 2060260503288029184i64 });
        assert_eq!(json_id(&big, "conversationId"), "2060260503288029184");
        // MARK_READ 那类 string id 直接取字符串。
        let s = serde_json::json!({ "conversationId": "2061726528261062656" });
        assert_eq!(json_id(&s, "conversationId"), "2061726528261062656");
        // 缺失 / 非标量 → 空串。
        assert_eq!(json_id(&serde_json::json!({}), "conversationId"), "");
        let arr = serde_json::json!({ "conversationId": [1, 2] });
        assert_eq!(json_id(&arr, "conversationId"), "");
    }

    #[test]
    fn decode_full_payload_translates_customer_direction_to_in() {
        let ev = full_event("2060260503288029184", 2); // 2 = 客户/接收方
        let r = decode_message_row(&ev, "42").expect("full payload decodes");
        assert_eq!(r.local_message_id, "LM_A");
        assert_eq!(
            r.conversation_id, "2060260503288029184",
            "数字 conversationId 转字符串、逐字保真"
        );
        assert_eq!(
            r.wecom_account_id, "GuoHeZuZi",
            "wecomAccountId 来自 message{{}}"
        );
        assert_eq!(r.employee_id, "42", "employee_id 来自 batch,不在 payload");
        assert_eq!(r.message_direction, 1, "2=客户/接收方 → 本地 1(in)");
        assert_eq!(r.content_text, "你好");
        assert_eq!(r.message_type, 1, "chatMessageType 优先");
        assert!(r.message_time_ms > 0, "messageTimeMillis 兜底新鲜度");
        assert!(!r.revoked, "非撤回事件 revoked=false");
    }

    #[test]
    fn decode_translates_sender_and_sync_to_out() {
        assert_eq!(
            decode_message_row(&full_event("2060260503288029184", 1), "42")
                .unwrap()
                .message_direction,
            2,
            "1=发送方 → 本地 2(out)"
        );
        assert_eq!(
            decode_message_row(&full_event("2060260503288029184", 3), "42")
                .unwrap()
                .message_direction,
            2,
            "3=多端同步方 → 本地 2(out)"
        );
        // 源方向原样持久化:多端同步(3)据此在读路径派生 synced_from_other_device。
        assert_eq!(
            decode_message_row(&full_event("2060260503288029184", 3), "42")
                .unwrap()
                .source_direction,
            3,
            "MULTI_DEVICE_SYNC 源方向 3 落库"
        );
        assert_eq!(
            decode_message_row(&full_event("2060260503288029184", 1), "42")
                .unwrap()
                .source_direction,
            1,
            "发送方源方向 1 落库"
        );
    }

    #[test]
    fn normalize_sync_send_status_only_lifts_unset_for_multi_device_sync() {
        // 多端同步(源方向 3)且 sendStatus 未置位(0)→ 归一成功(3),杜绝出站气泡永久转圈。
        assert_eq!(normalize_sync_send_status(3, 0), 3, "多端同步未置位 → 成功");
        // 上游已明确终态一律尊重原值,不臆改(含 4=失败)。
        assert_eq!(
            normalize_sync_send_status(3, 4),
            4,
            "多端同步已明确失败 → 保留 4"
        );
        assert_eq!(normalize_sync_send_status(3, 3), 3, "已成功 → 不变");
        // 发送方/客户方完全不动:发送方走正常 send→PENDING(2)→CONFIRMED(3),0 是合法在途。
        assert_eq!(
            normalize_sync_send_status(1, 0),
            0,
            "发送方 sendStatus=0 不动"
        );
        assert_eq!(normalize_sync_send_status(2, 0), 0, "客户/接收方不动");
    }

    #[test]
    fn decode_prefers_chat_message_type_then_falls_back_to_message_type() {
        // 仅 messageType(无 chatMessageType)→ 取 messageType。
        let mut ev = full_event("2060260503288029184", 2);
        ev["message"]
            .as_object_mut()
            .unwrap()
            .remove("chatMessageType");
        ev["message"]["messageType"] = serde_json::json!(4);
        assert_eq!(
            decode_message_row(&ev, "42").unwrap().message_type,
            4,
            "缺 chatMessageType 时回退 messageType"
        );
    }

    #[test]
    fn decode_missing_required_returns_none() {
        let mut ev = full_event("2060260503288029184", 2);
        ev["message"]
            .as_object_mut()
            .unwrap()
            .remove("localMessageId");
        assert!(decode_message_row(&ev, "42").is_none(), "缺 localMessageId");

        let mut ev = full_event("2060260503288029184", 2);
        ev["message"].as_object_mut().unwrap().remove("sortKey");
        assert!(decode_message_row(&ev, "42").is_none(), "缺 sortKey");

        let mut ev = full_event("2060260503288029184", 2);
        ev["message"]
            .as_object_mut()
            .unwrap()
            .remove("conversationId");
        assert!(
            decode_message_row(&ev, "42").is_none(),
            "缺 message.conversationId"
        );

        let mut ev = full_event("2060260503288029184", 2);
        ev.as_object_mut().unwrap().remove("message");
        assert!(decode_message_row(&ev, "42").is_none(), "缺 message 快照");
    }

    #[test]
    fn decode_message_revoked_sets_revoked_flag() {
        let mut ev = full_event("2060260503288029184", 2);
        ev["eventReason"] = serde_json::json!("MESSAGE_REVOKED");
        let r = decode_message_row(&ev, "42").expect("撤回事件可解码");
        assert!(r.revoked, "MESSAGE_REVOKED → revoked=true");
    }

    #[test]
    fn decode_send_failed_carries_fail_reason_and_status() {
        let mut ev = full_event("2060260503288029184", 1);
        ev["eventReason"] = serde_json::json!("SEND_FAILED");
        ev["message"]["sendStatus"] = serde_json::json!(4);
        ev["message"]["failReason"] =
            serde_json::json!("MAPPING_NOT_FOUND:2:wmITqmBgAAZg4SntYu9tFAcrFp1GZrKg");
        let r = decode_message_row(&ev, "42").expect("失败事件可解码");
        assert_eq!(r.send_status, 4, "send_status=4 失败");
        assert!(!r.fail_reason.is_empty(), "fail_reason 非空");
        assert!(!r.revoked, "失败不等于撤回");
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
        QuarantinedEventsStore,
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
        let quarantine = QuarantinedEventsStore::new(pool.clone());
        let applier = MessageEventApplier::new(store.clone(), sync, quarantine.clone(), tx);
        (applier, store, quarantine, rx)
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

    /// 真实形态数字会话 id(字符串)。与 `full_event` 内的数字 conversationId 对齐。
    const CONV: &str = "2060260503288029184";

    fn seed_window(conv: &str, employee_id: &str, newest_sort_key: &str) -> MessageWindow {
        MessageWindow {
            conversation_id: conv.into(),
            employee_id: employee_id.into(),
            wecom_account_id: "GuoHeZuZi".into(),
            external_user_id: "wmITqmBgAAZg4SntYu9tFAcrFp1GZrKg".into(),
            newest_sort_key: newest_sort_key.into(),
            oldest_sort_key: "0000000000000_0_0".into(),
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
        let (applier, store, _quarantine, mut rx) = applier_with_store().await;
        store
            .upsert_window(seed_window(CONV, "42", "0000000000000_0_0"))
            .await
            .unwrap();

        applier
            .apply_push_batch(&batch(serde_json::json!([full_event(CONV, 2)]), 42, 10))
            .await;

        let rows = store.list_recent("42", CONV, 10).await.unwrap();
        assert_eq!(rows.len(), 1, "气泡已落库");
        assert_eq!(rows[0].local_message_id, "LM_A");
        assert_eq!(rows[0].conversation_id, CONV, "数字会话 id 转字符串落库");
        assert_eq!(rows[0].message_direction, 1, "客户消息 → in");
        assert_eq!(rows[0].content_text, "你好");

        let w = store.get_window("42", CONV).await.unwrap().unwrap();
        assert_eq!(
            w.newest_sort_key, "1780390520611_00000000000000000000_2061733392617046016",
            "窗口 newest 扩界为真实 sortKey"
        );

        let notice = rx.try_recv().expect("ConversationMessages 通知");
        assert_eq!(notice.topic, ChangeTopic::ConversationMessages);
        assert_eq!(notice.scope.conversation_id.as_deref(), Some(CONV));
        assert_eq!(notice.scope.employee_id, "42");
    }

    #[tokio::test]
    async fn multi_device_sync_lands_as_sent_outbound_bubble() {
        let (applier, store, quarantine, _rx) = applier_with_store().await;
        store
            .upsert_window(seed_window(CONV, "42", "0000000000000_0_0"))
            .await
            .unwrap();

        // 真实多端同步事件:新 MULTI_DEVICE_SYNC + messageDirection=3 + sendStatus=0 + messageType=1。
        let mut ev = full_event(CONV, 3);
        ev["eventReason"] = serde_json::json!("MULTI_DEVICE_SYNC");
        ev["message"]["sendStatus"] = serde_json::json!(0);
        applier
            .apply_push_batch(&batch(serde_json::json!([ev]), 42, 10))
            .await;

        // 不应被语义矛盾网关误隔离(指纹要求 direction==1 + CUSTOMER_MESSAGE_RECEIVED)。
        assert!(
            quarantine.list_recent("42", 10).await.unwrap().is_empty(),
            "MULTI_DEVICE_SYNC 不该进异常库"
        );
        let rows = store.list_recent("42", CONV, 10).await.unwrap();
        assert_eq!(rows.len(), 1, "多端同步气泡已落库");
        assert_eq!(rows[0].message_direction, 2, "源方向 3 → 本地 out(出站)");
        assert_eq!(
            rows[0].send_status, 3,
            "sendStatus=0 归一为成功(3):出站气泡显示已发送、不永久转圈"
        );
    }

    #[tokio::test]
    async fn cold_conversation_skips_no_orphan() {
        let (applier, store, _quarantine, mut rx) = applier_with_store().await;
        // 不预置窗口 → 冷会话
        applier
            .apply_push_batch(&batch(serde_json::json!([full_event(CONV, 2)]), 42, 10))
            .await;
        assert!(
            store.list_recent("42", CONV, 10).await.unwrap().is_empty(),
            "不落气泡"
        );
        assert!(
            store.get_window("42", CONV).await.unwrap().is_none(),
            "不建孤儿窗口"
        );
        assert!(rx.try_recv().is_err(), "无通知");
    }

    #[tokio::test]
    async fn cold_conversation_updates_existing_attachments_and_notifies() {
        // 冷会话(无 window)但消息行已存在(此前转存中已落库):转存完成事件应就地刷新
        // 该行附件并发通知,不建孤儿气泡。覆盖「卡在转存中、切回/重启才更新」的根因。
        let (applier, store, _quarantine, mut rx) = applier_with_store().await;

        // 预置一条「转存中(1)」行,但**不**建窗口 → 冷会话。
        let mut pending_ev = full_event(CONV, 2);
        pending_ev["message"]["attachments"] =
            serde_json::json!([{ "attachmentType": 3, "transferStatus": 1 }]);
        let pending_row = decode_message_row(&pending_ev, "42").expect("pending 行可解码");
        store.upsert_messages(&[pending_row]).await.unwrap();
        assert!(
            store.get_window("42", CONV).await.unwrap().is_none(),
            "前提:冷会话无窗口"
        );

        // 转存完成事件(transferStatus=2),同 localMessageId。
        let mut changed = full_event(CONV, 2);
        changed["eventReason"] = serde_json::json!("ATTACHMENT_TRANSFER_CHANGED");
        changed["message"]["attachments"] =
            serde_json::json!([{ "attachmentType": 3, "transferStatus": 2 }]);
        applier
            .apply_push_batch(&batch(serde_json::json!([changed]), 42, 11))
            .await;

        let rows = store.list_recent("42", CONV, 10).await.unwrap();
        assert_eq!(rows.len(), 1, "不新增第二条");
        assert!(
            rows[0].attachments_json.contains("\"transferStatus\":2"),
            "冷会话已存在行被刷成成功(2);实得 {}",
            rows[0].attachments_json
        );
        let notice = rx
            .try_recv()
            .expect("冷会话就地更新也要发 ConversationMessages 通知");
        assert_eq!(notice.topic, ChangeTopic::ConversationMessages);
        assert_eq!(notice.scope.conversation_id.as_deref(), Some(CONV));
        assert_eq!(notice.scope.employee_id, "42");
    }

    #[tokio::test]
    async fn send_confirmed_updates_same_bubble_not_duplicate() {
        let (applier, store, _quarantine, _rx) = applier_with_store().await;
        store
            .upsert_window(seed_window(CONV, "42", "0000000000000_0_0"))
            .await
            .unwrap();
        // 先来一条 sendStatus=2(发送中)
        let mut ev = full_event(CONV, 1);
        ev["eventReason"] = serde_json::json!("SEND_PENDING_CREATED");
        ev["message"]["sendStatus"] = serde_json::json!(2);
        applier
            .apply_push_batch(&batch(serde_json::json!([ev]), 42, 10))
            .await;
        // 再来 SEND_CONFIRMED 同 localMessageId,sendStatus=3
        let mut ev2 = full_event(CONV, 1);
        ev2["eventReason"] = serde_json::json!("SEND_CONFIRMED");
        ev2["message"]["sendStatus"] = serde_json::json!(3);
        applier
            .apply_push_batch(&batch(serde_json::json!([ev2]), 42, 11))
            .await;

        let rows = store.list_recent("42", CONV, 10).await.unwrap();
        assert_eq!(rows.len(), 1, "同 localMessageId 不新增第二条");
        assert_eq!(rows[0].send_status, 3, "send_status 被刷新");
    }

    #[tokio::test]
    async fn non_message_event_is_noop() {
        let (applier, store, _quarantine, mut rx) = applier_with_store().await;
        store
            .upsert_window(seed_window(CONV, "42", "0000000000000_0_0"))
            .await
            .unwrap();
        applier
            .apply_push_batch(&batch(
                serde_json::json!([{ "eventType": "ACCOUNT_STATUS_CHANGE", "wecomAccountId": "wa-1" }]),
                42,
                10,
            ))
            .await;
        assert!(store.list_recent("42", CONV, 10).await.unwrap().is_empty());
        assert!(rx.try_recv().is_err());
    }

    /// 拦截指纹只在四条件同时成立时命中,缺任一条件都不拦截(防误伤正常消息)。
    #[test]
    fn semantic_conflict_reason_matches_only_full_fingerprint() {
        // 真实脏报文形态:messageType=99(无 chatMessageType)+ messageDirection=1
        //   + eventReason=CUSTOMER_MESSAGE_RECEIVED + sendStatus=0。
        let mut dirty = full_event(CONV, 1);
        dirty["message"]
            .as_object_mut()
            .unwrap()
            .remove("chatMessageType");
        dirty["message"]["messageType"] = serde_json::json!(99);
        dirty["message"]["sendStatus"] = serde_json::json!(0);
        assert_eq!(
            semantic_conflict_reason(&dirty),
            Some("semantic_conflict_in_as_out"),
            "四条件齐(messageType 兜底取 99)→ 命中"
        );

        // 缺任一条件都不拦截:
        let mut s3 = dirty.clone();
        s3["message"]["sendStatus"] = serde_json::json!(3);
        assert!(
            semantic_conflict_reason(&s3).is_none(),
            "sendStatus≠0 不拦截"
        );
        let mut t1 = dirty.clone();
        t1["message"]["messageType"] = serde_json::json!(1);
        assert!(
            semantic_conflict_reason(&t1).is_none(),
            "messageType≠99 不拦截"
        );
        let mut d2 = dirty.clone();
        d2["message"]["messageDirection"] = serde_json::json!(2);
        assert!(
            semantic_conflict_reason(&d2).is_none(),
            "messageDirection≠1 不拦截"
        );
        let mut r = dirty.clone();
        r["eventReason"] = serde_json::json!("SEND_CONFIRMED");
        assert!(
            semantic_conflict_reason(&r).is_none(),
            "eventReason≠CUSTOMER_MESSAGE_RECEIVED 不拦截"
        );
    }

    /// 脏事件被隔离进异常库、不入正常消息库;同批次正常事件不受影响照常落库。
    #[tokio::test]
    async fn dirty_semantic_conflict_event_quarantined_not_stored() {
        let (applier, store, quarantine, _rx) = applier_with_store().await;
        // 预置窗口:让同批正常事件能命中热会话直接 upsert(证明拦截不波及兄弟事件)。
        store
            .upsert_window(seed_window(CONV, "42", "0000000000000_0_0"))
            .await
            .unwrap();

        // 脏事件(真实报文形态)+ 同批正常客户消息(type=1, direction=2 → in, localMessageId=LM_A)。
        let mut dirty = full_event(CONV, 1);
        dirty["message"]["localMessageId"] = serde_json::json!("LM_DIRTY");
        dirty["message"]
            .as_object_mut()
            .unwrap()
            .remove("chatMessageType");
        dirty["message"]["messageType"] = serde_json::json!(99);
        dirty["message"]["sendStatus"] = serde_json::json!(0);
        let clean = full_event(CONV, 2);

        applier
            .apply_push_batch(&batch(serde_json::json!([dirty, clean]), 42, 10))
            .await;

        // 脏事件进异常库,原文 + 原因 + 定位字段留存。
        let q = quarantine.list_recent("42", 10).await.unwrap();
        assert_eq!(q.len(), 1, "脏事件入异常库");
        assert_eq!(q[0].reason, "semantic_conflict_in_as_out");
        assert_eq!(q[0].local_message_id, "LM_DIRTY");
        assert_eq!(q[0].conversation_id, CONV);

        // 正常消息库:仅 clean(LM_A),绝无脏 LM_DIRTY → 不再被渲染成永久转圈。
        let rows = store.list_recent("42", CONV, 10).await.unwrap();
        assert_eq!(rows.len(), 1, "脏事件不入正常库、同批正常事件正常落库");
        assert_eq!(rows[0].local_message_id, "LM_A");
    }
}
