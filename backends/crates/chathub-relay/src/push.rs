//! axum router: POST /internal/push (Bearer) + GET /healthz。

use crate::router::{Router, RouterError};
use crate::storage::events::EventStore;
use crate::storage::seqs::SeqAllocator;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router as AxumRouter};
use chathub_proto::v1::ServerEvent;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Clone)]
pub struct PushState {
    pub secret: String,
    pub seqs: SeqAllocator,
    pub events: EventStore,
    pub router: Arc<Router>,
}

#[derive(Deserialize)]
pub struct PushBody {
    pub wecom_account_id: String,
    pub event: ServerEvent,
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
    // Bearer 校验
    let want = format!("Bearer {}", state.secret);
    let ok = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .map(|s| s == want)
        .unwrap_or(false);
    if !ok {
        return (StatusCode::UNAUTHORIZED, "invalid secret").into_response();
    }
    let assigned_seq = match state.seqs.next_seq(&body.wecom_account_id).await {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!("next_seq: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, "seq").into_response();
        }
    };
    let mut evt = body.event;
    evt.wecom_account_id = body.wecom_account_id.clone();
    evt.seq = assigned_seq;
    let mut buf = Vec::new();
    if let Err(e) = prost::Message::encode(&evt, &mut buf) {
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
        tracing::warn!("events.record: {e}");
        return (StatusCode::INTERNAL_SERVER_ERROR, "record").into_response();
    }
    let no_stream = matches!(
        state.router.fanout(&body.wecom_account_id, evt),
        Err(RouterError::NoStream)
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
}
