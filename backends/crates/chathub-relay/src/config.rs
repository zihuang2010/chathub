//! Config — relay 启动配置;`from_env()` 读 env var。
//! 必填(无默认):RELAY_DOWNSTREAM_URL / RELAY_PUSH_SECRET(或 RELAY_PUSH_SECRET_FILE)
//!
//! 鉴权模型(2026-05-16 OAuth2 重构):
//!   - relay → 业务后台所有业务请求,用客户端 raw Bearer token(透传)
//!   - 唯一例外:Auth.Login 走 OAuth2,用 Basic client_id:client_secret
//!   - RELAY_DOWNSTREAM_SECRET 已下线(relay 不再持有出站 shared secret)
//!   - RELAY_PUSH_SECRET 仍保留(业务后台 → relay /rpc/v1/wecomAggregate/notify/push 方向)

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;

#[derive(thiserror::Error, Debug)]
pub enum ConfigError {
    #[error("missing required env var: {0}")]
    Missing(&'static str),
    #[error("invalid env var {var}: {message}")]
    Invalid { var: &'static str, message: String },
    #[error("insecure config: {0} — set RELAY_ALLOW_HTTP=true to acknowledge (dev only)")]
    Insecure(&'static str),
    #[error("IO error reading {var} from file {path}: {source}")]
    Io {
        var: &'static str,
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("config validation failed: {0}")]
    ValidationFailed(String),
}

#[derive(Clone, Debug)]
pub struct Config {
    pub grpc_addr: SocketAddr,
    pub push_addr: SocketAddr,
    pub db_path: PathBuf,
    pub downstream_url: String,
    pub push_secret: String,
    pub log: LogConfig,
    /// 客户端 → relay TLS(F5):若两个都设置则启用 tonic TLS,否则 plaintext。
    pub tls_cert_path: Option<PathBuf>,
    pub tls_key_path: Option<PathBuf>,
    /// push body 最大字节数,防 body-bomb DoS(F2)。env `RELAY_PUSH_MAX_BODY_BYTES`,默认 1MB。
    pub push_max_body_bytes: usize,
    /// 后台 GC 间隔(秒),hub_events 保留 days(F5)。env `RELAY_EVENT_RETENTION_DAYS`,默认 7。
    pub event_retention_days: u64,
    /// Hub.Forward 的 method → 业务后台 HTTP (verb, path) 映射。
    pub routes: DownstreamRoutes,
    /// Auth.Login 的 OAuth2 路径(env `RELAY_PATH_LOGIN`,默认 `/account-app/oauth2/token`)。
    pub path_login: String,
    /// verify_token 路径(env `RELAY_PATH_VERIFY_TOKEN`,默认 `/wechat-business-app/wecom-cs/v1/wecomAggregate/connection/verifyToken`)。
    pub path_verify_token: String,
    /// logout 路径(env `RELAY_PATH_LOGOUT`,默认 `/auth/logout`)。
    pub path_logout: String,
    /// notify/pull 通知补偿拉取路径(env `RELAY_PATH_NOTIFY_PULL`,默认
    /// `/wechat-business-app/rpc/v1/wecomAggregate/notify/pull`)。relay→业务端内部 RPC,
    /// 客户端禁止经 Forward 触达,故独立字段而非进 DownstreamRoutes。
    pub path_notify_pull: String,
    /// OAuth2 Basic client id(env `RELAY_OAUTH_CLIENT_ID`,默认 `rh_wxchat`)。
    pub oauth_client_id: String,
    /// OAuth2 Basic client secret(env `RELAY_OAUTH_CLIENT_SECRET`,默认 `rh_wxchat`)。
    pub oauth_client_secret: String,
    /// CONNECTION_FORCE_CLOSE 收到后等多久才摘除连接。env `RELAY_FORCE_CLOSE_GRACE_MS`,默认 2000。
    pub force_close_grace_ms: u64,
    /// Push v2 接收的 clientId 白名单。env `RELAY_ALLOWED_CLIENT_IDS`(逗号分隔),默认 `rh_wxchat`。
    pub allowed_client_ids: Vec<String>,
    /// TokenAuthenticator moka cache 最大条目数。env `RELAY_AUTH_CACHE_MAX_ENTRIES`,默认 10000。
    /// 高 QPS / 大量不同 token 场景调高;受限内存场景调低。
    pub auth_cache_max_entries: u64,
    /// notify/pull 补偿拉取总开关(env `RELAY_NOTIFY_PULL_ENABLED`,默认 true)。
    /// 关闭后 subscribe 检测到缺口直接置 resync_required=true,让客户端走 REST 全量兜底。
    pub notify_pull_enabled: bool,
    /// 单次 notify/pull 范围拉取最大条数(env `RELAY_NOTIFY_PULL_PAGE_SIZE`,默认 100)。
    /// 读取时夹到 1..=200(规范 §6.4 单次 ≤200)。
    pub notify_pull_page_size: u32,
    /// subscribe catch-up 循环最大迭代次数(env `RELAY_NOTIFY_PULL_MAX_ITERS`,默认 50)。
    pub notify_pull_max_iters: u32,
    /// subscribe catch-up 同步拉取的时间预算 ms(env `RELAY_NOTIFY_PULL_BUDGET_MS`,默认 4000)。
    /// 超预算则停止拉取并置 resync_required=true。validate() 拒 0。
    pub notify_pull_budget_ms: u64,
    /// Nacos 服务注册/发现配置。`enabled=false`(默认)时完全走静态 downstream_url,零行为变化。
    pub nacos: NacosConfig,
}

/// Nacos 服务注册与发现配置(2026-05-25)。
///
/// 设计要点:
///   - **全程 best-effort**:Nacos 任何故障都不阻断 relay 主流程,降级到静态 `downstream_url`。
///   - **发现**:把 `discovery_service` 解析成的健康实例 `scheme://ip:port` 作为下游 base_url;
///     拿不到实例时回退 `downstream_url`(每请求决策 → Nacos 恢复后自动切回发现结果)。
///   - **注册**:把 relay 的 push HTTP 端点(供业务后台回调 notify/push)注册进 Nacos。
#[derive(Clone, Debug)]
pub struct NacosConfig {
    /// 总开关(env `RELAY_NACOS_ENABLED`,默认 false)。
    pub enabled: bool,
    /// Nacos server 地址,如 `127.0.0.1:8848`,逗号分隔支持集群(env `RELAY_NACOS_SERVER_ADDR`)。
    pub server_addr: String,
    /// 命名空间(env `RELAY_NACOS_NAMESPACE`,默认空 = public)。
    pub namespace: String,
    /// 分组(env `RELAY_NACOS_GROUP`,默认 `DEFAULT_GROUP`)。注册与发现共用。
    pub group: String,
    /// 可选 HTTP 鉴权用户名(env `RELAY_NACOS_USERNAME`)。
    pub username: Option<String>,
    /// 可选 HTTP 鉴权密码(env `RELAY_NACOS_PASSWORD` 或 `_FILE`)。
    pub password: Option<String>,
    /// 下游业务后台在 Nacos 的服务名(env `RELAY_NACOS_DISCOVERY_SERVICE`)。
    pub discovery_service: String,
    /// 拼下游 base_url 用的 scheme(env `RELAY_NACOS_DISCOVERY_SCHEME`,默认 https)。
    /// http 时同样受 `RELAY_ALLOW_HTTP` 约束,防客户端 Bearer token 明文上行。
    pub discovery_scheme: String,
    /// relay 注册到 Nacos 的服务名(env `RELAY_NACOS_REGISTER_SERVICE`,默认 `chathub-relay`)。
    pub register_service: String,
    /// 注册到 Nacos 的可达 IP(env `RELAY_NACOS_REGISTER_IP`)。
    /// 默认取 push_addr 的 IP;push_addr 是 0.0.0.0/通配时为空,此时 validate() 要求显式设置。
    pub register_ip: String,
    /// 注册到 Nacos 的端口(env `RELAY_NACOS_REGISTER_PORT`,默认取 push_addr 端口)。
    pub register_port: u16,
    /// 注册实例权重(env `RELAY_NACOS_REGISTER_WEIGHT`,默认 1.0)。
    pub register_weight: f64,
    /// 注册实例元数据(env `RELAY_NACOS_REGISTER_METADATA`,`k=v,k2=v2`),典型放 push 回调路径供后台用。
    pub register_metadata: HashMap<String, String>,
}

/// `Hub.Forward(method, body_json)` 时,relay 用这张表把 method 转成 (HTTP verb, 业务后台路径)。
///
/// env 格式(`RELAY_PATH_<METHOD-UPPERCASE>`):
///   - `GET:/path` 或 `POST:/path` — 显式指定 verb
///   - `/path` — verb 取默认表中的值(向后兼容已有部署)
///
/// 加新业务 method 时:
///   1. 加默认值到 `DEFAULT_ROUTES`
///   2. 业务后台部署对应路径
///   3. 客户端 SDK 调 `Hub.Forward("new_method", body)` 即可,relay 不需要重新编译
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HttpMethod {
    Get,
    Post,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RouteSpec {
    pub method: HttpMethod,
    pub path: String,
}

#[derive(Clone, Debug)]
pub struct DownstreamRoutes {
    map: HashMap<String, RouteSpec>,
}

/// 默认 method → (verb, path, env_var) 映射。
const DEFAULT_ROUTES: &[(&str, HttpMethod, &str, &str)] = &[
    ("send", HttpMethod::Post, "/v1/send", "RELAY_PATH_SEND"),
    (
        "recall",
        HttpMethod::Post,
        "/v1/recall",
        "RELAY_PATH_RECALL",
    ),
    (
        "ack_read",
        HttpMethod::Post,
        "/v1/ack_read",
        "RELAY_PATH_ACK_READ",
    ),
    (
        "fetch_message_history",
        HttpMethod::Post,
        "/wechat-business-app/wecom-cs/v1/wecomAggregate/message/history",
        "RELAY_PATH_FETCH_MESSAGE_HISTORY",
    ),
    (
        "send_message",
        HttpMethod::Post,
        "/wechat-business-app/wecom-cs/v1/wecomAggregate/message/send",
        "RELAY_PATH_SEND_MESSAGE",
    ),
    // 融合公共上传:聊天附件直传 OSS 前先取 STS 临时凭证 + objectName(GET + query)。
    (
        "oss_token_info",
        HttpMethod::Get,
        "/basic-public-app/V1/common/oss/tokenInfoByVersion",
        "RELAY_PATH_OSS_TOKEN_INFO",
    ),
    (
        "oss_gen_post_path",
        HttpMethod::Get,
        "/basic-public-app/V1/common/oss/genPostPathByVersion",
        "RELAY_PATH_OSS_GEN_POST_PATH",
    ),
    (
        "list_accounts",
        HttpMethod::Get,
        "/wechat-business-app/wecom-cs/v1/wecomAggregate/account/listMine",
        "RELAY_PATH_LIST_ACCOUNTS",
    ),
    (
        "list_friends",
        HttpMethod::Post,
        "/wechat-business-app/wecom-cs/v1/wecomAggregate/account/listFriends",
        "RELAY_PATH_LIST_FRIENDS",
    ),
    (
        "friend_detail",
        HttpMethod::Post,
        "/wechat-business-app/wecom-cs/v1/wecomAggregate/friend/detail",
        "RELAY_PATH_FRIEND_DETAIL",
    ),
    (
        "list_recent_friends",
        HttpMethod::Post,
        "/wechat-business-app/wecom-cs/v1/wecomAggregate/session/recentFriends",
        "RELAY_PATH_LIST_RECENT_FRIENDS",
    ),
    (
        "mark_read",
        HttpMethod::Post,
        "/wechat-business-app/wecom-cs/v1/wecomAggregate/session/markRead",
        "RELAY_PATH_MARK_READ",
    ),
    // verify_token / login / logout 由 relay 自己直接调,不经 Forward 通道。
];

/// 解析 env value 为 RouteSpec。`GET:/foo` / `POST:/foo` / `/foo`(用 default_verb)。
fn parse_route_value(raw: &str, default_verb: HttpMethod) -> RouteSpec {
    if let Some((prefix, rest)) = raw.split_once(':') {
        let upper = prefix.trim().to_ascii_uppercase();
        match upper.as_str() {
            "GET" => {
                return RouteSpec {
                    method: HttpMethod::Get,
                    path: rest.to_string(),
                };
            }
            "POST" => {
                return RouteSpec {
                    method: HttpMethod::Post,
                    path: rest.to_string(),
                };
            }
            _ => {}
        }
    }
    RouteSpec {
        method: default_verb,
        path: raw.to_string(),
    }
}

impl DownstreamRoutes {
    pub fn from_env() -> Self {
        let mut map = HashMap::new();
        for (method, default_verb, default_path, env_var) in DEFAULT_ROUTES {
            let spec = match std::env::var(env_var) {
                Ok(raw) => parse_route_value(&raw, *default_verb),
                Err(_) => RouteSpec {
                    method: *default_verb,
                    path: (*default_path).to_string(),
                },
            };
            map.insert((*method).into(), spec);
        }
        Self { map }
    }

    /// 测试用,固定默认路径。
    pub fn default_for_test() -> Self {
        let mut map = HashMap::new();
        for (method, default_verb, default_path, _) in DEFAULT_ROUTES {
            map.insert(
                (*method).into(),
                RouteSpec {
                    method: *default_verb,
                    path: (*default_path).to_string(),
                },
            );
        }
        Self { map }
    }

    pub fn get(&self, method: &str) -> Option<&RouteSpec> {
        self.map.get(method)
    }

    /// 兼容旧调用点 —— 只关心 path(verb 信息忽略)。新代码应改用 `get()`。
    pub fn path_for(&self, method: &str) -> Option<&str> {
        self.map.get(method).map(|s| s.path.as_str())
    }

    /// 已知的所有 method,主要给日志/调试用。
    pub fn known_methods(&self) -> Vec<&str> {
        self.map.keys().map(|s| s.as_str()).collect()
    }
}

#[derive(Clone, Debug)]
pub struct LogConfig {
    pub dir: PathBuf,
    pub file_prefix: String,
    pub stdout: StdoutFormat,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StdoutFormat {
    Off,
    Compact,
    Pretty,
    Json,
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        let downstream_url = required("RELAY_DOWNSTREAM_URL")?;
        // F2 安全:非 https 必须 opt-in,防意外明文上行 token
        validate_downstream_scheme(&downstream_url)?;

        let cfg = Self::build_from_env(downstream_url)?;
        cfg.validate()?;
        Ok(cfg)
    }

    fn build_from_env(downstream_url: String) -> Result<Self, ConfigError> {
        let grpc_addr = parse_addr_or("RELAY_GRPC_ADDR", "127.0.0.1:50051")?;
        let push_addr = parse_addr_or("RELAY_PUSH_ADDR", "127.0.0.1:50052")?;
        let nacos = NacosConfig::from_env(push_addr)?;
        Ok(Self {
            grpc_addr,
            push_addr,
            db_path: std::env::var("RELAY_DB_PATH")
                .unwrap_or_else(|_| "./relay.db".into())
                .into(),
            downstream_url,
            // F2 安全:与 OAuth secret 对齐,支持 *_FILE 路径(secrets manager / k8s secret 挂载)。
            push_secret: required_secret_with_file_fallback(
                "RELAY_PUSH_SECRET",
                "RELAY_PUSH_SECRET_FILE",
            )?,
            path_login: std::env::var("RELAY_PATH_LOGIN")
                .unwrap_or_else(|_| "/account-app/oauth2/token".into()),
            path_verify_token: std::env::var("RELAY_PATH_VERIFY_TOKEN").unwrap_or_else(|_| {
                "/wechat-business-app/wecom-cs/v1/wecomAggregate/connection/verifyToken".into()
            }),
            path_logout: std::env::var("RELAY_PATH_LOGOUT")
                .unwrap_or_else(|_| "/auth/logout".into()),
            path_notify_pull: std::env::var("RELAY_PATH_NOTIFY_PULL").unwrap_or_else(|_| {
                "/wechat-business-app/rpc/v1/wecomAggregate/notify/pull".into()
            }),
            oauth_client_id: std::env::var("RELAY_OAUTH_CLIENT_ID")
                .unwrap_or_else(|_| "rh_wxchat".into()),
            // F2 安全:secret 可走 *_FILE 路径,生产推荐;直填仅 dev 用
            oauth_client_secret: read_secret_with_file_fallback(
                "RELAY_OAUTH_CLIENT_SECRET",
                "RELAY_OAUTH_CLIENT_SECRET_FILE",
                "rh_wxchat",
            )?,
            tls_cert_path: std::env::var("RELAY_TLS_CERT_PATH").ok().map(PathBuf::from),
            tls_key_path: std::env::var("RELAY_TLS_KEY_PATH").ok().map(PathBuf::from),
            push_max_body_bytes: std::env::var("RELAY_PUSH_MAX_BODY_BYTES")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(1024 * 1024),
            event_retention_days: std::env::var("RELAY_EVENT_RETENTION_DAYS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(7),
            log: LogConfig {
                dir: std::env::var("RELAY_LOG_DIR")
                    .unwrap_or_else(|_| "./logs".into())
                    .into(),
                file_prefix: std::env::var("RELAY_LOG_FILE_PREFIX")
                    .unwrap_or_else(|_| "relay".into()),
                stdout: parse_stdout_format("RELAY_LOG_STDOUT")?,
            },
            routes: DownstreamRoutes::from_env(),
            force_close_grace_ms: std::env::var("RELAY_FORCE_CLOSE_GRACE_MS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(2000),
            allowed_client_ids: std::env::var("RELAY_ALLOWED_CLIENT_IDS")
                .ok()
                .filter(|s| !s.is_empty())
                .map(|s| s.split(',').map(|x| x.trim().to_string()).collect())
                .unwrap_or_else(|| vec!["rh_wxchat".to_string()]),
            auth_cache_max_entries: std::env::var("RELAY_AUTH_CACHE_MAX_ENTRIES")
                .ok()
                .and_then(|s| s.parse().ok())
                .filter(|n: &u64| *n > 0)
                .unwrap_or(10_000),
            notify_pull_enabled: std::env::var("RELAY_NOTIFY_PULL_ENABLED")
                .map(|v| v != "false" && v != "0")
                .unwrap_or(true),
            notify_pull_page_size: std::env::var("RELAY_NOTIFY_PULL_PAGE_SIZE")
                .ok()
                .and_then(|s| s.parse::<u32>().ok())
                .map(|n| n.clamp(1, 200))
                .unwrap_or(100),
            notify_pull_max_iters: std::env::var("RELAY_NOTIFY_PULL_MAX_ITERS")
                .ok()
                .and_then(|s| s.parse().ok())
                .filter(|n: &u32| *n > 0)
                .unwrap_or(50),
            notify_pull_budget_ms: std::env::var("RELAY_NOTIFY_PULL_BUDGET_MS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(4000),
            nacos,
        })
    }

    /// 解析后的聚合校验 —— 单点检查跨字段约束。错误用 `ValidationFailed` 一次返回全量,
    /// 而不是让 ops 一条一条改 + 重启。
    fn validate(&self) -> Result<(), ConfigError> {
        let mut errors: Vec<String> = Vec::new();

        // grpc 和 push 不能监听同一端口
        if self.grpc_addr == self.push_addr {
            errors.push(format!(
                "RELAY_GRPC_ADDR ({}) 与 RELAY_PUSH_ADDR ({}) 不能相同",
                self.grpc_addr, self.push_addr
            ));
        }

        // TLS 配置必须成对出现
        match (&self.tls_cert_path, &self.tls_key_path) {
            (Some(_), None) => errors.push(
                "RELAY_TLS_CERT_PATH 已设置但 RELAY_TLS_KEY_PATH 缺失;TLS 需成对出现否则会 fallback 到 plaintext"
                    .into(),
            ),
            (None, Some(_)) => errors.push(
                "RELAY_TLS_KEY_PATH 已设置但 RELAY_TLS_CERT_PATH 缺失;TLS 需成对出现否则会 fallback 到 plaintext"
                    .into(),
            ),
            _ => {}
        }

        if self.push_max_body_bytes == 0 {
            errors.push("RELAY_PUSH_MAX_BODY_BYTES 不能为 0".into());
        }
        if self.event_retention_days == 0 {
            errors.push("RELAY_EVENT_RETENTION_DAYS 不能为 0(否则 GC 启动即清空所有事件)".into());
        }
        if self.notify_pull_budget_ms == 0 {
            errors.push(
                "RELAY_NOTIFY_PULL_BUDGET_MS 不能为 0(否则补偿拉取永远超预算,等于禁用)".into(),
            );
        }
        if self.allowed_client_ids.is_empty() {
            errors.push("RELAY_ALLOWED_CLIENT_IDS 不能为空 — 否则没有任何 client 能 push".into());
        }

        // Nacos 仅在 enabled 时强校验,避免未启用的部署被无关变量卡启动。
        if self.nacos.enabled {
            if self.nacos.server_addr.is_empty() {
                errors.push("RELAY_NACOS_ENABLED=true 时 RELAY_NACOS_SERVER_ADDR 必填".into());
            }
            if self.nacos.discovery_service.is_empty() {
                errors
                    .push("RELAY_NACOS_ENABLED=true 时 RELAY_NACOS_DISCOVERY_SERVICE 必填".into());
            }
            if self.nacos.register_ip.is_empty() {
                errors.push(
                    "RELAY_NACOS_ENABLED=true 且 RELAY_PUSH_ADDR 为通配地址(0.0.0.0/::)时,\
                     必须显式设置 RELAY_NACOS_REGISTER_IP 为业务后台可达的 relay IP"
                        .into(),
                );
            }
            match self.nacos.discovery_scheme.as_str() {
                "https" => {}
                "http" => {
                    let allow_http = std::env::var("RELAY_ALLOW_HTTP")
                        .map(|v| v == "true" || v == "1")
                        .unwrap_or(false);
                    if !allow_http {
                        errors.push(
                            "RELAY_NACOS_DISCOVERY_SCHEME=http 会让客户端 Bearer token 明文上行;\
                             生产请用 https,dev 需显式设 RELAY_ALLOW_HTTP=true 确认"
                                .into(),
                        );
                    }
                }
                other => errors.push(format!(
                    "RELAY_NACOS_DISCOVERY_SCHEME 只能是 http|https,得到 `{other}`"
                )),
            }
        }

        // 弱约束 — eprintln 不阻止启动(dev 脚本默认 `push-secret` 长度 11 会触发)。
        // 用 eprintln 而非 tracing::warn!,因为本函数在 init_tracing 之前调用。
        if self.push_secret.len() < 32 {
            eprintln!(
                "[chathub-relay] WARN: RELAY_PUSH_SECRET 长度 {} < 32,生产建议 ≥ 32 字符以抵抗暴力枚举",
                self.push_secret.len()
            );
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(ConfigError::ValidationFailed(errors.join("; ")))
        }
    }

    /// 启动日志用 — 把所有生效配置 dump 出来,**自动脱敏 secret 字段**。
    /// Ops 看一眼就知道当前 relay 实际生效的是什么,无需翻 env 现场。
    pub fn dump_redacted(&self) -> String {
        use crate::secret::Redacted;
        let tls = match (&self.tls_cert_path, &self.tls_key_path) {
            (Some(c), Some(k)) => format!("enabled(cert={}, key={})", c.display(), k.display()),
            _ => "disabled (plaintext)".into(),
        };
        let mut routes: Vec<&String> = self.routes.map.keys().collect();
        routes.sort();
        let nacos = if self.nacos.enabled {
            format!(
                "enabled(server={}, namespace={:?}, group={}, username={:?}, password={}, \
                 discovery_service={}, discovery_scheme={}, register={}:{}@{} weight={})",
                self.nacos.server_addr,
                self.nacos.namespace,
                self.nacos.group,
                self.nacos.username,
                self.nacos
                    .password
                    .as_deref()
                    .map(|p| Redacted(p).to_string())
                    .unwrap_or_else(|| "<none>".into()),
                self.nacos.discovery_service,
                self.nacos.discovery_scheme,
                self.nacos.register_service,
                self.nacos.register_ip,
                self.nacos.register_port,
                self.nacos.register_weight,
            )
        } else {
            "disabled (static downstream_url)".into()
        };
        format!(
            "Config {{\n\
             \x20  grpc_addr             = {}\n\
             \x20  push_addr             = {}\n\
             \x20  db_path               = {}\n\
             \x20  downstream_url        = {}\n\
             \x20  push_secret           = {}\n\
             \x20  path_login            = {}\n\
             \x20  path_verify_token     = {}\n\
             \x20  path_logout           = {}\n\
             \x20  path_notify_pull      = {}\n\
             \x20  oauth_client_id       = {}\n\
             \x20  oauth_client_secret   = {}\n\
             \x20  tls                   = {}\n\
             \x20  push_max_body_bytes   = {}\n\
             \x20  event_retention_days  = {}\n\
             \x20  force_close_grace_ms  = {}\n\
             \x20  allowed_client_ids    = {:?}\n\
             \x20  auth_cache_max_entries= {}\n\
             \x20  notify_pull_enabled   = {}\n\
             \x20  notify_pull_page_size = {}\n\
             \x20  notify_pull_max_iters = {}\n\
             \x20  notify_pull_budget_ms = {}\n\
             \x20  nacos                 = {}\n\
             \x20  log.dir               = {}\n\
             \x20  log.file_prefix       = {}\n\
             \x20  log.stdout            = {:?}\n\
             \x20  routes                = {:?}\n\
             }}",
            self.grpc_addr,
            self.push_addr,
            self.db_path.display(),
            self.downstream_url,
            Redacted(&self.push_secret),
            self.path_login,
            self.path_verify_token,
            self.path_logout,
            self.path_notify_pull,
            self.oauth_client_id,
            Redacted(&self.oauth_client_secret),
            tls,
            self.push_max_body_bytes,
            self.event_retention_days,
            self.force_close_grace_ms,
            self.allowed_client_ids,
            self.auth_cache_max_entries,
            self.notify_pull_enabled,
            self.notify_pull_page_size,
            self.notify_pull_max_iters,
            self.notify_pull_budget_ms,
            nacos,
            self.log.dir.display(),
            self.log.file_prefix,
            self.log.stdout,
            routes,
        )
    }
}

impl NacosConfig {
    /// 从 env 读取。`push_addr` 用于推导 register_ip / register_port 默认值。
    /// 注:enabled=false 时其余字段仍被解析(取默认),但不会被使用;必填校验在 `Config::validate` 内,
    /// 仅在 enabled=true 时生效,避免未启用 Nacos 的部署被无关变量卡启动。
    fn from_env(push_addr: SocketAddr) -> Result<Self, ConfigError> {
        let enabled = std::env::var("RELAY_NACOS_ENABLED")
            .map(|v| v == "true" || v == "1")
            .unwrap_or(false);

        // register_ip 默认:push_addr 是具体非通配 IP 则取之;0.0.0.0/:: 时留空(validate 要求显式给)。
        let default_register_ip = {
            let ip = push_addr.ip();
            if ip.is_unspecified() {
                String::new()
            } else {
                ip.to_string()
            }
        };

        Ok(Self {
            enabled,
            server_addr: std::env::var("RELAY_NACOS_SERVER_ADDR").unwrap_or_default(),
            namespace: std::env::var("RELAY_NACOS_NAMESPACE").unwrap_or_default(),
            group: std::env::var("RELAY_NACOS_GROUP")
                .ok()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "DEFAULT_GROUP".into()),
            username: std::env::var("RELAY_NACOS_USERNAME")
                .ok()
                .filter(|s| !s.is_empty()),
            password: read_optional_secret_with_file_fallback(
                "RELAY_NACOS_PASSWORD",
                "RELAY_NACOS_PASSWORD_FILE",
            )?,
            discovery_service: std::env::var("RELAY_NACOS_DISCOVERY_SERVICE").unwrap_or_default(),
            discovery_scheme: std::env::var("RELAY_NACOS_DISCOVERY_SCHEME")
                .ok()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "https".into()),
            register_service: std::env::var("RELAY_NACOS_REGISTER_SERVICE")
                .ok()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "chathub-relay".into()),
            register_ip: std::env::var("RELAY_NACOS_REGISTER_IP")
                .ok()
                .filter(|s| !s.is_empty())
                .unwrap_or(default_register_ip),
            register_port: std::env::var("RELAY_NACOS_REGISTER_PORT")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or_else(|| push_addr.port()),
            register_weight: std::env::var("RELAY_NACOS_REGISTER_WEIGHT")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(1.0),
            register_metadata: parse_kv_metadata(
                std::env::var("RELAY_NACOS_REGISTER_METADATA")
                    .ok()
                    .as_deref(),
            ),
        })
    }
}

/// 解析 `k=v,k2=v2` 形式的元数据。空串/None → 空 map。忽略无 `=` 或空 key 的片段。
fn parse_kv_metadata(raw: Option<&str>) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Some(raw) = raw else {
        return map;
    };
    for pair in raw.split(',') {
        if let Some((k, v)) = pair.split_once('=') {
            let k = k.trim();
            if !k.is_empty() {
                map.insert(k.to_string(), v.trim().to_string());
            }
        }
    }
    map
}

/// 可选 secret 的 *_FILE 回退:优先 file_var(去空白),其次 direct_var,二者皆缺 → None。
fn read_optional_secret_with_file_fallback(
    direct_var: &'static str,
    file_var: &'static str,
) -> Result<Option<String>, ConfigError> {
    if let Some(v) = read_secret_file_if_set(file_var)? {
        return Ok(Some(v).filter(|s| !s.is_empty()));
    }
    Ok(std::env::var(direct_var).ok().filter(|s| !s.is_empty()))
}

fn parse_stdout_format(var: &'static str) -> Result<StdoutFormat, ConfigError> {
    let raw = std::env::var(var).unwrap_or_else(|_| "compact".into());
    match raw.as_str() {
        "off" => Ok(StdoutFormat::Off),
        "compact" => Ok(StdoutFormat::Compact),
        "pretty" => Ok(StdoutFormat::Pretty),
        "json" => Ok(StdoutFormat::Json),
        other => Err(ConfigError::Invalid {
            var,
            message: format!("expected one of off|compact|pretty|json, got `{other}`"),
        }),
    }
}

fn required(var: &'static str) -> Result<String, ConfigError> {
    std::env::var(var)
        .ok()
        .filter(|s| !s.is_empty())
        .ok_or(ConfigError::Missing(var))
}

/// F2 安全:downstream URL 必须 https,除非显式 RELAY_ALLOW_HTTP=true(dev 用)。
fn validate_downstream_scheme(url: &str) -> Result<(), ConfigError> {
    if url.starts_with("https://") {
        return Ok(());
    }
    let allow = std::env::var("RELAY_ALLOW_HTTP")
        .map(|v| v == "true" || v == "1")
        .unwrap_or(false);
    if allow {
        tracing::warn!(
            "RELAY_DOWNSTREAM_URL is not https — all client Bearer tokens will be sent cleartext. \
             This is only acceptable for dev. Set https in production."
        );
        Ok(())
    } else {
        Err(ConfigError::Insecure(
            "RELAY_DOWNSTREAM_URL must be https (else tokens leak)",
        ))
    }
}

/// F2 安全:secret 可从 *_FILE 读(生产推荐 secrets manager 挂文件),否则取直填,最后默认。
fn read_secret_with_file_fallback(
    direct_var: &'static str,
    file_var: &'static str,
    default: &str,
) -> Result<String, ConfigError> {
    if let Some(v) = read_secret_file_if_set(file_var)? {
        return Ok(v);
    }
    Ok(std::env::var(direct_var).unwrap_or_else(|_| default.to_string()))
}

/// 必填 secret 的 *_FILE 回退:优先 file_var,其次 direct_var,二者皆缺 → `Missing(direct_var)`。
fn required_secret_with_file_fallback(
    direct_var: &'static str,
    file_var: &'static str,
) -> Result<String, ConfigError> {
    if let Some(v) = read_secret_file_if_set(file_var)? {
        if v.is_empty() {
            return Err(ConfigError::Invalid {
                var: file_var,
                message: "file is empty".into(),
            });
        }
        return Ok(v);
    }
    required(direct_var)
}

fn read_secret_file_if_set(file_var: &'static str) -> Result<Option<String>, ConfigError> {
    let Ok(path) = std::env::var(file_var) else {
        return Ok(None);
    };
    let content = std::fs::read_to_string(&path).map_err(|e| ConfigError::Io {
        var: file_var,
        path: path.clone(),
        source: e,
    })?;
    Ok(Some(content.trim().to_string()))
}

fn parse_addr_or(var: &'static str, default: &str) -> Result<SocketAddr, ConfigError> {
    let raw = std::env::var(var).unwrap_or_else(|_| default.into());
    raw.parse()
        .map_err(|e: std::net::AddrParseError| ConfigError::Invalid {
            var,
            message: e.to_string(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `std::env::set_var` 在多线程测试下不安全,用 lock 保证单线程。
    static ENV_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

    fn clear_all() {
        for k in [
            "RELAY_GRPC_ADDR",
            "RELAY_PUSH_ADDR",
            "RELAY_DB_PATH",
            "RELAY_DOWNSTREAM_URL",
            "RELAY_DOWNSTREAM_SECRET",
            "RELAY_PUSH_SECRET",
            "RELAY_LOG_DIR",
            "RELAY_LOG_FILE_PREFIX",
            "RELAY_LOG_STDOUT",
            "RELAY_PATH_SEND",
            "RELAY_PATH_RECALL",
            "RELAY_PATH_ACK_READ",
            "RELAY_PATH_FETCH_HISTORY",
            "RELAY_PATH_SEND_MESSAGE",
            "RELAY_PATH_LIST_ACCOUNTS",
            "RELAY_PATH_LIST_FRIENDS",
            "RELAY_PATH_FRIEND_DETAIL",
            "RELAY_PATH_LIST_RECENT_FRIENDS",
            "RELAY_PATH_LOGIN",
            "RELAY_PATH_VERIFY_TOKEN",
            "RELAY_PATH_LOGOUT",
            "RELAY_OAUTH_CLIENT_ID",
            "RELAY_OAUTH_CLIENT_SECRET",
            "RELAY_OAUTH_CLIENT_SECRET_FILE",
            "RELAY_FORCE_CLOSE_GRACE_MS",
            "RELAY_ALLOWED_CLIENT_IDS",
            "RELAY_ALLOW_HTTP",
            "RELAY_TLS_CERT_PATH",
            "RELAY_TLS_KEY_PATH",
            "RELAY_PUSH_MAX_BODY_BYTES",
            "RELAY_EVENT_RETENTION_DAYS",
            "RELAY_PATH_NOTIFY_PULL",
            "RELAY_NOTIFY_PULL_ENABLED",
            "RELAY_NOTIFY_PULL_PAGE_SIZE",
            "RELAY_NOTIFY_PULL_MAX_ITERS",
            "RELAY_NOTIFY_PULL_BUDGET_MS",
            "RELAY_NACOS_ENABLED",
            "RELAY_NACOS_SERVER_ADDR",
            "RELAY_NACOS_NAMESPACE",
            "RELAY_NACOS_GROUP",
            "RELAY_NACOS_USERNAME",
            "RELAY_NACOS_PASSWORD",
            "RELAY_NACOS_PASSWORD_FILE",
            "RELAY_NACOS_DISCOVERY_SERVICE",
            "RELAY_NACOS_DISCOVERY_SCHEME",
            "RELAY_NACOS_REGISTER_SERVICE",
            "RELAY_NACOS_REGISTER_IP",
            "RELAY_NACOS_REGISTER_PORT",
            "RELAY_NACOS_REGISTER_WEIGHT",
            "RELAY_NACOS_REGISTER_METADATA",
        ] {
            std::env::remove_var(k);
        }
    }

    fn set_required() {
        std::env::set_var("RELAY_PUSH_SECRET", "ps");
        std::env::set_var("RELAY_DOWNSTREAM_URL", "http://dn.local");
        std::env::set_var("RELAY_ALLOW_HTTP", "true"); // 测试用 http
    }

    #[test]
    fn from_env_happy_path_uses_defaults_for_optional() {
        let _g = ENV_LOCK.lock();
        clear_all();
        set_required();

        let cfg = Config::from_env().expect("config");
        assert_eq!(cfg.grpc_addr.to_string(), "127.0.0.1:50051");
        assert_eq!(cfg.push_addr.to_string(), "127.0.0.1:50052");
        assert_eq!(cfg.push_secret, "ps");
        assert_eq!(cfg.downstream_url, "http://dn.local");
        assert_eq!(cfg.path_login, "/account-app/oauth2/token");
        assert_eq!(
            cfg.path_verify_token,
            "/wechat-business-app/wecom-cs/v1/wecomAggregate/connection/verifyToken"
        );
        assert_eq!(cfg.path_logout, "/auth/logout");
        assert_eq!(cfg.oauth_client_id, "rh_wxchat");
        assert_eq!(cfg.oauth_client_secret, "rh_wxchat");
        clear_all();
    }

    #[test]
    fn from_env_missing_push_secret_errors() {
        let _g = ENV_LOCK.lock();
        clear_all();
        std::env::set_var("RELAY_DOWNSTREAM_URL", "https://dn.local"); // 用 https 跳过 ALLOW_HTTP gate
                                                                       // PUSH_SECRET 故意不设
        let err = Config::from_env().unwrap_err();
        match err {
            ConfigError::Missing(v) => assert_eq!(v, "RELAY_PUSH_SECRET"),
            other => panic!("wrong variant: {other:?}"),
        }
        clear_all();
    }

    #[test]
    fn from_env_no_longer_requires_downstream_secret() {
        let _g = ENV_LOCK.lock();
        clear_all();
        set_required();
        // 不设 DOWNSTREAM_SECRET 也能启动(已下线)
        let cfg = Config::from_env().expect("config");
        assert_eq!(cfg.downstream_url, "http://dn.local");
        clear_all();
    }

    #[test]
    fn from_env_log_defaults_apply_when_log_vars_unset() {
        let _g = ENV_LOCK.lock();
        clear_all();
        set_required();
        let cfg = Config::from_env().expect("config");
        assert_eq!(cfg.log.dir.to_string_lossy(), "./logs");
        assert_eq!(cfg.log.file_prefix, "relay");
        assert_eq!(cfg.log.stdout, StdoutFormat::Compact);
        clear_all();
    }

    #[test]
    fn from_env_log_overrides_pick_up_env_vars() {
        let _g = ENV_LOCK.lock();
        clear_all();
        set_required();
        std::env::set_var("RELAY_LOG_DIR", "/var/log/relay");
        std::env::set_var("RELAY_LOG_FILE_PREFIX", "relay-prod");
        std::env::set_var("RELAY_LOG_STDOUT", "json");
        let cfg = Config::from_env().expect("config");
        assert_eq!(cfg.log.dir.to_string_lossy(), "/var/log/relay");
        assert_eq!(cfg.log.file_prefix, "relay-prod");
        assert_eq!(cfg.log.stdout, StdoutFormat::Json);
        clear_all();
    }

    #[test]
    fn from_env_log_stdout_off_parses() {
        let _g = ENV_LOCK.lock();
        clear_all();
        set_required();
        std::env::set_var("RELAY_LOG_STDOUT", "off");
        let cfg = Config::from_env().expect("config");
        assert_eq!(cfg.log.stdout, StdoutFormat::Off);
        clear_all();
    }

    #[test]
    fn from_env_log_stdout_invalid_value_errors() {
        let _g = ENV_LOCK.lock();
        clear_all();
        set_required();
        std::env::set_var("RELAY_LOG_STDOUT", "verbose");
        let err = Config::from_env().unwrap_err();
        match err {
            ConfigError::Invalid { var, .. } => assert_eq!(var, "RELAY_LOG_STDOUT"),
            other => panic!("wrong: {other:?}"),
        }
        clear_all();
    }

    #[test]
    fn from_env_oauth_credentials_override() {
        let _g = ENV_LOCK.lock();
        clear_all();
        set_required();
        std::env::set_var("RELAY_OAUTH_CLIENT_ID", "client-x");
        std::env::set_var("RELAY_OAUTH_CLIENT_SECRET", "shhh");
        let cfg = Config::from_env().expect("config");
        assert_eq!(cfg.oauth_client_id, "client-x");
        assert_eq!(cfg.oauth_client_secret, "shhh");
        clear_all();
    }

    #[test]
    fn downstream_routes_default_when_no_env() {
        let _g = ENV_LOCK.lock();
        clear_all();
        let r = DownstreamRoutes::from_env();
        let send = r.get("send").expect("send");
        assert_eq!(send.method, HttpMethod::Post);
        assert_eq!(send.path, "/v1/send");
        let list = r.get("list_accounts").expect("list");
        assert_eq!(list.method, HttpMethod::Get);
        assert_eq!(
            list.path,
            "/wechat-business-app/wecom-cs/v1/wecomAggregate/account/listMine"
        );
        assert!(r.get("unknown").is_none());
    }

    #[test]
    fn downstream_routes_env_overrides_path_only_keeps_default_verb() {
        let _g = ENV_LOCK.lock();
        clear_all();
        std::env::set_var("RELAY_PATH_SEND", "/v2/messages/send");
        let r = DownstreamRoutes::from_env();
        let send = r.get("send").unwrap();
        assert_eq!(send.method, HttpMethod::Post); // 没指定 prefix → 取默认 POST
        assert_eq!(send.path, "/v2/messages/send");
        clear_all();
    }

    #[test]
    fn downstream_routes_env_with_get_prefix_switches_verb() {
        let _g = ENV_LOCK.lock();
        clear_all();
        std::env::set_var("RELAY_PATH_SEND", "GET:/v2/messages/send");
        let r = DownstreamRoutes::from_env();
        let send = r.get("send").unwrap();
        assert_eq!(send.method, HttpMethod::Get);
        assert_eq!(send.path, "/v2/messages/send");
        clear_all();
    }

    #[test]
    fn downstream_routes_env_with_post_prefix_keeps_post() {
        let _g = ENV_LOCK.lock();
        clear_all();
        std::env::set_var("RELAY_PATH_LIST_ACCOUNTS", "POST:/v2/accounts");
        let r = DownstreamRoutes::from_env();
        let la = r.get("list_accounts").unwrap();
        assert_eq!(la.method, HttpMethod::Post);
        assert_eq!(la.path, "/v2/accounts");
        clear_all();
    }

    #[test]
    fn downstream_routes_env_prefix_case_insensitive() {
        let _g = ENV_LOCK.lock();
        clear_all();
        std::env::set_var("RELAY_PATH_SEND", "get:/a");
        let r = DownstreamRoutes::from_env();
        assert_eq!(r.get("send").unwrap().method, HttpMethod::Get);
        clear_all();
    }

    #[test]
    fn downstream_routes_env_unknown_prefix_treated_as_path() {
        // 比如 "PUT:/foo" 当前不支持,落回默认 verb + 整个 value 当 path
        let _g = ENV_LOCK.lock();
        clear_all();
        std::env::set_var("RELAY_PATH_SEND", "PUT:/foo");
        let r = DownstreamRoutes::from_env();
        let send = r.get("send").unwrap();
        assert_eq!(send.method, HttpMethod::Post); // 默认
        assert_eq!(send.path, "PUT:/foo"); // 整体当 path
        clear_all();
    }

    #[test]
    fn config_from_env_includes_routes() {
        let _g = ENV_LOCK.lock();
        clear_all();
        set_required();
        std::env::set_var("RELAY_PATH_SEND", "/v3/send");
        let cfg = Config::from_env().expect("config");
        assert_eq!(cfg.routes.path_for("send"), Some("/v3/send"));
        clear_all();
    }

    #[test]
    fn from_env_https_downstream_url_accepted_without_opt_in() {
        let _g = ENV_LOCK.lock();
        clear_all();
        std::env::set_var("RELAY_PUSH_SECRET", "ps");
        std::env::set_var("RELAY_DOWNSTREAM_URL", "https://dn.local");
        // 不设 RELAY_ALLOW_HTTP
        Config::from_env().expect("https url OK without opt-in");
        clear_all();
    }

    #[test]
    fn from_env_http_downstream_url_rejected_without_opt_in() {
        let _g = ENV_LOCK.lock();
        clear_all();
        std::env::set_var("RELAY_PUSH_SECRET", "ps");
        std::env::set_var("RELAY_DOWNSTREAM_URL", "http://dn.local");
        // RELAY_ALLOW_HTTP 故意不设
        let err = Config::from_env().unwrap_err();
        assert!(matches!(err, ConfigError::Insecure(_)));
        clear_all();
    }

    #[test]
    fn from_env_oauth_secret_from_file_overrides_direct() {
        let _g = ENV_LOCK.lock();
        clear_all();
        set_required();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secret.txt");
        std::fs::write(&path, "from-file-secret\n").unwrap();
        std::env::set_var("RELAY_OAUTH_CLIENT_SECRET", "from-direct-env"); // 应被 file 盖
        std::env::set_var("RELAY_OAUTH_CLIENT_SECRET_FILE", path.to_str().unwrap());
        let cfg = Config::from_env().expect("config");
        assert_eq!(cfg.oauth_client_secret, "from-file-secret");
        clear_all();
    }

    #[test]
    fn from_env_oauth_secret_file_missing_errors() {
        let _g = ENV_LOCK.lock();
        clear_all();
        set_required();
        std::env::set_var("RELAY_OAUTH_CLIENT_SECRET_FILE", "/no/such/path");
        let err = Config::from_env().unwrap_err();
        assert!(matches!(err, ConfigError::Io { .. }));
        clear_all();
    }

    #[test]
    fn from_env_push_max_body_bytes_default_1mb() {
        let _g = ENV_LOCK.lock();
        clear_all();
        set_required();
        let cfg = Config::from_env().unwrap();
        assert_eq!(cfg.push_max_body_bytes, 1024 * 1024);
        clear_all();
    }

    #[test]
    fn from_env_tls_paths_default_none() {
        let _g = ENV_LOCK.lock();
        clear_all();
        set_required();
        let cfg = Config::from_env().unwrap();
        assert!(cfg.tls_cert_path.is_none());
        assert!(cfg.tls_key_path.is_none());
        clear_all();
    }

    #[test]
    fn from_env_invalid_grpc_addr_errors() {
        let _g = ENV_LOCK.lock();
        clear_all();
        set_required();
        std::env::set_var("RELAY_GRPC_ADDR", "not-an-addr");
        let err = Config::from_env().unwrap_err();
        match err {
            ConfigError::Invalid { var, .. } => assert_eq!(var, "RELAY_GRPC_ADDR"),
            other => panic!("wrong: {other:?}"),
        }
        clear_all();
    }

    #[test]
    fn validate_rejects_same_grpc_and_push_addr() {
        let _g = ENV_LOCK.lock();
        clear_all();
        set_required();
        std::env::set_var("RELAY_GRPC_ADDR", "127.0.0.1:60001");
        std::env::set_var("RELAY_PUSH_ADDR", "127.0.0.1:60001");
        let err = Config::from_env().unwrap_err();
        assert!(matches!(err, ConfigError::ValidationFailed(_)));
        clear_all();
    }

    #[test]
    fn validate_rejects_tls_cert_without_key() {
        let _g = ENV_LOCK.lock();
        clear_all();
        set_required();
        std::env::set_var("RELAY_TLS_CERT_PATH", "/tmp/cert.pem");
        // KEY_PATH 故意不设
        let err = Config::from_env().unwrap_err();
        match err {
            ConfigError::ValidationFailed(m) => assert!(m.contains("RELAY_TLS_KEY_PATH")),
            other => panic!("wrong: {other:?}"),
        }
        clear_all();
    }

    #[test]
    fn validate_rejects_zero_retention() {
        let _g = ENV_LOCK.lock();
        clear_all();
        set_required();
        std::env::set_var("RELAY_EVENT_RETENTION_DAYS", "0");
        let err = Config::from_env().unwrap_err();
        match err {
            ConfigError::ValidationFailed(m) => assert!(m.contains("RELAY_EVENT_RETENTION_DAYS")),
            other => panic!("wrong: {other:?}"),
        }
        clear_all();
    }

    #[test]
    fn notify_pull_defaults_apply() {
        let _g = ENV_LOCK.lock();
        clear_all();
        set_required();
        let cfg = Config::from_env().unwrap();
        assert_eq!(
            cfg.path_notify_pull,
            "/wechat-business-app/rpc/v1/wecomAggregate/notify/pull"
        );
        assert!(cfg.notify_pull_enabled);
        assert_eq!(cfg.notify_pull_page_size, 100);
        assert_eq!(cfg.notify_pull_max_iters, 50);
        assert_eq!(cfg.notify_pull_budget_ms, 4000);
        clear_all();
    }

    #[test]
    fn notify_pull_overrides_and_clamps() {
        let _g = ENV_LOCK.lock();
        clear_all();
        set_required();
        std::env::set_var("RELAY_PATH_NOTIFY_PULL", "/custom/pull");
        std::env::set_var("RELAY_NOTIFY_PULL_ENABLED", "false");
        std::env::set_var("RELAY_NOTIFY_PULL_PAGE_SIZE", "999"); // 夹到 200
        std::env::set_var("RELAY_NOTIFY_PULL_MAX_ITERS", "10");
        std::env::set_var("RELAY_NOTIFY_PULL_BUDGET_MS", "2000");
        let cfg = Config::from_env().unwrap();
        assert_eq!(cfg.path_notify_pull, "/custom/pull");
        assert!(!cfg.notify_pull_enabled);
        assert_eq!(cfg.notify_pull_page_size, 200);
        assert_eq!(cfg.notify_pull_max_iters, 10);
        assert_eq!(cfg.notify_pull_budget_ms, 2000);
        clear_all();
    }

    #[test]
    fn notify_pull_page_size_zero_clamps_to_one() {
        let _g = ENV_LOCK.lock();
        clear_all();
        set_required();
        std::env::set_var("RELAY_NOTIFY_PULL_PAGE_SIZE", "0");
        let cfg = Config::from_env().unwrap();
        assert_eq!(cfg.notify_pull_page_size, 1);
        clear_all();
    }

    #[test]
    fn validate_rejects_zero_notify_pull_budget() {
        let _g = ENV_LOCK.lock();
        clear_all();
        set_required();
        std::env::set_var("RELAY_NOTIFY_PULL_BUDGET_MS", "0");
        let err = Config::from_env().unwrap_err();
        match err {
            ConfigError::ValidationFailed(m) => assert!(m.contains("RELAY_NOTIFY_PULL_BUDGET_MS")),
            other => panic!("wrong: {other:?}"),
        }
        clear_all();
    }

    #[test]
    fn dump_redacted_hides_push_and_oauth_secrets() {
        let _g = ENV_LOCK.lock();
        clear_all();
        set_required();
        std::env::set_var("RELAY_PUSH_SECRET", "super-secret-push-token-xyz-abc-123");
        std::env::set_var(
            "RELAY_OAUTH_CLIENT_SECRET",
            "super-secret-oauth-value-xyz-456",
        );
        let cfg = Config::from_env().unwrap();
        let dump = cfg.dump_redacted();
        // 不能出现完整 secret;只允许出现脱敏前 8 char
        assert!(!dump.contains("super-secret-push-token-xyz-abc-123"));
        assert!(!dump.contains("super-secret-oauth-value-xyz-456"));
        // 应包含前 8 + ***
        assert!(dump.contains("super-se***"));
        // 同时也覆盖了非 secret 字段透出
        assert!(dump.contains("auth_cache_max_entries"));
        clear_all();
    }

    #[test]
    fn auth_cache_max_entries_default_and_override() {
        let _g = ENV_LOCK.lock();
        clear_all();
        set_required();
        let cfg = Config::from_env().unwrap();
        assert_eq!(cfg.auth_cache_max_entries, 10_000);

        std::env::set_var("RELAY_AUTH_CACHE_MAX_ENTRIES", "50000");
        let cfg = Config::from_env().unwrap();
        assert_eq!(cfg.auth_cache_max_entries, 50_000);

        // 0 → fallback 默认(filter > 0)
        std::env::set_var("RELAY_AUTH_CACHE_MAX_ENTRIES", "0");
        let cfg = Config::from_env().unwrap();
        assert_eq!(cfg.auth_cache_max_entries, 10_000);
        clear_all();
    }

    #[test]
    fn push_secret_from_file_overrides_direct() {
        let _g = ENV_LOCK.lock();
        clear_all();
        std::env::set_var("RELAY_DOWNSTREAM_URL", "http://dn.local");
        std::env::set_var("RELAY_ALLOW_HTTP", "true");
        // 写一个临时文件
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("push.secret");
        std::fs::write(&path, "file-based-push-secret\n").unwrap();
        std::env::set_var("RELAY_PUSH_SECRET_FILE", &path);
        // direct 不设
        let cfg = Config::from_env().unwrap();
        assert_eq!(cfg.push_secret, "file-based-push-secret");
        clear_all();
        std::env::remove_var("RELAY_PUSH_SECRET_FILE");
    }

    // ─── Nacos ───────────────────────────────────────────────────────

    #[test]
    fn nacos_disabled_by_default() {
        let _g = ENV_LOCK.lock();
        clear_all();
        set_required();
        let cfg = Config::from_env().expect("config");
        // 未启用 → 即使缺 server_addr / discovery_service 也能启动
        assert!(!cfg.nacos.enabled);
        clear_all();
    }

    fn set_nacos_enabled_minimal() {
        std::env::set_var("RELAY_NACOS_ENABLED", "true");
        std::env::set_var("RELAY_NACOS_SERVER_ADDR", "127.0.0.1:8848");
        std::env::set_var("RELAY_NACOS_DISCOVERY_SERVICE", "wechat-business-app");
    }

    #[test]
    fn nacos_enabled_requires_server_and_discovery_service() {
        let _g = ENV_LOCK.lock();
        clear_all();
        set_required();
        std::env::set_var("RELAY_NACOS_ENABLED", "true");
        // server_addr / discovery_service 都不设
        let err = Config::from_env().unwrap_err();
        match err {
            ConfigError::ValidationFailed(m) => {
                assert!(m.contains("RELAY_NACOS_SERVER_ADDR"));
                assert!(m.contains("RELAY_NACOS_DISCOVERY_SERVICE"));
            }
            other => panic!("wrong: {other:?}"),
        }
        clear_all();
    }

    #[test]
    fn nacos_enabled_happy_path_defaults() {
        let _g = ENV_LOCK.lock();
        clear_all();
        set_required(); // push_addr 默认 127.0.0.1:50052 → register_ip 推导出 127.0.0.1
        set_nacos_enabled_minimal();
        let cfg = Config::from_env().expect("config");
        assert!(cfg.nacos.enabled);
        assert_eq!(cfg.nacos.group, "DEFAULT_GROUP");
        assert_eq!(cfg.nacos.discovery_scheme, "https");
        assert_eq!(cfg.nacos.register_service, "chathub-relay");
        assert_eq!(cfg.nacos.register_ip, "127.0.0.1");
        assert_eq!(cfg.nacos.register_port, 50052);
        assert_eq!(cfg.nacos.register_weight, 1.0);
        assert!(cfg.nacos.username.is_none());
        clear_all();
    }

    #[test]
    fn nacos_wildcard_push_addr_requires_register_ip() {
        let _g = ENV_LOCK.lock();
        clear_all();
        set_required();
        set_nacos_enabled_minimal();
        std::env::set_var("RELAY_PUSH_ADDR", "0.0.0.0:50052"); // 通配 → register_ip 留空
        let err = Config::from_env().unwrap_err();
        match err {
            ConfigError::ValidationFailed(m) => assert!(m.contains("RELAY_NACOS_REGISTER_IP")),
            other => panic!("wrong: {other:?}"),
        }
        clear_all();
    }

    #[test]
    fn nacos_wildcard_push_addr_ok_with_explicit_register_ip() {
        let _g = ENV_LOCK.lock();
        clear_all();
        set_required();
        set_nacos_enabled_minimal();
        std::env::set_var("RELAY_PUSH_ADDR", "0.0.0.0:50052");
        std::env::set_var("RELAY_NACOS_REGISTER_IP", "10.0.0.5");
        std::env::set_var("RELAY_NACOS_REGISTER_PORT", "18080");
        let cfg = Config::from_env().expect("config");
        assert_eq!(cfg.nacos.register_ip, "10.0.0.5");
        assert_eq!(cfg.nacos.register_port, 18080);
        clear_all();
    }

    #[test]
    fn nacos_http_scheme_requires_allow_http() {
        let _g = ENV_LOCK.lock();
        clear_all();
        // 不用 set_required(它设 ALLOW_HTTP=true);手动用 https downstream 跳过 downstream gate
        std::env::set_var("RELAY_PUSH_SECRET", "ps");
        std::env::set_var("RELAY_DOWNSTREAM_URL", "https://dn.local");
        set_nacos_enabled_minimal();
        std::env::set_var("RELAY_NACOS_DISCOVERY_SCHEME", "http");
        // 不设 RELAY_ALLOW_HTTP → 应报错
        let err = Config::from_env().unwrap_err();
        match err {
            ConfigError::ValidationFailed(m) => {
                assert!(m.contains("RELAY_NACOS_DISCOVERY_SCHEME"))
            }
            other => panic!("wrong: {other:?}"),
        }
        clear_all();
    }

    #[test]
    fn nacos_http_scheme_ok_with_allow_http() {
        let _g = ENV_LOCK.lock();
        clear_all();
        set_required(); // 含 ALLOW_HTTP=true
        set_nacos_enabled_minimal();
        std::env::set_var("RELAY_NACOS_DISCOVERY_SCHEME", "http");
        let cfg = Config::from_env().expect("config");
        assert_eq!(cfg.nacos.discovery_scheme, "http");
        clear_all();
    }

    #[test]
    fn nacos_invalid_scheme_rejected() {
        let _g = ENV_LOCK.lock();
        clear_all();
        set_required();
        set_nacos_enabled_minimal();
        std::env::set_var("RELAY_NACOS_DISCOVERY_SCHEME", "ftp");
        let err = Config::from_env().unwrap_err();
        match err {
            ConfigError::ValidationFailed(m) => assert!(m.contains("http|https")),
            other => panic!("wrong: {other:?}"),
        }
        clear_all();
    }

    #[test]
    fn nacos_register_metadata_parsed() {
        let _g = ENV_LOCK.lock();
        clear_all();
        set_required();
        set_nacos_enabled_minimal();
        std::env::set_var(
            "RELAY_NACOS_REGISTER_METADATA",
            "scheme=http, pushPath=/rpc/v1/notify/push ,bad,=novalue,k=",
        );
        let cfg = Config::from_env().expect("config");
        let md = &cfg.nacos.register_metadata;
        assert_eq!(md.get("scheme").map(String::as_str), Some("http"));
        assert_eq!(
            md.get("pushPath").map(String::as_str),
            Some("/rpc/v1/notify/push")
        );
        assert_eq!(md.get("k").map(String::as_str), Some("")); // 空值保留
        assert!(!md.contains_key("bad")); // 无 '=' 忽略
        assert_eq!(md.len(), 3); // scheme / pushPath / k(=novalue 空 key 被忽略)
        clear_all();
    }

    #[test]
    fn nacos_password_from_file_overrides_direct() {
        let _g = ENV_LOCK.lock();
        clear_all();
        set_required();
        set_nacos_enabled_minimal();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nacos.pass");
        std::fs::write(&path, "file-nacos-pass\n").unwrap();
        std::env::set_var("RELAY_NACOS_PASSWORD", "direct-pass"); // 应被 file 盖
        std::env::set_var("RELAY_NACOS_PASSWORD_FILE", path.to_str().unwrap());
        let cfg = Config::from_env().expect("config");
        assert_eq!(cfg.nacos.password.as_deref(), Some("file-nacos-pass"));
        clear_all();
    }

    #[test]
    fn nacos_dump_redacts_password() {
        let _g = ENV_LOCK.lock();
        clear_all();
        set_required();
        set_nacos_enabled_minimal();
        std::env::set_var("RELAY_NACOS_USERNAME", "nacos");
        std::env::set_var("RELAY_NACOS_PASSWORD", "super-secret-nacos-password-123456");
        let cfg = Config::from_env().unwrap();
        let dump = cfg.dump_redacted();
        assert!(!dump.contains("super-secret-nacos-password-123456"));
        assert!(dump.contains("super-se***"));
        assert!(dump.contains("discovery_service=wechat-business-app"));
        clear_all();
    }
}
