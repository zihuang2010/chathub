//! axum router: `POST /internal/push` (spec §3 字段) + `GET /healthz`(Plan 7 — legacy /internal/push 已删)。

use crate::event_policy::{self, EventPolicy};
use crate::router::Router;
use crate::storage::events::{EventLog, EventRow};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router as AxumRouter};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Instant;
use subtle::ConstantTimeEq;

/// 常数时间比较 Authorization header 与 `Bearer <secret>`,防止时序攻击(P0-2)。
fn bearer_matches(header_val: Option<&str>, expected_secret: &str) -> bool {
    let want = format!("Bearer {}", expected_secret);
    match header_val {
        Some(s) if s.len() == want.len() => s.as_bytes().ct_eq(want.as_bytes()).into(),
        _ => {
            let dummy = vec![0u8; want.len()];
            let _ = dummy.ct_eq(want.as_bytes());
            false
        }
    }
}

#[derive(Clone)]
pub struct PushState {
    pub secret: String,
    pub events_log: EventLog,
    pub router: Arc<Router>,
    /// CONNECTION_FORCE_CLOSE 后等多久才摘除连接(让客户端读完帧)。默认 2000ms。
    pub force_close_grace_ms: u64,
    /// 业务后台 → relay 的 clientId 白名单(env `RELAY_ALLOWED_CLIENT_IDS`)。
    pub allowed_client_ids: Vec<String>,
}

pub fn app(state: PushState) -> AxumRouter {
    AxumRouter::new()
        .route("/healthz", get(|| async { (StatusCode::OK, "ok") }))
        .route("/internal/push", post(handle_push))
        .with_state(state)
}

// ─── /internal/push ─────────────────────────────────────────────────────
//
// 入参对应 docs/工具网关通知事件与字段规范.md §3 外层通知包 + §5 events[]。
// relay 不解析业务 payload —— events 数组每个元素当作 opaque JSON,入库时回写整原文。

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
    /// Control 类事件数(ControlOnly,不入库)。FORCE_CLOSE 触发 grace timer。
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
async fn handle_push(
    State(state): State<PushState>,
    headers: HeaderMap,
    Json(body): Json<PushBatchIn>,
) -> axum::response::Response {
    let started = Instant::now();

    // 1. Bearer secret 校验(常数时间)
    let header_val = headers.get("authorization").and_then(|v| v.to_str().ok());
    if !bearer_matches(header_val, &state.secret) {
        tracing::warn!(status = 401, "push auth failed");
        return (StatusCode::UNAUTHORIZED, "invalid secret").into_response();
    }

    // 2. clientId 白名单(env-driven)
    if !state
        .allowed_client_ids
        .iter()
        .any(|c| c == &body.client_id)
    {
        tracing::warn!(
            status = 403,
            client_id = %body.client_id,
            "push client_id rejected (not in RELAY_ALLOWED_CLIENT_IDS)"
        );
        return (StatusCode::FORBIDDEN, "client_id not allowed").into_response();
    }

    // 3. 基本字段校验
    if body.employee_id == 0 {
        tracing::warn!(status = 400, "push employee_id missing");
        return (StatusCode::BAD_REQUEST, "employeeId required").into_response();
    }
    if body.events.is_empty() {
        tracing::warn!(status = 400, "push events empty");
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
    let mut has_force_close = false;

    for (index, event_value) in body.events.iter().enumerate() {
        let event_type = event_value
            .get("eventType")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if event_type.is_empty() {
            tracing::warn!(status = 400, event_index = index, "push missing eventType",);
            return (StatusCode::BAD_REQUEST, "events[i].eventType required").into_response();
        }

        match event_policy::policy(event_type) {
            EventPolicy::ControlOnly => {
                control_count += 1;
                if event_type == "CONNECTION_FORCE_CLOSE" {
                    has_force_close = true;
                }
            }
            EventPolicy::Persist => {
                if !is_known_event_type(event_type) {
                    unknown_count += 1;
                    tracing::warn!(
                        event_type,
                        event_index = index,
                        "push unknown eventType (persisted by default)"
                    );
                }
                // P1-9:Value::to_string() infallible(Display 永远产出有效 JSON)
                let payload_json = event_value.to_string();
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
            tracing::warn!(status = 500, error = %e, "push persist failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, "persist").into_response();
        }
    };

    // 6. Fanout 给该 employee 的所有在线连接
    // events_json = 原 events 数组(包括 Control 类) — 客户端按 eventType 自分流。
    // Persist 类已经入库,即使 fanout 失败客户端也能续点;Control 类丢就丢。
    let events_json = serde_json::to_vec(&body.events).unwrap_or_default();
    let push_batch = chathub_proto::v1::PushBatchOut {
        notify_seq: body.notify_seq,
        client_id: body.client_id.clone(),
        employee_id: body.employee_id,
        batch_id: body.batch_id.clone().unwrap_or_default(),
        batch_time: body.batch_time.clone().unwrap_or_default(),
        device_id: String::new(),
        events_json,
    };
    let event = chathub_proto::v1::ServerEvent {
        body: Some(chathub_proto::v1::server_event::Body::PushBatch(push_batch)),
    };
    let fanout = state.router.fanout_employee(body.employee_id, event);

    // 清理 closed/backpressure 的连接 —— 客户端会感知断开并 since_notify_seq 重连
    for conn_id in fanout.closed.iter().chain(fanout.backpressure.iter()) {
        state.router.drop_employee_stream(body.employee_id, conn_id);
    }

    // P0-3:CONNECTION_FORCE_CLOSE grace 流程
    //   1. force_close 事件已经包在上面 fanout 的 events_json 里送达客户端
    //   2. 等 grace,让客户端读完帧并显示提示
    //   3. 然后摘除该 employee 的所有路由 → gRPC stream 自然关闭
    //   4. 客户端旧 token 之后再 Subscribe 会被 verify_token 拒(token 已失效)
    if has_force_close {
        let router = state.router.clone();
        let emp_id = body.employee_id;
        let grace = state.force_close_grace_ms;
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(grace)).await;
            let dropped = router.drop_all_employee_streams(emp_id);
            tracing::info!(
                target: "chathub_relay::push",
                employee_id = emp_id,
                connections_dropped = dropped.len(),
                grace_ms = grace,
                "force_close grace expired; streams evicted"
            );
        });
    }

    tracing::info!(
        persisted = inserted,
        control_count,
        unknown_count,
        fanout_delivered = fanout.delivered,
        fanout_backpressure = fanout.backpressure.len(),
        fanout_closed = fanout.closed.len(),
        has_force_close,
        elapsed_ms = started.elapsed().as_millis() as u64,
        status = 200,
        "push ok",
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

#[cfg(test)]
mod tests {
    use super::*;
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
            events_log: EventLog::new(storage),
            router: Arc::new(Router::new()),
            force_close_grace_ms: 50,
            allowed_client_ids: vec!["rh_wxchat".into()],
        }
    }

    fn body(notify_seq: u64, employee_id: i64, events: serde_json::Value) -> String {
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

    async fn post(app: AxumRouter, body: String, secret: &str) -> (StatusCode, serde_json::Value) {
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/internal/push")
                    .header("authorization", format!("Bearer {secret}"))
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = resp.status();
        let raw = axum::body::to_bytes(resp.into_body(), 4096).await.unwrap();
        let v = if raw.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_slice(&raw).unwrap_or(serde_json::Value::Null)
        };
        (status, v)
    }

    #[tokio::test]
    async fn healthz_returns_200() {
        let st = make_state().await;
        let resp = app(st)
            .oneshot(
                Request::builder()
                    .uri("/healthz")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }

    #[tokio::test]
    async fn push_happy_path_persists_message_upsert() {
        let st = make_state().await;
        let log = st.events_log.clone();
        let (status, ack) = post(
            app(st),
            body(
                1001,
                42,
                serde_json::json!([{
                    "eventType": "MESSAGE_UPSERT",
                    "eventReason": "CUSTOMER_MESSAGE_RECEIVED",
                    "conversationId": "conv-1",
                    "message": { "localMessageId": "LM_1", "contentText": "你好" }
                }]),
            ),
            "ps",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(ack["inserted"], 1);
        let rows = log.query_since(42, 0, 10).await.unwrap();
        assert_eq!(rows.len(), 1);
        let payload: serde_json::Value = serde_json::from_str(&rows[0].payload_json).unwrap();
        assert_eq!(payload["message"]["contentText"], "你好");
    }

    #[tokio::test]
    async fn push_auth_failure_returns_401() {
        let st = make_state().await;
        let (status, _) = post(
            app(st),
            body(
                1,
                42,
                serde_json::json!([{ "eventType": "MESSAGE_UPSERT" }]),
            ),
            "wrong",
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn push_unknown_client_id_returns_403() {
        let st = make_state().await;
        let body = serde_json::json!({
            "notifySeq": 1, "clientId": "other", "employeeId": 42,
            "batchTime": "x", "events": [{ "eventType": "MESSAGE_UPSERT" }]
        })
        .to_string();
        let (status, _) = post(app(st), body, "ps").await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn push_empty_events_returns_400() {
        let st = make_state().await;
        let (status, _) = post(app(st), body(1, 42, serde_json::json!([])), "ps").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn push_idempotent_on_duplicate_notify_seq() {
        let st = make_state().await;
        let log = st.events_log.clone();
        let b = body(
            500,
            42,
            serde_json::json!([
                { "eventType": "MESSAGE_UPSERT", "conversationId": "c1" },
                { "eventType": "SESSION_SUMMARY_UPSERT", "conversationId": "c1" },
            ]),
        );
        let (_, ack1) = post(app(st.clone()), b.clone(), "ps").await;
        assert_eq!(ack1["inserted"], 2);
        let (_, ack2) = post(app(st), b, "ps").await;
        assert_eq!(ack2["inserted"], 0);
        let rows = log.query_since(42, 0, 100).await.unwrap();
        assert_eq!(rows.len(), 2);
    }

    #[tokio::test]
    async fn push_force_close_evicts_streams_after_grace() {
        let st = make_state().await;
        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        st.router.register_employee(42, "dev-A".into(), tx);

        let b = body(
            500,
            42,
            serde_json::json!([{
                "eventType": "CONNECTION_FORCE_CLOSE",
                "eventReason": "EXCLUSIVE_LOGIN",
                "forceClose": { "closeScope": "EMPLOYEE" }
            }]),
        );
        let (status, ack) = post(app(st.clone()), b, "ps").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(ack["inserted"], 0);
        assert_eq!(ack["controlCount"], 1);

        // 客户端立即收到 PushBatchOut(含 FORCE_CLOSE)
        let frame = tokio::time::timeout(std::time::Duration::from_millis(200), rx.recv())
            .await
            .expect("force_close frame timeout")
            .expect("channel closed")
            .expect("status err");
        use chathub_proto::v1::server_event::Body;
        match frame.body {
            Some(Body::PushBatch(pb)) => {
                let arr: serde_json::Value = serde_json::from_slice(&pb.events_json).unwrap();
                assert_eq!(arr[0]["eventType"], "CONNECTION_FORCE_CLOSE");
            }
            other => panic!("expected PushBatch with FORCE_CLOSE, got {other:?}"),
        }
        // grace 前还在
        assert_eq!(st.router.employee_connection_count(42), 1);
        // grace 后被摘除(make_state 用 50ms grace)
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert_eq!(st.router.employee_connection_count(42), 0);
    }

    #[tokio::test]
    async fn push_fanout_delivers_to_registered_employee_stream() {
        let st = make_state().await;
        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        st.router.register_employee(42, "dev-A".into(), tx);

        let b = body(
            300,
            42,
            serde_json::json!([{ "eventType": "MESSAGE_UPSERT", "conversationId": "c1" }]),
        );
        let (status, ack) = post(app(st.clone()), b, "ps").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(ack["inserted"], 1);

        let frame = tokio::time::timeout(std::time::Duration::from_millis(500), rx.recv())
            .await
            .expect("fanout timeout")
            .expect("channel closed")
            .expect("status err");
        use chathub_proto::v1::server_event::Body;
        match frame.body {
            Some(Body::PushBatch(pb)) => {
                assert_eq!(pb.notify_seq, 300);
                assert_eq!(pb.employee_id, 42);
            }
            other => panic!("expected PushBatch, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn push_unknown_event_type_persisted_by_default() {
        let st = make_state().await;
        let log = st.events_log.clone();
        let (status, ack) = post(
            app(st),
            body(
                9,
                42,
                serde_json::json!([{ "eventType": "FUTURE_EVENT_TYPE", "future_field": "foo" }]),
            ),
            "ps",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(ack["inserted"], 1);
        let rows = log.query_since(42, 0, 10).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].event_type, "FUTURE_EVENT_TYPE");
    }
}
