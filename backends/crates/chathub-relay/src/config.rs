//! Config — relay 启动配置;`from_env()` 读 env var。
//! 必填(无默认):RELAY_DOWNSTREAM_URL / RELAY_PUSH_SECRET
//!
//! 鉴权模型(2026-05-16 OAuth2 重构):
//!   - relay → 业务后台所有业务请求,用客户端 raw Bearer token(透传)
//!   - 唯一例外:Auth.Login 走 OAuth2,用 Basic client_id:client_secret
//!   - RELAY_DOWNSTREAM_SECRET 已下线(relay 不再持有出站 shared secret)
//!   - RELAY_PUSH_SECRET 仍保留(业务后台 → relay /internal/push 方向)

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
    /// 后台 GC 间隔(秒),events_v2 保留 days(F5)。env `RELAY_EVENT_RETENTION_DAYS`,默认 7。
    pub event_retention_days: u64,
    /// Hub.Forward 的 method → 业务后台 HTTP (verb, path) 映射。
    pub routes: DownstreamRoutes,
    /// Auth.Login 的 OAuth2 路径(env `RELAY_PATH_LOGIN`,默认 `/account-app/oauth2/token`)。
    pub path_login: String,
    /// verify_token 路径(env `RELAY_PATH_VERIFY_TOKEN`,默认 `/v1/verify_token`)。
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
        "fetch_history",
        HttpMethod::Post,
        "/v1/fetch_history",
        "RELAY_PATH_FETCH_HISTORY",
    ),
    (
        "list_accounts",
        HttpMethod::Get,
        "/wechat-business-app/wecom-cs/v1/wecomAggregate/account/listMine",
        "RELAY_PATH_LIST_ACCOUNTS",
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

        Ok(Self {
            grpc_addr: parse_addr_or("RELAY_GRPC_ADDR", "127.0.0.1:50051")?,
            push_addr: parse_addr_or("RELAY_PUSH_ADDR", "127.0.0.1:50052")?,
            db_path: std::env::var("RELAY_DB_PATH")
                .unwrap_or_else(|_| "./relay.db".into())
                .into(),
            downstream_url,
            push_secret: required("RELAY_PUSH_SECRET")?,
            path_login: std::env::var("RELAY_PATH_LOGIN")
                .unwrap_or_else(|_| "/account-app/oauth2/token".into()),
            path_verify_token: std::env::var("RELAY_PATH_VERIFY_TOKEN")
                .unwrap_or_else(|_| "/v1/verify_token".into()),
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
        })
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
    if let Ok(path) = std::env::var(file_var) {
        let content = std::fs::read_to_string(&path).map_err(|e| ConfigError::Io {
            var: file_var,
            path: path.clone(),
            source: e,
        })?;
        return Ok(content.trim().to_string());
    }
    Ok(std::env::var(direct_var).unwrap_or_else(|_| default.to_string()))
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
            "RELAY_PATH_LIST_ACCOUNTS",
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
        assert_eq!(cfg.path_verify_token, "/v1/verify_token");
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
}
