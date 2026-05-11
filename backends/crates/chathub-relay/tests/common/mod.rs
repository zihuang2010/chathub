//! RelayHarness — in-process relay fixture(tonic + axum + wiremock + tempdir)。
//!
//! 用法:
//! ```ignore
//! #[tokio::test(flavor = "multi_thread")]
//! async fn my_test() {
//!     let h = spawn_relay().await;
//!     let token = mint_jwt(&h.signer, "u-1", vec!["wa-1".into()], "dev-A");
//!     // ... 用 chathub-net::HubClient 直连 h.grpc_addr
//! }
//! ```

#![allow(dead_code)]

use chathub_proto::v1::auth_server::AuthServer;
use chathub_proto::v1::hub_server::HubServer;
use chathub_relay::auth_service::AuthSvc;
use chathub_relay::downstream::DownstreamClient;
use chathub_relay::hub_service::{HubSvc, JwtAuthInterceptor};
use chathub_relay::jwt::{Claims, Signer};
use chathub_relay::push::{self, PushState};
use chathub_relay::router::Router;
use chathub_relay::storage::events::EventStore;
use chathub_relay::storage::seqs::SeqAllocator;
use chathub_relay::storage::sessions::SessionStore;
use chathub_relay::storage::Storage;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use tokio_stream::wrappers::TcpListenerStream;
use tonic::transport::Server;
use wiremock::MockServer;

pub struct RelayHarness {
    pub grpc_addr: SocketAddr,
    pub push_addr: SocketAddr,
    pub push_url: String,
    pub push_secret: String,
    pub downstream: MockServer,
    pub signer: Signer,
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
    let signer = Signer::bootstrap(&storage, None, None, "chathub-relay")
        .await
        .unwrap();
    let sessions = SessionStore::new(storage.clone());
    let seqs = SeqAllocator::new(storage.clone());
    let events = EventStore::new(storage.clone());
    let router = Arc::new(Router::new());
    let dn_client = Arc::new(DownstreamClient::new(&downstream.uri(), "dn-secret").unwrap());

    let auth_svc = AuthSvc {
        downstream: dn_client.clone(),
        sessions,
        signer: signer.clone(),
        pepper: "test-pepper".into(),
        access_ttl: Duration::from_secs(1800),
        refresh_ttl: Duration::from_secs(86400 * 30),
    };
    let hub_svc = HubSvc {
        router: router.clone(),
        seqs: seqs.clone(),
        events: events.clone(),
        downstream: dn_client.clone(),
    };

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let grpc_addr = listener.local_addr().unwrap();
    let stream = TcpListenerStream::new(listener);
    let ic = JwtAuthInterceptor::new(signer.verifier());
    let tonic_h = tokio::spawn(async move {
        let _ = Server::builder()
            .add_service(AuthServer::new(auth_svc))
            .add_service(HubServer::with_interceptor(hub_svc, ic))
            .serve_with_incoming(stream)
            .await;
    });

    let push_state = PushState {
        secret: "push-secret".into(),
        seqs,
        events: events.clone(),
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
        signer,
        events,
        router,
        _db: tmp,
        _tonic: tonic_h,
        _axum: axum_h,
    }
}

/// 直接由 Signer 签出 JWT,跳过 login(测试用)。
pub fn mint_jwt(signer: &Signer, user_id: &str, accounts: Vec<String>, device_id: &str) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let claims = Claims {
        iss: signer.issuer().to_string(),
        sub: user_id.to_string(),
        exp: now + 1800,
        iat: now,
        accounts,
        device_id: device_id.to_string(),
    };
    signer.sign(&claims).unwrap()
}
