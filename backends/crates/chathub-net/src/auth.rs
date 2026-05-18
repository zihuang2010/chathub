//! AuthApi:供 backends 用的高层包装。
//! 内部持有 TokenStore + SessionStore,负责本地 SQLite / 内存 state 协同。

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
        // 2026-05-17:LoginResp.wecom_accounts 永远空,账号列表走 `list_accounts` 命令 +
        // `AccountCacheStore` 独立同步。SessionStore 只镜像 UserProfile。
        self.session_store.upsert_session(&profile).await?;
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

    /// 进程启动时调用:本地 SQLite 有 token + SessionStore 有 profile → 直接复活会话。
    ///
    /// 客户端不做续签:不发任何网络请求,只把持久化的 token 装回内存 state。
    /// 若 token 已失效,首个 Hub RPC 会收到 Unauthenticated,届时再触发登出重登。
    pub async fn try_resume_session(&self) -> Result<Option<UserProfile>, AuthError> {
        // 1. 本地有 token?
        let token = match self.token_store.try_load_token().await {
            Some(t) => t,
            None => return Ok(None),
        };

        // 2. SessionStore 有 profile?没有则状态不一致,清掉本地 token。
        let profile = match self.session_store.read_current().await? {
            Some(p) => p,
            None => {
                self.token_store.clear_session().await;
                return Ok(None);
            }
        };

        // 3. 装回内存 state,会话复活。
        self.token_store.set_session(token, profile.user_id.clone());
        Ok(Some(profile))
    }
}
