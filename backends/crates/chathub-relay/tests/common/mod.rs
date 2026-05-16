//! RelayHarness — in-process relay fixture(tonic + axum + wiremock + tempdir)。
//!
//! Relay 退化为纯隔道后,认证委托业务后台 verifyToken。测试用法:
//! ```ignore
//! #[tokio::test(flavor = "multi_thread")]
//! async fn my_test() {
//!     let h = spawn_relay().await;
//!     mount_verify_token(&h.downstream, "tok-A", "u-1", "dev-A", &["wa-1"]).await;
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
use chathub_relay::storage::events::{EventLog, EventStore};
use chathub_relay::storage::seqs::SeqAllocator;
use chathub_relay::storage::Storage;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use tokio_stream::wrappers::TcpListenerStream;
use tonic::transport::Server;
use wiremock::matchers::{body_partial_json, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

pub struct RelayHarness {
    pub grpc_addr: SocketAddr,
    pub push_addr: SocketAddr,
    pub push_url: String,
    pub push_secret: String,
    /// 业务后台 mock。测试在其上 mount /auth/login、/v1/verify_token、/v1/send 等。
    pub downstream: MockServer,
    pub events: EventStore,
    pub router: Arc<Router>,
    _db: tempfile::TempDir,
    _tonic: JoinHandle<()>,
    _axum: JoinHandle<()>,
}

pub async fn spawn_relay() -> RelayHarness {
    let downstream = MockServer::start().await;
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("relay.db");
    let storage = Storage::open(&db).await.unwrap();
    let seqs = SeqAllocator::new(storage.clone());
    let events = EventStore::new(storage.clone());
    let events_log = EventLog::new(storage.clone());
    let router = Arc::new(Router::new());
    let dn_client = Arc::new(DownstreamClient::new(&downstream.uri(), "dn-secret").unwrap());

    let auth_svc = AuthSvc {
        downstream: dn_client.clone(),
    };
    let hub_svc = HubSvc {
        router: router.clone(),
        seqs: seqs.clone(),
        events: events.clone(),
        downstream: dn_client.clone(),
        auth: Arc::new(TokenAuthenticator::new(dn_client.clone())),
        routes: chathub_relay::config::DownstreamRoutes::default_for_test(),
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
        seqs,
        events: events.clone(),
        events_log,
        router: router.clone(),
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
        events,
        router,
        _db: tmp,
        _tonic: tonic_h,
        _axum: axum_h,
    }
}

/// 在业务后台 mock 上挂一条 verifyToken:token=`token` → 返回给定连接身份。
pub async fn mount_verify_token(
    mock: &MockServer,
    token: &str,
    user_id: &str,
    device_id: &str,
    accounts: &[&str],
) {
    Mock::given(method("POST"))
        .and(path("/v1/verify_token"))
        .and(body_partial_json(serde_json::json!({ "token": token })))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "active": true,
            "user_id": user_id,
            "device_id": device_id,
            "accounts": accounts,
        })))
        .mount(mock)
        .await;
}
