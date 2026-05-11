//! Config — relay 启动配置;`from_env()` 读 12 个 env var(spec §11.1)。
//! 必填(无默认):RELAY_PUSH_SECRET / RELAY_DOWNSTREAM_URL / RELAY_REFRESH_HASH_PEPPER

use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

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
    pub jwt_private_pem: Option<String>,
    pub jwt_kid: Option<String>,
    pub issuer: String,
    pub access_ttl: Duration,
    pub refresh_ttl: Duration,
    pub refresh_hash_pepper: String,
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
            downstream_secret: std::env::var("RELAY_DOWNSTREAM_SECRET").unwrap_or_default(),
            push_secret: required("RELAY_PUSH_SECRET")?,
            jwt_private_pem: std::env::var("RELAY_JWT_PRIVATE_PEM").ok(),
            jwt_kid: std::env::var("RELAY_JWT_KID").ok(),
            issuer: std::env::var("RELAY_ISSUER").unwrap_or_else(|_| "chathub-relay".into()),
            access_ttl: Duration::from_secs(parse_u64_or("RELAY_ACCESS_TTL_SECS", 1800)?),
            refresh_ttl: Duration::from_secs(parse_u64_or("RELAY_REFRESH_TTL_SECS", 2_592_000)?),
            refresh_hash_pepper: required("RELAY_REFRESH_HASH_PEPPER")?,
        })
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

fn parse_u64_or(var: &'static str, default: u64) -> Result<u64, ConfigError> {
    match std::env::var(var) {
        Ok(s) => s
            .parse()
            .map_err(|e: std::num::ParseIntError| ConfigError::Invalid {
                var,
                message: e.to_string(),
            }),
        Err(_) => Ok(default),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 把 `from_env` 的全部必填/可选都置成确定值。
    /// 注意:`std::env::set_var` 在多线程测试下不安全,本模块 #[cfg(test)] 使用
    /// `serial_test::serial` 等不在 walking skeleton 范围;改用 lock 保证单线程。
    static ENV_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

    fn clear_all() {
        for k in [
            "RELAY_GRPC_ADDR",
            "RELAY_PUSH_ADDR",
            "RELAY_DB_PATH",
            "RELAY_DOWNSTREAM_URL",
            "RELAY_DOWNSTREAM_SECRET",
            "RELAY_PUSH_SECRET",
            "RELAY_JWT_PRIVATE_PEM",
            "RELAY_JWT_KID",
            "RELAY_ISSUER",
            "RELAY_ACCESS_TTL_SECS",
            "RELAY_REFRESH_TTL_SECS",
            "RELAY_REFRESH_HASH_PEPPER",
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
        std::env::set_var("RELAY_REFRESH_HASH_PEPPER", "p".repeat(64));

        let cfg = Config::from_env().expect("config");
        assert_eq!(cfg.grpc_addr.to_string(), "127.0.0.1:50051");
        assert_eq!(cfg.push_addr.to_string(), "127.0.0.1:50052");
        assert_eq!(cfg.issuer, "chathub-relay");
        assert_eq!(cfg.access_ttl, Duration::from_secs(1800));
        assert_eq!(cfg.refresh_ttl, Duration::from_secs(2_592_000));
        assert_eq!(cfg.push_secret, "ps");
        assert!(cfg.jwt_private_pem.is_none());
        clear_all();
    }

    #[test]
    fn from_env_missing_push_secret_errors() {
        let _g = ENV_LOCK.lock();
        clear_all();
        std::env::set_var("RELAY_DOWNSTREAM_URL", "http://dn.local");
        std::env::set_var("RELAY_REFRESH_HASH_PEPPER", "p".repeat(64));
        // PUSH_SECRET 故意不设
        let err = Config::from_env().unwrap_err();
        match err {
            ConfigError::Missing(v) => assert_eq!(v, "RELAY_PUSH_SECRET"),
            other => panic!("wrong variant: {other:?}"),
        }
        clear_all();
    }

    #[test]
    fn from_env_invalid_grpc_addr_errors() {
        let _g = ENV_LOCK.lock();
        clear_all();
        std::env::set_var("RELAY_PUSH_SECRET", "ps");
        std::env::set_var("RELAY_DOWNSTREAM_URL", "http://dn.local");
        std::env::set_var("RELAY_REFRESH_HASH_PEPPER", "p".repeat(64));
        std::env::set_var("RELAY_GRPC_ADDR", "not-an-addr");
        let err = Config::from_env().unwrap_err();
        match err {
            ConfigError::Invalid { var, .. } => assert_eq!(var, "RELAY_GRPC_ADDR"),
            other => panic!("wrong: {other:?}"),
        }
        clear_all();
    }
}
