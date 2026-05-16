//! ChatHub local state:SQLite (deadpool-sqlite)。
//!
//! 公共 API:
//!   - `LocalTokenStore`:存 device_id + 业务后台 token 到 SQLite kv 表
//!   - `SessionStore`:存 UserProfile 与 WecomAccount 镜像到 SQLite
//!   - `SeqStore`:每账号 last_seq 持久化(Plan 3)
//!   - `SqlitePool`:WAL-mode SQLite 连接池,自动跑迁移
//!   - `StateError`:统一错误类型

pub mod error;
pub mod local_token;
pub mod pool;
pub mod seqs;
pub mod session;

pub use error::StateError;
pub use local_token::LocalTokenStore;
pub use pool::SqlitePool;
pub use seqs::SeqStore;
pub use session::SessionStore;
