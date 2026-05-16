//! Storage — deadpool_sqlite::Pool 包装 + 启动时跑迁移 + 每次取 conn 时确保 PRAGMA 已应用。
//!
//! 设计:deadpool 按需扩展 pool,新 connection 的 PRAGMA 默认不会带过来。
//! 这里通过 `Storage::conn()` 包装一层,每次从 pool 拿 conn 时跑一次 `apply_connection_pragmas`
//! (PRAGMA 写是幂等的,SQLite 内部对相同值是 noop,只是一次系统调用)。
//!
//! 这比 deadpool 的 `post_create` hook 简单得多(deadpool-sqlite 内部用 SyncWrapper,
//! 在 Hook 闭包里类型推断很难写)。微观成本可忽略(每次 interact 多一次 µs 级 PRAGMA)。

pub mod events;
pub mod kv;
pub mod migrations;
pub mod seqs;

use deadpool_sqlite::{Config as PoolCfg, Object, Pool, Runtime};
use std::path::Path;
use std::time::Duration;

#[derive(thiserror::Error, Debug)]
pub enum StorageError {
    #[error("pool: {0}")]
    Pool(String),
    #[error("interact: {0}")]
    Interact(String),
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("migration: {0}")]
    Migration(#[from] rusqlite_migration::Error),
}

#[derive(Clone)]
pub struct Storage {
    pool: Pool,
}

/// 每个新 connection 启动时必须应用的 PRAGMA(WAL + busy_timeout + 等)。
/// 通过 deadpool 的 `post_create` hook 调用,确保 pool 长出新连接时也会应用。
fn apply_connection_pragmas(c: &mut rusqlite::Connection) -> Result<(), rusqlite::Error> {
    c.pragma_update(None, "journal_mode", "WAL")?;
    c.pragma_update(None, "synchronous", "NORMAL")?;
    c.pragma_update(None, "foreign_keys", "ON")?;
    // P0:并发 push 时 SQLite 写锁竞争 → 等待最多 5 秒而非立即 SQLITE_BUSY 失败
    c.pragma_update(None, "busy_timeout", "5000")?;
    Ok(())
}

impl Storage {
    pub async fn open(db_path: impl AsRef<Path>) -> Result<Self, StorageError> {
        let cfg = PoolCfg::new(db_path.as_ref().to_path_buf());

        let pool = cfg
            .builder(Runtime::Tokio1)
            .map_err(|e| StorageError::Pool(e.to_string()))?
            .wait_timeout(Some(Duration::from_secs(5)))
            .build()
            .map_err(|e| StorageError::Pool(e.to_string()))?;

        let storage = Self { pool };
        // 跑 migrations(走 storage.conn() 确保 PRAGMA 已应用)
        let conn = storage.conn().await?;
        conn.interact(|c| -> Result<(), StorageError> {
            migrations::migrations().to_latest(c)?;
            Ok(())
        })
        .await
        .map_err(|e| StorageError::Interact(e.to_string()))??;

        Ok(storage)
    }

    /// 取一个应用了 PRAGMA(WAL + busy_timeout + 等)的 connection。
    /// PRAGMA 写是幂等的 — 第二次以后 SQLite 内部 noop。
    /// **所有 storage 层的 interact 都应通过这个函数取 conn,而不是直接调 `pool.get()`**。
    pub async fn conn(&self) -> Result<Object, StorageError> {
        let conn = self
            .pool
            .get()
            .await
            .map_err(|e| StorageError::Pool(e.to_string()))?;
        conn.interact(|c| apply_connection_pragmas(c))
            .await
            .map_err(|e| StorageError::Interact(e.to_string()))??;
        Ok(conn)
    }

    pub fn pool(&self) -> &Pool {
        &self.pool
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn open_creates_four_tables() {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("t.db");
        let storage = Storage::open(&db).await.expect("open");

        let conn = storage.pool().get().await.unwrap();
        let names = conn
            .interact(|c| -> Result<Vec<String>, rusqlite::Error> {
                let mut stmt = c.prepare(
                    "SELECT name FROM sqlite_master \
                     WHERE type='table' AND name NOT LIKE 'sqlite_%' \
                     ORDER BY name",
                )?;
                let rows = stmt
                    .query_map([], |r| r.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(rows)
            })
            .await
            .unwrap()
            .unwrap();

        // 4 业务表 + rusqlite_migration 的 1 张元数据表
        assert!(names.contains(&"sessions".to_string()));
        assert!(names.contains(&"seq_counters".to_string()));
        assert!(names.contains(&"events".to_string()));
        assert!(names.contains(&"kv".to_string()));
    }

    #[tokio::test]
    async fn reopen_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("t.db");
        let _ = Storage::open(&db).await.unwrap();
        // 第二次 open 应当不报错(migrations.to_latest 幂等)
        let _ = Storage::open(&db).await.unwrap();
    }
}
