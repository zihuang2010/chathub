//! AuthInterceptor:同步 Interceptor,注入 Bearer + 协议头。
//!
//! 仅供 Plan 3 起的 Hub.* 客户端使用;Auth.* RPC 不走此 interceptor。

use crate::token::TokenStore;
use std::sync::Arc;
use tonic::metadata::MetadataValue;
use tonic::{Request, Status};

#[derive(Clone)]
pub struct AuthInterceptor {
    token_store: Arc<TokenStore>,
    client_version: &'static str,
    platform: &'static str,
}

impl AuthInterceptor {
    pub fn new(token_store: Arc<TokenStore>) -> Self {
        Self {
            token_store,
            client_version: env!("CARGO_PKG_VERSION"),
            platform: PLATFORM,
        }
    }
}

impl tonic::service::Interceptor for AuthInterceptor {
    fn call(&mut self, mut req: Request<()>) -> Result<Request<()>, Status> {
        let access = self
            .token_store
            .current_access_token()
            .ok_or_else(|| Status::unauthenticated("not logged in"))?;
        let md = req.metadata_mut();

        let bearer: MetadataValue<_> = format!("Bearer {access}")
            .parse()
            .map_err(|_| Status::internal("bearer encode"))?;
        md.insert("authorization", bearer);

        md.insert("chathub-protocol-version", MetadataValue::from_static("1"));
        md.insert(
            "chathub-client-version",
            self.client_version
                .parse()
                .map_err(|_| Status::internal("client_version"))?,
        );
        md.insert(
            "chathub-platform",
            MetadataValue::from_static(self.platform),
        );

        Ok(req)
    }
}

#[cfg(target_os = "macos")]
const PLATFORM: &str = "macos";
#[cfg(target_os = "windows")]
const PLATFORM: &str = "windows";
#[cfg(target_os = "linux")]
const PLATFORM: &str = "linux";
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
const PLATFORM: &str = "unknown";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::token::TokenStore;
    use chathub_state::KeyringTokenStore;
    use tonic::service::Interceptor;

    fn unique_keyring() -> KeyringTokenStore {
        KeyringTokenStore::new(format!("chathub-test-{}", uuid::Uuid::new_v4()))
    }

    #[tokio::test]
    async fn unauthenticated_when_not_logged_in() {
        let kr = unique_keyring();
        let ep = tonic::transport::Endpoint::from_static("http://127.0.0.1:1");
        let store = Arc::new(TokenStore::new(ep, kr.clone()).expect("store"));
        let mut interceptor = AuthInterceptor::new(store);

        let req = Request::new(());
        let err = interceptor
            .call(req)
            .expect_err("should be unauthenticated");
        assert_eq!(err.code(), tonic::Code::Unauthenticated);

        let _ = kr.clear_refresh_token();
        let _ = kr._clear_device_id_for_test();
    }

    // 集成测试覆盖"已登录情况下注入 Bearer + 头" — 在 Plan 3 真正用 Hub.* 时验证。
}
