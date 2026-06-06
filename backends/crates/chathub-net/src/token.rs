//! TokenStore:进程内 token 状态 + 业务后台登录/登出(经 Relay gRPC 透传)。
//!
//! Relay 退化为纯隔道后,客户端不再做 token 续签:
//!   - login / logout 仍走 Relay 的 AuthSvc gRPC(Relay 透传到业务后台)。
//!   - token 持久化到本地 SQLite(LocalTokenStore),不再用 macOS 钥匙串。
//!   - token 失效由业务后台判断;客户端收到 gRPC Unauthenticated 即登出重登,
//!     不在客户端维护过期时间、不跑后台 refresher。

use crate::error::AuthError;
use chathub_state::LocalTokenStore;
use parking_lot::RwLock;
use std::sync::Arc;
use tokio::sync::broadcast;

/// 进程内的 token 当前值。过期判断不在客户端,故只存 token + user_id。
#[derive(Clone, Debug, PartialEq)]
pub struct TokenState {
    pub access_token: String,
    pub user_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoggedOutReason {
    /// 用户主动登出。
    Manual,
    /// token 失效(业务后台判定 / gRPC 返回 Unauthenticated)→ 需重新登录。
    TokenInvalid,
    /// 被其它设备踢下线。
    Kicked,
}

pub struct TokenStore {
    pub(crate) state: Arc<RwLock<Option<TokenState>>>,
    pub(crate) local: LocalTokenStore,
    pub(crate) device_id: String,
    pub(crate) logged_out_tx: broadcast::Sender<LoggedOutReason>,
    /// Auth client(不带 interceptor)— Channel 内部 Arc,clone 廉价。
    pub(crate) auth_client: chathub_proto::v1::auth_client::AuthClient<tonic::transport::Channel>,
}

impl TokenStore {
    /// 构造一个空的 TokenStore(未登录)。
    /// `device_id` 由调用方先从 LocalTokenStore 取出再传入(避免 new 变 async)。
    pub fn new(
        endpoint: tonic::transport::Endpoint,
        local: LocalTokenStore,
        device_id: String,
    ) -> Self {
        let (tx, _rx) = broadcast::channel(8);
        let channel = endpoint.connect_lazy();
        let auth_client = chathub_proto::v1::auth_client::AuthClient::new(channel);
        Self {
            state: Arc::new(RwLock::new(None)),
            local,
            device_id,
            logged_out_tx: tx,
            auth_client,
        }
    }

    /// 同步读 access token。Interceptor 用此。
    pub fn current_access_token(&self) -> Option<String> {
        self.state.read().as_ref().map(|s| s.access_token.clone())
    }

    pub fn current_user_id(&self) -> Option<String> {
        self.state.read().as_ref().map(|s| s.user_id.clone())
    }

    pub fn logged_out_subscribe(&self) -> broadcast::Receiver<LoggedOutReason> {
        self.logged_out_tx.subscribe()
    }

    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    pub fn is_logged_in(&self) -> bool {
        self.state.read().is_some()
    }

    /// 发起一次 Login RPC(经 Relay 透传到业务后台),成功后写本地 SQLite + 设置 state。
    pub async fn login(
        &self,
        username: &str,
        password: &str,
    ) -> Result<chathub_proto::v1::LoginResponse, AuthError> {
        use chathub_proto::v1::LoginRequest;

        let req = LoginRequest {
            username: username.to_string(),
            password: password.to_string(),
            device_id: self.device_id.clone(),
            device_name: hostname_or_default(),
            client_ver: env!("CARGO_PKG_VERSION").to_string(),
        };

        let started = std::time::Instant::now();
        tracing::info!(
            target: "chathub::auth",
            username,
            device_id = %self.device_id,
            "Auth.Login start",
        );

        let mut client = self.auth_client.clone();
        let resp = match client.login(req).await {
            Ok(r) => r.into_inner(),
            Err(status) => {
                tracing::warn!(
                    target: "chathub::auth",
                    username,
                    code = ?status.code(),
                    elapsed_ms = started.elapsed().as_millis() as u64,
                    message = status.message(),
                    "Auth.Login failed",
                );
                return Err(status.into());
            }
        };

        // 持久化 token 到本地 SQLite + 设置内存 state
        self.local.write_token(&resp.access_token).await?;
        let user_id = resp
            .user
            .as_ref()
            .map(|p| p.user_id.clone())
            .unwrap_or_default();
        *self.state.write() = Some(TokenState {
            access_token: resp.access_token.clone(),
            user_id: user_id.clone(),
        });

        tracing::info!(
            target: "chathub::auth",
            username,
            user_id = %user_id,
            accounts = resp.wecom_accounts.len(),
            elapsed_ms = started.elapsed().as_millis() as u64,
            "Auth.Login ok",
        );
        Ok(resp)
    }

    /// 主动登出:调 Auth.Logout(best-effort)→ 清本地 token + state → broadcast Manual。
    pub async fn logout(&self) -> Result<(), AuthError> {
        use chathub_proto::v1::LogoutRequest;

        if let Ok(Some(token)) = self.local.read_token().await {
            let mut client = self.auth_client.clone();
            let _ = client.logout(LogoutRequest { token }).await; // 网络错忽略
        }

        let _ = self.local.clear_token().await;
        *self.state.write() = None;
        let _ = self.logged_out_tx.send(LoggedOutReason::Manual);
        Ok(())
    }

    /// token 失效:清本地 token + state → broadcast TokenInvalid。
    /// ConnectionManager 在收到 gRPC Unauthenticated 时调用。
    pub async fn mark_token_invalid(&self) {
        let _ = self.local.clear_token().await;
        *self.state.write() = None;
        let _ = self.logged_out_tx.send(LoggedOutReason::TokenInvalid);
    }

    /// 被顶下线(CONNECTION_FORCE_CLOSE / EXCLUSIVE_LOGIN):清 state → broadcast Kicked。
    /// 前端 App.tsx 对 `kicked` 有专门提示("账号在其他设备登录,本端已退出")并切回登录页。
    /// `clear_local_token` 取自 forceClose.clearLocalToken:true 时一并清本地持久化 token。
    pub async fn mark_kicked(&self, clear_local_token: bool) {
        if clear_local_token {
            let _ = self.local.clear_token().await;
        }
        *self.state.write() = None;
        let _ = self.logged_out_tx.send(LoggedOutReason::Kicked);
    }

    /// 读本地 SQLite 持久化的 token(冷启动 resume 用)。
    pub async fn try_load_token(&self) -> Option<String> {
        self.local.read_token().await.ok().flatten()
    }

    /// 直接设置已登录 state(resume 用:本地有 token + SessionStore 有 profile)。
    pub fn set_session(&self, access_token: String, user_id: String) {
        *self.state.write() = Some(TokenState {
            access_token,
            user_id,
        });
    }

    /// 清本地 token + state,不 broadcast(用于 resume 时发现状态不一致的清理)。
    pub async fn clear_session(&self) {
        let _ = self.local.clear_token().await;
        *self.state.write() = None;
    }

    /// 仅供集成测试:向本地 SQLite 种一个 token。
    #[doc(hidden)]
    pub async fn seed_token_for_test(&self, token: &str) {
        self.local
            .write_token(token)
            .await
            .expect("seed_token_for_test");
    }
}

fn hostname_or_default() -> String {
    std::env::var("CHATHUB_DEVICE_NAME")
        .ok()
        .unwrap_or_else(|| "chathub-desktop".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chathub_state::SqlitePool;

    async fn fresh_local() -> LocalTokenStore {
        let pool = SqlitePool::in_memory().await.unwrap();
        LocalTokenStore::new(pool)
    }

    #[tokio::test]
    async fn empty_store_returns_none() {
        let local = fresh_local().await;
        let ep = tonic::transport::Endpoint::from_static("http://127.0.0.1:1");
        let store = TokenStore::new(ep, local, "dev-test".into());
        assert!(store.current_access_token().is_none());
        assert!(store.current_user_id().is_none());
        assert!(!store.is_logged_in());
        assert_eq!(store.device_id(), "dev-test");
    }

    #[tokio::test]
    async fn set_session_reflects_in_getters() {
        let local = fresh_local().await;
        let ep = tonic::transport::Endpoint::from_static("http://127.0.0.1:1");
        let store = TokenStore::new(ep, local, "dev".into());
        store.set_session("tok-1".into(), "u-1".into());
        assert!(store.is_logged_in());
        assert_eq!(store.current_access_token().as_deref(), Some("tok-1"));
        assert_eq!(store.current_user_id().as_deref(), Some("u-1"));
    }

    #[tokio::test]
    async fn try_load_token_reads_local_persistence() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let local = LocalTokenStore::new(pool.clone());
        local.write_token("persisted-tok").await.unwrap();
        let ep = tonic::transport::Endpoint::from_static("http://127.0.0.1:1");
        let store = TokenStore::new(ep, LocalTokenStore::new(pool), "dev".into());
        assert_eq!(
            store.try_load_token().await.as_deref(),
            Some("persisted-tok")
        );
    }

    #[tokio::test]
    async fn mark_token_invalid_clears_and_broadcasts() {
        let local = fresh_local().await;
        let ep = tonic::transport::Endpoint::from_static("http://127.0.0.1:1");
        let store = TokenStore::new(ep, local, "dev".into());
        store.seed_token_for_test("tok-x").await;
        store.set_session("tok-x".into(), "u-1".into());
        let mut rx = store.logged_out_subscribe();

        store.mark_token_invalid().await;

        assert!(!store.is_logged_in());
        assert!(store.try_load_token().await.is_none());
        assert_eq!(rx.recv().await.unwrap(), LoggedOutReason::TokenInvalid);
    }

    #[tokio::test]
    async fn mark_kicked_clears_and_broadcasts_kicked() {
        let local = fresh_local().await;
        let ep = tonic::transport::Endpoint::from_static("http://127.0.0.1:1");
        let store = TokenStore::new(ep, local, "dev".into());
        store.seed_token_for_test("tok-x").await;
        store.set_session("tok-x".into(), "u-1".into());
        let mut rx = store.logged_out_subscribe();

        store.mark_kicked(true).await;

        assert!(!store.is_logged_in());
        assert!(store.try_load_token().await.is_none());
        assert_eq!(rx.recv().await.unwrap(), LoggedOutReason::Kicked);
    }

    #[tokio::test]
    async fn mark_kicked_without_clear_keeps_local_token() {
        let local = fresh_local().await;
        let ep = tonic::transport::Endpoint::from_static("http://127.0.0.1:1");
        let store = TokenStore::new(ep, local, "dev".into());
        store.seed_token_for_test("tok-x").await;
        store.set_session("tok-x".into(), "u-1".into());
        let mut rx = store.logged_out_subscribe();

        store.mark_kicked(false).await;

        // 内存 state 清空(本端已退),但本地持久化 token 保留(clearLocalToken=false)。
        assert!(!store.is_logged_in());
        assert_eq!(store.try_load_token().await.as_deref(), Some("tok-x"));
        assert_eq!(rx.recv().await.unwrap(), LoggedOutReason::Kicked);
    }
}
