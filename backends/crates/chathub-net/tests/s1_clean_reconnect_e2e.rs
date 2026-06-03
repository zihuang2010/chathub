//! S1 e2e:验证"已 Subscribed 的 ConnectionManager 再 stop→start 会强制干净重连"。
//! 修复前(login 直接调 start()):run_loop task 未结束 → start() 静默 return → 不重订阅。
//! 修复后(login 改 stop→start;ConnectionManager::stop 已 abort task):产生第二次 subscribe。

mod common;

use chathub_net::hub::ConnectionState;
use chathub_net::{AuthInterceptor, BackoffConfig, ConnectionManager, HubClient, TokenStore};
use chathub_state::{LocalTokenStore, NotifySeqStore, SqlitePool};
use common::stub_relay::start_stub_full;
use common::wait_for_state;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast;

#[tokio::test]
async fn stop_then_start_forces_clean_resubscribe() {
    let (addr, _auth_state, hub_state, _h) = start_stub_full().await;

    let ep = chathub_net::build_endpoint(format!("http://{addr}")).expect("ep");
    let channel = ep.connect_lazy();
    let db_path = std::env::temp_dir().join(format!("chathub_s1_{}.db", uuid::Uuid::new_v4()));
    let pool = SqlitePool::open(&db_path).await.unwrap();
    let local = LocalTokenStore::new(pool.clone());
    let token_store = Arc::new(TokenStore::new(ep, local, "dev-1".into()));
    token_store.login("alice", "pwd").await.expect("login");

    let interceptor = AuthInterceptor::new(token_store.clone());
    let hub = HubClient::new(channel, interceptor);
    let notify_seq_store = NotifySeqStore::new(pool.clone());
    let (change_tx, _change_rx) = broadcast::channel(64);

    let cm = Arc::new(ConnectionManager::new(
        hub,
        token_store,
        notify_seq_store,
        "dev-1".into(),
        "test".into(),
        BackoffConfig::default(),
        None,
        None,
        None,
        None,
        change_tx,
    ));

    cm.start().await;
    let mut state_rx = cm.state_subscribe();
    wait_for_state(
        &mut state_rx,
        |s| matches!(s, ConnectionState::Subscribed),
        Duration::from_secs(5),
    )
    .await;
    assert_eq!(
        hub_state.lock().unwrap().subscribes.len(),
        1,
        "首次 start 应触发恰好一次 subscribe"
    );

    cm.stop().await;
    cm.start().await;

    wait_for_state(
        &mut state_rx,
        |s| matches!(s, ConnectionState::Subscribed),
        Duration::from_secs(5),
    )
    .await;
    assert_eq!(
        hub_state.lock().unwrap().subscribes.len(),
        2,
        "stop→start 必须触发第二次 subscribe(start() 幂等陷阱已修)"
    );

    cm.stop().await;
    let _ = std::fs::remove_file(&db_path);
    let _ = std::fs::remove_file(db_path.with_extension("db-shm"));
    let _ = std::fs::remove_file(db_path.with_extension("db-wal"));
}
