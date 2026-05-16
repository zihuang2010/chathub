//! axum router: POST /internal/push (Bearer) + GET /healthz。

use crate::event_policy::{self, EventPolicy};
use crate::router::{Router, RouterError};
use crate::storage::events::{EventLog, EventRow, EventStore};
use crate::storage::seqs::SeqAllocator;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router as AxumRouter};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Instant;
use subtle::ConstantTimeEq;

/// 常数时间比较 Authorization header 与 `Bearer <secret>`,防止时序攻击。
/// 长度不等也走常数时间(否则攻击者能通过响应时长推 secret 长度)。
fn bearer_matches(header_val: Option<&str>, expected_secret: &str) -> bool {
    let want = format!("Bearer {}", expected_secret);
    match header_val {
        Some(s) if s.len() == want.len() => s.as_bytes().ct_eq(want.as_bytes()).into(),
        _ => {
            // 长度不等仍走一次 ct_eq 凑齐时间,降低长度泄漏
            let dummy = vec![0u8; want.len()];
            let _ = dummy.ct_eq(want.as_bytes());
            false
        }
    }
}

#[derive(Clone)]
pub struct PushState {
    pub secret: String,
    pub seqs: SeqAllocator,
    pub events: EventStore,
    /// Plan 6:新事件日志(employee_id + notify_seq + event_index 主键)。
    /// 旧 `events` 字段继续给 legacy `/internal/push` 用,新 `events_log` 给 `/internal/push/v2` 用。
    pub events_log: EventLog,
    pub router: Arc<Router>,
}

/// 业务后台 → relay 的 clientId 白名单(spec §3:本期固定 "rh_wxchat")。
/// stage 4+ 可改为 env 配置;当前硬编码已经够。
const ALLOWED_CLIENT_IDS: &[&str] = &["rh_wxchat"];

// ─── 入站 JSON 协议 ─────────────────────────────────────────────────────────────
//
// 下游用 **protobuf JSON 风格**(平铺 oneof:`{"incoming":{...}}` 而不是
// `{"body":{"Incoming":{...}}}`)。直接复用 prost 生成的 ServerEvent 会让 oneof
// 字段被 serde 当成 unknown 字段静默丢弃 —— body 永远是 None。所以这里维护一组
// 显式的 wrapper 类型,反序列化后通过 into_proto() 组装成正经的 ServerEvent。
//
// MessageBody.kind 同样是 oneof,需要 PushMessageBody 一起包。

#[derive(Deserialize)]
pub struct PushBody {
    pub wecom_account_id: String,
    pub event: PushEvent,
}

#[derive(Deserialize, Default)]
pub struct PushEvent {
    #[serde(default)]
    pub wecom_account_id: String,
    #[serde(default)]
    pub seq: i64,
    // 平铺 oneof — 同一时刻只允许一个被设置。
    #[serde(default)]
    pub incoming: Option<PushIncomingMsg>,
    #[serde(default)]
    pub recalled: Option<chathub_proto::v1::MessageRecalled>,
    #[serde(default)]
    pub read_receipt: Option<chathub_proto::v1::ReadReceipt>,
    #[serde(default)]
    pub status_change: Option<PushMessageStatusChange>,
    #[serde(default)]
    pub system: Option<PushSystemSignal>,
}

/// 与 prost 生成的 SystemSignal 同构,但 `kind` 用字符串(protobuf JSON 标准),
/// 转换时映射回 i32 枚举。
#[derive(Deserialize, Default)]
pub struct PushSystemSignal {
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub detail: String,
}

impl PushSystemSignal {
    fn into_proto(self) -> Result<chathub_proto::v1::SystemSignal, &'static str> {
        use chathub_proto::v1::system_signal::Kind;
        let kind = match self.kind.as_str() {
            "" | "KIND_UNSPECIFIED" => Kind::Unspecified as i32,
            "KIND_KICKED" => Kind::Kicked as i32,
            "KIND_SERVER_DRAIN" => Kind::ServerDrain as i32,
            _ => return Err("unknown system signal kind"),
        };
        Ok(chathub_proto::v1::SystemSignal {
            kind,
            detail: self.detail,
        })
    }
}

/// 与 prost 生成的 MessageStatusChange 同构,但 `status` 用字符串。
#[derive(Deserialize, Default)]
pub struct PushMessageStatusChange {
    #[serde(default)]
    pub conversation_id: String,
    #[serde(default)]
    pub client_msg_id: String,
    #[serde(default)]
    pub server_msg_id: String,
    #[serde(default)]
    pub status: String,
}

impl PushMessageStatusChange {
    fn into_proto(self) -> Result<chathub_proto::v1::MessageStatusChange, &'static str> {
        use chathub_proto::v1::message_status_change::Status;
        let status = match self.status.as_str() {
            "" | "STATUS_UNSPECIFIED" => Status::Unspecified as i32,
            "STATUS_SENT" => Status::Sent as i32,
            "STATUS_DELIVERED" => Status::Delivered as i32,
            "STATUS_FAILED" => Status::Failed as i32,
            _ => return Err("unknown message status"),
        };
        Ok(chathub_proto::v1::MessageStatusChange {
            conversation_id: self.conversation_id,
            client_msg_id: self.client_msg_id,
            server_msg_id: self.server_msg_id,
            status,
        })
    }
}

#[derive(Deserialize)]
pub struct PushIncomingMsg {
    pub conversation_id: String,
    pub from_user_id: String,
    pub body: PushMessageBody,
    #[serde(default)]
    pub sent_at_ms: i64,
    pub server_msg_id: String,
    #[serde(default)]
    pub remote: Option<chathub_proto::v1::RemoteId>,
}

#[derive(Deserialize, Default)]
pub struct PushMessageBody {
    #[serde(default)]
    pub text: Option<chathub_proto::v1::TextBody>,
    #[serde(default)]
    pub reply_to: Option<chathub_proto::v1::ReplyToRef>,
    #[serde(default)]
    pub mentions: Vec<chathub_proto::v1::Mention>,
}

impl PushEvent {
    fn into_proto(self) -> Result<chathub_proto::v1::ServerEvent, &'static str> {
        use chathub_proto::v1::server_event::Body;
        let mut chosen: Option<Body> = None;
        let mut count = 0usize;
        if let Some(v) = self.incoming {
            chosen = Some(Body::Incoming(v.into_proto()?));
            count += 1;
        }
        if let Some(v) = self.recalled {
            chosen = Some(Body::Recalled(v));
            count += 1;
        }
        if let Some(v) = self.read_receipt {
            chosen = Some(Body::ReadReceipt(v));
            count += 1;
        }
        if let Some(v) = self.status_change {
            chosen = Some(Body::StatusChange(v.into_proto()?));
            count += 1;
        }
        if let Some(v) = self.system {
            chosen = Some(Body::System(v.into_proto()?));
            count += 1;
        }
        if count > 1 {
            return Err("multiple oneof variants set in event");
        }
        Ok(chathub_proto::v1::ServerEvent {
            wecom_account_id: self.wecom_account_id,
            seq: self.seq,
            body: chosen,
        })
    }
}

impl PushIncomingMsg {
    fn into_proto(self) -> Result<chathub_proto::v1::IncomingMsg, &'static str> {
        Ok(chathub_proto::v1::IncomingMsg {
            conversation_id: self.conversation_id,
            from_user_id: self.from_user_id,
            body: Some(self.body.into_proto()?),
            sent_at_ms: self.sent_at_ms,
            server_msg_id: self.server_msg_id,
            remote: self.remote,
        })
    }
}

impl PushMessageBody {
    fn into_proto(self) -> Result<chathub_proto::v1::MessageBody, &'static str> {
        use chathub_proto::v1::message_body::Kind;
        let mut chosen: Option<Kind> = None;
        let mut count = 0usize;
        if let Some(v) = self.text {
            chosen = Some(Kind::Text(v));
            count += 1;
        }
        if count > 1 {
            return Err("multiple oneof variants set in message body");
        }
        Ok(chathub_proto::v1::MessageBody {
            kind: chosen,
            reply_to: self.reply_to,
            mentions: self.mentions,
        })
    }
}

#[derive(Serialize)]
pub struct PushResp {
    pub assigned_seq: i64,
    pub no_stream: bool,
}

pub fn app(state: PushState) -> AxumRouter {
    AxumRouter::new()
        .route("/healthz", get(|| async { (StatusCode::OK, "ok") }))
        .route("/internal/push", post(handle_push))
        // Plan 6 — spec §3 字段格式;旧 endpoint 兼容期保留。
        .route("/internal/push/v2", post(handle_push_v2))
        .with_state(state)
}

// ─── stage 3: /internal/push/v2 ────────────────────────────────────────
//
// 入参对应 docs/工具网关通知事件与字段规范.md §3 外层通知包 + §5 events[]。
// relay 不解析业务 payload —— events 数组每个元素当作 opaque JSON,入库时回写整原文。
// 本阶段只做"鉴权 + 分类 + 入 events_v2",fanout 留到 stage 3.5(router 加 employee 索引)。

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushBatchIn {
    pub notify_seq: u64,
    pub client_id: String,
    pub employee_id: i64,
    #[serde(default)]
    pub batch_id: Option<String>,
    #[serde(default)]
    pub batch_time: Option<String>,
    pub events: Vec<serde_json::Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushBatchAck {
    pub notify_seq: u64,
    /// 实际入库的 events 数(INSERT OR IGNORE 之后)。
    /// 重投时:全部 IGNORE → 0;首次:= 该 batch 内 Persist 类 events 数。
    pub inserted: usize,
    /// Control 类事件数(ControlOnly,不入库)。stage 4 触发 force_close 流程。
    pub control_count: usize,
}

#[tracing::instrument(
    skip_all,
    fields(
        notify_seq = body.notify_seq,
        client_id = %body.client_id,
        employee_id = body.employee_id,
        events_count = body.events.len(),
    )
)]
async fn handle_push_v2(
    State(state): State<PushState>,
    headers: HeaderMap,
    Json(body): Json<PushBatchIn>,
) -> axum::response::Response {
    let started = Instant::now();

    // 1. Bearer secret 校验(常数时间比较,防时序攻击)
    let header_val = headers.get("authorization").and_then(|v| v.to_str().ok());
    if !bearer_matches(header_val, &state.secret) {
        tracing::warn!(status = 401, "push v2 auth failed");
        return (StatusCode::UNAUTHORIZED, "invalid secret").into_response();
    }

    // 2. clientId 白名单
    if !ALLOWED_CLIENT_IDS.iter().any(|&c| c == body.client_id) {
        tracing::warn!(status = 403, "push v2 client_id rejected");
        return (StatusCode::FORBIDDEN, "client_id not allowed").into_response();
    }

    // 3. 基本字段校验
    if body.employee_id == 0 {
        tracing::warn!(status = 400, "push v2 employee_id missing");
        return (StatusCode::BAD_REQUEST, "employeeId required").into_response();
    }
    if body.events.is_empty() {
        tracing::warn!(status = 400, "push v2 events empty");
        return (StatusCode::BAD_REQUEST, "events must be non-empty").into_response();
    }

    // 4. 分类 + 准备 EventRow(Persist 类) / 计数 Control 类
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let mut rows: Vec<EventRow> = Vec::with_capacity(body.events.len());
    let mut control_count = 0usize;
    let mut unknown_count = 0usize;

    for (index, event_value) in body.events.iter().enumerate() {
        let event_type = event_value
            .get("eventType")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if event_type.is_empty() {
            tracing::warn!(
                status = 400,
                event_index = index,
                "push v2 missing eventType",
            );
            return (StatusCode::BAD_REQUEST, "events[i].eventType required").into_response();
        }

        match event_policy::policy(event_type) {
            EventPolicy::ControlOnly => {
                control_count += 1;
                // stage 4 在此触发 force_close 流程;stage 3 仅计数
            }
            EventPolicy::Persist => {
                if !is_known_event_type(event_type) {
                    unknown_count += 1;
                    tracing::warn!(
                        event_type,
                        event_index = index,
                        "push v2 unknown eventType (persisted by default)"
                    );
                }
                let payload_json = serde_json::to_string(event_value).unwrap_or_else(|_| {
                    // serde_json::Value → string 实践上不会失败;落空字符串保险
                    String::new()
                });
                rows.push(EventRow {
                    employee_id: body.employee_id,
                    notify_seq: body.notify_seq as i64,
                    event_index: index as i64,
                    event_type: event_type.to_string(),
                    event_reason: extract_str(event_value, "eventReason"),
                    conversation_id: extract_str(event_value, "conversationId"),
                    customer_user_id: extract_str(event_value, "customerUserId"),
                    external_user_id: extract_str(event_value, "externalUserId"),
                    client_id: body.client_id.clone(),
                    batch_id: body.batch_id.clone(),
                    batch_time: body.batch_time.clone(),
                    event_time: extract_str(event_value, "eventTime"),
                    payload_json,
                    created_at_ms: now_ms,
                });
            }
        }
    }

    // 5. 入库(INSERT OR IGNORE 天然幂等)
    let inserted = match state.events_log.insert_batch(rows).await {
        Ok(n) => n,
        Err(e) => {
            tracing::warn!(status = 500, error = %e, "push v2 persist failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, "persist").into_response();
        }
    };

    // 6. Fanout 给该 employee 的所有在线连接(stage 3.5 接通)
    //    events_json = 原 events 数组(包括 Control 类) — 客户端按 eventType 自分流。
    //    Persist 类已经入库,即使 fanout 失败客户端也能续点;Control 类丢就丢。
    let events_json = serde_json::to_vec(&body.events).unwrap_or_default();
    let push_batch = chathub_proto::v1::PushBatchOut {
        notify_seq: body.notify_seq,
        client_id: body.client_id.clone(),
        employee_id: body.employee_id,
        batch_id: body.batch_id.clone().unwrap_or_default(),
        batch_time: body.batch_time.clone().unwrap_or_default(),
        device_id: String::new(), // stage 4:按 per-conn device_id 定制
        events_json,
    };
    let event = chathub_proto::v1::ServerEvent {
        wecom_account_id: String::new(),
        seq: 0,
        body: Some(chathub_proto::v1::server_event::Body::PushBatch(push_batch)),
    };
    let fanout = state.router.fanout_employee(body.employee_id, event);

    // 清理 closed/backpressure 的连接 —— 客户端会感知断开并 since_notify_seq 重连。
    // stage 4 在 backpressure 之前可以先发 RESYNC_REQUIRED 信号(本期满了直接 drop)。
    for conn_id in fanout.closed.iter().chain(fanout.backpressure.iter()) {
        state.router.drop_employee_stream(body.employee_id, conn_id);
    }

    tracing::info!(
        persisted = inserted,
        control_count,
        unknown_count,
        fanout_delivered = fanout.delivered,
        fanout_backpressure = fanout.backpressure.len(),
        fanout_closed = fanout.closed.len(),
        elapsed_ms = started.elapsed().as_millis() as u64,
        status = 200,
        "push v2 ok",
    );

    (
        StatusCode::OK,
        Json(PushBatchAck {
            notify_seq: body.notify_seq,
            inserted,
            control_count,
        }),
    )
        .into_response()
}

fn extract_str(value: &serde_json::Value, key: &str) -> Option<String> {
    value.get(key).and_then(|v| v.as_str()).map(String::from)
}

fn is_known_event_type(event_type: &str) -> bool {
    matches!(
        event_type,
        "MESSAGE_UPSERT"
            | "SESSION_SUMMARY_UPSERT"
            | "FRIEND_UPSERT"
            | "ACCOUNT_BINDING_CHANGE"
            | "ACCOUNT_STATUS_CHANGE"
            | "CONNECTION_FORCE_CLOSE"
    )
}

async fn handle_push(
    State(state): State<PushState>,
    headers: HeaderMap,
    Json(body): Json<PushBody>,
) -> impl IntoResponse {
    let started = Instant::now();
    let account = body.wecom_account_id.as_str();

    // Bearer 校验(常数时间比较,防时序攻击)
    let header_val = headers.get("authorization").and_then(|v| v.to_str().ok());
    if !bearer_matches(header_val, &state.secret) {
        tracing::warn!(
            target: "chathub_relay::push",
            account,
            status = 401,
            elapsed_ms = started.elapsed().as_millis() as u64,
            "push auth failed",
        );
        return (StatusCode::UNAUTHORIZED, "invalid secret").into_response();
    }
    tracing::debug!(target: "chathub_relay::push", account, "push received");

    // 平铺 oneof JSON → 内部 prost ServerEvent
    let mut evt = match body.event.into_proto() {
        Ok(e) => e,
        Err(msg) => {
            tracing::warn!(
                target: "chathub_relay::push",
                account,
                status = 400,
                elapsed_ms = started.elapsed().as_millis() as u64,
                error = msg,
                "push payload invalid",
            );
            return (StatusCode::BAD_REQUEST, msg).into_response();
        }
    };

    let assigned_seq = match state.seqs.next_seq(account).await {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(
                target: "chathub_relay::push",
                account,
                status = 500,
                elapsed_ms = started.elapsed().as_millis() as u64,
                error = %e,
                "next_seq failed",
            );
            return (StatusCode::INTERNAL_SERVER_ERROR, "seq").into_response();
        }
    };
    evt.wecom_account_id = body.wecom_account_id.clone();
    evt.seq = assigned_seq;
    let mut buf = Vec::new();
    if let Err(e) = prost::Message::encode(&evt, &mut buf) {
        tracing::warn!(
            target: "chathub_relay::push",
            account,
            assigned_seq,
            status = 400,
            elapsed_ms = started.elapsed().as_millis() as u64,
            error = %e,
            "encode failed",
        );
        return (StatusCode::BAD_REQUEST, format!("encode: {e}")).into_response();
    }
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    if let Err(e) = state
        .events
        .record(&body.wecom_account_id, assigned_seq, buf, now_ms)
        .await
    {
        tracing::warn!(
            target: "chathub_relay::push",
            account,
            assigned_seq,
            status = 500,
            elapsed_ms = started.elapsed().as_millis() as u64,
            error = %e,
            "events.record failed",
        );
        return (StatusCode::INTERNAL_SERVER_ERROR, "record").into_response();
    }
    let fanout_result = state.router.fanout(&body.wecom_account_id, evt);
    let (no_stream, fanout) = match fanout_result {
        Ok(()) => (false, "delivered"),
        Err(RouterError::NoStream) => (true, "no_stream"),
        Err(RouterError::Backpressure) => {
            // 队列填满:发 SERVER_DRAIN 后踢掉该流,客户端收到 no_stream=true 后重连并 replay。
            let drain_evt = {
                use chathub_proto::v1::{server_event::Body, system_signal::Kind, SystemSignal};
                chathub_proto::v1::ServerEvent {
                    wecom_account_id: body.wecom_account_id.clone(),
                    seq: 0,
                    body: Some(Body::System(SystemSignal {
                        kind: Kind::ServerDrain as i32,
                        detail: String::new(),
                    })),
                }
            };
            state
                .router
                .evict_account(&body.wecom_account_id, drain_evt);
            (true, "backpressure_drained")
        }
    };
    tracing::info!(
        target: "chathub_relay::push",
        account,
        assigned_seq,
        no_stream,
        fanout,
        status = 202,
        elapsed_ms = started.elapsed().as_millis() as u64,
        "push ok",
    );
    (
        StatusCode::ACCEPTED,
        Json(PushResp {
            assigned_seq,
            no_stream,
        }),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::router::StreamTicket;
    use crate::storage::Storage;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    async fn make_state() -> PushState {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("t.db");
        let storage = Storage::open(&db).await.unwrap();
        std::mem::forget(tmp);
        PushState {
            secret: "ps".into(),
            seqs: SeqAllocator::new(storage.clone()),
            events: EventStore::new(storage.clone()),
            events_log: EventLog::new(storage.clone()),
            router: Arc::new(Router::new()),
        }
    }

    fn json_body(account: &str) -> String {
        format!(
            r#"{{"wecom_account_id":"{account}","event":{{
                "wecom_account_id":"","seq":0,
                "system":{{"kind":"KIND_UNSPECIFIED","detail":"hi"}}
            }}}}"#
        )
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn healthz_returns_200() {
        let st = make_state().await;
        let app = app(st);
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/healthz")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn push_no_auth_401() {
        let st = make_state().await;
        let app = app(st);
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/internal/push")
                    .header("content-type", "application/json")
                    .body(Body::from(json_body("wa-1")))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn push_wrong_secret_401() {
        let st = make_state().await;
        let app = app(st);
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/internal/push")
                    .header("authorization", "Bearer WRONG")
                    .header("content-type", "application/json")
                    .body(Body::from(json_body("wa-1")))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn push_no_stream_returns_202_no_stream_true() {
        let st = make_state().await;
        let app = app(st.clone());
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/internal/push")
                    .header("authorization", "Bearer ps")
                    .header("content-type", "application/json")
                    .body(Body::from(json_body("wa-1")))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::ACCEPTED);
        let body = axum::body::to_bytes(resp.into_body(), 1024).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["assigned_seq"], 1);
        assert_eq!(v["no_stream"], true);
        // event 仍入 ring
        let rows = st.events.replay_after("wa-1", 0, 10).await.unwrap();
        assert_eq!(rows.len(), 1);
    }

    /// 平铺 oneof JSON(`{"incoming":{...}}`,protobuf JSON 风格)→ 完整 ServerEvent
    /// 投递,内部 MessageBody.kind 也要正确组装。回归 oneof-丢失 bug。
    #[tokio::test(flavor = "multi_thread")]
    async fn push_incoming_payload_arrives_with_full_body() {
        let st = make_state().await;
        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        st.router.register(
            StreamTicket {
                user_id: "u-1".into(),
                device_id: "d-1".into(),
                accounts: vec!["wa-1".into()],
            },
            tx,
        );

        let payload = r#"{
            "wecom_account_id":"wa-1",
            "event":{"incoming":{
                "conversation_id":"conv-1","from_user_id":"peer-1",
                "server_msg_id":"sm-1","sent_at_ms":0,
                "body":{"text":{"text":"hello"}}
            }}
        }"#;

        let app = app(st.clone());
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/internal/push")
                    .header("authorization", "Bearer ps")
                    .header("content-type", "application/json")
                    .body(Body::from(payload))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::ACCEPTED);

        let evt = rx
            .recv()
            .await
            .expect("stream got an event")
            .expect("Ok event");
        assert_eq!(evt.wecom_account_id, "wa-1");
        assert_eq!(evt.seq, 1);

        use chathub_proto::v1::message_body::Kind as MsgKind;
        use chathub_proto::v1::server_event::Body as EvBody;
        let inner = match evt.body {
            Some(EvBody::Incoming(m)) => m,
            other => panic!("expected Incoming body, got {other:?}"),
        };
        assert_eq!(inner.conversation_id, "conv-1");
        assert_eq!(inner.from_user_id, "peer-1");
        assert_eq!(inner.server_msg_id, "sm-1");
        let msg_body = inner.body.expect("MessageBody present");
        match msg_body.kind.expect("kind present") {
            MsgKind::Text(t) => assert_eq!(t.text, "hello"),
        }
    }

    /// backpressure 路径:mpsc 满 → SERVER_DRAIN + drop → no_stream=true,ring 保留事件。
    #[tokio::test(flavor = "multi_thread")]
    async fn push_backpressure_drains_stream_and_returns_no_stream_true() {
        let st = make_state().await;

        // 注册一个容量为 1 的流,然后先填满它
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        st.router.register(
            StreamTicket {
                user_id: "u-1".into(),
                device_id: "d-1".into(),
                accounts: vec!["wa-1".into()],
            },
            tx.clone(),
        );
        // 填满 channel(直接 try_send 而不经过 push endpoint,避免 seq 干扰)
        {
            use chathub_proto::v1::{
                server_event::Body as ProtoBody, system_signal::Kind, SystemSignal,
            };
            let filler = chathub_proto::v1::ServerEvent {
                wecom_account_id: "wa-1".into(),
                seq: 0,
                body: Some(ProtoBody::System(SystemSignal {
                    kind: Kind::Unspecified as i32,
                    detail: String::new(),
                })),
            };
            let _ = tx.try_send(Ok(filler));
        }
        // channel 现在满了;下一次 fanout 会返回 Backpressure

        let app = app(st.clone());
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/internal/push")
                    .header("authorization", "Bearer ps")
                    .header("content-type", "application/json")
                    .body(Body::from(json_body("wa-1")))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::ACCEPTED);
        let resp_body = axum::body::to_bytes(resp.into_body(), 1024).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&resp_body).unwrap();
        assert_eq!(v["no_stream"], true);
        // event 仍入 ring(push endpoint 先 record 再 fanout)
        let rows = st.events.replay_after("wa-1", 0, 10).await.unwrap();
        assert_eq!(rows.len(), 1);
        // 流已被清理:再次 fanout → NoStream
        let probe = chathub_proto::v1::ServerEvent {
            wecom_account_id: "wa-1".into(),
            seq: 99,
            body: None,
        };
        let err = st.router.fanout("wa-1", probe).unwrap_err();
        assert!(matches!(err, RouterError::NoStream));
    }

    // ─── stage 3:/internal/push/v2 测试 ────────────────────────────────

    fn v2_body(notify_seq: u64, employee_id: i64, events: serde_json::Value) -> String {
        serde_json::json!({
            "notifySeq": notify_seq,
            "clientId": "rh_wxchat",
            "employeeId": employee_id,
            "batchId": format!("rh_wxchat:{employee_id}:{notify_seq}"),
            "batchTime": "2026-05-14 10:30:00",
            "events": events,
        })
        .to_string()
    }

    async fn post_v2(
        app: AxumRouter,
        body: String,
        secret: &str,
    ) -> (StatusCode, serde_json::Value) {
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/internal/push/v2")
                    .header("authorization", format!("Bearer {secret}"))
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = resp.status();
        let raw = axum::body::to_bytes(resp.into_body(), 4096).await.unwrap();
        let v: serde_json::Value = if raw.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_slice(&raw).unwrap_or(serde_json::Value::Null)
        };
        (status, v)
    }

    #[tokio::test]
    async fn push_v2_happy_path_persists_message_upsert() {
        let st = make_state().await;
        let log = st.events_log.clone();
        let body = v2_body(
            1001,
            42,
            serde_json::json!([{
                "eventType": "MESSAGE_UPSERT",
                "eventReason": "CUSTOMER_MESSAGE_RECEIVED",
                "conversationId": "conv-1",
                "customerUserId": "rocky",
                "externalUserId": "ext-1",
                "eventTime": "2026-05-14 10:30:00",
                "message": {
                    "localMessageId": "LM_1",
                    "messageDirection": 2,
                    "messageType": 1,
                    "messageStatus": 0,
                    "sendStatus": 0,
                    "contentText": "你好",
                    "contentSummary": "你好"
                }
            }]),
        );
        let (status, ack) = post_v2(app(st), body, "ps").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(ack["inserted"], 1);
        assert_eq!(ack["controlCount"], 0);
        assert_eq!(ack["notifySeq"], 1001);

        // 入库后能查到
        let rows = log.query_since(42, 0, 10).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].notify_seq, 1001);
        assert_eq!(rows[0].event_type, "MESSAGE_UPSERT");
        assert_eq!(
            rows[0].event_reason.as_deref(),
            Some("CUSTOMER_MESSAGE_RECEIVED")
        );
        assert_eq!(rows[0].conversation_id.as_deref(), Some("conv-1"));
        // payload_json 完整保留(含业务 message 字段)
        let payload: serde_json::Value = serde_json::from_str(&rows[0].payload_json).unwrap();
        assert_eq!(payload["message"]["localMessageId"], "LM_1");
        assert_eq!(payload["message"]["contentText"], "你好");
    }

    #[tokio::test]
    async fn push_v2_auth_failure_returns_401() {
        let st = make_state().await;
        let body = v2_body(
            1,
            42,
            serde_json::json!([{ "eventType": "MESSAGE_UPSERT" }]),
        );
        let (status, _) = post_v2(app(st), body, "wrong-secret").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn push_v2_unknown_client_id_returns_403() {
        let st = make_state().await;
        let body = serde_json::json!({
            "notifySeq": 1,
            "clientId": "other_client",
            "employeeId": 42,
            "batchTime": "2026-05-14 10:30:00",
            "events": [{ "eventType": "MESSAGE_UPSERT" }],
        })
        .to_string();
        let (status, _) = post_v2(app(st), body, "ps").await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn push_v2_missing_employee_id_returns_400() {
        let st = make_state().await;
        let body = serde_json::json!({
            "notifySeq": 1,
            "clientId": "rh_wxchat",
            "employeeId": 0,
            "batchTime": "2026-05-14 10:30:00",
            "events": [{ "eventType": "MESSAGE_UPSERT" }],
        })
        .to_string();
        let (status, _) = post_v2(app(st), body, "ps").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn push_v2_empty_events_returns_400() {
        let st = make_state().await;
        let body = v2_body(1, 42, serde_json::json!([]));
        let (status, _) = post_v2(app(st), body, "ps").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn push_v2_missing_event_type_returns_400() {
        let st = make_state().await;
        let body = v2_body(1, 42, serde_json::json!([{ "eventReason": "FOO" }]));
        let (status, _) = post_v2(app(st), body, "ps").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn push_v2_idempotent_on_duplicate_notify_seq() {
        let st = make_state().await;
        let log = st.events_log.clone();
        let body = v2_body(
            500,
            42,
            serde_json::json!([
                { "eventType": "MESSAGE_UPSERT", "conversationId": "c1" },
                { "eventType": "SESSION_SUMMARY_UPSERT", "conversationId": "c1" },
            ]),
        );

        // 第一次:2 行入库
        let (s1, ack1) = post_v2(app(st.clone()), body.clone(), "ps").await;
        assert_eq!(s1, StatusCode::OK);
        assert_eq!(ack1["inserted"], 2);

        // 第二次同 notify_seq:200 但 0 行新入库
        let (s2, ack2) = post_v2(app(st), body, "ps").await;
        assert_eq!(s2, StatusCode::OK);
        assert_eq!(ack2["inserted"], 0);

        // 事件日志里仍然只有 2 行(没重复)
        let rows = log.query_since(42, 0, 100).await.unwrap();
        assert_eq!(rows.len(), 2);
    }

    #[tokio::test]
    async fn push_v2_force_close_event_not_persisted() {
        let st = make_state().await;
        let log = st.events_log.clone();
        let body = v2_body(
            7,
            42,
            serde_json::json!([{
                "eventType": "CONNECTION_FORCE_CLOSE",
                "eventReason": "EXCLUSIVE_LOGIN",
                "forceClose": { "closeScope": "EMPLOYEE", "reasonCode": "EXCLUSIVE_LOGIN" }
            }]),
        );
        let (status, ack) = post_v2(app(st), body, "ps").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(ack["inserted"], 0);
        assert_eq!(ack["controlCount"], 1);
        // 没入事件日志
        let rows = log.query_since(42, 0, 10).await.unwrap();
        assert_eq!(rows.len(), 0);
    }

    #[tokio::test]
    async fn push_v2_unknown_event_type_persisted_by_default() {
        // 向前兼容:业务后台先升级时,relay 仍然保住事件等续点
        let st = make_state().await;
        let log = st.events_log.clone();
        let body = v2_body(
            9,
            42,
            serde_json::json!([{
                "eventType": "FUTURE_EVENT_TYPE",
                "future_field": "foo"
            }]),
        );
        let (status, ack) = post_v2(app(st), body, "ps").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(ack["inserted"], 1);
        let rows = log.query_since(42, 0, 10).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].event_type, "FUTURE_EVENT_TYPE");
    }

    #[tokio::test]
    async fn push_v2_batch_with_multiple_events_preserves_order() {
        let st = make_state().await;
        let log = st.events_log.clone();
        let body = v2_body(
            100,
            42,
            serde_json::json!([
                { "eventType": "MESSAGE_UPSERT", "conversationId": "c1" },
                { "eventType": "SESSION_SUMMARY_UPSERT", "conversationId": "c1" },
                { "eventType": "FRIEND_UPSERT", "customerUserId": "u1" },
            ]),
        );
        let (status, ack) = post_v2(app(st), body, "ps").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(ack["inserted"], 3);

        let rows = log.query_since(42, 0, 10).await.unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].event_index, 0);
        assert_eq!(rows[1].event_index, 1);
        assert_eq!(rows[2].event_index, 2);
        assert_eq!(rows[0].event_type, "MESSAGE_UPSERT");
        assert_eq!(rows[1].event_type, "SESSION_SUMMARY_UPSERT");
        assert_eq!(rows[2].event_type, "FRIEND_UPSERT");
    }

    #[tokio::test]
    async fn push_v2_fanout_delivers_to_registered_employee_stream() {
        // 注册 employee → push v2 → 该 stream 应该收到 PushBatchOut
        let st = make_state().await;
        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        let outcome = st.router.register_employee(42, "dev-A".into(), tx);
        let _conn_id = outcome.connection_id;

        let body = v2_body(
            300,
            42,
            serde_json::json!([
                { "eventType": "MESSAGE_UPSERT", "conversationId": "c1" }
            ]),
        );
        let (status, ack) = post_v2(app(st.clone()), body, "ps").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(ack["inserted"], 1);

        // 该 employee stream 应该收到 PushBatchOut(events_json 是原数组的 JSON)
        let frame = tokio::time::timeout(std::time::Duration::from_millis(500), rx.recv())
            .await
            .expect("fanout timeout")
            .expect("channel closed")
            .expect("status err");

        use chathub_proto::v1::server_event::Body;
        match frame.body {
            Some(Body::PushBatch(pb)) => {
                assert_eq!(pb.notify_seq, 300);
                assert_eq!(pb.client_id, "rh_wxchat");
                assert_eq!(pb.employee_id, 42);
                let parsed: serde_json::Value = serde_json::from_slice(&pb.events_json).unwrap();
                assert_eq!(parsed.as_array().unwrap().len(), 1);
                assert_eq!(parsed[0]["eventType"], "MESSAGE_UPSERT");
            }
            other => panic!("expected PushBatch, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn push_v2_fanout_to_offline_employee_returns_ok_no_delivery() {
        // 没注册的 employee — 入库成功,fanout 0 delivered。客户端日后 since_notify_seq 拿。
        let st = make_state().await;
        let log = st.events_log.clone();
        let body = v2_body(
            400,
            42,
            serde_json::json!([
                { "eventType": "MESSAGE_UPSERT", "conversationId": "c1" }
            ]),
        );
        let (status, ack) = post_v2(app(st), body, "ps").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(ack["inserted"], 1);

        // 事件确实留在 events_v2 等续点
        let rows = log.query_since(42, 0, 10).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].notify_seq, 400);
    }

    #[tokio::test]
    async fn push_v2_persist_and_control_events_in_same_batch() {
        // 同 batch 里 Persist 类入库,Control 类只计数
        let st = make_state().await;
        let log = st.events_log.clone();
        let body = v2_body(
            200,
            42,
            serde_json::json!([
                { "eventType": "MESSAGE_UPSERT", "conversationId": "c1" },
                { "eventType": "CONNECTION_FORCE_CLOSE", "forceClose": { "closeScope": "EMPLOYEE" } },
            ]),
        );
        let (status, ack) = post_v2(app(st), body, "ps").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(ack["inserted"], 1);
        assert_eq!(ack["controlCount"], 1);

        let rows = log.query_since(42, 0, 10).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].event_type, "MESSAGE_UPSERT");
        assert_eq!(rows[0].event_index, 0); // batch 内是第 0 个;FORCE_CLOSE 在第 1 个但跳过
    }
}
