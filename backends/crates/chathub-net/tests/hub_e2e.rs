//! Plan 3 e2e:HubClient + ConnectionManager 与 stub Relay 的端到端验证。
//! 9 个场景见 spec §9.2。本 task 先打 1 个最小烟雾测试。

mod common;

use chathub_net::{
    build_endpoint, AuthInterceptor, BackoffConfig, ConnectionManager, ConnectionState, HubClient,
    TokenStore,
};
use chathub_state::{KeyringTokenStore, SeqStore, SqlitePool};
use std::sync::Arc;
use std::time::Duration;

use chathub_net::AuthError;
use chathub_proto::v1::{
    AckReadRequest, AckReadResponse, RecallRequest, RecallResponse, SendRequest, SendResponse,
};
use common::stub_relay::{
    start_stub_full, AckReadStubOutcome, RecallStubOutcome, SendStubOutcome, SubscribeOutcome,
};
use tonic::Status;

fn fast_backoff() -> BackoffConfig {
    BackoffConfig {
        base: Duration::from_millis(10),
        factor: 2.0,
        cap: Duration::from_millis(150),
    }
}

async fn make_cm(
    addr: std::net::SocketAddr,
) -> (Arc<ConnectionManager>, Arc<TokenStore>, SeqStore) {
    let url = format!("http://{}", addr);
    let endpoint = build_endpoint(url).expect("endpoint");
    let channel = endpoint.connect_lazy();

    let pool = SqlitePool::in_memory().await.expect("pool");
    let seq_store = SeqStore::new(pool.clone());
    let keyring = KeyringTokenStore::new(common::unique_keyring_service());
    let token_store = Arc::new(TokenStore::new(endpoint, keyring).expect("token store"));

    let interceptor = AuthInterceptor::new(token_store.clone());
    let hub = HubClient::new(channel, interceptor);
    let cm = Arc::new(ConnectionManager::new(
        hub,
        token_store.clone(),
        seq_store.clone(),
        fast_backoff(),
    ));
    (cm, token_store, seq_store)
}

#[tokio::test]
async fn connection_state_initial_is_disconnected() {
    let (addr, _auth_state, _hub_state, _h) = start_stub_full().await;
    let (cm, _ts, _ss) = make_cm(addr).await;
    // 不调 start —— 仅断言 new() 后初始 state 是 Disconnected{None}
    let s = cm.state_subscribe().borrow().clone();
    assert!(
        matches!(s, ConnectionState::Disconnected { last_error: None }),
        "got {:?}",
        s
    );
}

use chathub_proto::v1::message_body;
use chathub_proto::v1::{
    server_event, system_signal, IncomingMsg, MessageBody, ServerEvent, SystemSignal, TextBody,
};
use common::{push_event, wait_for_state};

fn make_incoming(account: &str, seq: i64, text: &str) -> ServerEvent {
    ServerEvent {
        wecom_account_id: account.into(),
        seq,
        body: Some(server_event::Body::Incoming(IncomingMsg {
            conversation_id: "conv-1".into(),
            from_user_id: "peer-1".into(),
            body: Some(MessageBody {
                kind: Some(message_body::Kind::Text(TextBody { text: text.into() })),
                reply_to: None,
                mentions: vec![],
            }),
            sent_at_ms: 1_700_000_000_000,
            server_msg_id: format!("sm-{seq}"),
            remote: None,
        })),
    }
}

/// 让 token_store 内部"看起来已登录" — 直接给一个 fake access token。
/// Plan 3 e2e 不走 Login RPC(那是 Plan 2 测的),直接造 TokenState 注入。
/// seed_refresh_token_for_test 保证 force_refresh 能走到 Auth RPC(keyring 非空)。
async fn force_login(token_store: &Arc<TokenStore>) {
    token_store.seed_user_id("u-test");
    token_store.seed_refresh_token_for_test("rt-e2e-fake");
}

#[tokio::test]
async fn subscribe_success_streams_event() {
    let (addr, _auth, hub_state, _h) = start_stub_full().await;
    let (cm, token_store, _seq_store) = make_cm(addr).await;
    force_login(&token_store).await;

    cm.start().await;

    // 等到 Subscribed
    let mut state_rx = cm.state_subscribe();
    wait_for_state(
        &mut state_rx,
        |s| matches!(s, ConnectionState::Subscribed),
        Duration::from_secs(2),
    )
    .await;

    // 注入一个 IncomingMsg
    let mut event_rx = cm.event_subscribe();
    push_event(&hub_state, make_incoming("wxa1", 100, "hi")).await;

    // 验证 broadcast 收到
    let event = tokio::time::timeout(Duration::from_secs(2), event_rx.recv())
        .await
        .expect("recv timeout")
        .expect("recv ok");
    assert_eq!(event.wecom_account_id, "wxa1");
    assert_eq!(event.seq, 100);

    cm.stop().await;
}

#[tokio::test]
async fn subscribe_unavailable_backoffs_and_reconnects() {
    let (addr, _auth, hub_state, _h) = start_stub_full().await;
    {
        let mut s = hub_state.lock().unwrap();
        s.subscribe_outcome = SubscribeOutcome::RejectOnce(Status::unavailable("relay down"));
    }
    let (cm, token_store, _ss) = make_cm(addr).await;
    force_login(&token_store).await;

    cm.start().await;

    let mut state_rx = cm.state_subscribe();
    // 第一次 Connecting → 收到 Unavailable → Disconnected{Network} → backoff → 第二次 Connecting → Subscribed
    wait_for_state(
        &mut state_rx,
        |s| matches!(s, ConnectionState::Subscribed),
        Duration::from_secs(3),
    )
    .await;

    // 断言 stub 至少被 subscribe 过 2 次(第一次拒,第二次成功)
    let count = hub_state.lock().unwrap().subscribes.len();
    assert!(count >= 2, "expected ≥2 subscribe attempts, got {count}");

    cm.stop().await;
}

#[tokio::test]
async fn subscribe_unauthenticated_triggers_force_refresh() {
    let (addr, auth_state, hub_state, _h) = start_stub_full().await;
    // 让 stub Hub 第一次返回 Unauthenticated,第二次接受
    {
        let mut s = hub_state.lock().unwrap();
        s.subscribe_outcome = SubscribeOutcome::RejectOnce(Status::unauthenticated("expired"));
    }
    let (cm, token_store, _ss) = make_cm(addr).await;
    force_login(&token_store).await;

    cm.start().await;

    let mut state_rx = cm.state_subscribe();
    wait_for_state(
        &mut state_rx,
        |s| matches!(s, ConnectionState::Subscribed),
        Duration::from_secs(3),
    )
    .await;

    // 断言 force_refresh 被触发过(stub Auth.refresh_count >= 1)
    let refresh_count = auth_state.lock().unwrap().refresh_count;
    assert!(
        refresh_count >= 1,
        "expected refresh_count ≥1, got {refresh_count}"
    );

    // 断言 stub 至少被 subscribe 过 2 次(第一次 Unauthenticated,第二次 Stream)
    let sub_count = hub_state.lock().unwrap().subscribes.len();
    assert!(sub_count >= 2, "expected ≥2 subscribes, got {sub_count}");

    cm.stop().await;
}

fn upgrade_required_status() -> Status {
    use chathub_proto::v1::{error_detail, ErrorDetail, UpgradeRequired};
    use prost::Message;
    let detail = ErrorDetail {
        body: Some(error_detail::Body::Upgrade(UpgradeRequired {
            min_client_version: "9.9.9".into(),
            download_url: "https://example.com/dl".into(),
        })),
    };
    Status::with_details(
        tonic::Code::FailedPrecondition,
        "upgrade required",
        detail.encode_to_vec().into(),
    )
}

#[tokio::test]
async fn subscribe_upgrade_required_terminates() {
    use chathub_net::AuthError;

    let (addr, _auth, hub_state, _h) = start_stub_full().await;
    {
        let mut s = hub_state.lock().unwrap();
        s.subscribe_outcome = SubscribeOutcome::RejectAlways(upgrade_required_status());
    }
    let (cm, token_store, _ss) = make_cm(addr).await;
    force_login(&token_store).await;

    cm.start().await;

    let mut state_rx = cm.state_subscribe();
    let final_state = wait_for_state(
        &mut state_rx,
        |s| {
            matches!(
                s,
                ConnectionState::Disconnected {
                    last_error: Some(AuthError::UpgradeRequired { .. })
                }
            )
        },
        Duration::from_secs(3),
    )
    .await;

    match final_state {
        ConnectionState::Disconnected {
            last_error: Some(AuthError::UpgradeRequired { min_version, .. }),
        } => {
            assert_eq!(min_version, "9.9.9");
        }
        other => panic!("wrong final state: {other:?}"),
    }

    // 等 200ms,断言 task 已退出 + state 不再变
    tokio::time::sleep(Duration::from_millis(200)).await;
    // subscribe 计数应 ≤ 3(初始 + 可能内部一次重试),而不是无限重连
    let sub_count = hub_state.lock().unwrap().subscribes.len();
    assert!(
        sub_count <= 3,
        "task should have terminated, got {sub_count} subscribes"
    );

    cm.stop().await;
}

use chathub_net::LoggedOutReason;

#[tokio::test]
async fn logged_out_during_subscribe_terminates_task() {
    let (addr, _auth, hub_state, _h) = start_stub_full().await;
    let (cm, token_store, _ss) = make_cm(addr).await;
    force_login(&token_store).await;

    cm.start().await;

    // 等到 Subscribed
    let mut state_rx = cm.state_subscribe();
    wait_for_state(
        &mut state_rx,
        |s| matches!(s, ConnectionState::Subscribed),
        Duration::from_secs(2),
    )
    .await;

    // 主动 emit LoggedOut
    token_store._emit_logged_out_for_test(LoggedOutReason::RefreshFailed);

    // 等到 Disconnected{None}
    wait_for_state(
        &mut state_rx,
        |s| matches!(s, ConnectionState::Disconnected { last_error: None }),
        Duration::from_secs(2),
    )
    .await;

    // sleep 200ms 验证 task 不再重连
    tokio::time::sleep(Duration::from_millis(200)).await;
    let sub_count = hub_state.lock().unwrap().subscribes.len();
    // 仅一次 subscribe(LoggedOut 后 task 退出,不应重连)
    assert_eq!(sub_count, 1, "task should not reconnect after LoggedOut");

    cm.stop().await;
}

#[tokio::test]
async fn subscribe_resumes_with_since_seqs() {
    let (addr, _auth, hub_state, _h) = start_stub_full().await;
    let (cm, token_store, _ss) = make_cm(addr).await;
    force_login(&token_store).await;

    cm.start().await;

    let mut state_rx = cm.state_subscribe();
    wait_for_state(
        &mut state_rx,
        |s| matches!(s, ConnectionState::Subscribed),
        Duration::from_secs(2),
    )
    .await;

    // 推一个 event(seq=10),让 SeqStore 持久化
    let mut event_rx = cm.event_subscribe();
    push_event(&hub_state, make_incoming("wxa1", 10, "first")).await;
    let _ = tokio::time::timeout(Duration::from_secs(1), event_rx.recv())
        .await
        .expect("recv timeout")
        .expect("recv ok");

    // 给 SQLite 一点时间持久化(亚毫秒级,但稳一些)
    tokio::time::sleep(Duration::from_millis(50)).await;

    // 停 → 启,断言第二次 subscribe 收到 since_seqs={"wxa1":10}
    // stop().await 已等 task 真停(abort + JoinHandle::await),start 能可靠新建
    cm.stop().await;
    cm.start().await;

    // 等到第二次 Subscribed
    wait_for_state(
        &mut state_rx,
        |s| matches!(s, ConnectionState::Subscribed),
        Duration::from_secs(2),
    )
    .await;

    let subs = hub_state.lock().unwrap().subscribes.clone();
    assert!(
        subs.len() >= 2,
        "expected ≥2 subscribes, got {}",
        subs.len()
    );
    let last = subs.last().expect("at least one");
    assert_eq!(
        last.get("wxa1"),
        Some(&10),
        "since_seqs not resumed correctly: {last:?}"
    );

    cm.stop().await;
}

#[tokio::test]
async fn subscribe_kicked_emits_event_then_terminates() {
    let (addr, _auth, hub_state, _h) = start_stub_full().await;
    let (cm, token_store, _ss) = make_cm(addr).await;
    force_login(&token_store).await;

    cm.start().await;

    let mut state_rx = cm.state_subscribe();
    wait_for_state(
        &mut state_rx,
        |s| matches!(s, ConnectionState::Subscribed),
        Duration::from_secs(2),
    )
    .await;

    let mut event_rx = cm.event_subscribe();

    // 推一个 SystemSignal::KICKED
    let kicked_event = ServerEvent {
        wecom_account_id: "wxa1".into(),
        seq: 999,
        body: Some(server_event::Body::System(SystemSignal {
            kind: system_signal::Kind::Kicked as i32,
            detail: "another device".into(),
        })),
    };
    push_event(&hub_state, kicked_event.clone()).await;

    // 验证 broadcast 收到 KICKED event
    let event = tokio::time::timeout(Duration::from_secs(2), event_rx.recv())
        .await
        .expect("recv timeout")
        .expect("recv ok");
    assert_eq!(event.seq, 999);
    assert!(
        matches!(&event.body, Some(server_event::Body::System(s)) if s.kind == system_signal::Kind::Kicked as i32)
    );

    // 验证 state → Disconnected{None}
    wait_for_state(
        &mut state_rx,
        |s| matches!(s, ConnectionState::Disconnected { last_error: None }),
        Duration::from_secs(2),
    )
    .await;

    // 200ms 后断言不再重连
    tokio::time::sleep(Duration::from_millis(200)).await;
    let sub_count = hub_state.lock().unwrap().subscribes.len();
    assert_eq!(
        sub_count, 1,
        "task should terminate after KICKED, got {sub_count}"
    );

    cm.stop().await;
}

// ============================ e2e #8 + #9: Send unary ============================

fn make_send_req(account: &str, conv: &str, msg_id: &str, text: &str) -> SendRequest {
    SendRequest {
        wecom_account_id: account.into(),
        conversation_id: conv.into(),
        client_msg_id: msg_id.into(),
        body: Some(MessageBody {
            kind: Some(message_body::Kind::Text(TextBody { text: text.into() })),
            reply_to: None,
            mentions: vec![],
        }),
    }
}

#[tokio::test]
async fn send_success_returns_server_msg_id() {
    let (addr, _auth, hub_state, _h) = start_stub_full().await;
    {
        let mut s = hub_state.lock().unwrap();
        s.send_outcome = SendStubOutcome::Ok(SendResponse {
            server_msg_id: "sm-xyz".into(),
            sent_at_ms: 1_700_000_000_000,
        });
    }

    // 直接构造 HubClient — Send 不需要 ConnectionManager
    let url = format!("http://{}", addr);
    let endpoint = build_endpoint(&url).expect("endpoint");
    let channel = endpoint.connect_lazy();
    let keyring = KeyringTokenStore::new(common::unique_keyring_service());
    let token_store = Arc::new(TokenStore::new(endpoint, keyring).expect("ts"));
    // 种好 refresh token 后 force_refresh,令 interceptor 拿到真实 access token
    force_login(&token_store).await;
    token_store.force_refresh().await.expect("force_refresh");
    let interceptor = AuthInterceptor::new(token_store.clone());
    let hub = HubClient::new(channel, interceptor);

    let req = make_send_req("wxa1", "conv-1", "msg-id-uuid-fake", "hello");
    let resp = hub.send(req).await.expect("send ok");

    assert_eq!(resp.server_msg_id, "sm-xyz");
    assert_eq!(resp.sent_at_ms, 1_700_000_000_000);

    // 断言 stub 收到的 client_msg_id 是 "msg-id-uuid-fake"(测试本身写死)
    let sends = hub_state.lock().unwrap().sends.clone();
    assert_eq!(sends.len(), 1);
    assert_eq!(sends[0].client_msg_id, "msg-id-uuid-fake");
    assert_eq!(sends[0].wecom_account_id, "wxa1");
}

#[tokio::test]
async fn send_unavailable_returns_network_error() {
    let (addr, _auth, hub_state, _h) = start_stub_full().await;
    {
        let mut s = hub_state.lock().unwrap();
        s.send_outcome = SendStubOutcome::Status(Status::unavailable("relay down"));
    }

    let url = format!("http://{}", addr);
    let endpoint = build_endpoint(&url).expect("endpoint");
    let channel = endpoint.connect_lazy();
    let keyring = KeyringTokenStore::new(common::unique_keyring_service());
    let token_store = Arc::new(TokenStore::new(endpoint, keyring).expect("ts"));
    // 种好 refresh token 后 force_refresh,令 interceptor 拿到真实 access token
    force_login(&token_store).await;
    token_store.force_refresh().await.expect("force_refresh");
    let interceptor = AuthInterceptor::new(token_store.clone());
    let hub = HubClient::new(channel, interceptor);

    let req = make_send_req("wxa1", "conv-1", "msg-id", "hello");
    let err = hub.send(req).await.expect_err("should fail");

    assert!(matches!(err, AuthError::Network { .. }), "got {err:?}");
}

// ============================ e2e #10 + #11: Recall unary ============================

/// Plan 4 helper:不经 ConnectionManager,直接造 HubClient(unary RPC 路径)
async fn make_hub_only(addr: std::net::SocketAddr) -> HubClient {
    let url = format!("http://{}", addr);
    let endpoint = build_endpoint(&url).expect("endpoint");
    let channel = endpoint.connect_lazy();
    let keyring = KeyringTokenStore::new(common::unique_keyring_service());
    let token_store = Arc::new(TokenStore::new(endpoint, keyring).expect("ts"));
    force_login(&token_store).await;
    token_store.force_refresh().await.expect("force_refresh");
    let interceptor = AuthInterceptor::new(token_store.clone());
    HubClient::new(channel, interceptor)
}

#[tokio::test]
async fn recall_success_returns_recalled_at_ms() {
    let (addr, _auth, hub_state, _h) = start_stub_full().await;
    {
        let mut s = hub_state.lock().unwrap();
        s.recall_outcome = RecallStubOutcome::Ok(RecallResponse {
            recalled_at_ms: 1_700_000_000_000,
        });
    }
    let hub = make_hub_only(addr).await;

    let resp = hub
        .recall(RecallRequest {
            wecom_account_id: "wxa1".into(),
            conversation_id: "conv-1".into(),
            server_msg_id: "sm-1".into(),
        })
        .await
        .expect("recall ok");

    assert_eq!(resp.recalled_at_ms, 1_700_000_000_000);

    let recalls = hub_state.lock().unwrap().recalls.clone();
    assert_eq!(recalls.len(), 1);
    assert_eq!(recalls[0].server_msg_id, "sm-1");
    assert_eq!(recalls[0].wecom_account_id, "wxa1");
}

#[tokio::test]
async fn recall_permission_denied_returns_account_disabled() {
    let (addr, _auth, hub_state, _h) = start_stub_full().await;
    {
        let mut s = hub_state.lock().unwrap();
        s.recall_outcome =
            RecallStubOutcome::Status(Status::permission_denied("no recall permission"));
    }
    let hub = make_hub_only(addr).await;

    let err = hub
        .recall(RecallRequest {
            wecom_account_id: "wxa1".into(),
            conversation_id: "conv-1".into(),
            server_msg_id: "sm-1".into(),
        })
        .await
        .expect_err("should fail");

    match err {
        AuthError::AccountDisabled { message } => {
            assert!(message.contains("no recall permission"), "got {message}");
        }
        other => panic!("wrong variant: {other:?}"),
    }
}

// ============================ e2e #12: AckRead ============================

#[tokio::test]
async fn ack_read_success_records_last_read_msg() {
    let (addr, _auth, hub_state, _h) = start_stub_full().await;
    {
        let mut s = hub_state.lock().unwrap();
        s.ack_read_outcome = AckReadStubOutcome::Ok(AckReadResponse {
            acked_at_ms: 1_700_000_000_500,
        });
    }
    let hub = make_hub_only(addr).await;

    let resp = hub
        .ack_read(AckReadRequest {
            wecom_account_id: "wxa1".into(),
            conversation_id: "conv-1".into(),
            last_read_server_msg_id: "sm-50".into(),
        })
        .await
        .expect("ack_read ok");

    assert_eq!(resp.acked_at_ms, 1_700_000_000_500);

    let acks = hub_state.lock().unwrap().ack_reads.clone();
    assert_eq!(acks.len(), 1);
    assert_eq!(acks[0].last_read_server_msg_id, "sm-50");
    assert_eq!(acks[0].conversation_id, "conv-1");
}
