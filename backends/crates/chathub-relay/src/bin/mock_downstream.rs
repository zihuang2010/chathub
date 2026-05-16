//! chathub-mock-downstream — 本地联调用的下游 mock。
//!
//! 响应 relay 的 HTTP 合约:
//!   认证类(relay 透传 / 调用):
//!     POST /auth/login        → 返回业务 token + user + wecom_accounts
//!     POST /auth/logout       → 204
//!     POST /v1/verify_token   → 返回连接身份 {active,user_id,device_id,accounts}
//!   业务类(relay 透传):
//!     POST /v1/send, /v1/recall, /v1/ack_read, /v1/fetch_history
//!
//! 全部 Bearer 校验(`MOCK_DOWNSTREAM_SECRET`,默认 `dn-secret`,与 relay 的
//! `RELAY_DOWNSTREAM_SECRET` 必须一致)。
//!
//! 联调假设:任意 username/password 都登录成功,返回固定 user + token;
//! verify_token 接受任意 token,返回固定连接身份。

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::post;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

#[derive(Clone)]
struct AppState {
    secret: String,
    token: String,
    user_id: String,
    display_name: String,
    role: String,
    tenant_id: String,
    device_id: String,
    accounts: Vec<WecomAccount>,
}

#[derive(Serialize, Clone)]
struct WecomAccount {
    wecom_account_id: String,
    corp_id: String,
    agent_id: i64,
    display_name: String,
    enabled: bool,
}

// ── /auth/login ──────────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[allow(dead_code)] // mock 不校验,只为日志/形状
struct LoginReq {
    username: String,
    password: String,
    device_id: String,
    device_name: String,
}

#[derive(Serialize)]
struct LoginResp {
    access_token: String,
    user_id: String,
    display_name: String,
    avatar_url: String,
    role: String,
    tenant_id: String,
    wecom_accounts: Vec<WecomAccount>,
}

// ── /v1/verify_token ─────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[allow(dead_code)]
struct VerifyTokenReq {
    token: String,
}

#[derive(Serialize)]
struct VerifyTokenResp {
    active: bool,
    user_id: String,
    device_id: String,
    accounts: Vec<String>,
    exp_ms: i64,
}

// ── /auth/logout ─────────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[allow(dead_code)]
struct LogoutReq {
    token: String,
}

// ── 业务类 ───────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[allow(dead_code)]
struct SendReq {
    user_id: String,
    wecom_account_id: String,
    conversation_id: String,
    client_msg_id: String,
    body: serde_json::Value,
}

#[derive(Serialize)]
struct SendResp {
    server_msg_id: String,
    sent_at_ms: i64,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct RecallReq {
    user_id: String,
    wecom_account_id: String,
    conversation_id: String,
    server_msg_id: String,
}

#[derive(Serialize)]
struct RecallResp {
    recalled_at_ms: i64,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct AckReadReq {
    user_id: String,
    wecom_account_id: String,
    conversation_id: String,
    last_read_server_msg_id: String,
}

#[derive(Serialize)]
struct AckReadResp {
    acked_at_ms: i64,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct FetchHistoryReq {
    user_id: String,
    wecom_account_id: String,
    conversation_id: String,
    limit: u32,
    cursor: String,
}

#[derive(Serialize)]
struct FetchHistoryResp {
    messages: Vec<serde_json::Value>,
    next_cursor: String,
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let secret =
        std::env::var("MOCK_DOWNSTREAM_SECRET").unwrap_or_else(|_| "dn-secret".to_string());
    let addr: SocketAddr = std::env::var("MOCK_DOWNSTREAM_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:8080".to_string())
        .parse()?;
    let token = std::env::var("MOCK_TOKEN").unwrap_or_else(|_| "mock-token-1".to_string());
    let user_id = std::env::var("MOCK_USER_ID").unwrap_or_else(|_| "u-test".to_string());
    let display_name =
        std::env::var("MOCK_DISPLAY_NAME").unwrap_or_else(|_| "Test User".to_string());
    let role = std::env::var("MOCK_ROLE").unwrap_or_else(|_| "operator".to_string());
    let tenant_id = std::env::var("MOCK_TENANT_ID").unwrap_or_else(|_| "tenant-test".to_string());
    let device_id = std::env::var("MOCK_DEVICE_ID").unwrap_or_else(|_| "mock-device".to_string());
    let accounts: Vec<WecomAccount> = std::env::var("MOCK_ACCOUNTS")
        .unwrap_or_else(|_| "wa-1".to_string())
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .enumerate()
        .map(|(i, id)| WecomAccount {
            wecom_account_id: id.clone(),
            corp_id: format!("corp-{}", i + 1),
            agent_id: 1_000_000 + i as i64,
            display_name: format!("Mock 企微账号 {}", i + 1),
            enabled: true,
        })
        .collect();

    let state = Arc::new(AppState {
        secret,
        token,
        user_id,
        display_name,
        role,
        tenant_id,
        device_id,
        accounts,
    });

    let app = Router::new()
        .route("/auth/login", post(login))
        .route("/auth/logout", post(logout))
        .route("/v1/verify_token", post(verify_token))
        .route("/v1/send", post(send))
        .route("/v1/recall", post(recall))
        .route("/v1/ack_read", post(ack_read))
        .route("/v1/fetch_history", post(fetch_history))
        .with_state(state.clone());

    let listener = TcpListener::bind(addr).await?;
    tracing::info!(
        target: "mock_downstream",
        %addr,
        accounts = ?state.accounts.iter().map(|a| &a.wecom_account_id).collect::<Vec<_>>(),
        user_id = %state.user_id,
        "mock downstream listening",
    );
    axum::serve(listener, app).await?;
    Ok(())
}

fn check_auth(headers: &HeaderMap, secret: &str) -> Result<(), (StatusCode, &'static str)> {
    let want = format!("Bearer {secret}");
    let ok = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .map(|s| s == want)
        .unwrap_or(false);
    if ok {
        Ok(())
    } else {
        Err((StatusCode::UNAUTHORIZED, "invalid downstream secret"))
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

async fn login(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<LoginReq>,
) -> impl IntoResponse {
    if let Err(e) = check_auth(&headers, &state.secret) {
        tracing::warn!(target: "mock_downstream", endpoint = "login", "auth failed");
        return e.into_response();
    }
    tracing::info!(
        target: "mock_downstream",
        endpoint = "login",
        username = %req.username,
        device_id = %req.device_id,
        device_name = %req.device_name,
        "ok",
    );
    Json(LoginResp {
        access_token: state.token.clone(),
        user_id: state.user_id.clone(),
        display_name: state.display_name.clone(),
        avatar_url: String::new(),
        role: state.role.clone(),
        tenant_id: state.tenant_id.clone(),
        wecom_accounts: state.accounts.clone(),
    })
    .into_response()
}

async fn logout(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<LogoutReq>,
) -> impl IntoResponse {
    if let Err(e) = check_auth(&headers, &state.secret) {
        return e.into_response();
    }
    tracing::info!(target: "mock_downstream", endpoint = "logout", token = %req.token, "ok");
    StatusCode::NO_CONTENT.into_response()
}

async fn verify_token(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<VerifyTokenReq>,
) -> impl IntoResponse {
    if let Err(e) = check_auth(&headers, &state.secret) {
        tracing::warn!(target: "mock_downstream", endpoint = "verify_token", "auth failed");
        return e.into_response();
    }
    tracing::info!(
        target: "mock_downstream",
        endpoint = "verify_token",
        token = %req.token,
        "ok (active)",
    );
    Json(VerifyTokenResp {
        active: true,
        user_id: state.user_id.clone(),
        device_id: state.device_id.clone(),
        accounts: state
            .accounts
            .iter()
            .map(|a| a.wecom_account_id.clone())
            .collect(),
        exp_ms: now_ms() + 30 * 60 * 1000,
    })
    .into_response()
}

async fn send(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<SendReq>,
) -> impl IntoResponse {
    if let Err(e) = check_auth(&headers, &state.secret) {
        return e.into_response();
    }
    let resp = SendResp {
        server_msg_id: format!("sm-mock-{}", uuid::Uuid::new_v4().simple()),
        sent_at_ms: now_ms(),
    };
    tracing::info!(
        target: "mock_downstream",
        endpoint = "send",
        user = %req.user_id,
        account = %req.wecom_account_id,
        conversation = %req.conversation_id,
        client_msg_id = %req.client_msg_id,
        server_msg_id = %resp.server_msg_id,
        "ok",
    );
    Json(resp).into_response()
}

async fn recall(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<RecallReq>,
) -> impl IntoResponse {
    if let Err(e) = check_auth(&headers, &state.secret) {
        return e.into_response();
    }
    tracing::info!(
        target: "mock_downstream",
        endpoint = "recall",
        user = %req.user_id,
        server_msg_id = %req.server_msg_id,
        "ok",
    );
    Json(RecallResp {
        recalled_at_ms: now_ms(),
    })
    .into_response()
}

async fn ack_read(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<AckReadReq>,
) -> impl IntoResponse {
    if let Err(e) = check_auth(&headers, &state.secret) {
        return e.into_response();
    }
    tracing::info!(
        target: "mock_downstream",
        endpoint = "ack_read",
        user = %req.user_id,
        last_read = %req.last_read_server_msg_id,
        "ok",
    );
    Json(AckReadResp {
        acked_at_ms: now_ms(),
    })
    .into_response()
}

async fn fetch_history(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<FetchHistoryReq>,
) -> impl IntoResponse {
    if let Err(e) = check_auth(&headers, &state.secret) {
        return e.into_response();
    }
    tracing::info!(
        target: "mock_downstream",
        endpoint = "fetch_history",
        user = %req.user_id,
        conversation = %req.conversation_id,
        limit = req.limit,
        cursor = %req.cursor,
        "ok (returning empty)",
    );
    Json(FetchHistoryResp {
        messages: Vec::new(),
        next_cursor: String::new(),
    })
    .into_response()
}
