//! axum router: POST /internal/push (Bearer) + GET /healthz。

use crate::router::{Router, RouterError};
use crate::storage::events::EventStore;
use crate::storage::seqs::SeqAllocator;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router as AxumRouter};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Instant;

#[derive(Clone)]
pub struct PushState {
    pub secret: String,
    pub seqs: SeqAllocator,
    pub events: EventStore,
    pub router: Arc<Router>,
}

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
        .with_state(state)
}

async fn handle_push(
    State(state): State<PushState>,
    headers: HeaderMap,
    Json(body): Json<PushBody>,
) -> impl IntoResponse {
    let started = Instant::now();
    let account = body.wecom_account_id.as_str();

    // Bearer 校验
    let want = format!("Bearer {}", state.secret);
    let ok = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .map(|s| s == want)
        .unwrap_or(false);
    if !ok {
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
}
