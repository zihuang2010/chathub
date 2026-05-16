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

    // P0-6 Graceful shutdown:
    //   1. 收到 Ctrl-C / SIGTERM 后,先广播 SERVER_DRAIN 给所有连接
    //   2. 等 grace 让客户端读完帧并主动断
    //   3. 用 graceful_shutdown 让 tonic + axum 排空在途请求后退出
    let (shutdown_tx, mut shutdown_rx) = tokio::sync::watch::channel(false);

    // 监听信号的 task
    let router_for_signal = router.clone();
    tokio::spawn(async move {
        wait_for_shutdown_signal().await;
        let (legacy, employee) = router_for_signal.broadcast_server_drain("relay shutting down");
        tracing::info!(
            legacy_drained = legacy,
            employee_drained = employee,
            "SERVER_DRAIN broadcast complete; sleeping grace then shutting down"
        );
        // grace 让客户端读到 DRAIN 帧并主动断
        tokio::time::sleep(Duration::from_secs(2)).await;
        let _ = shutdown_tx.send(true);
    });

    let grpc_stream = tokio_stream::wrappers::TcpListenerStream::new(grpc_listener);
    let grpc_shutdown_rx = shutdown_rx.clone();
    let grpc_fut = Server::builder()
        .http2_keepalive_interval(Some(Duration::from_secs(30)))
        .add_service(AuthServer::new(auth_svc))
        .add_service(HubServer::with_interceptor(
            hub_svc,
            ProtocolInterceptor::new(),
        ))
        .serve_with_incoming_shutdown(grpc_stream, async move {
            let mut rx = grpc_shutdown_rx;
            // 等到 watch 信号变 true
            while rx.changed().await.is_ok() {
                if *rx.borrow() {
                    break;
                }
            }
        });

    let mut push_shutdown_rx = shutdown_rx.clone();
    let axum_fut = axum::serve(push_listener, push_app).with_graceful_shutdown(async move {
        while push_shutdown_rx.changed().await.is_ok() {
            if *push_shutdown_rx.borrow() {
                break;
            }
        }
    });

    tokio::select! {
        r = grpc_fut => { r?; tracing::info!("gRPC server exited"); }
        r = axum_fut => { r?; tracing::info!("axum server exited"); }
        _ = shutdown_rx.changed() => {
            if *shutdown_rx.borrow() {
                tracing::info!("shutdown signal observed; waiting for server tasks");
            }
        }
    }

    tracing::info!("relay graceful shutdown complete");
    Ok(())
}

/// 同时监听 Ctrl-C 与 SIGTERM(Unix);Windows 下退化为只听 Ctrl-C。
async fn wait_for_shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut sigterm = signal(SignalKind::terminate()).expect("install SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => tracing::info!("Ctrl-C received"),
            _ = sigterm.recv() => tracing::info!("SIGTERM received"),
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
        tracing::info!("Ctrl-C received");
    }
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
