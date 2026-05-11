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

use common::stub_relay::start_stub_full;

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
