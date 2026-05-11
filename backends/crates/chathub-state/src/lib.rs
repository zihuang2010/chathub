//! ChatHub local state:SQLite (deadpool-sqlite) + OS keychain (keyring)。
//!
//! 公共 API:
//!   - `KeyringTokenStore`:存 refresh_token + device_id 到 OS Keychain
//!   - `SessionStore`:存 UserProfile 与 WecomAccount 镜像到 SQLite
//!   - `SeqStore`:每账号 last_seq 持久化(Plan 3)
//!   - `SqlitePool`:WAL-mode SQLite 连接池,自动跑迁移
//!   - `StateError`:统一错误类型

pub mod error;
pub mod pool;
pub mod seqs;
pub mod session;
pub mod tokens;

pub use error::StateError;
pub use pool::SqlitePool;
pub use seqs::SeqStore;
pub use session::SessionStore;
pub use tokens::KeyringTokenStore;
