//! 流静默看门狗 e2e:ConnectionManager ↔ stub_relay。
//!
//! 线上现象:relay 把连接从路由表静默摘除(backpressure)/ 360 吞推送帧 / 网络黑洞但 TCP 还活,
//! `stream.message()` 既不返回 Ok 也不返回 Err,run_loop 永久阻塞 → UI 卡"已连接"实则收不到任何帧。
//! 修复:relay 周期下发 HEARTBEAT;客户端"收到过心跳后"武装看门狗(②自协商),`silence_timeout`
//! 内再无任何帧 → 判定流静默死亡 → 静默重连(不打断用户)。
//!
//! 正向:收到心跳 → 武装 → 静默超时 → 重连(stub 收到第 2 次 Subscribe)。
//! 负向:从未收到心跳 → 永不武装 → 长时间静默也不重连(连旧 relay 退化为今日行为)。

mod common;

use chathub_net::change_notice::ChangeNotice;
use chathub_net::hub::ConnectionState;
use chathub_net::{AuthInterceptor, BackoffConfig, ConnectionManager, HubClient, TokenStore};
use chathub_proto::v1::system_signal::Kind;
use chathub_proto::v1::{server_event::Body, ServerEvent, SystemSignal};
use chathub_state::{LocalTokenStore, NotifySeqStore, SqlitePool};
use common::stub_relay::{start_stub_full, StubHubState};
use common::{push_event, wait_for_state};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, watch};

struct Fixture {
    cm: Arc<ConnectionManager>,
    hub_state: Arc<Mutex<StubHubState>>,
    state_rx: watch::Receiver<ConnectionState>,
    _token_store: Arc<TokenStore>,
    db_path: PathBuf,
}

/// 登录 + 组 ConnectionManager(注入小 silence_timeout)+ start + 等到 Subscribed。
async fn setup(silence_timeout: Duration) -> Fixture {
    let (addr, _auth_state, hub_state, _h) = start_stub_full().await;
    let ep = chathub_net::build_endpoint(format!("http://{addr}")).expect("ep");
    let channel = ep.connect_lazy();

    let db_path = std::env::temp_dir().join(format!("chathub_sw_{}.db", uuid::Uuid::new_v4()));
    let pool = SqlitePool::open(&db_path).await.unwrap();
    let local = LocalTokenStore::new(pool.clone());
    let token_store = Arc::new(TokenStore::new(ep, local, "dev-1".into()));
    token_store.login("alice", "pwd").await.expect("login");

    let interceptor = AuthInterceptor::new(token_store.clone());
    let hub = HubClient::new(channel, interceptor);
    let notify_seq_store = NotifySeqStore::new(pool.clone());
    let (change_tx, _change_rx) = broadcast::channel::<ChangeNotice>(64);

    let cm = Arc::new(ConnectionManager::new(
        hub,
        token_store.clone(),
        notify_seq_store,
        "dev-1".into(),
        "test".into(),
        BackoffConfig {
            base: Duration::from_millis(10),
            factor: 2.0,
            cap: Duration::from_millis(50),
            silence_timeout,
        },
        None,
        None,
        None,
        None,
        change_tx.clone(),
    ));

    cm.start().await;
    let mut state_rx = cm.state_subscribe();
    wait_for_state(
        &mut state_rx,
        |s| matches!(s, ConnectionState::Subscribed),
        Duration::from_secs(5),
    )
    .await;

    Fixture {
        cm,
        hub_state,
        state_rx,
        _token_store: token_store,
        db_path,
    }
}

fn cleanup(db_path: &PathBuf) {
    let _ = std::fs::remove_file(db_path);
    let _ = std::fs::remove_file(db_path.with_extension("db-shm"));
    let _ = std::fs::remove_file(db_path.with_extension("db-wal"));
}

fn heartbeat_frame() -> ServerEvent {
    ServerEvent {
        body: Some(Body::System(SystemSignal {
            kind: Kind::Heartbeat as i32,
            detail: String::new(),
        })),
    }
}

fn subscribe_count(hub_state: &Arc<Mutex<StubHubState>>) -> usize {
    hub_state.lock().unwrap().subscribes.len()
}

/// 轮询 subscribe 次数直到 >= want 或超时,返回最终值。
async fn wait_subscribe_count(
    hub_state: &Arc<Mutex<StubHubState>>,
    want: usize,
    timeout: Duration,
) -> usize {
    let deadline = Instant::now() + timeout;
    loop {
        let n = subscribe_count(hub_state);
        if n >= want || Instant::now() >= deadline {
            return n;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn silent_stream_after_heartbeat_triggers_reconnect() {
    let fx = setup(Duration::from_millis(500)).await;
    assert_eq!(subscribe_count(&fx.hub_state), 1, "前置:首次订阅 1 次");

    // 收到一帧心跳 → 武装看门狗。随后保持静默(不再推任何帧)。
    push_event(&fx.hub_state, heartbeat_frame()).await;

    // silence_timeout(500ms)内无帧 → 静默重连 → stub 收到第 2 次 Subscribe。
    let n = wait_subscribe_count(&fx.hub_state, 2, Duration::from_secs(5)).await;
    assert!(
        n >= 2,
        "心跳后静默应触发重连(第 2 次 Subscribe),实际订阅次数={n}"
    );

    // 重连后状态回到 Connecting/Subscribed(非 Rejected 终态):静默重连不打断用户。
    let st = fx.state_rx.borrow().clone();
    assert!(
        !matches!(st, ConnectionState::Rejected { .. }),
        "静默重连不应进入 Rejected 终态,实际={st:?}"
    );

    fx.cm.stop().await;
    cleanup(&fx.db_path);
}

#[tokio::test]
async fn silent_stream_without_heartbeat_does_not_reconnect() {
    let fx = setup(Duration::from_millis(500)).await;
    assert_eq!(subscribe_count(&fx.hub_state), 1, "前置:首次订阅 1 次");

    // 从未收到心跳 → 看门狗不武装。即使静默远超 silence_timeout 也不应重连(②自协商)。
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(
        subscribe_count(&fx.hub_state),
        1,
        "未收到心跳时看门狗不应武装、不应重连"
    );

    fx.cm.stop().await;
    cleanup(&fx.db_path);
}
