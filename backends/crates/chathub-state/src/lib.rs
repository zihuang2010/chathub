//! ChatHub local state:SQLite (deadpool-sqlite)。
//!
//! 公共 API(Plan 7 已清掉 SeqStore;改用 NotifySeqStore 单 seq 水位):
//!   - `LocalTokenStore`:存 device_id + 业务后台 token 到 SQLite kv 表
//!   - `NotifySeqStore`:存最高已处理 notify_seq 到 kv 表
//!   - `SessionStore`:存 UserProfile 与 WecomAccount 镜像到 SQLite
//!   - `SqlitePool`:WAL-mode SQLite 连接池,自动跑迁移
//!   - `StateError`:统一错误类型

pub mod error;
pub mod local_token;
pub mod notify_seq;
pub mod pool;
pub mod session;

pub use error::StateError;
pub use local_token::LocalTokenStore;
pub use notify_seq::NotifySeqStore;
pub use pool::SqlitePool;
pub use session::SessionStore;
