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

// ─── listFriends 请求/响应(POST,20 字段 + 分页)────────────────────────────

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct ListFriendsReq {
    wecom_account_ids: Vec<String>,
    current: u32,
    size: u32,
    #[serde(default)]
    external_name: Option<String>,
    #[serde(default)]
    external_mobile: Option<String>,
    #[serde(default)]
    add_start_time: Option<String>,
    #[serde(default)]
    add_end_time: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct MockFriend {
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
    total: u64,
    current: u32,
    size: u32,
    pages: u32,
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
    let size = req.size.max(1);
    let current = req.current.max(1);

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

    // 服务端筛选:子串匹配 + 时间区间(字符串比较即可,因格式 yyyy-MM-dd HH:mm:ss 可比)
    if let Some(name) = req.external_name.as_deref().filter(|s| !s.is_empty()) {
        all.retain(|f| f.external_name.contains(name));
    }
    if let Some(mobile) = req.external_mobile.as_deref().filter(|s| !s.is_empty()) {
        all.retain(|f| f.external_mobile.contains(mobile));
    }
    if let Some(start) = req.add_start_time.as_deref().filter(|s| !s.is_empty()) {
        all.retain(|f| f.add_time.as_str() >= start);
    }
    if let Some(end) = req.add_end_time.as_deref().filter(|s| !s.is_empty()) {
        all.retain(|f| f.add_time.as_str() <= end);
    }

    let total = all.len() as u64;
    let pages = total.div_ceil(size as u64).max(1) as u32;
    let offset = ((current.saturating_sub(1)) as u64).saturating_mul(size as u64) as usize;
    let end = (offset + size as usize).min(all.len());
    let records: Vec<MockFriend> = if offset >= all.len() {
        Vec::new()
    } else {
        all[offset..end].to_vec()
    };

    envelope_ok(ListFriendsResp {
        records,
        total,
        current,
        size,
        pages,
    })
    .into_response()
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

async fn fetch_history(headers: HeaderMap, body: Bytes) -> impl IntoResponse {
    if !has_bearer(&headers) {
        return (StatusCode::UNAUTHORIZED, "missing Bearer").into_response();
    }
    let _ = body;
    envelope_ok(FetchHistoryResp {
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
