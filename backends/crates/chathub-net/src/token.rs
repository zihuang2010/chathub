//! TokenStore:sync RwLock 持有 TokenState,interceptor 友好。
//!
//! 本 Task 只含类型 + 同步 getter;login/refresh/refresher 在后续 task 加。

use crate::error::AuthError;
use chathub_state::KeyringTokenStore;
use parking_lot::RwLock;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::{broadcast, Mutex};

/// 进程内的 token 当前值。
#[derive(Clone, Debug, PartialEq)]
pub struct TokenState {
    pub access_token: String,
    pub access_exp_ms: i64,
    pub refresh_exp_ms: i64,
    pub user_id: String,
}

impl TokenState {
    pub fn is_near_expiry(&self, threshold_ms: i64) -> bool {
        let now = now_unix_ms();
        (self.access_exp_ms - now) < threshold_ms
    }
}

#[derive(Debug, Clone, Copy)]
pub enum LoggedOutReason {
    Manual,
    RefreshFailed,
    Kicked,
}

pub(crate) const PROACTIVE_REFRESH_THRESHOLD_MS: i64 = 5 * 60 * 1000;

pub struct TokenStore {
    pub(crate) state: Arc<RwLock<Option<TokenState>>>,
    pub(crate) refresh_lock: Arc<Mutex<()>>,
    pub(crate) keyring: Arc<KeyringTokenStore>,
    pub(crate) device_id: String,
    pub(crate) logged_out_tx: broadcast::Sender<LoggedOutReason>,
    /// Auth client(不带 interceptor)— Channel 内部 Arc,clone 廉价。
    /// 每次 RPC 前 .clone() 出 &mut 副本调用,不需要 Mutex。
    pub(crate) auth_client: chathub_proto::v1::auth_client::AuthClient<tonic::transport::Channel>,
    /// Plan 2 Task 13:后台 refresher task 句柄(Option 是因为可能未启动或被 abort)
    pub(crate) refresher: tokio::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl TokenStore {
    /// 构造一个空的 TokenStore(未登录)。endpoint 已配置好,后续 login 时连。
    pub fn new(
        endpoint: tonic::transport::Endpoint,
        keyring: KeyringTokenStore,
    ) -> Result<Self, AuthError> {
        let device_id = keyring.ensure_device_id()?;
        let (tx, _rx) = broadcast::channel(8);
        let channel = endpoint.connect_lazy();
        let auth_client = chathub_proto::v1::auth_client::AuthClient::new(channel);
        Ok(Self {
            state: Arc::new(RwLock::new(None)),
            refresh_lock: Arc::new(Mutex::new(())),
            keyring: Arc::new(keyring),
            device_id,
            logged_out_tx: tx,
            auth_client,
            refresher: tokio::sync::Mutex::new(None),
        })
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
}

pub(crate) fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_state_is_near_expiry_boundary() {
        let now = now_unix_ms();
        let exp_in_4min = now + 4 * 60 * 1000;
        let s = TokenState {
            access_token: "a".into(),
            access_exp_ms: exp_in_4min,
            refresh_exp_ms: now + 30 * 24 * 60 * 60 * 1000,
            user_id: "u-1".into(),
        };
        assert!(
            s.is_near_expiry(5 * 60 * 1000),
            "4min < 5min threshold should be near"
        );
        assert!(
            !s.is_near_expiry(60 * 1000),
            "4min > 1min threshold should NOT be near"
        );
    }

    #[tokio::test]
    async fn empty_store_returns_none() {
        let kr = KeyringTokenStore::new(format!("chathub-test-{}", uuid::Uuid::new_v4()));
        let ep = tonic::transport::Endpoint::from_static("http://127.0.0.1:1");
        let store = TokenStore::new(ep, kr.clone()).expect("new");
        assert!(store.current_access_token().is_none());
        assert!(store.current_user_id().is_none());
        assert!(!store.is_logged_in());
        let _ = kr._clear_device_id_for_test();
    }
}
