//! chathub-relay binary entrypoint。

use chathub_proto::v1::auth_server::AuthServer;
use chathub_proto::v1::hub_server::HubServer;
use chathub_relay::auth_service::AuthSvc;
use chathub_relay::config::Config;
use chathub_relay::downstream::DownstreamClient;
use chathub_relay::hub_service::{HubSvc, JwtAuthInterceptor};
use chathub_relay::jwt::Signer;
use chathub_relay::push::{self, PushState};
use chathub_relay::router::Router;
use chathub_relay::storage::events::EventStore;
use chathub_relay::storage::seqs::SeqAllocator;
use chathub_relay::storage::sessions::SessionStore;
use chathub_relay::storage::Storage;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use tonic::transport::Server;
use tracing_subscriber::EnvFilter;

#[tokio::main(flavor = "multi_thread")]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let cfg = Config::from_env()?;
    let storage = Storage::open(&cfg.db_path).await?;
    let signer = Signer::bootstrap(
        &storage,
        cfg.jwt_private_pem.as_deref(),
        cfg.jwt_kid.as_deref(),
        &cfg.issuer,
    )
    .await?;
    let router = Arc::new(Router::new());
    let sessions = SessionStore::new(storage.clone());
    let seqs = SeqAllocator::new(storage.clone());
    let events = EventStore::new(storage.clone());
    let downstream = Arc::new(DownstreamClient::new(
        &cfg.downstream_url,
        &cfg.downstream_secret,
    )?);

    let auth_svc = AuthSvc {
        downstream: downstream.clone(),
        sessions,
        signer: signer.clone(),
        pepper: cfg.refresh_hash_pepper.clone(),
        access_ttl: cfg.access_ttl,
        refresh_ttl: cfg.refresh_ttl,
    };
    let hub_svc = HubSvc {
        router: router.clone(),
        seqs: seqs.clone(),
        events: events.clone(),
        downstream: downstream.clone(),
    };
    let ic = JwtAuthInterceptor::new(signer.verifier());

    let grpc_listener = TcpListener::bind(cfg.grpc_addr).await?;
    let push_listener = TcpListener::bind(cfg.push_addr).await?;
    let push_state = PushState {
        secret: cfg.push_secret.clone(),
        seqs,
        events,
        router: router.clone(),
    };
    let push_app = push::app(push_state);

    tracing::info!(grpc=%cfg.grpc_addr, push=%cfg.push_addr, "relay listening");

    let grpc_stream = tokio_stream::wrappers::TcpListenerStream::new(grpc_listener);
    tokio::select! {
        r = Server::builder()
            .http2_keepalive_interval(Some(Duration::from_secs(30)))
            .add_service(AuthServer::new(auth_svc))
            .add_service(HubServer::with_interceptor(hub_svc, ic))
            .serve_with_incoming(grpc_stream) => { r?; }
        r = axum::serve(push_listener, push_app) => { r?; }
        _ = tokio::signal::ctrl_c() => { tracing::info!("ctrl_c received, shutting down"); }
    }
    Ok(())
}
