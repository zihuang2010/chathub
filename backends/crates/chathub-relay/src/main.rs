//! chathub-relay binary entrypoint。

// 极致性能(F1):mimalloc 比 macOS/glibc 默认 allocator 在 alloc-heavy 场景快 5-15%
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

use chathub_proto::v1::auth_server::AuthServer;
use chathub_proto::v1::hub_server::HubServer;
use chathub_relay::auth_service::AuthSvc;
use chathub_relay::config::{Config, StdoutFormat};
use chathub_relay::downstream::DownstreamClient;
use chathub_relay::hub_service::{HubSvc, ProtocolInterceptor, TokenAuthenticator};
use chathub_relay::push::{self, PushState};
use chathub_relay::router::Router;
use chathub_relay::storage::events::EventLog;
use chathub_relay::storage::Storage;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use tonic::transport::{Identity, Server, ServerTlsConfig};
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

#[tokio::main(flavor = "multi_thread")]
async fn main() -> anyhow::Result<()> {
    let cfg = Config::from_env()?;
    let _log_guard = init_tracing(&cfg)?;
    tracing::info!(
        target: "chathub_relay::config",
        "effective configuration:\n{}",
        cfg.dump_redacted()
    );
    let storage = Storage::open(&cfg.db_path).await?;
    let router = Arc::new(Router::new());
    let events_log = EventLog::new(storage.clone());
    let downstream = Arc::new(DownstreamClient::new(
        &cfg.downstream_url,
        chathub_relay::downstream::AuthPaths {
            login: cfg.path_login.clone(),
            verify_token: cfg.path_verify_token.clone(),
            logout: cfg.path_logout.clone(),
        },
        chathub_relay::downstream::OAuthCreds {
            client_id: cfg.oauth_client_id.clone(),
            client_secret: cfg.oauth_client_secret.clone(),
        },
    )?);

    // 共享 TokenAuthenticator:AuthSvc.login 后预填,HubSvc.{subscribe,ack,forward} 命中
    // 容量来自 RELAY_AUTH_CACHE_MAX_ENTRIES,防止恶意刷不同 token 触发缓存无界增长。
    let auth = Arc::new(TokenAuthenticator::with_capacity(
        downstream.clone(),
        cfg.auth_cache_max_entries,
    ));
    let auth_svc = AuthSvc {
        downstream: downstream.clone(),
        auth: auth.clone(),
    };
    let hub_svc = HubSvc {
        router: router.clone(),
        events_log: events_log.clone(),
        downstream: downstream.clone(),
        auth: auth.clone(),
        routes: cfg.routes.clone(),
    };

    let grpc_listener = TcpListener::bind(cfg.grpc_addr).await?;
    let push_listener = TcpListener::bind(cfg.push_addr).await?;
    let push_state = PushState {
        secret: cfg.push_secret.clone(),
        events_log: events_log.clone(),
        router: router.clone(),
        force_close_grace_ms: cfg.force_close_grace_ms,
        allowed_client_ids: cfg.allowed_client_ids.clone(),
        max_body_bytes: cfg.push_max_body_bytes,
    };
    let push_app = push::app(push_state);

    tracing::info!(grpc=%cfg.grpc_addr, push=%cfg.push_addr, "relay listening");

    // F5:events_v2 GC task —— 后台跑,每 60s 排干超 retention 的批次(LIMIT 5000)。
    let gc_log = events_log.clone();
    let retention_days = cfg.event_retention_days;
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(60));
        tick.tick().await; // 第一 tick 立即返回,跳过
        let retention_ms = (retention_days * 24 * 3600 * 1000) as i64;
        loop {
            tick.tick().await;
            let cutoff = now_ms() - retention_ms;
            // 排干策略:循环 cleanup 直到一次回 0 (不要让 LIMIT 把 backlog 切成长尾)
            let mut total = 0u64;
            loop {
                match gc_log.cleanup_older_than(cutoff, 5000).await {
                    Ok(0) => break,
                    Ok(n) => {
                        total += n as u64;
                        if n < 5000 {
                            break;
                        }
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "events_v2 cleanup failed");
                        break;
                    }
                }
            }
            if total > 0 {
                tracing::info!(deleted = total, retention_days, "events_v2 gc ran");
            }
        }
    });

    // P0-6 Graceful shutdown:
    //   1. 收到 Ctrl-C / SIGTERM 后,先广播 SERVER_DRAIN 给所有连接
    //   2. 等 grace 让客户端读完帧并主动断
    //   3. 用 graceful_shutdown 让 tonic + axum 排空在途请求后退出
    let (shutdown_tx, mut shutdown_rx) = tokio::sync::watch::channel(false);

    // 监听信号的 task
    let router_for_signal = router.clone();
    tokio::spawn(async move {
        wait_for_shutdown_signal().await;
        let drained = router_for_signal.broadcast_server_drain("relay shutting down");
        tracing::info!(
            connections_drained = drained,
            "SERVER_DRAIN broadcast complete; sleeping grace then shutting down"
        );
        // grace 让客户端读到 DRAIN 帧并主动断
        tokio::time::sleep(Duration::from_secs(2)).await;
        let _ = shutdown_tx.send(true);
    });

    // F5:TLS env-driven。两个 cert/key 路径都设了才启 TLS,否则 plaintext(开发用)。
    let tls_config = match (&cfg.tls_cert_path, &cfg.tls_key_path) {
        (Some(cert), Some(key)) => {
            let cert_pem = std::fs::read(cert)?;
            let key_pem = std::fs::read(key)?;
            tracing::info!(cert=%cert.display(), "tonic Server TLS enabled");
            Some(ServerTlsConfig::new().identity(Identity::from_pem(&cert_pem, &key_pem)))
        }
        (None, None) => {
            tracing::warn!("tonic Server TLS not configured (plaintext gRPC) — set RELAY_TLS_CERT_PATH + RELAY_TLS_KEY_PATH for production");
            None
        }
        _ => anyhow::bail!(
            "RELAY_TLS_CERT_PATH and RELAY_TLS_KEY_PATH must be both set or both unset"
        ),
    };

    let grpc_stream = tokio_stream::wrappers::TcpListenerStream::new(grpc_listener);
    let grpc_shutdown_rx = shutdown_rx.clone();
    // F4/F5:tonic Server 完整 h2 + TCP 调优
    let mut server_builder = Server::builder()
        .tcp_nodelay(true)                                              // F4 T1
        .tcp_keepalive(Some(Duration::from_secs(120)))                  // F4 T2
        .http2_keepalive_interval(Some(Duration::from_secs(30)))
        .http2_keepalive_timeout(Some(Duration::from_secs(10)))         // F4 T5
        .http2_adaptive_window(Some(true))
        .initial_connection_window_size(1024 * 1024)                    // F4 T3 → 1MB
        .initial_stream_window_size(256 * 1024)                         // F4 T4 → 256KB
        .max_concurrent_streams(Some(256))                              // F4 T6 防 stream-flood
        .concurrency_limit_per_connection(256); // F4 T7
    if let Some(tls) = tls_config {
        server_builder = server_builder.tls_config(tls)?;
    }
    let grpc_fut = server_builder
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

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
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
