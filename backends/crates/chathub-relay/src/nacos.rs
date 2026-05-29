//! Nacos 服务注册与发现封装(2026-05-25)。
//!
//! 职责:
//!   - **注册**:把 relay 的 push HTTP 端点(业务后台回调 notify/push 用)注册进 Nacos,停机时注销。
//!   - **发现**:把下游业务后台在 Nacos 的服务名解析成一个健康实例的 `scheme://ip:port`。
//!
//! 全程 **best-effort**:任何 Nacos 故障都只 warn/debug,不阻断 relay 主流程。
//!   - 连接失败 → main 降级为纯静态 downstream_url(根本不构造本 client)。
//!   - 注册失败 → 只 warn(SDK 会在重连后自动补注册)。
//!   - 发现失败/无健康实例 → `discover_base_url` 返回 None,由 `BaseUrlSource` 回退静态 url。
//!
//! 注:`discover_base_url` 在下游请求热路径上被每请求调用,SDK 内部已缓存实例并订阅变更,
//!   这是本地查找而非每次走网络;miss 路径用 `debug` 而非 `warn`,避免 Nacos 不可用时日志刷屏。

use crate::config::NacosConfig;
use nacos_sdk::api::naming::{NamingService, NamingServiceBuilder, ServiceInstance};
use nacos_sdk::api::props::ClientProps;

/// 封装 Nacos `NamingService` + relay 自身注册信息 + 下游发现参数。
/// 用 `Arc` 共享(见 `BaseUrlSource::Nacos`),自身无需 `Clone`。
pub struct NacosClient {
    naming: NamingService,
    cfg: NacosConfig,
}

impl NacosClient {
    /// 构建并连接 Nacos。失败返回 `Err` —— 调用方(main)据此 best-effort 降级为纯静态。
    pub async fn connect(cfg: NacosConfig) -> anyhow::Result<Self> {
        let mut props = ClientProps::new()
            .server_addr(cfg.server_addr.clone())
            .namespace(cfg.namespace.clone())
            .app_name("chathub-relay");
        if let Some(user) = &cfg.username {
            props = props.auth_username(user.clone());
        }
        if let Some(pass) = &cfg.password {
            props = props.auth_password(pass.clone());
        }

        let mut builder = NamingServiceBuilder::new(props);
        // 仅在配置了凭据时启用 HTTP 鉴权插件(auth-by-http feature)。
        if cfg.username.is_some() || cfg.password.is_some() {
            builder = builder.enable_auth_plugin_http();
        }
        let naming = builder.build().await?;
        Ok(Self { naming, cfg })
    }

    fn group(&self) -> Option<String> {
        Some(self.cfg.group.clone())
    }

    /// relay 自身的 push 端点实例。ephemeral=true:靠 gRPC 连接/心跳保活,
    /// 连接断开(进程崩溃)时由 Nacos 自动摘除,作为主动注销之外的兜底。
    fn push_instance(&self) -> ServiceInstance {
        ServiceInstance {
            ip: self.cfg.register_ip.clone(),
            port: self.cfg.register_port as i32,
            weight: self.cfg.register_weight,
            healthy: true,
            enabled: true,
            ephemeral: true,
            metadata: self.cfg.register_metadata.clone(),
            ..Default::default()
        }
    }

    /// 注册 relay 的 push HTTP 端点。失败仅 warn(SDK 会在重连后自动补注册)。
    pub async fn register_push(&self) {
        match self
            .naming
            .register_instance(
                self.cfg.register_service.clone(),
                self.group(),
                self.push_instance(),
            )
            .await
        {
            Ok(()) => tracing::info!(
                target: "chathub_relay::nacos",
                service = %self.cfg.register_service,
                group = %self.cfg.group,
                ip = %self.cfg.register_ip,
                port = self.cfg.register_port,
                "registered push endpoint to Nacos",
            ),
            Err(e) => tracing::warn!(
                target: "chathub_relay::nacos",
                error = %e,
                "register push endpoint failed (best-effort; SDK will retry on reconnect)",
            ),
        }
    }

    /// 停机注销 push 端点,让业务后台尽快不再把回调路由到本实例。失败仅 warn。
    pub async fn deregister_push(&self) {
        match self
            .naming
            .deregister_instance(
                self.cfg.register_service.clone(),
                self.group(),
                self.push_instance(),
            )
            .await
        {
            Ok(()) => tracing::info!(
                target: "chathub_relay::nacos",
                service = %self.cfg.register_service,
                "deregistered push endpoint from Nacos",
            ),
            Err(e) => tracing::warn!(
                target: "chathub_relay::nacos",
                error = %e,
                "deregister push endpoint failed (best-effort)",
            ),
        }
    }

    /// 发现下游业务后台,返回一个健康实例的 base_url(`scheme://ip:port`)。
    /// 无健康实例或出错 → `None`,调用方回退静态 url。
    ///
    /// `subscribe=true`:首次调用触发 SDK 订阅该服务,后续命中本地缓存;
    ///   选址由 SDK 按实例权重做加权随机。
    pub async fn discover_base_url(&self) -> Option<String> {
        match self
            .naming
            .select_one_healthy_instance(
                self.cfg.discovery_service.clone(),
                self.group(),
                Vec::new(),
                true,
            )
            .await
        {
            Ok(inst) => Some(format!(
                "{}://{}:{}",
                self.cfg.discovery_scheme, inst.ip, inst.port
            )),
            Err(e) => {
                // 热路径:用 debug 避免 Nacos 不可用时刷屏。降级本身是预期行为。
                tracing::debug!(
                    target: "chathub_relay::nacos",
                    service = %self.cfg.discovery_service,
                    error = %e,
                    "no healthy downstream instance — falling back to static url",
                );
                None
            }
        }
    }
}
