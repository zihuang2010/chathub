//! RelayHarness — in-process relay fixture(tonic + axum + wiremock + tempdir,Plan 7 简化版)。
//!
//! Relay 是纯隔道;认证委托业务后台 verifyToken。测试用法:
//! ```ignore
//! #[tokio::test(flavor = "multi_thread")]
//! async fn my_test() {
//!     let h = spawn_relay().await;
//!     mount_verify_token(&h.downstream, "tok-A", 42, "dev-A").await;
//!     // ... 用 token "tok-A" 直连 h.grpc_addr 的 HubSvc
//! }
//! ```

#![allow(dead_code)]

use chathub_proto::v1::auth_server::AuthServer;
use chathub_proto::v1::hub_server::HubServer;
use chathub_relay::auth_service::AuthSvc;
use chathub_relay::downstream::DownstreamClient;
use chathub_relay::hub_service::{HubSvc, ProtocolInterceptor, TokenAuthenticator};
use chathub_relay::push::{self, PushState};
use chathub_relay::router::Router;
use chathub_relay::storage::events::EventLog;
use chathub_relay::storage::Storage;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use tokio_stream::wrappers::TcpListenerStream;
use tonic::transport::Server;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

pub struct RelayHarness {
    pub grpc_addr: SocketAddr,
    pub push_addr: SocketAddr,
    pub push_url: String,
    pub push_secret: String,
    pub downstream: MockServer,
    pub events_log: EventLog,
    pub router: Arc<Router>,
    _db: tempfile::TempDir,
    _tonic: JoinHandle<()>,
    _axum: JoinHandle<()>,
}

/// notify/pull 补偿拉取的测试配置(对应 HubSvc 的 4 个 knob)。
pub struct PullCfg {
    pub enabled: bool,
    pub page_size: u32,
    pub max_iters: u32,
    pub budget_ms: u64,
}

impl Default for PullCfg {
    fn default() -> Self {
        Self {
            enabled: true,
            page_size: 100,
            max_iters: 50,
            budget_ms: 4000,
        }
    }
}

pub async fn spawn_relay() -> RelayHarness {
    spawn_relay_with(PullCfg::default()).await
}

pub async fn spawn_relay_with(pull: PullCfg) -> RelayHarness {
    let downstream = MockServer::start().await;
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("relay.db");
    let storage = Storage::open(&db).await.unwrap();
    let events_log = EventLog::new(storage.clone());
    let router = Arc::new(Router::new());
    let dn_client = Arc::new(DownstreamClient::new_with_defaults(&downstream.uri()).unwrap());

    let auth = Arc::new(TokenAuthenticator::new(dn_client.clone()));
    let auth_svc = AuthSvc {
        downstream: dn_client.clone(),
        auth: auth.clone(),
    };
    let hub_svc = HubSvc {
        router: router.clone(),
        events_log: events_log.clone(),
        downstream: dn_client.clone(),
        auth: auth.clone(),
        routes: chathub_relay::config::DownstreamRoutes::default_for_test(),
        client_id: "rh_wxchat".into(),
        notify_pull_enabled: pull.enabled,
        notify_pull_page_size: pull.page_size,
        notify_pull_max_iters: pull.max_iters,
        notify_pull_budget_ms: pull.budget_ms,
    };

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let grpc_addr = listener.local_addr().unwrap();
    let stream = TcpListenerStream::new(listener);
    let tonic_h = tokio::spawn(async move {
        let _ = Server::builder()
            .add_service(AuthServer::new(auth_svc))
            .add_service(HubServer::with_interceptor(
                hub_svc,
                ProtocolInterceptor::new(),
            ))
            .serve_with_incoming(stream)
            .await;
    });

    let push_state = PushState {
        secret: "push-secret".into(),
        events_log: events_log.clone(),
        router: router.clone(),
        force_close_grace_ms: 50,
        allowed_client_ids: vec!["rh_wxchat".into()],
        max_body_bytes: 1024 * 1024,
        auth: auth.clone(),
    };
    let push_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let push_addr = push_listener.local_addr().unwrap();
    let push_app = push::app(push_state);
    let axum_h = tokio::spawn(async move {
        let _ = axum::serve(push_listener, push_app).await;
    });

    tokio::time::sleep(Duration::from_millis(80)).await;

    RelayHarness {
        grpc_addr,
        push_addr,
        push_url: format!("http://{push_addr}"),
        push_secret: "push-secret".into(),
        downstream,
        events_log,
        router,
        _db: tmp,
        _tonic: tonic_h,
        _axum: axum_h,
    }
}

/// 在业务后台 mock 上挂 notify/pull,返回 `seqs` 对应的批次(单页,hasMore=false)。
/// 每条 batch 的 payload 是合法的 §6.3 push body(单 MESSAGE_UPSERT)。
pub async fn mount_notify_pull(mock: &MockServer, employee_id: i64, seqs: &[u64]) {
    let batches: Vec<serde_json::Value> = seqs
        .iter()
        .map(|&seq| {
            let batch_id = format!("rh_wxchat:{employee_id}:{seq}");
            serde_json::json!({
                "notifySeq": seq,
                "batchId": batch_id,
                "batchTime": "2026-05-17 11:28:00",
                "sendStatus": 1,
                "payload": {
                    "notifySeq": seq,
                    "clientId": "rh_wxchat",
                    "employeeId": employee_id,
                    "batchId": batch_id,
                    "batchTime": "2026-05-17 11:28:00",
                    "events": [{
                        "eventType": "MESSAGE_UPSERT",
                        "eventReason": "SYNC_MSG_COMPENSATED",
                        "conversationId": format!("c-{seq}"),
                        "message": { "localMessageId": format!("LM_{seq}"), "contentText": format!("m{seq}") }
                    }]
                }
            })
        })
        .collect();
    Mock::given(method("POST"))
        .and(path(
            "/wechat-business-app/rpc/v1/wecomAggregate/notify/pull",
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "code": 1,
            "serviceCode": "",
            "msg": "成功",
            "data": {
                "accepted": true,
                "clientId": "rh_wxchat",
                "employeeId": employee_id,
                "batches": batches,
                "missingNotifySeqList": [],
                "hasMore": false
            }
        })))
        .mount(mock)
        .await;
}

/// 在业务后台 mock 上挂 notify/pull,直接返回指定 HTTP 状态码(测失败回退)。
pub async fn mount_notify_pull_status(mock: &MockServer, status: u16) {
    Mock::given(method("POST"))
        .and(path(
            "/wechat-business-app/rpc/v1/wecomAggregate/notify/pull",
        ))
        .respond_with(ResponseTemplate::new(status))
        .mount(mock)
        .await;
}

/// 在业务后台 mock 上挂一条 verifyToken,返回带 employeeId 的连接身份。
/// 新合约:relay 用 `Authorization: Bearer <token>` 发空 body,响应仅 employeeId + 几个
/// 可空 string 字段。`_device_id` 保留参数兼容旧调用点,实际不入响应 — Subscribe 自行
/// 从 gRPC 请求体取 device_id。
pub async fn mount_verify_token(
    mock: &MockServer,
    token: &str,
    employee_id: i64,
    _device_id: &str,
) {
    // 业务后台 2026-05-17 起统一包络:`{code:1, msg:"成功", data:{...}}`
    Mock::given(method("POST"))
        .and(path(
            "/wechat-business-app/wecom-cs/v1/wecomAggregate/connection/verifyToken",
        ))
        .and(header("authorization", &*format!("Bearer {token}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "code": 1,
            "serviceCode": "",
            "msg": "成功",
            "data": {
                "employeeId": employee_id,
                "username": "",
                "nickName": "",
                "mobile": "",
                "channel": ""
            }
        })))
        .mount(mock)
        .await;
}
