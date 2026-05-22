//! ChatHub network layer:tonic gRPC client + TokenStore + AuthInterceptor + AuthApi + Hub。
//!
//! 公共 API:
//!   - `RELAY_URL`:编译期注入,CHATHUB_RELAY_URL env 提供
//!   - `build_endpoint(url)`:tonic Endpoint 配置(keep-alive、TLS、超时)
//!   - `TokenStore`:进程内 token 状态 + 本地 SQLite 持久化(无续签、无钥匙串)
//!   - `AuthInterceptor`:同步 Interceptor,注入 Bearer + 版本头
//!   - `AuthApi`:login/logout/try_resume_session 业务包装
//!   - `AuthError`:统一错误类型 + From<Status>
//!   - `HubClient` / `ConnectionManager` / `ConnectionState` / `BackoffConfig`

pub mod account_event;
pub mod auth;
pub mod change_notice;
pub mod channel;
pub mod error;
pub mod friend_event;
pub mod hub;
pub mod interceptor;
pub mod message_event;
pub mod message_sync;
pub mod recent_session_event;
pub mod token;

pub use account_event::AccountEventApplier;
pub use auth::{AuthApi, LoggedOutReason};
pub use change_notice::{ChangeKind, ChangeNotice, ChangeScope, ChangeSource, ChangeTopic};
pub use channel::build_endpoint;
pub use error::AuthError;
pub use friend_event::FriendEventApplier;
pub use hub::*;
pub use interceptor::AuthInterceptor;
pub use message_event::MessageEventApplier;
pub use message_sync::{
    classify_reconcile, history_to_row, row_to_history, LoadOlderResult, MessageSync, ReconcileMode,
};
pub use recent_session_event::{record_to_remote, RecentSessionEventApplier};
pub use token::{TokenState, TokenStore};

/// 编译期由 build.rs 注入。无 env 时为占位 https://relay.example.com。
pub const RELAY_URL: &str = env!("CHATHUB_RELAY_URL_RESOLVED");
