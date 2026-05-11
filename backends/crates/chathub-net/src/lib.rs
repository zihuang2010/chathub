//! ChatHub network layer:tonic gRPC client + TokenStore + AuthInterceptor + AuthApi + Hub。
//!
//! 公共 API:
//!   - `RELAY_URL`:编译期注入,CHATHUB_RELAY_URL env 提供
//!   - `build_endpoint(url)`:tonic Endpoint 配置(keep-alive、TLS、超时)
//!   - `TokenStore`:同步 RwLock + 后台 refresher task
//!   - `AuthInterceptor`:同步 Interceptor,注入 Bearer + 版本头
//!   - `AuthApi`:login/logout/try_resume_session 业务包装
//!   - `AuthError`:统一错误类型 + From<Status>
//!   - `HubClient` / `ConnectionManager` / `ConnectionState` / `BackoffConfig`(Plan 3)

pub mod auth;
pub mod channel;
pub mod error;
pub mod hub;
pub mod interceptor;
pub mod token;

pub use auth::{AuthApi, LoggedOutReason};
pub use channel::build_endpoint;
pub use error::AuthError;
pub use hub::*;
pub use interceptor::AuthInterceptor;
pub use token::{TokenState, TokenStore};

/// 编译期由 build.rs 注入。无 env 时为占位 https://relay.example.com。
pub const RELAY_URL: &str = env!("CHATHUB_RELAY_URL_RESOLVED");
