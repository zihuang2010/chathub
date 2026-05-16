//! chathub-mock-downstream — 本地联调用的下游 mock(2026-05-16 OAuth2 重构后)。
//!
//! 协议:
//!   - 鉴权:relay → 此 mock 一律 Bearer 客户端原 token(login 除外用 Basic client auth);
//!   - 打印:每个请求/响应**整段 HTTP 都 dump 到 stdout**,方便对协议形态。
//!
//! 提供的 endpoints:
//!   认证类:
//!     POST /account-app/oauth2/token         OAuth2 password grant + Basic client auth
//!                                            → 返 JddTokenVO 形态
//!     POST /v1/verify_token                  Bearer <token> + 空 body → 返 {active, employee_id, ...}
//!     POST /auth/logout                      Bearer <token> + 空 body → 204
//!   业务类(Forward 通道):
//!     GET  /wechat-business-app/wecom-cs/v1/wecomAggregate/account/listMine
//!                                            Bearer <token> → 返账号列表
//!     POST /v1/send, /v1/recall, /v1/ack_read, /v1/fetch_history
//!                                            Bearer <token> + X-Relay-Employee-Id → 返业务响应
//!
//! 联调假设:任何 username/password 都登录成功;任何 Bearer 都 verify 通过。
//! mock 仅校验"形态合规"(grant_type=password、scope=server、Basic header 存在等)。
//!
//! Env:
//!   MOCK_DOWNSTREAM_ADDR     默认 127.0.0.1:8080
//!   MOCK_OAUTH_CLIENT_ID     默认 rh_wxchat
//!   MOCK_OAUTH_CLIENT_SECRET 默认 rh_wxchat
//!   MOCK_USER_ID             默认 1234(数值 ID,用作 JddTokenVO.userId + verify employee_id)
//!   MOCK_NICK_NAME           默认 "Mock User"
//!   MOCK_ACCOUNTS            默认 "wa-1"(逗号分隔,用于 listMine + verify accounts)
//!   MOCK_TOKEN               默认 "mock-token-<random>"

use axum::body::{Body, Bytes};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Form, Json, Router};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

const SEP: &str =
    "═══════════════════════════════════════════════════════════════════════════════════";

#[derive(Clone)]
struct AppState {
    oauth_client_id: String,
    oauth_client_secret: String,
    token: String,
    user_id: i64,
    nick_name: String,
    accounts: Vec<MockAccount>,
}

#[derive(Clone)]
struct MockAccount {
    wecom_account_id: String,
    corp_id: String,
    agent_id: i64,
    display_name: String,
    enabled: bool,
}

// ─── JddTokenVO(login 响应)───────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JddTokenVO {
    access_token: JddAccessToken,
    user_id: i64,
    username: String,
    nick_name: String,
    mobile: String,
    channel: i32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JddAccessToken {
    token_value: String,
    token_type: JddTokenType,
    issued_at: String,
    expires_at: String,
}

#[derive(Serialize)]
struct JddTokenType {
    value: String,
}

#[derive(Deserialize, Debug)]
#[allow(dead_code)]
struct LoginForm {
    username: String,
    password: String,
}

// ─── verifyToken 响应 ───────────────────────────────────────────────────────

#[derive(Serialize)]
struct VerifyTokenResp {
    active: bool,
    user_id: String,
    device_id: String,
    accounts: Vec<String>,
    exp_ms: i64,
    employee_id: i64,
}

// ─── listMine 响应(GET,字段未确定 → 用骨架猜测,等后端确认再 adapt)──────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ListMineItem {
    wx_cs_account_id: String,
    corp_id: String,
    agent_id: i64,
    name: String,
    enabled: bool,
}

// ─── 业务类 ─────────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct SendResp {
    server_msg_id: String,
    sent_at_ms: i64,
}

#[derive(Serialize)]
struct RecallResp {
    recalled_at_ms: i64,
}

#[derive(Serialize)]
struct AckReadResp {
    acked_at_ms: i64,
}

#[derive(Serialize)]
struct FetchHistoryResp {
    messages: Vec<serde_json::Value>,
    next_cursor: String,
}

// ───────────────────────────────────────────────────────────────────────────

#[tokio::main(flavor = "multi_thread")]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let addr: SocketAddr = std::env::var("MOCK_DOWNSTREAM_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:8080".to_string())
        .parse()?;
    let oauth_client_id =
        std::env::var("MOCK_OAUTH_CLIENT_ID").unwrap_or_else(|_| "rh_wxchat".to_string());
    let oauth_client_secret =
        std::env::var("MOCK_OAUTH_CLIENT_SECRET").unwrap_or_else(|_| "rh_wxchat".to_string());
    let token = std::env::var("MOCK_TOKEN").unwrap_or_else(|_| {
        format!(
            "mock-token-{}",
            &uuid::Uuid::new_v4().simple().to_string()[..12]
        )
    });
    let user_id: i64 = std::env::var("MOCK_USER_ID")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(1234);
    let nick_name = std::env::var("MOCK_NICK_NAME").unwrap_or_else(|_| "Mock User".to_string());
    let accounts: Vec<MockAccount> = std::env::var("MOCK_ACCOUNTS")
        .unwrap_or_else(|_| "wa-1".to_string())
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .enumerate()
        .map(|(i, id)| MockAccount {
            wecom_account_id: id.clone(),
            corp_id: format!("wwd{:08}", i + 1),
            agent_id: 1_000_000 + i as i64,
            display_name: format!("Mock 企微账号 {}", i + 1),
            enabled: true,
        })
        .collect();

    let state = Arc::new(AppState {
        oauth_client_id,
        oauth_client_secret,
        token,
        user_id,
        nick_name,
        accounts,
    });

    let app = Router::new()
        .route("/account-app/oauth2/token", post(oauth2_token))
        .route("/v1/verify_token", post(verify_token))
        .route("/auth/logout", post(logout))
        .route(
            "/wechat-business-app/wecom-cs/v1/wecomAggregate/account/listMine",
            get(list_mine),
        )
        .route("/v1/send", post(send))
        .route("/v1/recall", post(recall))
        .route("/v1/ack_read", post(ack_read))
        .route("/v1/fetch_history", post(fetch_history))
        .layer(axum::middleware::from_fn(dump_http))
        .with_state(state.clone());

    let listener = TcpListener::bind(addr).await?;
    println!("{SEP}");
    println!("[mock-downstream] listening on {addr}");
    println!(
        "[mock-downstream] OAuth2 client_id={}  client_secret={}",
        state.oauth_client_id, state.oauth_client_secret
    );
    println!(
        "[mock-downstream] user_id={}  nick_name={}  token={}",
        state.user_id, state.nick_name, state.token
    );
    println!(
        "[mock-downstream] accounts={:?}",
        state
            .accounts
            .iter()
            .map(|a| &a.wecom_account_id)
            .collect::<Vec<_>>()
    );
    println!("{SEP}\n");
    axum::serve(listener, app).await?;
    Ok(())
}

// ─── HTTP dump middleware ──────────────────────────────────────────────────

const MAX_DUMP_BODY: usize = 4096;

async fn dump_http(req: Request, next: Next) -> Response {
    let method = req.method().clone();
    let uri = req.uri().clone();
    let headers = req.headers().clone();
    let (parts, body) = req.into_parts();
    let body_bytes = axum::body::to_bytes(body, 8 * 1024 * 1024)
        .await
        .unwrap_or_default();

    print_request(&method, &uri, &headers, &body_bytes);

    let req = Request::from_parts(parts, Body::from(body_bytes));
    let resp = next.run(req).await;

    let status = resp.status();
    let resp_headers = resp.headers().clone();
    let (parts, body) = resp.into_parts();
    let body_bytes = axum::body::to_bytes(body, 8 * 1024 * 1024)
        .await
        .unwrap_or_default();

    print_response(status, &resp_headers, &body_bytes);

    Response::from_parts(parts, Body::from(body_bytes))
}

fn print_request(method: &Method, uri: &Uri, headers: &HeaderMap, body: &[u8]) {
    println!("\n{SEP}");
    println!("← {} {}", method, uri);
    println!("  ─ Headers ─");
    for (k, v) in headers {
        let v_str = v.to_str().unwrap_or("<binary>");
        println!("    {}: {}", k, v_str);
    }
    print_body(body);
}

fn print_response(status: StatusCode, headers: &HeaderMap, body: &[u8]) {
    println!(
        "→ {} {}",
        status.as_u16(),
        status.canonical_reason().unwrap_or("")
    );
    println!("  ─ Headers ─");
    for (k, v) in headers {
        let v_str = v.to_str().unwrap_or("<binary>");
        println!("    {}: {}", k, v_str);
    }
    print_body(body);
    println!("{SEP}\n");
}

fn print_body(body: &[u8]) {
    if body.is_empty() {
        println!("  ─ Body ─");
        println!("    (empty)");
        return;
    }
    println!("  ─ Body ({} bytes) ─", body.len());
    let display_bytes = if body.len() > MAX_DUMP_BODY {
        &body[..MAX_DUMP_BODY]
    } else {
        body
    };
    match std::str::from_utf8(display_bytes) {
        Ok(text) => {
            // 尝试 pretty 化 JSON
            if let Ok(v) = serde_json::from_slice::<serde_json::Value>(display_bytes) {
                if let Ok(pretty) = serde_json::to_string_pretty(&v) {
                    for line in pretty.lines() {
                        println!("    {}", line);
                    }
                } else {
                    println!("    {}", text);
                }
            } else {
                println!("    {}", text);
            }
        }
        Err(_) => {
            println!("    <{} bytes binary>", display_bytes.len());
        }
    }
    if body.len() > MAX_DUMP_BODY {
        println!(
            "    ... [truncated, {} more bytes]",
            body.len() - MAX_DUMP_BODY
        );
    }
}

// ─── OAuth2 password grant ─────────────────────────────────────────────────

#[derive(Deserialize)]
#[allow(dead_code)]
struct OAuthQuery {
    scope: Option<String>,
    #[serde(rename = "terminalId")]
    terminal_id: Option<String>,
    grant_type: Option<String>,
}

async fn oauth2_token(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    axum::extract::Query(query): axum::extract::Query<OAuthQuery>,
    Form(form): Form<LoginForm>,
) -> impl IntoResponse {
    // 1. Basic auth 形态校验(mock 接受任意 client_id:client_secret,但要求 Basic 存在)
    let basic = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Basic "));
    if basic.is_none() {
        return (StatusCode::UNAUTHORIZED, "missing Basic auth").into_response();
    }
    // 期望 client_id:client_secret = MOCK_OAUTH_CLIENT_ID:MOCK_OAUTH_CLIENT_SECRET
    let expected = base64_encode(format!(
        "{}:{}",
        state.oauth_client_id, state.oauth_client_secret
    ));
    let got = basic.unwrap();
    if got != expected {
        println!(
            "[mock-downstream] WARN: Basic auth mismatch — expected base64({}:{}), got {}",
            state.oauth_client_id, state.oauth_client_secret, got
        );
        // mock 仍放行,只警告;生产应该拒绝
    }

    // 2. Query 必填(spec §7.1)
    if query.grant_type.as_deref() != Some("password") {
        return (StatusCode::BAD_REQUEST, "grant_type must be password").into_response();
    }
    if query.scope.as_deref() != Some("server") {
        return (StatusCode::BAD_REQUEST, "scope must be server").into_response();
    }
    let _terminal_id = query.terminal_id.unwrap_or_default();

    // 3. Form 必填
    if form.username.is_empty() || form.password.is_empty() {
        return (StatusCode::BAD_REQUEST, "username and password required").into_response();
    }

    // 4. 返 JddTokenVO
    let now = now_local_yyyy_mm_dd_hh_mm_ss();
    let exp = now_local_yyyy_mm_dd_hh_mm_ss_offset(12 * 3600); // +12h
    Json(JddTokenVO {
        access_token: JddAccessToken {
            token_value: state.token.clone(),
            token_type: JddTokenType {
                value: "Bearer".into(),
            },
            issued_at: now,
            expires_at: exp,
        },
        user_id: state.user_id,
        username: form.username.clone(),
        nick_name: state.nick_name.clone(),
        mobile: "13800000000".into(),
        channel: 3,
    })
    .into_response()
}

// ─── /v1/verify_token(Bearer + 空 body)─────────────────────────────────

async fn verify_token(State(state): State<Arc<AppState>>, headers: HeaderMap) -> impl IntoResponse {
    let bearer = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "));
    if bearer.is_none() {
        return (StatusCode::UNAUTHORIZED, "missing Bearer").into_response();
    }
    // mock 接受任意 token,返固定身份
    Json(VerifyTokenResp {
        active: true,
        user_id: format!("u-{}", state.user_id),
        device_id: "mock-device".into(),
        accounts: state
            .accounts
            .iter()
            .map(|a| a.wecom_account_id.clone())
            .collect(),
        exp_ms: now_ms() + 30 * 60 * 1000,
        employee_id: state.user_id,
    })
    .into_response()
}

// ─── /auth/logout(Bearer + 空 body)─────────────────────────────────────

async fn logout(headers: HeaderMap) -> impl IntoResponse {
    if !has_bearer(&headers) {
        return (StatusCode::UNAUTHORIZED, "missing Bearer").into_response();
    }
    StatusCode::NO_CONTENT.into_response()
}

// ─── listMine(GET,Bearer)──────────────────────────────────────────────

async fn list_mine(State(state): State<Arc<AppState>>, headers: HeaderMap) -> impl IntoResponse {
    if !has_bearer(&headers) {
        return (StatusCode::UNAUTHORIZED, "missing Bearer").into_response();
    }
    let items: Vec<ListMineItem> = state
        .accounts
        .iter()
        .map(|a| ListMineItem {
            wx_cs_account_id: a.wecom_account_id.clone(),
            corp_id: a.corp_id.clone(),
            agent_id: a.agent_id,
            name: a.display_name.clone(),
            enabled: a.enabled,
        })
        .collect();
    Json(items).into_response()
}

// ─── 业务类 ───────────────────────────────────────────────────────────────

async fn send(headers: HeaderMap, body: Bytes) -> impl IntoResponse {
    if !has_bearer(&headers) {
        return (StatusCode::UNAUTHORIZED, "missing Bearer").into_response();
    }
    let _ = body; // raw body 已被 dump 打印,不再 typed-parse
    Json(SendResp {
        server_msg_id: format!("sm-mock-{}", uuid::Uuid::new_v4().simple()),
        sent_at_ms: now_ms(),
    })
    .into_response()
}

async fn recall(headers: HeaderMap, body: Bytes) -> impl IntoResponse {
    if !has_bearer(&headers) {
        return (StatusCode::UNAUTHORIZED, "missing Bearer").into_response();
    }
    let _ = body;
    Json(RecallResp {
        recalled_at_ms: now_ms(),
    })
    .into_response()
}

async fn ack_read(headers: HeaderMap, body: Bytes) -> impl IntoResponse {
    if !has_bearer(&headers) {
        return (StatusCode::UNAUTHORIZED, "missing Bearer").into_response();
    }
    let _ = body;
    Json(AckReadResp {
        acked_at_ms: now_ms(),
    })
    .into_response()
}

async fn fetch_history(headers: HeaderMap, body: Bytes) -> impl IntoResponse {
    if !has_bearer(&headers) {
        return (StatusCode::UNAUTHORIZED, "missing Bearer").into_response();
    }
    let _ = body;
    Json(FetchHistoryResp {
        messages: Vec::new(),
        next_cursor: String::new(),
    })
    .into_response()
}

// ─── helpers ──────────────────────────────────────────────────────────────

fn has_bearer(headers: &HeaderMap) -> bool {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.starts_with("Bearer "))
        .unwrap_or(false)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn base64_encode(s: String) -> String {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    STANDARD.encode(s)
}

/// 返回 "yyyy-MM-dd HH:mm:ss" 本地时区(简化:UTC+8 中国时间)
fn now_local_yyyy_mm_dd_hh_mm_ss() -> String {
    now_local_yyyy_mm_dd_hh_mm_ss_offset(0)
}

fn now_local_yyyy_mm_dd_hh_mm_ss_offset(offset_secs: i64) -> String {
    // UTC + 8h + offset_secs;为避免引入 chrono dep,手工算
    let secs = (now_ms() / 1000) + 8 * 3600 + offset_secs;
    let (y, mo, d, h, mi, s) = ymdhms_from_unix(secs);
    format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}", y, mo, d, h, mi, s)
}

/// Howard Hinnant 算法的简化版:unix 秒 → (年, 月, 日, 时, 分, 秒)
fn ymdhms_from_unix(secs: i64) -> (i32, u32, u32, u32, u32, u32) {
    let days = secs.div_euclid(86400);
    let secs_in_day = secs.rem_euclid(86400) as u32;
    let h = secs_in_day / 3600;
    let mi = (secs_in_day % 3600) / 60;
    let s = secs_in_day % 60;

    // 1970-01-01 是 unix epoch
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i32 + era as i32 * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d, h, mi, s)
}
