//! axum router: `POST /rpc/v1/wecomAggregate/notify/push` (spec §3 字段) + `GET /healthz`。
//!
//! push 响应统一走业务后台响应包络 `{ code, serviceCode, msg, data }`:成功 `code=1`
//! 且 `data` 装 [`PushBatchAck`];错误沿用原 HTTP 状态码 + `code=0`、`data=null`、`msg`
//! 透传错误文案。`serviceCode` 固定 `"260000000"`。`GET /healthz` 仍为纯文本探活,不包络。

use crate::event_policy::{self, EventPolicy};
use crate::hub_service::TokenAuthenticator;
use crate::router::Router;
use crate::storage::events::{EventLog, EventRow};
use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::{self, Next};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router as AxumRouter};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::sync::Arc;
use std::time::Instant;
use subtle::ConstantTimeEq;

/// 业务后台 → relay 的统一事件推送端点路径(对齐网关规范)。
const NOTIFY_PUSH_PATH: &str = "/rpc/v1/wecomAggregate/notify/push";

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
    // 暂随 CONNECTION_FORCE_CLOSE 处理停用,后续打开时移除此 allow。
    #[allow(dead_code)]
    pub force_close_grace_ms: u64,
    /// 业务后台 → relay 的 clientId 白名单(env `RELAY_ALLOWED_CLIENT_IDS`)。
    pub allowed_client_ids: Vec<String>,
    /// F2 安全:push body 最大字节数,防 body-bomb DoS。默认 1MB。
    pub max_body_bytes: usize,
    /// 与 HubSvc 共享的鉴权缓存 —— FORCE_CLOSE 时失效被踢 employee 的旧 token。
    // 暂随 CONNECTION_FORCE_CLOSE 处理停用,后续打开时移除此 allow。
    #[allow(dead_code)]
    pub auth: Arc<TokenAuthenticator>,
    /// 可选:push 原始入站 body 旁路写独立按日轮转文件(上线后 diff/jq 比对)。
    /// `None` = 关闭(不挂中间件,零开销)。来源 env `RELAY_SOURCE_JSON_LOG`。
    pub source_json_log: Option<tracing_appender::non_blocking::NonBlocking>,
}

pub fn app(state: PushState) -> AxumRouter {
    let max_body = state.max_body_bytes;
    // 仅当开启时给 push 路由(不含 /healthz)挂一层中间件,把原始 body 旁路写文件。
    // 关闭时不挂任何层,push 热路径零额外开销。
    let push_route = match state.source_json_log.clone() {
        Some(writer) => {
            post(handle_push).layer(middleware::from_fn(move |req: Request, next: Next| {
                let writer = writer.clone();
                async move { log_raw_body(writer, max_body, req, next).await }
            }))
        }
        None => post(handle_push),
    };
    AxumRouter::new()
        .route("/healthz", get(|| async { (StatusCode::OK, "ok") }))
        .route(NOTIFY_PUSH_PATH, push_route)
        // F2 安全:axum 默认 body limit 2MB,我们收紧到 RELAY_PUSH_MAX_BODY_BYTES(默认 1MB)
        .layer(DefaultBodyLimit::max(max_body))
        .with_state(state)
}

/// push 原始入站 body 旁路落盘中间件:进入 `handle_push` 前把整条 body 原样写一行
/// (verbatim 字节 + `\n`,单次 `write_all` 保证整行原子、并发不交错),再用缓冲出的
/// bytes 重建 request 交回原 handler。`handle_push` 及其 tracing 不受影响。
///
/// 超大 body(超 `max_body`,本就会被 `DefaultBodyLimit` 拒)时 `to_bytes` 返回 `Err`、
/// body 已排空,只能转发空 body 让 handler 走原拒绝路径 —— 仅此一条已被拒的边界路径有差异。
async fn log_raw_body(
    mut writer: tracing_appender::non_blocking::NonBlocking,
    max_body: usize,
    req: Request,
    next: Next,
) -> axum::response::Response {
    let (parts, body) = req.into_parts();
    match axum::body::to_bytes(body, max_body).await {
        Ok(bytes) => {
            let mut line = Vec::with_capacity(bytes.len() + 1);
            line.extend_from_slice(&bytes);
            line.push(b'\n');
            let _ = writer.write_all(&line); // best-effort,不阻塞请求
            next.run(Request::from_parts(parts, Body::from(bytes)))
                .await
        }
        Err(_) => next.run(Request::from_parts(parts, Body::empty())).await,
    }
}

// ─── /rpc/v1/wecomAggregate/notify/push ───────────────────────────────────
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
    /// 是否受理。成功恒为 `true`;鉴权/校验失败走 HTTP 错误码 + `code=0`,不进此结构。
    pub accepted: bool,
    /// 回显请求 `batchId`(缺省时为空串)。
    pub batch_id: String,
    pub notify_seq: u64,
    /// 回显请求 `clientId`。
    pub client_id: String,
    /// 回显请求 `employeeId`。
    pub employee_id: i64,
    /// 本批请求携带的事件总数(`events.len()`,与是否重投/是否控制事件无关)。
    pub accepted_event_count: usize,
    /// 本批 fan-out 实际投递成功的在线连接数。
    pub online_connection_count: usize,
    /// 受理成功恒为空;保留字段对齐业务回执 schema。
    pub reject_code: String,
    pub reject_message: String,
}

/// 业务后台统一响应包络(产出端):`{ code, serviceCode, msg, data }`。
/// 成功 = `code == 1`(`data` 装 payload);错误 = `code == 0`(`data` 为 null,`msg` 透传错误文案)。
/// `serviceCode` 固定为本服务标识 [`PUSH_SERVICE_CODE`],由消费方按统一约定解析。
const PUSH_SERVICE_CODE: &str = "260000000";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Envelope<T: Serialize> {
    code: i32,
    service_code: String,
    msg: String,
    data: T,
}

/// 成功包络:HTTP 200 + `code=1` + `data=payload`。
fn ok_envelope<T: Serialize>(data: T) -> axum::response::Response {
    (
        StatusCode::OK,
        Json(Envelope {
            code: 1,
            service_code: PUSH_SERVICE_CODE.to_string(),
            msg: "成功".to_string(),
            data,
        }),
    )
        .into_response()
}

/// 错误包络:沿用原 HTTP 状态码 + `code=0` + `data=null`,`msg` 透传错误文案。
fn err_envelope(status: StatusCode, msg: &str) -> axum::response::Response {
    (
        status,
        Json(Envelope {
            code: 0,
            service_code: PUSH_SERVICE_CODE.to_string(),
            msg: msg.to_string(),
            data: serde_json::Value::Null,
        }),
    )
        .into_response()
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
        return err_envelope(StatusCode::UNAUTHORIZED, "invalid secret");
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
        return err_envelope(StatusCode::FORBIDDEN, "client_id not allowed");
    }

    // 3. 基本字段校验
    if body.employee_id == 0 {
        tracing::warn!(status = 400, "push employee_id missing");
        return err_envelope(StatusCode::BAD_REQUEST, "employeeId required");
    }
    if body.events.is_empty() {
        tracing::warn!(status = 400, "push events empty");
        return err_envelope(StatusCode::BAD_REQUEST, "events must be non-empty");
    }

    // 4. 分类 + 准备 EventRow(Persist 类) / 计数 Control 类。
    // 转换逻辑抽到 convert_batch_to_rows,与 notify_pull 写回共用。
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let BatchConversion {
        rows,
        control_count,
        unknown_count,
        has_force_close,
    } = match convert_batch_to_rows(&body, now_ms) {
        Ok(c) => c,
        Err(index) => {
            tracing::warn!(status = 400, event_index = index, "push missing eventType",);
            return err_envelope(StatusCode::BAD_REQUEST, "events[i].eventType required");
        }
    };

    // 5+6. F7:**并行** persist + fanout(原本是串行的 await)。
    //
    // 客户端用 notify_seq 做幂等(本地 NotifySeqStore 单调水位),
    // 所以 fanout 比 persist 早 1-2ms 不会带来正确性问题:
    //   - 客户端 ack 之前事件已重复(再 push 时 INSERT OR IGNORE 兜底)
    //   - persist 失败也已 fanout 出去 → 客户端只是早收到一次(下次断线重连续点会再来)
    //
    // 收益:push 响应延迟 T_persist+T_fanout(~5ms) → max(T_persist, T_fanout)(~3ms)。
    let events_json: bytes::Bytes = serde_json::to_vec(&body.events).unwrap_or_default().into();
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

    let persist_fut = state.events_log.insert_batch(rows);
    let employee_id = body.employee_id;
    let router_for_fanout = state.router.clone();
    let fanout_fut = async move { router_for_fanout.fanout_employee(employee_id, event) };

    let (insert_result, fanout) = tokio::join!(persist_fut, fanout_fut);

    let inserted = match insert_result {
        Ok(n) => n,
        Err(e) => {
            tracing::warn!(status = 500, error = %e, "push persist failed (fanout may have already sent)");
            return err_envelope(StatusCode::INTERNAL_SERVER_ERROR, "persist");
        }
    };

    // 摘除 closed/backpressure 连接的 router 注册,停止继续向其 fanout:
    //   - closed:客户端已断(rx 已 drop)→ 摘注册即终态清理。
    //   - backpressure:缓冲满、客户端落后 → 摘注册后不再投递;流不会立即关
    //     (subscribe spawn 仍持 tx),客户端靠重连超时重订阅 + resync 续点兜底。
    for conn_id in fanout.closed.iter().chain(fanout.backpressure.iter()) {
        state.router.drop_employee_stream(body.employee_id, conn_id);
    }

    // P0-3:CONNECTION_FORCE_CLOSE grace 流程 —— 【暂时停用,后续打开】
    //   TODO(force_close): 暂不处理 CONNECTION_FORCE_CLOSE 事件 —— relay 侧不失效鉴权缓存、
    //   也不 grace 摘流。事件本身仍随 batch fanout 下发给客户端(在上面的 events_json 里),
    //   此处仅停用 relay 的踢人副作用。恢复时:取消下方整段注释,并移除
    //   PushState.{force_close_grace_ms, auth} 上的 #[allow(dead_code)]、两个 #[ignore] 测试标记。
    //
    //   1. force_close 事件已经包在上面 fanout 的 events_json 里送达客户端
    //   2. 立即失效该 employee 的鉴权缓存 → 旧 token 重连时不再命中缓存、强制回源 verify_token
    //   3. 等 grace,让客户端读完帧并显示提示
    //   4. 然后摘除该 employee 的所有路由 → gRPC stream 自然关闭
    //   5. 客户端旧 token 之后再 Subscribe 由缓存失效 + 后台 verify_token 双重拒(不再只靠 TTL 自然过期)
    // if has_force_close {
    //     // 失效缓存:不依赖 grace timer,踢人即刻生效。
    //     state.auth.invalidate_employee(body.employee_id).await;
    //     let router = state.router.clone();
    //     let emp_id = body.employee_id;
    //     let grace = state.force_close_grace_ms;
    //     tokio::spawn(async move {
    //         tokio::time::sleep(std::time::Duration::from_millis(grace)).await;
    //         let dropped = router.drop_all_employee_streams(emp_id);
    //         tracing::info!(
    //             target: "chathub_relay::push",
    //             employee_id = emp_id,
    //             connections_dropped = dropped.len(),
    //             grace_ms = grace,
    //             "force_close grace expired; streams evicted"
    //         );
    //     });
    // }

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

    ok_envelope(PushBatchAck {
        accepted: true,
        batch_id: body.batch_id.clone().unwrap_or_default(),
        notify_seq: body.notify_seq,
        client_id: body.client_id.clone(),
        employee_id: body.employee_id,
        accepted_event_count: body.events.len(),
        online_connection_count: fanout.delivered,
        reject_code: String::new(),
        reject_message: String::new(),
    })
}

/// `convert_batch_to_rows` 的结果:待入库的 Persist 行 + 控制/未知计数。
#[derive(Debug)]
pub struct BatchConversion {
    /// 仅 Persist 类事件(ControlOnly 不入库)。
    pub rows: Vec<EventRow>,
    pub control_count: usize,
    pub unknown_count: usize,
    pub has_force_close: bool,
}

/// 把一个 batch(push 入站 / notify_pull 拉回 共用同一 `PushBatchIn` 结构)分类转换为
/// 待入库的 `EventRow`。去 axum 化 — 不返回 HTTP 响应,纯逻辑。
///
/// `Err(index)` = `events[index]` 的 `eventType` 为空。调用方决定语义:
/// push 路径→400;notify_pull 写回→跳过该 batch + log。
pub fn convert_batch_to_rows(b: &PushBatchIn, now_ms: i64) -> Result<BatchConversion, usize> {
    let mut rows: Vec<EventRow> = Vec::with_capacity(b.events.len());
    let mut control_count = 0usize;
    let mut unknown_count = 0usize;
    let mut has_force_close = false;

    for (index, event_value) in b.events.iter().enumerate() {
        let event_type = event_value
            .get("eventType")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if event_type.is_empty() {
            return Err(index);
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
                        "batch unknown eventType (persisted by default)"
                    );
                }
                // P1-9:Value::to_string() infallible(Display 永远产出有效 JSON)
                let payload_json = event_value.to_string();
                rows.push(EventRow {
                    employee_id: b.employee_id,
                    notify_seq: b.notify_seq as i64,
                    event_index: index as i64,
                    event_type: event_type.to_string(),
                    event_reason: extract_str(event_value, "eventReason"),
                    conversation_id: extract_str(event_value, "conversationId"),
                    customer_user_id: extract_str(event_value, "customerUserId"),
                    external_user_id: extract_str(event_value, "externalUserId"),
                    client_id: b.client_id.clone(),
                    batch_id: b.batch_id.clone(),
                    batch_time: b.batch_time.clone(),
                    event_time: extract_str(event_value, "eventTime"),
                    payload_json,
                    created_at_ms: now_ms,
                });
            }
        }
    }

    Ok(BatchConversion {
        rows,
        control_count,
        unknown_count,
        has_force_close,
    })
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
        // invalidate_employee 只动本地缓存,不发网络;downstream 仅为构造 TokenAuthenticator。
        let downstream = Arc::new(
            crate::downstream::DownstreamClient::new_with_defaults("http://localhost").unwrap(),
        );
        PushState {
            secret: "ps".into(),
            events_log: EventLog::new(storage),
            router: Arc::new(Router::new()),
            force_close_grace_ms: 50,
            allowed_client_ids: vec!["rh_wxchat".into()],
            max_body_bytes: 1024 * 1024,
            auth: Arc::new(TokenAuthenticator::new(downstream)),
            source_json_log: None,
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
                    .uri(NOTIFY_PUSH_PATH)
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
        assert_eq!(ack["code"], 1);
        assert_eq!(ack["serviceCode"], "260000000");
        assert_eq!(ack["data"]["accepted"], true);
        assert_eq!(ack["data"]["acceptedEventCount"], 1);
        let rows = log.query_since(42, 0, 10).await.unwrap();
        assert_eq!(rows.len(), 1);
        let payload: serde_json::Value = serde_json::from_str(&rows[0].payload_json).unwrap();
        assert_eq!(payload["message"]["contentText"], "你好");
    }

    #[tokio::test]
    async fn push_auth_failure_returns_401() {
        let st = make_state().await;
        let (status, ack) = post(
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
        // 错误也走统一包络:沿用 HTTP 状态码 + code=0 / serviceCode 固定 / data=null
        assert_eq!(ack["code"], 0);
        assert_eq!(ack["serviceCode"], "260000000");
        assert_eq!(ack["msg"], "invalid secret");
        assert!(ack["data"].is_null());
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
        assert_eq!(ack1["data"]["acceptedEventCount"], 2);
        let (_, ack2) = post(app(st), b, "ps").await;
        // 重投响应字段与首投一致(acceptedEventCount 恒为请求事件数);
        // 幂等性由下方 event log 行数(2,而非 4)保证。
        assert_eq!(ack2["data"]["acceptedEventCount"], 2);
        let rows = log.query_since(42, 0, 100).await.unwrap();
        assert_eq!(rows.len(), 2);
    }

    #[tokio::test]
    #[ignore = "CONNECTION_FORCE_CLOSE 处理暂时停用,后续打开时移除"]
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
        assert_eq!(ack["data"]["acceptedEventCount"], 1);
        // 已注册一条连接,FORCE_CLOSE batch 整体 fan-out → 投递 1 路。
        assert_eq!(ack["data"]["onlineConnectionCount"], 1);

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
    #[ignore = "CONNECTION_FORCE_CLOSE 处理暂时停用,后续打开时移除"]
    async fn push_force_close_invalidates_auth_cache_for_employee() {
        let st = make_state().await;
        // 预热 emp42 与 emp99 的鉴权缓存
        st.auth
            .prepopulate(
                "tok-42",
                crate::hub_service::UserCtx {
                    user_id: "42".into(),
                    accounts: vec![],
                    device_id: String::new(),
                    employee_id: 42,
                },
            )
            .await;
        st.auth
            .prepopulate(
                "tok-99",
                crate::hub_service::UserCtx {
                    user_id: "99".into(),
                    accounts: vec![],
                    device_id: String::new(),
                    employee_id: 99,
                },
            )
            .await;

        let b = body(
            700,
            42,
            serde_json::json!([{ "eventType": "CONNECTION_FORCE_CLOSE" }]),
        );
        let (status, _) = post(app(st.clone()), b, "ps").await;
        assert_eq!(status, StatusCode::OK);

        // emp42 旧 token 缓存被清,emp99 不受影响
        assert!(!st.auth.is_cached_for_test("tok-42").await);
        assert!(st.auth.is_cached_for_test("tok-99").await);
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
        assert_eq!(ack["data"]["acceptedEventCount"], 1);
        assert_eq!(ack["data"]["onlineConnectionCount"], 1);

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

    fn batch_in(events: serde_json::Value) -> PushBatchIn {
        PushBatchIn {
            notify_seq: 500,
            client_id: "rh_wxchat".into(),
            employee_id: 42,
            batch_id: Some("rh_wxchat:42:500".into()),
            batch_time: Some("2026-05-14 10:30:00".into()),
            events: events.as_array().unwrap().clone(),
        }
    }

    #[test]
    fn convert_persist_and_control_classified() {
        let b = batch_in(serde_json::json!([
            { "eventType": "MESSAGE_UPSERT", "conversationId": "c1", "eventReason": "X" },
            { "eventType": "CONNECTION_FORCE_CLOSE" },
        ]));
        let c = convert_batch_to_rows(&b, 111).unwrap();
        assert_eq!(c.rows.len(), 1); // 仅 Persist 入库
        assert_eq!(c.control_count, 1);
        assert!(c.has_force_close);
        assert_eq!(c.unknown_count, 0);
        let r = &c.rows[0];
        assert_eq!(r.employee_id, 42);
        assert_eq!(r.notify_seq, 500);
        assert_eq!(r.event_index, 0);
        assert_eq!(r.conversation_id.as_deref(), Some("c1"));
        assert_eq!(r.event_reason.as_deref(), Some("X"));
        assert_eq!(r.created_at_ms, 111);
    }

    #[test]
    fn convert_unknown_type_persisted_and_counted() {
        let b = batch_in(serde_json::json!([{ "eventType": "FUTURE_X", "f": 1 }]));
        let c = convert_batch_to_rows(&b, 0).unwrap();
        assert_eq!(c.rows.len(), 1);
        assert_eq!(c.unknown_count, 1);
        assert_eq!(c.rows[0].event_type, "FUTURE_X");
    }

    #[test]
    fn convert_empty_event_type_errs_with_index() {
        let b = batch_in(serde_json::json!([
            { "eventType": "MESSAGE_UPSERT" },
            { "noType": true },
        ]));
        assert_eq!(convert_batch_to_rows(&b, 0).unwrap_err(), 1);
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
        assert_eq!(ack["data"]["acceptedEventCount"], 1);
        assert_eq!(ack["data"]["onlineConnectionCount"], 0);
        let rows = log.query_since(42, 0, 10).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].event_type, "FUTURE_EVENT_TYPE");
    }

    // ─── source_json 旁路落盘 ───────────────────────────────────────────────

    /// 读取 tempdir 里唯一一个 `relay-source-json*` 文件全文。
    fn read_source_json_file(dir: &std::path::Path) -> String {
        let mut found = None;
        for entry in std::fs::read_dir(dir).unwrap() {
            let p = entry.unwrap().path();
            if p.file_name()
                .and_then(|s| s.to_str())
                .map(|s| s.starts_with("relay-source-json"))
                .unwrap_or(false)
            {
                found = Some(p);
            }
        }
        std::fs::read_to_string(found.expect("source-json 文件应已创建")).unwrap()
    }

    #[tokio::test]
    async fn source_json_log_writes_raw_body_as_single_line() {
        let dir = tempfile::tempdir().unwrap();
        let (writer, guard) = tracing_appender::non_blocking(tracing_appender::rolling::daily(
            dir.path(),
            "relay-source-json",
        ));
        let mut st = make_state().await;
        st.source_json_log = Some(writer);

        let (status, _) = post(
            app(st),
            body(
                1001,
                42,
                serde_json::json!([{ "eventType": "MESSAGE_UPSERT", "conversationId": "c1" }]),
            ),
            "ps",
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        drop(guard); // flush + join worker

        let content = read_source_json_file(dir.path());
        let lines: Vec<&str> = content.lines().filter(|l| !l.is_empty()).collect();
        assert_eq!(lines.len(), 1, "一条 push = 一行");
        // 原样落盘:解析回来字段与请求一致
        let v: serde_json::Value = serde_json::from_str(lines[0]).expect("应为完整单行 JSON");
        assert_eq!(v["notifySeq"], 1001);
        assert_eq!(v["clientId"], "rh_wxchat");
        assert_eq!(v["employeeId"], 42);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn source_json_log_concurrent_no_interleave_no_loss() {
        let dir = tempfile::tempdir().unwrap();
        let (writer, guard) = tracing_appender::non_blocking(tracing_appender::rolling::daily(
            dir.path(),
            "relay-source-json",
        ));
        let mut st = make_state().await;
        st.source_json_log = Some(writer);

        let n: u64 = 20;
        let mut handles = Vec::new();
        for seq in 1..=n {
            let st = st.clone();
            handles.push(tokio::spawn(async move {
                let (status, _) = post(
                    app(st),
                    body(
                        seq,
                        42,
                        serde_json::json!([{ "eventType": "MESSAGE_UPSERT", "conversationId": "c1" }]),
                    ),
                    "ps",
                )
                .await;
                assert_eq!(status, StatusCode::OK);
            }));
        }
        for h in handles {
            h.await.unwrap();
        }
        drop(guard);

        let content = read_source_json_file(dir.path());
        let mut seen = std::collections::BTreeSet::new();
        for line in content.lines().filter(|l| !l.is_empty()) {
            // 每行都能独立解析 = 没有交错
            let v: serde_json::Value =
                serde_json::from_str(line).expect("每行应为完整 JSON(不交错)");
            seen.insert(v["notifySeq"].as_u64().unwrap());
        }
        let expected: std::collections::BTreeSet<u64> = (1..=n).collect();
        assert_eq!(seen, expected, "不交错、不丢行");
    }

    #[tokio::test]
    async fn source_json_log_disabled_creates_no_file() {
        let dir = tempfile::tempdir().unwrap();
        // make_state 默认 source_json_log = None → 不挂中间件、不写文件
        let st = make_state().await;
        assert!(st.source_json_log.is_none());
        let (status, _) = post(
            app(st),
            body(
                7,
                42,
                serde_json::json!([{ "eventType": "MESSAGE_UPSERT" }]),
            ),
            "ps",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        // tempdir 里不应出现 source-json 文件
        let any = std::fs::read_dir(dir.path()).unwrap().any(|e| {
            e.unwrap()
                .file_name()
                .to_str()
                .map(|s| s.starts_with("relay-source-json"))
                .unwrap_or(false)
        });
        assert!(!any, "关闭时不应创建 source-json 文件");
    }
}
