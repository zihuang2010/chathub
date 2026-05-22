//! ChatHub local state:SQLite (deadpool-sqlite)。
//!
//! 公共 API:
//!   - `LocalTokenStore`:存 device_id + 业务后台 token 到 `hub_secrets` 表
//!   - `NotifySeqStore`:存最高已处理 notify_seq 到 `hub_settings` 表(Subscribe 连接级 resume 水位)
//!   - `SessionStore`:存 UserProfile 到 `hub_current_session` 表
//!   - `AccountCacheStore`:wecom 账号列表本地镜像(`hub_wecom_accounts`)+ 账号事件水位(独立于 NotifySeqStore)
//!   - `FriendsStore`:wecom 好友(客户)行存(`hub_wecom_friends`)+ 全量同步状态 + 事件水位
//!   - `RecentSessionsStore`:session/recentFriends "头部热缓存"(`hub_conversation_recents`)
//!     + 客户端排序规则(置顶 / 草稿)+ 事件水位
//!   - `SqlitePool`:WAL-mode SQLite 连接池,自动跑迁移
//!   - `StateError`:统一错误类型
//!
//! 表命名规范见 `docs/db/conventions.md`(`hub_` 前缀强制 + KV 拆分)。

pub mod account_cache;
pub mod error;
pub mod friends_cache;
pub mod local_token;
pub mod messages;
pub mod notify_seq;
pub mod pool;
pub mod recent_sessions;
pub mod session;

pub use account_cache::{AccountCacheStore, BindingAction, WecomAccountRow};
pub use error::StateError;
pub use friends_cache::FriendsStore;
pub use local_token::LocalTokenStore;
pub use messages::{MessageRow, MessageWindow, MessagesStore, MESSAGE_HOT_CONVERSATIONS_LIMIT};
pub use notify_seq::NotifySeqStore;
pub use pool::SqlitePool;
pub use recent_sessions::{
    RecentSessionRemote, RecentSessionRow, RecentSessionSummary, RecentSessionsStore,
    RECENT_SESSIONS_GLOBAL_LIMIT, RECENT_SESSIONS_MAX_ROWS, RECENT_SESSIONS_PER_ACCOUNT_LIMIT,
};
pub use session::SessionStore;
