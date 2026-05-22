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
//!     POST /wechat-business-app/rpc/v1/wecomAggregate/connection/verifyToken
//!                                            Bearer <token> + {} body → 返 {employeeId, username, ...}
//!     POST /auth/logout                      Bearer <token> + 空 body → 200 envelope(data=null)
//!   业务类(Forward 通道):
//!     GET  /wechat-business-app/wecom-cs/v1/wecomAggregate/account/listMine
//!                                            Bearer <token> → 返账号列表
//!     POST /wechat-business-app/wecom-cs/v1/wecomAggregate/account/listFriends
//!                                            Bearer <token> + JSON body → 返多账号好友分页
//!     POST /wechat-business-app/wecom-cs/v1/wecomAggregate/session/recentFriends
//!                                            Bearer <token> + JSON body → 返接待列表(cursor 分页)
//!     POST /wechat-business-app/wecom-cs/v1/wecomAggregate/session/markRead
//!                                            Bearer <token> + JSON body → 返 {success:true}
//!     POST /wechat-business-app/wecom-cs/v1/wecomAggregate/message/history
//!                                            Bearer <token> + JSON body → 返历史消息(cursor 分页)
//!     POST /wechat-business-app/wecom-cs/v1/wecomAggregate/message/send
//!                                            Bearer <token> + JSON body → 返 {localMessageId, sendStatus, messageTime}
//!     POST /v1/send, /v1/recall, /v1/ack_read, /v1/fetch_history
//!                                            Bearer <token> + X-Relay-Employee-Id → 返业务响应
//!
//! 联调假设:任何 username/password 都登录成功;任何 Bearer 都 verify 通过。
//! mock 仅校验"形态合规"(grant_type=password、scope=server、Basic header 存在等)。
//!
//! Env:
//!   MOCK_DOWNSTREAM_ADDR        默认 127.0.0.1:8080
//!   MOCK_OAUTH_CLIENT_ID        默认 rh_wxchat
//!   MOCK_OAUTH_CLIENT_SECRET    默认 rh_wxchat
//!   MOCK_USER_ID                默认 1234(数值 ID,用作 JddTokenVO.userId + verify employee_id)
//!   MOCK_NICK_NAME              默认 "Mock User"
//!   MOCK_ACCOUNTS               默认 "wa-1"(逗号分隔,用于 listMine + verify accounts)
//!   MOCK_TOKEN                  默认 "mock-token-<random>"
//!   MOCK_FRIENDS_PER_ACCOUNT    默认 30(每账号生成多少 mock 好友;LCG 确定性派生)

use axum::body::{Body, Bytes};
use axum::extract::{Query, Request, State};
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
    friends_per_account: usize,
}

#[derive(Clone)]
struct MockAccount {
    wecom_account_id: String,
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

// ─── 统一响应包络(code=1 成功 / 否则 msg 报错)─────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Envelope<T: Serialize> {
    code: i32,
    service_code: String,
    msg: String,
    data: T,
}

fn envelope_ok<T: Serialize>(data: T) -> Json<Envelope<T>> {
    Json(Envelope {
        code: 1,
        service_code: String::new(),
        msg: "成功".into(),
        data,
    })
}

// ─── verifyToken 响应 ───────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VerifyTokenResp {
    employee_id: i64,
    username: String,
    nick_name: String,
    mobile: String,
    channel: String,
}

// ─── listMine 响应(GET,新契约 8 字段)────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ListMineItem {
    wecom_account_id: String,
    wecom_name: String,
    wecom_account: String,
    wecom_alias: String,
    wecom_avatar: String,
    wecom_status: i32,
    gender: i32,
    position: String,
}

// ─── listFriends 请求/响应(POST,单 cursor 跨账号 keyset)──────────────────────

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct ListFriendsReq {
    wecom_account_ids: Vec<String>,
    size: u32,
    /// 首页 ""(空串);续页填上轮 nextCursor。keyset 位置编码,见 `decode_friend_cursor`。
    #[serde(default)]
    cursor: String,
    /// 非空 → 名称/手机号统一模糊匹配(契约 #3:externalId 替代 externalName/externalMobile)。
    #[serde(default)]
    external_id: Option<String>,
    #[serde(default)]
    add_start_time: Option<String>,
    #[serde(default)]
    add_end_time: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct MockFriend {
    wecom_account_id: String,
    external_user_id: String,
    external_name: String,
    external_position: String,
    external_avatar: String,
    external_corp_name: String,
    external_corp_full_name: String,
    external_type: i32,
    external_gender: i32,
    external_mobile: String,
    follow_remark: String,
    follow_description: String,
    remark_corp_name: String,
    add_time: String,
    add_way: i32,
    follow_state: String,
    wechat_channels_nickname: String,
    wechat_channels_source: i32,
    last_sync_time: String,
    sync_status: i32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ListFriendsResp {
    records: Vec<MockFriend>,
    has_more: bool,
    next_cursor: String,
}

// ─── session/recentFriends 请求/响应(POST,cursor 分页)──────────────────────

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct ListRecentFriendsReq {
    size: u32,
    #[serde(default)]
    cursor: String,
    #[serde(default)]
    external_name: String,
    #[serde(default)]
    external_mobile: String,
    #[serde(default)]
    wecom_account_id: String,
    #[serde(default)]
    only_unread: bool,
}

/// 接待列表单条记录(17 字段,对齐 chathub-net::RecentFriendRecord)。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct MockRecentFriend {
    conversation_id: String,
    wecom_account_id: String,
    wecom_name: String,
    wecom_account: String,
    wecom_alias: String,
    external_user_id: String,
    external_name: String,
    external_avatar: String,
    external_mobile: String,
    last_local_message_id: String,
    last_message_type: i32,
    last_message_direction: i32,
    last_send_status: i32,
    last_message_summary: String,
    /// ISO 8601 UTC,形如 "2026-05-18T10:28:36Z"
    last_message_time: String,
    unread_count: i64,
    has_unread: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ListRecentFriendsResp {
    size: u32,
    has_more: bool,
    next_cursor: String,
    records: Vec<MockRecentFriend>,
}

// ─── 业务类 ─────────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct SendResp {
    server_msg_id: String,
    sent_at_ms: i64,
}

/// message/send 响应(text-only,镜像业务后台 data 形态)。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SendMessageResp {
    local_message_id: String,
    /// 2=已送达
    send_status: i32,
    /// `yyyy-MM-dd HH:mm:ss`
    message_time: String,
}

#[derive(Serialize)]
struct RecallResp {
    recalled_at_ms: i64,
}

#[derive(Serialize)]
struct AckReadResp {
    acked_at_ms: i64,
}

/// session/markRead 响应(镜像业务后台 data 形态)。
#[derive(Serialize)]
struct MarkReadResp {
    success: bool,
}

// ─── message/history 请求/响应 ──────────────────────────────────────────────

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct FetchMessageHistoryReq {
    size: u32,
    wecom_account_id: String,
    external_user_id: String,
    /// 首页 ""(空串)/续页填上轮 nextCursor。语义固定 earlier-only(往更早翻)。
    #[serde(default)]
    cursor: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct MockHistoryAttachment {
    media_id: String,
    file_name: String,
    file_size: i64,
    file_type: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct MockHistoryMessage {
    local_message_id: String,
    /// 1=入(对方发来) / 2=出(自己发出)
    message_direction: i32,
    /// 1=文本 / 2=图片
    message_type: i32,
    content_text: String,
    /// 1=已发送 / 3=已读
    send_status: i32,
    /// `yyyy-MM-dd HH:mm:ss`
    message_time: String,
    sort_key: String,
    attachments: Vec<MockHistoryAttachment>,
    /// 记录最后修改时间 `yyyy-MM-dd HH:mm:ss`
    gmt_modified_time: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FetchMessageHistoryResp {
    records: Vec<MockHistoryMessage>,
    size: u32,
    has_more: bool,
    next_cursor: String,
    /// 服务端不维护时 -1
    total: i64,
    current: i32,
    pages: i32,
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
    // 默认 30 条样例:覆盖更多城市与角色,体现分页/筛选/排序在真实数据量下的体感。
    // 末 3 条 `disabled-*` enabled=false,便于过滤验证。
    const DEFAULT_ACCOUNTS: &str = "\
        wa-bj-zhe,wa-sz-ling,wa-cd-zhou,wa-gz-bei,wa-hz-mei,wa-nj-fei,\
        wa-sh-yan,wa-wh-tao,wa-cq-xin,wa-xa-yu,wa-fz-rui,wa-xm-hai,\
        wa-tj-jin,wa-su-yan,wa-ha-rong,wa-ks-xin,wa-zz-bei,wa-cs-xiang,\
        wa-nb-yue,wa-qd-lu,wa-dl-bo,wa-ty-shan,wa-kun-chun,wa-gy-qian,\
        wa-nn-yong,wa-hk-gang,wa-jn-quan,wa-disabled-1,wa-disabled-2,wa-disabled-3";
    const DISPLAY_NAMES: &[&str] = &[
        // 启用账号(27 条):城市·角色
        "北京客服·阿哲",
        "深圳销售·阿玲",
        "成都客服·小周",
        "广州企微·小贝",
        "杭州企微·小美",
        "南京企微·阿菲",
        "上海售前·彦",
        "武汉客服·陶",
        "重庆售前·欣",
        "西安客服·豫",
        "福州销售·阿瑞",
        "厦门售后·海",
        "天津客服·津",
        "苏州企微·岩",
        "哈尔滨客服·荣",
        "昆山销售·新",
        "郑州企微·北",
        "长沙售前·湘",
        "宁波销售·岳",
        "青岛企微·鲁",
        "大连客服·渤",
        "太原企微·山",
        "昆明销售·春",
        "贵阳客服·黔",
        "南宁企微·勇",
        "香港客服·港",
        "济南客服·泉",
        // 停用账号(3 条)
        "停用账号·测试1",
        "停用账号·测试2",
        "停用账号·测试3",
    ];
    let accounts: Vec<MockAccount> = std::env::var("MOCK_ACCOUNTS")
        .unwrap_or_else(|_| DEFAULT_ACCOUNTS.to_string())
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .enumerate()
        .map(|(i, id)| MockAccount {
            wecom_account_id: id.clone(),
            display_name: DISPLAY_NAMES
                .get(i)
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("Mock 企微账号 {}", i + 1)),
            // 最后一条停用,演示 enabled 过滤
            enabled: !id.contains("disabled"),
        })
        .collect();

    let friends_per_account: usize = std::env::var("MOCK_FRIENDS_PER_ACCOUNT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(30);

    let state = Arc::new(AppState {
        oauth_client_id,
        oauth_client_secret,
        token,
        user_id,
        nick_name,
        accounts,
        friends_per_account,
    });

    let app = Router::new()
        .route("/account-app/oauth2/token", post(oauth2_token))
        .route(
            "/wechat-business-app/rpc/v1/wecomAggregate/connection/verifyToken",
            post(verify_token),
        )
        .route("/auth/logout", post(logout))
        .route(
            "/wechat-business-app/wecom-cs/v1/wecomAggregate/account/listMine",
            get(list_mine),
        )
        .route(
            "/wechat-business-app/wecom-cs/v1/wecomAggregate/account/listFriends",
            post(list_friends),
        )
        .route(
            "/wechat-business-app/wecom-cs/v1/wecomAggregate/session/recentFriends",
            post(list_recent_friends),
        )
        .route("/v1/send", post(send))
        .route("/v1/recall", post(recall))
        .route("/v1/ack_read", post(ack_read))
        .route(
            "/wechat-business-app/wecom-cs/v1/wecomAggregate/message/history",
            post(fetch_message_history),
        )
        .route(
            "/wechat-business-app/wecom-cs/v1/wecomAggregate/message/send",
            post(send_message),
        )
        .route(
            "/wechat-business-app/wecom-cs/v1/wecomAggregate/session/markRead",
            post(mark_read),
        )
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
    println!(
        "[mock-downstream] friends_per_account={}",
        state.friends_per_account
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

    // 4. 返 JddTokenVO(envelope 包络)
    let now = now_local_yyyy_mm_dd_hh_mm_ss();
    let exp = now_local_yyyy_mm_dd_hh_mm_ss_offset(12 * 3600); // +12h
    envelope_ok(JddTokenVO {
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

// ─── verifyToken(Bearer + {} body)──────────────────────────────────────

async fn verify_token(State(state): State<Arc<AppState>>, headers: HeaderMap) -> impl IntoResponse {
    let bearer = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "));
    if bearer.is_none() {
        return (StatusCode::UNAUTHORIZED, "missing Bearer").into_response();
    }
    // mock 接受任意 token,返固定 employeeId(relay 据此当连接身份)
    envelope_ok(VerifyTokenResp {
        employee_id: state.user_id,
        username: String::new(),
        nick_name: state.nick_name.clone(),
        mobile: String::new(),
        channel: String::new(),
    })
    .into_response()
}

// ─── /auth/logout(Bearer + 空 body)─────────────────────────────────────

async fn logout(headers: HeaderMap) -> impl IntoResponse {
    if !has_bearer(&headers) {
        return (StatusCode::UNAUTHORIZED, "missing Bearer").into_response();
    }
    envelope_ok(serde_json::Value::Null).into_response()
}

// ─── listMine(GET,Bearer + ?enabled=true|false)──────────────────────────

#[derive(serde::Deserialize, Default)]
struct ListMineQuery {
    enabled: Option<bool>,
}

async fn list_mine(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<ListMineQuery>,
) -> impl IntoResponse {
    if !has_bearer(&headers) {
        return (StatusCode::UNAUTHORIZED, "missing Bearer").into_response();
    }
    let items: Vec<ListMineItem> = state
        .accounts
        .iter()
        .filter(|a| q.enabled.map_or(true, |want| a.enabled == want))
        .map(|a| ListMineItem {
            wecom_account_id: a.wecom_account_id.clone(),
            wecom_name: a.display_name.clone(),
            wecom_account: format!("mock_{}", a.wecom_account_id),
            wecom_alias: format!("{}_alias", a.wecom_account_id),
            wecom_avatar: format!("https://example.com/avatar/{}.png", a.wecom_account_id),
            wecom_status: if a.enabled { 1 } else { 0 },
            gender: 1,
            position: "工程师".into(),
        })
        .collect();
    envelope_ok(items).into_response()
}

// ─── listFriends(POST,Bearer + JSON body)──────────────────────────────────

async fn list_friends(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<ListFriendsReq>,
) -> impl IntoResponse {
    if !has_bearer(&headers) {
        return (StatusCode::UNAUTHORIZED, "missing Bearer").into_response();
    }
    if req.wecom_account_ids.is_empty() {
        return (StatusCode::BAD_REQUEST, "wecomAccountIds required").into_response();
    }
    let size = req.size.clamp(1, 100) as usize;

    // 已知 mock 账号集合;请求里不存在的账号 ID 静默忽略(契约上不返错,空集合即可)
    let known: std::collections::HashSet<&str> = state
        .accounts
        .iter()
        .map(|a| a.wecom_account_id.as_str())
        .collect();
    let mut all: Vec<MockFriend> = req
        .wecom_account_ids
        .iter()
        .filter(|id| known.contains(id.as_str()))
        .flat_map(|id| generate_friends(id, state.friends_per_account))
        .collect();

    // 服务端筛选:externalId 统一模糊匹配名称/手机号;时间区间字符串比较(yyyy-MM-dd HH:mm:ss 可比)
    if let Some(q) = req.external_id.as_deref().filter(|s| !s.is_empty()) {
        all.retain(|f| f.external_name.contains(q) || f.external_mobile.contains(q));
    }
    if let Some(start) = req.add_start_time.as_deref().filter(|s| !s.is_empty()) {
        all.retain(|f| f.add_time.as_str() >= start);
    }
    if let Some(end) = req.add_end_time.as_deref().filter(|s| !s.is_empty()) {
        all.retain(|f| f.add_time.as_str() <= end);
    }

    // 单 cursor 跨账号 keyset:不可变排序键 (add_time DESC, external_user_id DESC)。
    all.sort_by(|a, b| {
        b.add_time
            .cmp(&a.add_time)
            .then_with(|| b.external_user_id.cmp(&a.external_user_id))
    });

    // cursor 解出上轮末行的 (add_time, external_user_id),保留严格更"小"(更靠后)的行。
    if let Some((c_time, c_uid)) = decode_friend_cursor(&req.cursor) {
        all.retain(|f| f.add_time < c_time || (f.add_time == c_time && f.external_user_id < c_uid));
    }

    let has_more = all.len() > size;
    all.truncate(size);
    let next_cursor = if has_more {
        all.last()
            .map(|f| encode_friend_cursor(&f.add_time, &f.external_user_id))
            .unwrap_or_default()
    } else {
        String::new()
    };

    envelope_ok(ListFriendsResp {
        records: all,
        has_more,
        next_cursor,
    })
    .into_response()
}

/// keyset cursor 编码:base64(`add_time \u{1} external_user_id`),模拟生产不透明 cursor。
fn encode_friend_cursor(add_time: &str, external_user_id: &str) -> String {
    base64_encode(format!("{add_time}\u{1}{external_user_id}"))
}

/// 解码 keyset cursor;空串或格式不符返 None(当首页处理)。
fn decode_friend_cursor(cursor: &str) -> Option<(String, String)> {
    if cursor.is_empty() {
        return None;
    }
    let raw = base64_decode(cursor)?;
    let s = String::from_utf8(raw).ok()?;
    let (add_time, uid) = s.split_once('\u{1}')?;
    Some((add_time.to_string(), uid.to_string()))
}

/// 按 `(account_id, i)` 确定性派生一个 friend。同一 (account, i) 永远得同一份数据,
/// 方便联调时 UI 显示稳定。复杂分支用 i 取模触发各类型/性别/渠道。
fn generate_friends(account_id: &str, count: usize) -> Vec<MockFriend> {
    const SURNAMES: &[&str] = &[
        "张", "李", "王", "刘", "陈", "杨", "黄", "赵", "周", "吴", "徐", "孙", "胡", "朱", "高",
        "林",
    ];
    const GIVEN_NAMES: &[&str] = &[
        "伟", "芳", "娜", "敏", "静", "强", "磊", "军", "洋", "勇", "艳", "杰", "娟", "涛", "明",
        "超",
    ];
    const COMPANY_PREFIXES: &[&str] = &[
        "蓝海", "云启", "智联", "瀚海", "星辰", "光合", "前沿", "本源", "格物", "致远",
    ];
    const POSITIONS: &[&str] = &[
        "产品经理",
        "销售经理",
        "客户成功",
        "采购主管",
        "运营专员",
        "技术负责人",
    ];
    const CHANNELS_NICKS: &[&str] = &["小张视频号", "云上漫谈", "蓝海笔记", "致远 Vlog"];

    (0..count)
        .map(|i| {
            let seed = mock_hash(account_id, i);
            let surname = SURNAMES[(seed % SURNAMES.len() as u64) as usize];
            let given = GIVEN_NAMES[((seed >> 8) % GIVEN_NAMES.len() as u64) as usize];
            let company = COMPANY_PREFIXES[((seed >> 16) % COMPANY_PREFIXES.len() as u64) as usize];
            let position = POSITIONS[((seed >> 24) % POSITIONS.len() as u64) as usize];

            let external_type = (i % 2 + 1) as i32; // 1=微信 2=企微
            let external_gender = (i % 3) as i32; // 0/1/2
            let add_way = (i % 8 + 1) as i32; // 1..=8

            // 加好友时间:从 2025-01-01 起每天 1 个,带 hash 派生分钟,确保排序稳定
            let day_offset = (i as i64) % 365;
            let minute = ((seed >> 32) % (12 * 60)) as i64 + 9 * 60; // 9:00 ~ 21:00 之间
            let add_time = format_yyyy_mm_dd_hh_mm_ss_from_base(2025, 1, 1, day_offset, minute);

            // 模拟脱敏后的手机号:138****<4 位数字>
            let phone_tail = (seed >> 40) % 10_000;
            let mobile = format!("138****{:04}", phone_tail);

            // 视频号来源:每 5 个有 1 个
            let from_channels = i % 5 == 0;

            MockFriend {
                wecom_account_id: account_id.to_string(),
                external_user_id: format!("wo-{account_id}-{i:03}"),
                external_name: format!("{surname}{given}"),
                external_position: position.to_string(),
                external_avatar: format!("https://example.com/avatar/{}/{}.png", account_id, i),
                external_corp_name: format!("{company}科技"),
                external_corp_full_name: format!("{company}科技有限公司"),
                external_type,
                external_gender,
                external_mobile: mobile,
                follow_remark: if i % 4 == 0 {
                    "重点跟进".into()
                } else {
                    String::new()
                },
                follow_description: if i % 7 == 0 {
                    "长期合作客户".into()
                } else {
                    String::new()
                },
                remark_corp_name: format!("{company}(备注)"),
                add_time,
                add_way,
                follow_state: format!("channel_state_{:03}", (i % 5) + 1),
                wechat_channels_nickname: if from_channels {
                    CHANNELS_NICKS[(seed >> 48) as usize % CHANNELS_NICKS.len()].to_string()
                } else {
                    String::new()
                },
                wechat_channels_source: if from_channels { 2 } else { 0 },
                last_sync_time: now_local_yyyy_mm_dd_hh_mm_ss(),
                sync_status: 1,
            }
        })
        .collect()
}

// ─── listRecentFriends(POST,Bearer + JSON body)─────────────────────────────

/// 接待列表 handler。从 `generate_friends` 派生会话,加上消息摘要/时间/未读等字段;
/// 按 lastMessageTime 倒序;cursor = "offset" 简易整数编码(对联调够用)。
async fn list_recent_friends(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<ListRecentFriendsReq>,
) -> impl IntoResponse {
    if !has_bearer(&headers) {
        return (StatusCode::UNAUTHORIZED, "missing Bearer").into_response();
    }
    let size = req.size.max(1).min(100);
    let offset: usize = req.cursor.parse().unwrap_or(0);

    // 派生 mock 会话池:每个启用账号取前 N 条 friend 当会话(N=8 给 27 启用账号即 216 条)
    const SESSIONS_PER_ACCOUNT: usize = 8;
    let mut all: Vec<MockRecentFriend> = state
        .accounts
        .iter()
        .filter(|a| a.enabled)
        .filter(|a| req.wecom_account_id.is_empty() || a.wecom_account_id == req.wecom_account_id)
        .flat_map(|a| generate_recent_sessions(a, SESSIONS_PER_ACCOUNT))
        .collect();

    // 服务端筛选
    if !req.external_name.is_empty() {
        all.retain(|r| r.external_name.contains(&req.external_name));
    }
    if !req.external_mobile.is_empty() {
        all.retain(|r| r.external_mobile.contains(&req.external_mobile));
    }
    if req.only_unread {
        all.retain(|r| r.has_unread);
    }

    // 按 lastMessageTime 倒序(ISO 8601 字符串比较即可)
    all.sort_by(|a, b| b.last_message_time.cmp(&a.last_message_time));

    let total = all.len();
    let end = (offset + size as usize).min(total);
    let records: Vec<MockRecentFriend> = if offset >= total {
        Vec::new()
    } else {
        all[offset..end].to_vec()
    };
    let has_more = end < total;
    let next_cursor = if has_more {
        end.to_string()
    } else {
        String::new()
    };

    envelope_ok(ListRecentFriendsResp {
        size: records.len() as u32,
        has_more,
        next_cursor,
        records,
    })
    .into_response()
}

/// 从 generate_friends 池前 N 条派生 recent sessions。
/// 消息时间在最近 30 天内分散,unread / direction / summary 用 seed 确定性派生。
fn generate_recent_sessions(account: &MockAccount, count: usize) -> Vec<MockRecentFriend> {
    const SUMMARIES: &[&str] = &[
        "您好,请问还有库存吗?",
        "明天上午方便约个时间吗?",
        "[图片]",
        "已收到合同,我看一下",
        "好的,辛苦了",
        "麻烦发一下报价",
        "周五下午有空对接",
        "已下单,谢谢",
        "我这边再确认下",
        "可以,稍等",
    ];
    let friends = generate_friends(&account.wecom_account_id, count);
    let now_secs = now_ms() / 1000;
    friends
        .into_iter()
        .enumerate()
        .map(|(i, f)| {
            let seed = mock_hash(&account.wecom_account_id, i + 7919);
            // 最近 30 天内分散
            let minutes_ago = (seed % (30 * 24 * 60)) as i64;
            let msg_secs = now_secs - minutes_ago * 60;
            let (y, mo, d, h, mi, s) = ymdhms_from_unix(msg_secs);
            let last_message_time =
                format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, mo, d, h, mi, s);
            // 未读 0-4 条,1 在 ~ 60% 概率没未读
            let unread_raw = ((seed >> 8) % 10) as i64;
            let unread = if unread_raw < 6 { 0 } else { unread_raw - 5 };
            let summary = SUMMARIES[((seed >> 16) as usize) % SUMMARIES.len()];
            // 1=入 2=出,均匀分布
            let direction = ((seed >> 24) % 2) as i32 + 1;
            // 文本=1, 图片=2;每 5 条 1 张图
            let message_type = if i % 5 == 0 { 2 } else { 1 };

            MockRecentFriend {
                conversation_id: format!("cv-{}-{:03}", account.wecom_account_id, i),
                wecom_account_id: account.wecom_account_id.clone(),
                wecom_name: account.display_name.clone(),
                wecom_account: format!("mock_{}", account.wecom_account_id),
                wecom_alias: account.display_name.clone(),
                external_user_id: f.external_user_id,
                external_name: f.external_name,
                external_avatar: f.external_avatar,
                external_mobile: f.external_mobile,
                last_local_message_id: format!("lm-{}-{:03}", account.wecom_account_id, i),
                last_message_type: message_type,
                last_message_direction: direction,
                last_send_status: 3, // 已读
                last_message_summary: summary.to_string(),
                last_message_time,
                unread_count: unread,
                has_unread: unread > 0,
            }
        })
        .collect()
}

/// 简易 FNV-1a 64bit hash,用于 mock 数据确定性派生(非密码学场景)。
fn mock_hash(account_id: &str, i: usize) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in account_id.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h ^= i as u64;
    h = h.wrapping_mul(0x100000001b3);
    h
}

/// 由基准日期 + 天数 + 分钟数 拼 yyyy-MM-dd HH:mm:ss(本地时区)。
fn format_yyyy_mm_dd_hh_mm_ss_from_base(
    base_year: i32,
    base_month: u32,
    base_day: u32,
    day_offset: i64,
    minute_of_day: i64,
) -> String {
    // 简化:用 unix epoch + 偏移,复用现有 ymdhms_from_unix
    // 2025-01-01 00:00:00 UTC 的 unix 秒:1735689600
    let base_unix = unix_secs_for_date(base_year, base_month, base_day);
    let total = base_unix + day_offset * 86400 + minute_of_day * 60;
    let (y, mo, d, h, mi, s) = ymdhms_from_unix(total);
    format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}", y, mo, d, h, mi, s)
}

/// 给定 YMD 返回 UTC 00:00:00 unix 秒。简单版,只对 1970+ 的常用日期正确。
fn unix_secs_for_date(year: i32, month: u32, day: u32) -> i64 {
    // 反算 days since epoch using Howard Hinnant 公式
    let y: i32 = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u32; // [0, 399]
    let m = month;
    let d = day;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era as i64 * 146097 + doe as i64 - 719468;
    days * 86400
}

// ─── 业务类 ───────────────────────────────────────────────────────────────

async fn send(headers: HeaderMap, body: Bytes) -> impl IntoResponse {
    if !has_bearer(&headers) {
        return (StatusCode::UNAUTHORIZED, "missing Bearer").into_response();
    }
    let _ = body; // raw body 已被 dump 打印,不再 typed-parse
    envelope_ok(SendResp {
        server_msg_id: format!("sm-mock-{}", uuid::Uuid::new_v4().simple()),
        sent_at_ms: now_ms(),
    })
    .into_response()
}

async fn send_message(headers: HeaderMap, body: Bytes) -> impl IntoResponse {
    if !has_bearer(&headers) {
        return (StatusCode::UNAUTHORIZED, "missing Bearer").into_response();
    }
    let _ = body; // raw body 已被 dump 打印,不再 typed-parse
    envelope_ok(SendMessageResp {
        local_message_id: format!("lm-mock-{}", uuid::Uuid::new_v4().simple()),
        send_status: 2,
        message_time: now_local_yyyy_mm_dd_hh_mm_ss(),
    })
    .into_response()
}

async fn recall(headers: HeaderMap, body: Bytes) -> impl IntoResponse {
    if !has_bearer(&headers) {
        return (StatusCode::UNAUTHORIZED, "missing Bearer").into_response();
    }
    let _ = body;
    envelope_ok(RecallResp {
        recalled_at_ms: now_ms(),
    })
    .into_response()
}

async fn ack_read(headers: HeaderMap, body: Bytes) -> impl IntoResponse {
    if !has_bearer(&headers) {
        return (StatusCode::UNAUTHORIZED, "missing Bearer").into_response();
    }
    let _ = body;
    envelope_ok(AckReadResp {
        acked_at_ms: now_ms(),
    })
    .into_response()
}

/// session/markRead:点开有未读的会话时调用,恒返成功(本地未读由后端清零)。
async fn mark_read(headers: HeaderMap, body: Bytes) -> impl IntoResponse {
    if !has_bearer(&headers) {
        return (StatusCode::UNAUTHORIZED, "missing Bearer").into_response();
    }
    let _ = body;
    envelope_ok(MarkReadResp { success: true }).into_response()
}

// ─── message/history(POST,Bearer + JSON body)────────────────────────────

/// 历史消息池总条数(per conversation)。env `MOCK_HISTORY_MESSAGES` 调整,默认 80。
fn history_pool_size() -> usize {
    std::env::var("MOCK_HISTORY_MESSAGES")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(80)
}

async fn fetch_message_history(
    headers: HeaderMap,
    Json(req): Json<FetchMessageHistoryReq>,
) -> impl IntoResponse {
    if !has_bearer(&headers) {
        return (StatusCode::UNAUTHORIZED, "missing Bearer").into_response();
    }
    if req.wecom_account_id.is_empty() || req.external_user_id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            "wecomAccountId / externalUserId required",
        )
            .into_response();
    }
    let size = req.size.max(1).min(100) as usize;

    // 派生完整消息池 — 同一 (account_id, external_user_id) 永远得同一份消息
    let pool = generate_message_pool(
        &req.wecom_account_id,
        &req.external_user_id,
        history_pool_size(),
    );
    let total_in_pool = pool.len();

    // cursor 编码: "" 首页 / "page_<offset>" 续页
    let offset: usize = if req.cursor.is_empty() {
        0
    } else if let Some(rest) = req.cursor.strip_prefix("page_") {
        rest.parse().unwrap_or(0)
    } else {
        0
    };

    // earlier-only 语义:从 offset 往后取(更早)。pool 按时间倒序(新→旧),
    // offset=0 拿到"最新一批",offset=20 拿到"更早一批"。
    let start = offset;
    let end = (start + size).min(total_in_pool);
    let page_slice = &pool[start..end];

    // 新契约:服务端按 sortKey **升序**(早→晚)返回。page_slice 取自倒序 pool,
    // 这里 reverse 成升序;客户端整页 prepend 到头部即得全局升序。
    let mut records = page_slice.to_vec();
    records.reverse();
    let next_offset = offset + size;
    let has_more = next_offset < total_in_pool;
    let next_cursor = if has_more {
        format!("page_{}", next_offset)
    } else {
        String::new()
    };

    envelope_ok(FetchMessageHistoryResp {
        records,
        size: page_slice.len() as u32,
        has_more,
        next_cursor,
        total: -1,
        current: -1,
        pages: -1,
    })
    .into_response()
}

/// 派生一条会话的完整消息池,**新 → 旧** 排序。
/// 每条消息时间在过去 30 天内某分钟;message_direction / message_type / 文本 由 seed 派生。
fn generate_message_pool(
    wecom_account_id: &str,
    external_user_id: &str,
    count: usize,
) -> Vec<MockHistoryMessage> {
    const TEXTS: &[&str] = &[
        "你好,请问有什么可以帮您?",
        "我想咨询一下订单情况",
        "好的,我看一下",
        "麻烦发一下报价单",
        "已收到,稍等",
        "请问什么时候可以发货?",
        "今天下午,辛苦了",
        "好的,谢谢",
        "请问支持企业转账吗?",
        "可以,我把账号发您",
        "[图片]",
        "明天上午我们再确认一下",
        "OK,期待您的回复",
        "嗯,好的",
        "周五对接进度",
    ];
    let now_secs = now_ms() / 1000;
    let composite_key = format!("{wecom_account_id}|{external_user_id}");
    (0..count)
        .map(|i| {
            let seed = mock_hash(&composite_key, i);
            // 时间分布:30 天内某分钟。i=0 最近,i 越大越早。
            let minutes_ago = (i as i64) * 25 + ((seed % 15) as i64);
            let msg_secs = now_secs - minutes_ago * 60;
            let (y, mo, d, h, mi, s) = ymdhms_from_unix(msg_secs + 8 * 3600); // UTC+8
            let message_time = format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}", y, mo, d, h, mi, s);
            // direction:1=入 2=出,交替为主但偶尔连发
            let message_direction = ((seed >> 8) % 3) as i32; // 0/1/2
            let message_direction = if message_direction == 0 { 1 } else { 2 };
            // 图片消息约 1/8 概率
            let is_image = (seed >> 16) % 8 == 0;
            let message_type = if is_image { 2 } else { 1 };
            let content_text = if is_image {
                "[图片]".to_string()
            } else {
                TEXTS[(seed >> 24) as usize % TEXTS.len()].to_string()
            };
            let attachments = if is_image {
                vec![MockHistoryAttachment {
                    media_id: format!("media_{}_{:03}", wecom_account_id, i),
                    file_name: format!("image_{:03}.jpg", i),
                    file_size: 102_400 + (seed as i64 % 500_000),
                    file_type: "jpg".to_string(),
                }]
            } else {
                Vec::new()
            };
            // sort_key:真实协议格式 {epochMs}:{dir}:{seq}(与网关推送 / message/history 同源)。
            // 旧 "sort_########" 假格式首字符 's',会让真实 {epochMs} 键(首字符数字)错排到顶部;
            // {seq} 用 99999999-i 保证同毫秒内更新的消息(i 更小)排在后面(更靠底)。
            let msg_ms = msg_secs * 1000;
            let sort_key = format!(
                "{:013}:{}:{:020}",
                msg_ms,
                message_direction,
                99_999_999 - i
            );
            // localMessageId 跟 conversation 强相关
            let local_message_id =
                format!("msg_{}_{}_{:03}", wecom_account_id, external_user_id, i);
            MockHistoryMessage {
                local_message_id,
                message_direction,
                message_type,
                content_text,
                send_status: if message_direction == 2 { 3 } else { 1 },
                message_time: message_time.clone(),
                sort_key,
                attachments,
                // mock 无独立修改语义,gmtModifiedTime 与 messageTime 同值即可。
                gmt_modified_time: message_time,
            }
        })
        .collect()
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

fn base64_decode(s: &str) -> Option<Vec<u8>> {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    STANDARD.decode(s).ok()
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
