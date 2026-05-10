//! Endpoint 配置:keep-alive、超时、TLS 选择。

use crate::error::AuthError;
use std::time::Duration;
use tonic::transport::{ClientTlsConfig, Endpoint};

/// 根据 url(http:// 或 https://)构造一个带 keep-alive 与超时的 Endpoint。
/// https:// 的连接自动启 TLS 并使用系统 root certs。
pub fn build_endpoint(url: impl Into<String>) -> Result<Endpoint, AuthError> {
    let url = url.into();
    let is_tls = url.starts_with("https://");
    let mut ep = Endpoint::from_shared(url)
        .map_err(|e| AuthError::Internal {
            message: format!("bad url: {e}"),
        })?
        .http2_keep_alive_interval(Duration::from_secs(10))
        .keep_alive_timeout(Duration::from_secs(5))
        .keep_alive_while_idle(true)
        .tcp_keepalive(Some(Duration::from_secs(30)))
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(30));
    if is_tls {
        ep = ep
            .tls_config(ClientTlsConfig::new().with_native_roots())
            .map_err(|e| AuthError::Internal {
                message: format!("tls config: {e}"),
            })?;
    }
    Ok(ep)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_https_endpoint_succeeds() {
        let ep = build_endpoint("https://relay.example.com").expect("https");
        let _ = ep; // 不实际 connect
    }

    #[test]
    fn build_http_endpoint_succeeds() {
        let ep = build_endpoint("http://127.0.0.1:50001").expect("http");
        let _ = ep;
    }

    #[test]
    fn build_with_invalid_url_errors() {
        let err = build_endpoint("not a url").expect_err("should err");
        assert!(matches!(err, AuthError::Internal { .. }));
    }
}
