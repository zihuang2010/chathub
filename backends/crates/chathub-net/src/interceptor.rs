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
    use chathub_state::{LocalTokenStore, SqlitePool};
    use tonic::service::Interceptor;

    async fn fresh_store() -> Arc<TokenStore> {
        let pool = SqlitePool::in_memory().await.unwrap();
        let local = LocalTokenStore::new(pool);
        let ep = tonic::transport::Endpoint::from_static("http://127.0.0.1:1");
        Arc::new(TokenStore::new(ep, local, "dev-test".into()))
    }

    #[tokio::test]
    async fn unauthenticated_when_not_logged_in() {
        let store = fresh_store().await;
        let mut interceptor = AuthInterceptor::new(store);

        let req = Request::new(());
        let err = interceptor
            .call(req)
            .expect_err("should be unauthenticated");
        assert_eq!(err.code(), tonic::Code::Unauthenticated);
    }

    #[tokio::test]
    async fn injects_bearer_and_headers_when_logged_in() {
        let store = fresh_store().await;
        store.set_session("biz-tok-1".into(), "u-1".into());
        let mut interceptor = AuthInterceptor::new(store);

        let out = interceptor.call(Request::new(())).expect("should pass");
        let md = out.metadata();
        assert_eq!(
            md.get("authorization").unwrap().to_str().unwrap(),
            "Bearer biz-tok-1"
        );
        assert_eq!(
            md.get("chathub-protocol-version")
                .unwrap()
                .to_str()
                .unwrap(),
            "1"
        );
    }
}
