//! AuthApi:供 backends 用的高层包装。
//! 内部 持有 TokenStore + SessionStore,负责 keyring/SQLite/state 协同。

use crate::error::AuthError;
use crate::token::{LoggedOutReason as TokenLoggedOutReason, TokenStore};
use chathub_proto::v1::UserProfile;
use chathub_state::SessionStore;
use std::sync::Arc;
use tokio::sync::broadcast;

pub use crate::token::LoggedOutReason;

#[derive(Clone)]
pub struct AuthApi {
    token_store: Arc<TokenStore>,
    session_store: SessionStore,
}

impl AuthApi {
    pub fn new(token_store: Arc<TokenStore>, session_store: SessionStore) -> Self {
        Self {
            token_store,
            session_store,
        }
    }

    pub async fn login(&self, username: &str, password: &str) -> Result<UserProfile, AuthError> {
        let resp = self.token_store.login(username, password).await?;
        let profile = resp.user.ok_or_else(|| AuthError::Internal {
            message: "login response missing user".into(),
        })?;
        let accounts = resp.wecom_accounts;

        self.session_store
            .upsert_session(&profile, &accounts)
            .await?;

        // 启动后台 refresher
        self.token_store.spawn_refresher().await;

        Ok(profile)
    }

    pub async fn logout(&self) -> Result<(), AuthError> {
        self.token_store.logout().await?;
        self.session_store.clear().await?;
        Ok(())
    }

    pub async fn current_session(&self) -> Result<Option<UserProfile>, AuthError> {
        // 以 SessionStore + TokenStore 双重一致性返回:任一缺失都视为未登录。
        if !self.token_store.is_logged_in() {
            return Ok(None);
        }
        Ok(self.session_store.read_current().await?)
    }

    pub fn logged_out_subscribe(&self) -> broadcast::Receiver<TokenLoggedOutReason> {
        self.token_store.logged_out_subscribe()
    }
}
