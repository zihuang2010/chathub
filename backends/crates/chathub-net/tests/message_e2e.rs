//! 对接回复消息流程 e2e:ConnectionManager ↔ stub_relay。
//! 注入 MESSAGE_UPSERT 帧 → 断言气泡落进 MessagesStore(热会话直接 upsert 路径)。

mod common;

use chathub_net::change_notice::ChangeNotice;
use chathub_net::hub::ConnectionState;
use chathub_net::{
    AuthInterceptor, BackoffConfig, ConnectionManager, HubClient, MessageEventApplier, MessageSync,
    TokenStore,
};
use chathub_proto::v1::{server_event::Body, ForwardResponse, PushBatchOut, ServerEvent};
use chathub_state::{LocalTokenStore, MessageWindow, MessagesStore, NotifySeqStore, SqlitePool};
use common::stub_relay::{start_stub_full, ForwardStubOutcome};
use common::{push_event, wait_for_state};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast;

fn message_upsert_event(conv: &str) -> serde_json::Value {
    serde_json::json!({
        "eventType": "MESSAGE_UPSERT",
        "eventReason": "CUSTOMER_MESSAGE_RECEIVED",
        "conversationId": conv,
        "wecomAccountId": "wa-1",
        "externalUserId": "ext-1",
        "message": {
            "localMessageId": "LM_E2E",
            "messageDirection": 2,
            "messageType": 1,
            "sendStatus": 3,
            // sortKey 格式: {epochMs}:{方向}:{平台序号补零}:{localMessageId};
            // 2=客户/接收方。
            "sortKey": "1770000000000:2:00000000000000009001:LM_E2E",
            "messageTime": "2026-05-14 10:30:00",
            "contentText": "在吗",
            "contentSummary": "在吗",
            "attachments": []
        }
    })
}

#[tokio::test]
async fn message_upsert_lands_bubble_via_connection_manager() {
    let (addr, _auth_state, hub_state, _h) = start_stub_full().await;

    let ep = chathub_net::build_endpoint(format!("http://{addr}")).expect("ep");
    let channel = ep.connect_lazy();
    // SqlitePool::in_memory() uses `:memory:`, which gives each deadpool connection its own
    // independent database. The e2e test runs a background task (ConnectionManager) concurrently
    // with the test body, so the pool may create a second connection with no migrations.
    // Use a temp file instead so all connections share the same schema.
    let db_path = std::env::temp_dir().join(format!("chathub_e2e_{}.db", uuid::Uuid::new_v4()));
    let pool = SqlitePool::open(&db_path).await.unwrap();
    let local = LocalTokenStore::new(pool.clone());
    let token_store = Arc::new(TokenStore::new(ep, local, "dev-1".into()));
    token_store.login("alice", "pwd").await.expect("login");

    let interceptor = AuthInterceptor::new(token_store.clone());
    let hub = HubClient::new(channel, interceptor);

    let messages_store = MessagesStore::new(pool.clone());
    let notify_seq_store = NotifySeqStore::new(pool.clone());
    let (change_tx, mut change_rx) = broadcast::channel::<ChangeNotice>(64);
    let sync = MessageSync::new(messages_store.clone(), hub.clone(), change_tx.clone());
    let message_applier = Arc::new(MessageEventApplier::new(
        messages_store.clone(),
        sync,
        change_tx.clone(),
    ));

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
        Some(message_applier),
        change_tx.clone(),
    ));

    // 预置热会话窗口(employee 42 与推送 batch 对齐)。
    messages_store
        .upsert_window(MessageWindow {
            conversation_id: "c-e2e".into(),
            employee_id: "42".into(),
            wecom_account_id: "wa-1".into(),
            external_user_id: "ext-1".into(),
            newest_sort_key: "0000000000000:1:seed".into(),
            oldest_sort_key: "0000000000000:1:seed".into(),
            older_cursor: "cur".into(),
            has_more_older: true,
            newest_message_time_ms: 1,
            last_accessed_ms: 0,
            reconciled_at_ms: 0,
            updated_at_ms: 0,
        })
        .await
        .unwrap();

    cm.start().await;
    let mut state_rx = cm.state_subscribe();
    wait_for_state(
        &mut state_rx,
        |s| matches!(s, ConnectionState::Subscribed),
        Duration::from_secs(5),
    )
    .await;

    // 注入 MESSAGE_UPSERT 帧。
    let events = serde_json::json!([message_upsert_event("c-e2e")]);
    let pb = PushBatchOut {
        notify_seq: 1,
        client_id: "rh_wxchat".into(),
        employee_id: 42,
        batch_id: "rh_wxchat:42:1".into(),
        batch_time: "2026-05-14 10:30:00".into(),
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

    // 轮询直到气泡出现(applier 异步处理)。
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        let rows = messages_store.list_recent("42", "c-e2e", 10).await.unwrap();
        if let Some(r) = rows.iter().find(|r| r.local_message_id == "LM_E2E") {
            assert_eq!(r.content_text, "在吗");
            assert_eq!(r.message_direction, 1, "2=客户/接收方 → 本地 1(in)");
            assert_eq!(r.sort_key, "1770000000000:2:00000000000000009001:LM_E2E");
            break;
        }
        if std::time::Instant::now() > deadline {
            panic!("bubble did not land within 5s");
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // 等通知:applier 在 upsert 之后才 send,可能晚于 DB 行可见,故用带超时的 recv 轮询。
    let mut saw_notice = false;
    let notice_deadline = std::time::Instant::now() + Duration::from_secs(2);
    while std::time::Instant::now() < notice_deadline {
        match tokio::time::timeout(Duration::from_millis(200), change_rx.recv()).await {
            Ok(Ok(n)) => {
                if matches!(
                    n.topic,
                    chathub_net::change_notice::ChangeTopic::ConversationMessages
                ) && n.scope.conversation_id.as_deref() == Some("c-e2e")
                {
                    saw_notice = true;
                    break;
                }
            }
            // channel 暂时无新消息或发送端关闭,继续等到 deadline。
            Ok(Err(_)) | Err(_) => {}
        }
    }
    assert!(saw_notice, "应发出 ConversationMessages 通知");

    cm.stop().await;

    // Clean up temp file (best-effort; ignore errors on Windows path locks).
    let _ = std::fs::remove_file(&db_path);
    let _ = std::fs::remove_file(db_path.with_extension("db-shm"));
    let _ = std::fs::remove_file(db_path.with_extension("db-wal"));
}

#[tokio::test]
async fn load_older_returns_frontend_local_directions_not_raw_source_directions() {
    let (addr, _auth_state, hub_state, _h) = start_stub_full().await;

    let ep = chathub_net::build_endpoint(format!("http://{addr}")).expect("ep");
    let channel = ep.connect_lazy();
    let db_path = std::env::temp_dir().join(format!("chathub_older_{}.db", uuid::Uuid::new_v4()));
    let pool = SqlitePool::open(&db_path).await.unwrap();
    let local = LocalTokenStore::new(pool.clone());
    let token_store = Arc::new(TokenStore::new(ep, local, "dev-1".into()));
    token_store.login("alice", "pwd").await.expect("login");

    let interceptor = AuthInterceptor::new(token_store);
    let hub = HubClient::new(channel, interceptor);
    let messages_store = MessagesStore::new(pool.clone());
    messages_store
        .upsert_window(MessageWindow {
            conversation_id: "c-older".into(),
            employee_id: "42".into(),
            wecom_account_id: "wa-1".into(),
            external_user_id: "ext-1".into(),
            newest_sort_key: "1770000003000:1:00000000000000000003:newest".into(),
            oldest_sort_key: "1770000003000:1:00000000000000000003:newest".into(),
            older_cursor: "older-cursor".into(),
            has_more_older: true,
            newest_message_time_ms: 1,
            last_accessed_ms: 0,
            reconciled_at_ms: 0,
            updated_at_ms: 0,
        })
        .await
        .unwrap();

    let data = serde_json::json!({
        "records": [
            {
                "localMessageId": "older-in",
                "messageDirection": 2,
                "messageType": 1,
                "contentText": "客户消息",
                "sendStatus": 3,
                "messageTime": "2026-05-30 10:00:01",
                "sortKey": "1770000001000:2:00000000000000000001:older-in",
                "attachments": [],
                "gmtModifiedTime": "2026-05-30 10:00:01"
            },
            {
                "localMessageId": "older-out",
                "messageDirection": 1,
                "messageType": 1,
                "contentText": "发送方消息",
                "sendStatus": 3,
                "messageTime": "2026-05-30 10:00:02",
                "sortKey": "1770000002000:1:00000000000000000002:older-out",
                "attachments": [],
                "gmtModifiedTime": "2026-05-30 10:00:02"
            }
        ],
        "size": 20,
        "hasMore": false,
        "nextCursor": "",
        "total": "-1",
        "current": "-1",
        "pages": "-1"
    });
    let envelope = serde_json::json!({
        "code": 1,
        "serviceCode": "",
        "msg": "成功",
        "data": data
    });
    {
        let mut state = hub_state.lock().unwrap();
        state.forward_outcome = ForwardStubOutcome::Ok(ForwardResponse {
            body_json: serde_json::to_vec(&envelope).unwrap().into(),
            http_status: 200,
        });
    }

    let (change_tx, _change_rx) = broadcast::channel::<ChangeNotice>(64);
    let sync = MessageSync::new(messages_store.clone(), hub, change_tx);

    let result = sync.load_older("c-older", "42", 20).await.unwrap();

    let directions: Vec<_> = result
        .records
        .iter()
        .map(|record| (record.local_message_id.as_str(), record.message_direction))
        .collect();
    assert_eq!(
        directions,
        vec![("older-in", 1), ("older-out", 2)],
        "load_older 返回给前端的新增历史页必须已经是本地 1=in/2=out,不能保留 API 1/2/3 源方向"
    );

    let rows = messages_store
        .list_recent("42", "c-older", 10)
        .await
        .unwrap();
    assert_eq!(
        rows.iter()
            .find(|row| row.local_message_id == "older-in")
            .unwrap()
            .message_direction,
        1
    );
    assert_eq!(
        rows.iter()
            .find(|row| row.local_message_id == "older-out")
            .unwrap()
            .message_direction,
        2
    );

    let _ = std::fs::remove_file(&db_path);
    let _ = std::fs::remove_file(db_path.with_extension("db-shm"));
    let _ = std::fs::remove_file(db_path.with_extension("db-wal"));
}
