//! Config — relay 启动配置;`from_env()` 读 env var。
//! 必填(无默认):RELAY_DOWNSTREAM_URL / RELAY_DOWNSTREAM_SECRET / RELAY_PUSH_SECRET
//!
//! Relay 退化为纯隔道后,不再需要 JWT 签发 / refresh 相关配置。

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;

#[derive(thiserror::Error, Debug)]
pub enum ConfigError {
    #[error("missing required env var: {0}")]
    Missing(&'static str),
    #[error("invalid env var {var}: {message}")]
    Invalid { var: &'static str, message: String },
}

#[derive(Clone, Debug)]
pub struct Config {
    pub grpc_addr: SocketAddr,
    pub push_addr: SocketAddr,
    pub db_path: PathBuf,
    pub downstream_url: String,
    pub downstream_secret: String,
    pub push_secret: String,
    pub log: LogConfig,
    /// Plan 6:Hub.Forward 的 method → 业务后台 HTTP 路径映射。
    pub routes: DownstreamRoutes,
}

/// `Hub.Forward(method, body_json)` 时,relay 用这张表把 method 转成业务后台路径。
///
/// 每个 method 对应一个 env var(`RELAY_PATH_<METHOD-UPPERCASE>`),不设时走默认值。
/// 加新业务 method 时:
///   1. 加默认值到 `DEFAULT_ROUTES`
///   2. 业务后台部署对应路径
///   3. 客户端 SDK 调 `Hub.Forward("new_method", body)` 即可,relay 不需要重新编译
#[derive(Clone, Debug)]
pub struct DownstreamRoutes {
    map: HashMap<String, String>,
}

/// 默认 method → path 映射。`(method, default_path, env_var)`。
const DEFAULT_ROUTES: &[(&str, &str, &str)] = &[
    ("send", "/v1/send", "RELAY_PATH_SEND"),
    ("recall", "/v1/recall", "RELAY_PATH_RECALL"),
    ("ack_read", "/v1/ack_read", "RELAY_PATH_ACK_READ"),
    (
        "fetch_history",
        "/v1/fetch_history",
        "RELAY_PATH_FETCH_HISTORY",
    ),
    // verify_token / login / logout 由 relay 自己直接调,不经 Forward 通道。
];

impl DownstreamRoutes {
    pub fn from_env() -> Self {
        let mut map = HashMap::new();
        for (method, default_path, env_var) in DEFAULT_ROUTES {
            let path = std::env::var(env_var).unwrap_or_else(|_| (*default_path).into());
            map.insert((*method).into(), path);
        }
        Self { map }
    }

    /// 测试用,固定默认路径。
    pub fn default_for_test() -> Self {
        let mut map = HashMap::new();
        for (method, default_path, _) in DEFAULT_ROUTES {
            map.insert((*method).into(), (*default_path).into());
        }
        Self { map }
    }

    pub fn path_for(&self, method: &str) -> Option<&str> {
        self.map.get(method).map(|s| s.as_str())
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
        Ok(Self {
            grpc_addr: parse_addr_or("RELAY_GRPC_ADDR", "127.0.0.1:50051")?,
            push_addr: parse_addr_or("RELAY_PUSH_ADDR", "127.0.0.1:50052")?,
            db_path: std::env::var("RELAY_DB_PATH")
                .unwrap_or_else(|_| "./relay.db".into())
                .into(),
            downstream_url: required("RELAY_DOWNSTREAM_URL")?,
            downstream_secret: required("RELAY_DOWNSTREAM_SECRET")?,
            push_secret: required("RELAY_PUSH_SECRET")?,
            log: LogConfig {
                dir: std::env::var("RELAY_LOG_DIR")
                    .unwrap_or_else(|_| "./logs".into())
                    .into(),
                file_prefix: std::env::var("RELAY_LOG_FILE_PREFIX")
                    .unwrap_or_else(|_| "relay".into()),
                stdout: parse_stdout_format("RELAY_LOG_STDOUT")?,
            },
            routes: DownstreamRoutes::from_env(),
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
        ] {
            std::env::remove_var(k);
        }
    }

    #[test]
    fn from_env_happy_path_uses_defaults_for_optional() {
        let _g = ENV_LOCK.lock();
        clear_all();
        std::env::set_var("RELAY_PUSH_SECRET", "ps");
        std::env::set_var("RELAY_DOWNSTREAM_URL", "http://dn.local");
        std::env::set_var("RELAY_DOWNSTREAM_SECRET", "dn-secret");

        let cfg = Config::from_env().expect("config");
        assert_eq!(cfg.grpc_addr.to_string(), "127.0.0.1:50051");
        assert_eq!(cfg.push_addr.to_string(), "127.0.0.1:50052");
        assert_eq!(cfg.push_secret, "ps");
        assert_eq!(cfg.downstream_url, "http://dn.local");
        clear_all();
    }

    #[test]
    fn from_env_missing_push_secret_errors() {
        let _g = ENV_LOCK.lock();
        clear_all();
        std::env::set_var("RELAY_DOWNSTREAM_URL", "http://dn.local");
        std::env::set_var("RELAY_DOWNSTREAM_SECRET", "dn-secret");
        // PUSH_SECRET 故意不设
        let err = Config::from_env().unwrap_err();
        match err {
            ConfigError::Missing(v) => assert_eq!(v, "RELAY_PUSH_SECRET"),
            other => panic!("wrong variant: {other:?}"),
        }
        clear_all();
    }

    #[test]
    fn from_env_missing_downstream_secret_errors() {
        let _g = ENV_LOCK.lock();
        clear_all();
        std::env::set_var("RELAY_DOWNSTREAM_URL", "http://dn.local");
        std::env::set_var("RELAY_PUSH_SECRET", "ps");
        // DOWNSTREAM_SECRET 故意不设
        let err = Config::from_env().unwrap_err();
        match err {
            ConfigError::Missing(v) => assert_eq!(v, "RELAY_DOWNSTREAM_SECRET"),
            other => panic!("wrong variant: {other:?}"),
        }
        clear_all();
    }

    #[test]
    fn from_env_log_defaults_apply_when_log_vars_unset() {
        let _g = ENV_LOCK.lock();
        clear_all();
        std::env::set_var("RELAY_PUSH_SECRET", "ps");
        std::env::set_var("RELAY_DOWNSTREAM_URL", "http://dn.local");
        std::env::set_var("RELAY_DOWNSTREAM_SECRET", "dn-secret");
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
        std::env::set_var("RELAY_PUSH_SECRET", "ps");
        std::env::set_var("RELAY_DOWNSTREAM_URL", "http://dn.local");
        std::env::set_var("RELAY_DOWNSTREAM_SECRET", "dn-secret");
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
        std::env::set_var("RELAY_PUSH_SECRET", "ps");
        std::env::set_var("RELAY_DOWNSTREAM_URL", "http://dn.local");
        std::env::set_var("RELAY_DOWNSTREAM_SECRET", "dn-secret");
        std::env::set_var("RELAY_LOG_STDOUT", "off");
        let cfg = Config::from_env().expect("config");
        assert_eq!(cfg.log.stdout, StdoutFormat::Off);
        clear_all();
    }

    #[test]
    fn from_env_log_stdout_invalid_value_errors() {
        let _g = ENV_LOCK.lock();
        clear_all();
        std::env::set_var("RELAY_PUSH_SECRET", "ps");
        std::env::set_var("RELAY_DOWNSTREAM_URL", "http://dn.local");
        std::env::set_var("RELAY_DOWNSTREAM_SECRET", "dn-secret");
        std::env::set_var("RELAY_LOG_STDOUT", "verbose");
        let err = Config::from_env().unwrap_err();
        match err {
            ConfigError::Invalid { var, .. } => assert_eq!(var, "RELAY_LOG_STDOUT"),
            other => panic!("wrong: {other:?}"),
        }
        clear_all();
    }

    #[test]
    fn downstream_routes_default_when_no_env() {
        let _g = ENV_LOCK.lock();
        clear_all();
        let r = DownstreamRoutes::from_env();
        assert_eq!(r.path_for("send"), Some("/v1/send"));
        assert_eq!(r.path_for("recall"), Some("/v1/recall"));
        assert_eq!(r.path_for("ack_read"), Some("/v1/ack_read"));
        assert_eq!(r.path_for("fetch_history"), Some("/v1/fetch_history"));
        assert_eq!(r.path_for("unknown"), None);
    }

    #[test]
    fn downstream_routes_env_overrides() {
        let _g = ENV_LOCK.lock();
        clear_all();
        std::env::set_var("RELAY_PATH_SEND", "/v2/messages/send");
        std::env::set_var("RELAY_PATH_RECALL", "/v2/messages/recall");
        let r = DownstreamRoutes::from_env();
        assert_eq!(r.path_for("send"), Some("/v2/messages/send"));
        assert_eq!(r.path_for("recall"), Some("/v2/messages/recall"));
        // 没设的仍是 default
        assert_eq!(r.path_for("ack_read"), Some("/v1/ack_read"));
        clear_all();
    }

    #[test]
    fn config_from_env_includes_routes() {
        let _g = ENV_LOCK.lock();
        clear_all();
        std::env::set_var("RELAY_PUSH_SECRET", "ps");
        std::env::set_var("RELAY_DOWNSTREAM_URL", "http://dn.local");
        std::env::set_var("RELAY_DOWNSTREAM_SECRET", "dn-secret");
        std::env::set_var("RELAY_PATH_SEND", "/v3/send");
        let cfg = Config::from_env().expect("config");
        assert_eq!(cfg.routes.path_for("send"), Some("/v3/send"));
        clear_all();
    }

    #[test]
    fn from_env_invalid_grpc_addr_errors() {
        let _g = ENV_LOCK.lock();
        clear_all();
        std::env::set_var("RELAY_PUSH_SECRET", "ps");
        std::env::set_var("RELAY_DOWNSTREAM_URL", "http://dn.local");
        std::env::set_var("RELAY_DOWNSTREAM_SECRET", "dn-secret");
        std::env::set_var("RELAY_GRPC_ADDR", "not-an-addr");
        let err = Config::from_env().unwrap_err();
        match err {
            ConfigError::Invalid { var, .. } => assert_eq!(var, "RELAY_GRPC_ADDR"),
            other => panic!("wrong: {other:?}"),
        }
        clear_all();
    }
}
