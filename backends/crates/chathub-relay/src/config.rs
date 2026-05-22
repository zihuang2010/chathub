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
    /// verify_token 路径(env `RELAY_PATH_VERIFY_TOKEN`,默认 `/wechat-business-app/rpc/v1/wecomAggregate/connection/verifyToken`)。
    pub path_verify_token: String,
    /// logout 路径(env `RELAY_PATH_LOGOUT`,默认 `/auth/logout`)。
    pub path_logout: String,
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
        Ok(Self {
            grpc_addr: parse_addr_or("RELAY_GRPC_ADDR", "127.0.0.1:50051")?,
            push_addr: parse_addr_or("RELAY_PUSH_ADDR", "127.0.0.1:50052")?,
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
                "/wechat-business-app/rpc/v1/wecomAggregate/connection/verifyToken".into()
            }),
            path_logout: std::env::var("RELAY_PATH_LOGOUT")
                .unwrap_or_else(|_| "/auth/logout".into()),
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
        if self.allowed_client_ids.is_empty() {
            errors.push("RELAY_ALLOWED_CLIENT_IDS 不能为空 — 否则没有任何 client 能 push".into());
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
             \x20  oauth_client_id       = {}\n\
             \x20  oauth_client_secret   = {}\n\
             \x20  tls                   = {}\n\
             \x20  push_max_body_bytes   = {}\n\
             \x20  event_retention_days  = {}\n\
             \x20  force_close_grace_ms  = {}\n\
             \x20  allowed_client_ids    = {:?}\n\
             \x20  auth_cache_max_entries= {}\n\
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
            self.oauth_client_id,
            Redacted(&self.oauth_client_secret),
            tls,
            self.push_max_body_bytes,
            self.event_retention_days,
            self.force_close_grace_ms,
            self.allowed_client_ids,
            self.auth_cache_max_entries,
            self.log.dir.display(),
            self.log.file_prefix,
            self.log.stdout,
            routes,
        )
    }
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
            "/wechat-business-app/rpc/v1/wecomAggregate/connection/verifyToken"
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
}
