//! 会话过期(forward 通道 HTTP 401)失效本地会话的 e2e 回归。
//!
//! 线上现象:业务后台判定会话已过期,relay 转发 send_message 收到 HTTP 401
//! (`{"code":0,"msg":"会话已过期,请重新登录.","serviceCode":"100000001"}`),但客户端仍显示
//! 在线、持续发送失败。根因:forward 通道的 401(token 已失效的权威信号)从未接入登出机制
//! —— 被当普通非 200 outcome 吞成泛化 Internal 错。本测试锁定修复后的行为:forward 遇 401
//! → HubClient 当场 mark_token_invalid(清 token + 广播 TokenInvalid)并返回 Unauthenticated。

mod common;

use chathub_net::{
    AuthError, AuthInterceptor, HubClient, LoggedOutReason, SendMessageRequest, TokenStore,
};
use chathub_proto::v1::ForwardResponse;
use chathub_state::{LocalTokenStore, SqlitePool};
use common::stub_relay::{start_stub_full, ForwardStubOutcome};
use std::sync::Arc;
use std::time::Duration;

/// 业务后台「会话已过期」响应包络(serviceCode 100000001),随 HTTP 401 下发。
fn session_expired_envelope() -> bytes::Bytes {
    bytes::Bytes::from_static(
        r#"{"code":0,"msg":"会话已过期,请重新登录.","serviceCode":"100000001"}"#.as_bytes(),
    )
}

#[tokio::test]
async fn forward_http_401_invalidates_session_and_returns_unauthenticated() {
    let (addr, _auth_state, hub_state, _h) = start_stub_full().await;

    let ep = chathub_net::build_endpoint(format!("http://{addr}")).expect("ep");
    let channel = ep.connect_lazy();

    // 临时文件 DB:后台连接共享同一 schema(见 message_e2e.rs 的 :memory: 注释)。
    let db_path = std::env::temp_dir().join(format!("chathub_401_{}.db", uuid::Uuid::new_v4()));
    let pool = SqlitePool::open(&db_path).await.unwrap();
    let local = LocalTokenStore::new(pool.clone());
    let token_store = Arc::new(TokenStore::new(ep, local, "dev-1".into()));
    token_store.login("alice", "pwd").await.expect("login");
    assert!(token_store.is_logged_in(), "前置:登录后应处于已登录态");

    let interceptor = AuthInterceptor::new(token_store.clone());
    // 关键:生产 setup 同样经 with_token_store 注入,使 forward 401 能失效本地会话。
    let hub = HubClient::new(channel, interceptor).with_token_store(token_store.clone());

    // stub forward 返回 HTTP 401 + 会话过期包络(复刻线上 relay 回包)。
    hub_state.lock().unwrap().forward_outcome = ForwardStubOutcome::Ok(ForwardResponse {
        http_status: 401,
        body_json: session_expired_envelope(),
    });

    // 调用前订阅登出广播(broadcast 只投递订阅之后的消息)。
    let mut logged_out_rx = token_store.logged_out_subscribe();

    let err = hub
        .send_message(SendMessageRequest {
            request_message_id: "req-401".into(),
            wecom_account_id: "wa-1".into(),
            external_user_id: "ext-1".into(),
            message_type: 1,
            content_text: "在吗".into(),
            file_path: None,
            file_name: None,
            file_size: None,
            duration_seconds: None,
        })
        .await
        .expect_err("forward 401 应返回错误");

    // 1) 错误类型:Unauthenticated(而非旧的泛化 Internal)。
    assert!(
        matches!(err, AuthError::Unauthenticated),
        "forward 401 应映射 AuthError::Unauthenticated,实际: {err:?}"
    );

    // 2) 广播了 TokenInvalid —— run_loop 收到后转 Disconnected(在线→离线),
    //    Tauri 桥接 emit auth:logged_out{token-invalid} → 前端回登录页、停止发送。
    let reason = tokio::time::timeout(Duration::from_secs(1), logged_out_rx.recv())
        .await
        .expect("应在 1s 内收到登出广播")
        .expect("登出广播通道不应关闭");
    assert_eq!(reason, LoggedOutReason::TokenInvalid);

    // 3) 本地会话已清除(不会再用死 token 重连/发送)。
    assert!(!token_store.is_logged_in(), "401 后本地会话应已清除");
}
