// crates/chathub-proto/src/lib.rs
//! ChatHub gRPC contracts(由 tonic-build 在 build.rs 中从 proto/chathub/v1/*.proto 生成)。
//!
//! 主要导出:
//!   - chathub_proto::v1::auth_client::AuthClient<Channel>
//!   - chathub_proto::v1::auth_server::{Auth, AuthServer}
//!   - chathub_proto::v1::hub_client::HubClient<Channel>
//!   - chathub_proto::v1::{LoginRequest, LoginResponse, RefreshTokenRequest, ...}
//!   - chathub_proto::v1::{ErrorDetail, RetryInfo, QuotaFailure, ...}
//!
//! 后续计划在引用时一律走 `chathub_proto::v1::...` 命名空间。

#![allow(clippy::all)]
#![allow(non_snake_case, missing_docs)]

pub mod v1 {
    tonic::include_proto!("chathub.v1");
}

#[cfg(test)]
mod tests {
    use super::v1::auth_client::AuthClient;
    use super::v1::{LoginRequest, LoginResponse, RefreshTokenRequest};
    use tonic::transport::Channel;

    #[test]
    fn login_request_default_compiles() {
        let req = LoginRequest::default();
        assert_eq!(req.username, "");
        assert_eq!(req.client_ver, "");
    }

    #[test]
    fn login_response_default_compiles() {
        let resp = LoginResponse::default();
        assert!(resp.access_token.is_empty());
        assert_eq!(resp.access_exp_ms, 0);
    }

    #[test]
    fn refresh_request_round_trips_via_prost() {
        // 编解码自检:防止 build.rs 配置漂了
        use prost::Message;
        let req = RefreshTokenRequest {
            refresh_token: "abc".into(),
            device_id: "dev-1".into(),
        };
        let bytes = req.encode_to_vec();
        let decoded = RefreshTokenRequest::decode(bytes.as_slice()).unwrap();
        assert_eq!(decoded.refresh_token, "abc");
        assert_eq!(decoded.device_id, "dev-1");
    }

    /// 仅作类型存在性 + 函数签名检查,不真的连服务端。
    #[allow(dead_code, unused_must_use)]
    fn _auth_client_new_signature_exists() {
        let _: fn(Channel) -> AuthClient<Channel> = AuthClient::<Channel>::new;
    }
}
