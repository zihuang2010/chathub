//! chathub-relay binary entrypoint。

use chathub_proto::v1::auth_server::AuthServer;
use chathub_proto::v1::hub_server::HubServer;
use chathub_relay::auth_service::AuthSvc;
use chathub_relay::config::{Config, StdoutFormat};
use chathub_relay::downstream::DownstreamClient;
use chathub_relay::hub_service::{HubSvc, ProtocolInterceptor, TokenAuthenticator};
use chathub_relay::push::{self, PushState};
use chathub_relay::router::Router;
use chathub_relay::storage::events::{EventLog, EventStore};
use chathub_relay::storage::seqs::SeqAllocator;
use chathub_relay::storage::Storage;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use tonic::transport::Server;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

#[tokio::main(flavor = "multi_thread")]
async fn main() -> anyhow::Result<()> {
    let cfg = Config::from_env()?;
    let _log_guard = init_tracing(&cfg)?;
    let storage = Storage::open(&cfg.db_path).await?;
    let router = Arc::new(Router::new());
    let seqs = SeqAllocator::new(storage.clone());
    let events = EventStore::new(storage.clone());
    let events_log = EventLog::new(storage.clone());
    let downstream = Arc::new(DownstreamClient::new(
        &cfg.downstream_url,
        &cfg.downstream_secret,
    )?);

    let auth_svc = AuthSvc {
        downstream: downstream.clone(),
    };
    let hub_svc = HubSvc {
        router: router.clone(),
        seqs: seqs.clone(),
        events: events.clone(),
        events_log: events_log.clone(),
        downstream: downstream.clone(),
        auth: Arc::new(TokenAuthenticator::new(downstream.clone())),
        routes: cfg.routes.clone(),
    };

    let grpc_listener = TcpListener::bind(cfg.grpc_addr).await?;
    let push_listener = TcpListener::bind(cfg.push_addr).await?;
    let push_state = PushState {
        secret: cfg.push_secret.clone(),
        seqs,
        events,
        events_log,
        router: router.clone(),
        force_close_grace_ms: cfg.force_close_grace_ms,
    };
    let push_app = push::app(push_state);

    tracing::info!(grpc=%cfg.grpc_addr, push=%cfg.push_addr, "relay listening");

    let grpc_stream = tokio_stream::wrappers::TcpListenerStream::new(grpc_listener);
    tokio::select! {
        r = Server::builder()
            .http2_keepalive_interval(Some(Duration::from_secs(30)))
            .add_service(AuthServer::new(auth_svc))
            .add_service(HubServer::with_interceptor(hub_svc, ProtocolInterceptor::new()))
            .serve_with_incoming(grpc_stream) => { r?; }
        r = axum::serve(push_listener, push_app) => { r?; }
        _ = tokio::signal::ctrl_c() => { tracing::info!("ctrl_c received, shutting down"); }
    }
    Ok(())
}

/// 初始化 tracing:文件 JSON(按日轮转,非阻塞) + 可选 stdout。
/// 返回 WorkerGuard 必须由 main 持有到进程退出,否则 drop 时会丢未刷盘的日志。
fn init_tracing(cfg: &Config) -> anyhow::Result<WorkerGuard> {
    std::fs::create_dir_all(&cfg.log.dir)?;

    let file_appender = tracing_appender::rolling::daily(&cfg.log.dir, &cfg.log.file_prefix);
    let (file_writer, guard) = tracing_appender::non_blocking(file_appender);

    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,chathub_relay=debug"));

    let file_layer = tracing_subscriber::fmt::layer()
        .json()
        .with_writer(file_writer)
        .with_target(true)
        .with_thread_ids(true)
        .with_current_span(true);

    let base = tracing_subscriber::registry()
        .with(env_filter)
        .with(file_layer);

    match cfg.log.stdout {
        StdoutFormat::Off => base.init(),
        StdoutFormat::Compact => base
            .with(tracing_subscriber::fmt::layer().compact().with_target(true))
            .init(),
        StdoutFormat::Pretty => base
            .with(tracing_subscriber::fmt::layer().pretty().with_target(true))
            .init(),
        StdoutFormat::Json => base
            .with(tracing_subscriber::fmt::layer().json().with_target(true))
            .init(),
    }

    tracing::info!(
        log_dir = %cfg.log.dir.display(),
        log_file_prefix = %cfg.log.file_prefix,
        log_stdout = ?cfg.log.stdout,
        "logging initialized"
    );

    Ok(guard)
}
