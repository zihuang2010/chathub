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

use common::stub_relay::{start_stub_full, SubscribeOutcome};
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
use chathub_proto::v1::{server_event, IncomingMsg, MessageBody, ServerEvent, TextBody};
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
