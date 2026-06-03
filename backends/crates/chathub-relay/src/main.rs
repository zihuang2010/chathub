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

    // push 原始入站 body 旁路落盘(env RELAY_SOURCE_JSON_LOG,默认开):独立按日轮转文件,
    // 每行一条原样 body,供上线初期 diff/jq 比对。复用 cfg.log.dir(init_tracing 已建)。
    // _source_json_guard 必须活到进程退出,否则丢未刷盘的行。
    let (source_json_writer, _source_json_guard) = if cfg.log.source_json {
        let appender = tracing_appender::rolling::daily(&cfg.log.dir, "relay-source-json");
        let (writer, guard) = tracing_appender::non_blocking(appender);
        (Some(writer), Some(guard))
    } else {
        (None, None)
    };

    tracing::info!(
        target: "chathub_relay::config",
        "effective configuration:\n{}",
        cfg.dump_redacted()
    );
    let storage = Storage::open(&cfg.db_path).await?;
    let router = Arc::new(Router::new());
    let events_log = EventLog::new(storage.clone());

    // Nacos(可选,best-effort):连接成功则注册 push 端点 + 启用下游服务发现;
    // 连接失败则 warn 并降级为纯静态 downstream_url(不阻断启动)。
    let nacos_client: Option<Arc<chathub_relay::nacos::NacosClient>> = if cfg.nacos.enabled {
        match chathub_relay::nacos::NacosClient::connect(cfg.nacos.clone()).await {
            Ok(c) => {
                let c = Arc::new(c);
                c.register_push().await;
                // 启动期探一次下游发现并打印解析到的地址,便于确认 relay 实际会请求/回调到哪个后台。
                // 仅此一次,不动每请求热路径(discover_base_url 自身按请求调用且只在 miss 时 debug)。
                match c.discover_base_url().await {
                    Some(url) => tracing::info!(
                        target: "chathub_relay::nacos",
                        service = %cfg.nacos.discovery_service,
                        base_url = %url,
                        "discovered downstream base_url from Nacos",
                    ),
                    None => tracing::info!(
                        target: "chathub_relay::nacos",
                        service = %cfg.nacos.discovery_service,
                        fallback = %cfg.downstream_url,
                        "no healthy downstream instance yet — will fall back to static url",
                    ),
                }
                Some(c)
            }
            Err(e) => {
                tracing::warn!(
                    target: "chathub_relay::nacos",
                    error = %e,
                    "connect Nacos failed — degrading to static downstream_url",
                );
                None
            }
        }
    } else {
        None
    };

    // 下游 base_url 来源:有 Nacos 走发现(静态 url 兜底),否则纯静态。
    let source = match &nacos_client {
        Some(c) => {
            chathub_relay::downstream::BaseUrlSource::new_nacos(c.clone(), &cfg.downstream_url)
        }
        None => chathub_relay::downstream::BaseUrlSource::new_static(&cfg.downstream_url),
    };

    let downstream = Arc::new(DownstreamClient::new_with_source(
        source,
        chathub_relay::downstream::AuthPaths {
            login: cfg.path_login.clone(),
            verify_token: cfg.path_verify_token.clone(),
            logout: cfg.path_logout.clone(),
            notify_pull: cfg.path_notify_pull.clone(),
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
        client_id: cfg
            .allowed_client_ids
            .first()
            .cloned()
            .unwrap_or_else(|| "rh_wxchat".into()),
        notify_pull_enabled: cfg.notify_pull_enabled,
        notify_pull_page_size: cfg.notify_pull_page_size,
        notify_pull_max_iters: cfg.notify_pull_max_iters,
        notify_pull_budget_ms: cfg.notify_pull_budget_ms,
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
        auth: auth.clone(),
        source_json_log: source_json_writer,
    };
    let push_app = push::app(push_state);

    tracing::info!(grpc=%cfg.grpc_addr, push=%cfg.push_addr, "relay listening");

    // F5:hub_events GC task —— 后台跑,每 60s 排干超 retention 的批次(LIMIT 5000)。
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
                        tracing::warn!(error = %e, "hub_events cleanup failed");
                        break;
                    }
                }
            }
            if total > 0 {
                tracing::info!(deleted = total, retention_days, "hub_events gc ran");
            }
        }
    });

    // P0-6 Graceful shutdown:
    //   1. 收到 Ctrl-C / SIGTERM 后,先广播 SERVER_DRAIN 给所有连接
    //   2. 等 grace 让客户端读完帧并主动断
    //   3. 用 graceful_shutdown 让 tonic + axum 排空在途请求后退出
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);

    // 监听信号的 task
    let router_for_signal = router.clone();
    let nacos_for_signal = nacos_client.clone();
    tokio::spawn(async move {
        wait_for_shutdown_signal().await;
        // 先从 Nacos 注销 push 端点,让业务后台尽快停止把回调路由过来,再排空在途连接。
        if let Some(c) = &nacos_for_signal {
            c.deregister_push().await;
        }
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
        // 第一版仅内网,故意明文 gRPC;不再告警(将来对外暴露时配 cert/key 即自动启 TLS)。
        (None, None) => None,
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
                                                // 注:以上均为 per-connection 限流;全局 TCP 连接数上限依赖基础设施层(LB/网关)兜底,
                                                // relay 本身不设全局连接上限。
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

    // 必须等两个 server **都排空完**再退出:它们各自的 graceful-shutdown future
    // 已接到同一个 watch,信号到来后会各自排空在途请求并返回。用 join! 而非 select! —
    // select! 会在 watch 翻 true 的瞬间(或任一 server 先返回时)立即退出并 drop 掉另一个
    // 仍在排空的 server,把 SERVER_DRAIN 之后的真正排空掐断。
    // 取舍:join! 下若某 server 在无信号时意外提前返回,另一个会继续跑到信号才退出 ——
    // 为换取"信号到来时两端都真正排空"的有意取舍,serve 中途返回 Err 属极少见路径。
    let (grpc_res, axum_res) = tokio::join!(grpc_fut, axum_fut);
    grpc_res?;
    tracing::info!("gRPC server exited");
    axum_res?;
    tracing::info!("axum server exited");

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

    // 默认过滤:压掉 nacos-sdk gRPC 健康检查的启动期噪声(connection 未注册 / 转换失败,
    // SDK 自述"重试成功即可忽略")。保留 error 级,真实故障仍会冒出。设 RUST_LOG 可整体覆盖本默认。
    let env_filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        EnvFilter::new("info,chathub_relay=debug,nacos_sdk::common::remote::grpc=error")
    });

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
