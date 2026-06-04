//! CONNECTION_FORCE_CLOSE(账号被顶下线 / EXCLUSIVE_LOGIN)e2e:ConnectionManager ↔ stub_relay。
//!
//! 线上现象:另一设备登录后,relay 随 batch 下发 CONNECTION_FORCE_CLOSE 事件,紧接着 ack 持续
//! 回 Unauthenticated,但客户端既不处理该事件、也不升级下线 → UI 卡在"在线",ack 每秒失败。
//! 本测试锁定修复后的行为:run_loop 收到该帧 → mark_kicked(清 token + 广播 Kicked)+ 连接置
//! Rejected 终态(停止重连),前端据此切回登录页并提示"账号在其他设备登录"。

mod common;

use chathub_net::change_notice::ChangeNotice;
use chathub_net::hub::ConnectionState;
use chathub_net::{
    AuthInterceptor, BackoffConfig, ConnectionManager, HubClient, LoggedOutReason, TokenStore,
};
use chathub_proto::v1::{server_event::Body, PushBatchOut, ServerEvent};
use chathub_state::{LocalTokenStore, NotifySeqStore, SqlitePool};
use common::stub_relay::start_stub_full;
use common::{push_event, wait_for_state};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast;

#[tokio::test]
async fn force_close_event_kicks_and_rejects_connection() {
    let (addr, _auth_state, hub_state, _h) = start_stub_full().await;

    let ep = chathub_net::build_endpoint(format!("http://{addr}")).expect("ep");
    let channel = ep.connect_lazy();

    // 临时文件 DB:后台 ConnectionManager 与测试体并发,需共享同一 schema(见 message_e2e.rs 注释)。
    let db_path = std::env::temp_dir().join(format!("chathub_fc_{}.db", uuid::Uuid::new_v4()));
    let pool = SqlitePool::open(&db_path).await.unwrap();
    let local = LocalTokenStore::new(pool.clone());
    let token_store = Arc::new(TokenStore::new(ep, local, "dev-1".into()));
    token_store.login("alice", "pwd").await.expect("login");
    assert!(token_store.is_logged_in(), "前置:登录后应已登录");

    let interceptor = AuthInterceptor::new(token_store.clone());
    let hub = HubClient::new(channel, interceptor);
    let notify_seq_store = NotifySeqStore::new(pool.clone());
    let (change_tx, _change_rx) = broadcast::channel::<ChangeNotice>(64);

    // 四个 applier 全 None:force_close 是控制事件,识别不依赖任何业务 applier。
    let cm = Arc::new(ConnectionManager::new(
        hub,
        token_store.clone(),
        notify_seq_store,
        "dev-1".into(),
        "test".into(),
        BackoffConfig::default(),
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

    // 订阅登出广播(broadcast 只投递订阅之后的消息),再推帧。
    let mut logged_out_rx = token_store.logged_out_subscribe();

    // 注入 CONNECTION_FORCE_CLOSE 帧(复刻线上 EXCLUSIVE_LOGIN payload)。
    let events = serde_json::json!([{
        "eventReason": "EXCLUSIVE_LOGIN",
        "eventType": "CONNECTION_FORCE_CLOSE",
        "forceClose": {
            "clearLocalToken": true,
            "closeMode": "IMMEDIATE",
            "closeScope": "EMPLOYEE",
            "reasonCode": "EXCLUSIVE_LOGIN",
            "reasonMessage": "账号已在其他设备登录",
            "reloginRequired": true
        }
    }]);
    let pb = PushBatchOut {
        notify_seq: 517,
        client_id: "rh_wxchat".into(),
        employee_id: 42,
        batch_id: "rh_wxchat:42:517".into(),
        batch_time: "2026-06-04 17:31:45".into(),
        device_id: "dev-1".into(),
        events_json: serde_json::to_vec(&events).unwrap().into(),
    };
    push_event(
        &hub_state,
        ServerEvent {
            body: Some(Body::PushBatch(pb)),
        },
    )
    .await;

    // 1) 连接置 Rejected 终态(透传 reasonCode/reasonMessage),不再重连。
    let st = wait_for_state(
        &mut state_rx,
        |s| matches!(s, ConnectionState::Rejected { .. }),
        Duration::from_secs(5),
    )
    .await;
    match st {
        ConnectionState::Rejected { code, message } => {
            assert_eq!(code, "EXCLUSIVE_LOGIN");
            assert_eq!(message, "账号已在其他设备登录");
        }
        other => panic!("期望 Rejected,实际: {other:?}"),
    }

    // 2) 广播了 Kicked → Tauri 桥接 emit auth:logged_out{kicked} → 前端回登录页并提示。
    let reason = tokio::time::timeout(Duration::from_secs(1), logged_out_rx.recv())
        .await
        .expect("应在 1s 内收到登出广播")
        .expect("登出广播通道不应关闭");
    assert_eq!(reason, LoggedOutReason::Kicked);

    // 3) clearLocalToken=true → 本地会话已清(不会再用死 token 重连)。
    assert!(
        !token_store.is_logged_in(),
        "force_close 后本地会话应已清除"
    );

    cm.stop().await;
    let _ = std::fs::remove_file(&db_path);
    let _ = std::fs::remove_file(db_path.with_extension("db-shm"));
    let _ = std::fs::remove_file(db_path.with_extension("db-wal"));
}
