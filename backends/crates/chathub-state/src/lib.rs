//! ChatHub local state:SQLite (deadpool-sqlite)。
//!
//! 公共 API:
//!   - `LocalTokenStore`:存 device_id + 业务后台 token 到 SQLite kv 表
//!   - `NotifySeqStore`:存最高已处理 notify_seq 到 kv 表(Subscribe 连接级 resume 水位)
//!   - `SessionStore`:存 UserProfile 到 current_session 表
//!   - `AccountCacheStore`:wecom 账号列表本地镜像 + 账号事件水位(独立于 NotifySeqStore)
//!   - `FriendsStore`:wecom 好友(客户)行存 + 全量同步状态 + 事件水位
//!   - `SqlitePool`:WAL-mode SQLite 连接池,自动跑迁移
//!   - `StateError`:统一错误类型

pub mod account_cache;
pub mod error;
pub mod friends_cache;
pub mod local_token;
pub mod notify_seq;
pub mod pool;
pub mod session;

pub use account_cache::{AccountCacheStore, BindingAction, WecomAccountRow};
pub use error::StateError;
pub use friends_cache::{FriendBindingAction, FriendsStore, WecomFriendRow};
pub use local_token::LocalTokenStore;
pub use notify_seq::NotifySeqStore;
pub use pool::SqlitePool;
pub use session::SessionStore;
