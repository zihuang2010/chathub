//! Storage — deadpool_sqlite::Pool 包装 + 启动时跑迁移 + PRAGMA 走 post_create hook。
//!
//! F3 性能修复(2026-05-16):PRAGMA 改成 `Hook::async_fn` 在 post_create 跑**一次/conn**,
//! 而不是每次 `Storage::conn()` 再 interact 一次。后者在 1000 push/s 场景双重 thread-pool
//! 跳转直接砍 DB 吞吐一半。

pub mod events;
pub mod migrations;

use deadpool_sqlite::{Config as PoolCfg, Hook, HookError, Object, Pool, Runtime};
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

        // F3:max_size 显式 = num_cpus * 4(deadpool 默认值的明确版),便于 sizing
        let max_size = num_cpus::get() * 4;

        let pool = cfg
            .builder(Runtime::Tokio1)
            .map_err(|e| StorageError::Pool(e.to_string()))?
            .max_size(max_size)
            .wait_timeout(Some(Duration::from_secs(5)))
            // F3:PRAGMA 一次跑完;新连接出生时 hook 把 WAL/sync/foreign_keys/busy_timeout 设上去
            .post_create(Hook::async_fn(|conn, _| {
                Box::pin(async move {
                    conn.interact(apply_connection_pragmas)
                        .await
                        .map_err(|e| HookError::Message(e.to_string().into()))?
                        .map_err(|e| HookError::Message(e.to_string().into()))?;
                    Ok(())
                })
            }))
            .build()
            .map_err(|e| StorageError::Pool(e.to_string()))?;

        let storage = Self { pool };

        // 跑 migrations
        let conn = storage.conn().await?;
        conn.interact(|c| -> Result<(), StorageError> {
            migrations::migrations().to_latest(c)?;
            Ok(())
        })
        .await
        .map_err(|e| StorageError::Interact(e.to_string()))??;

        Ok(storage)
    }

    /// 取一个 connection(PRAGMA 已在 post_create hook 里跑过,这里只是 pool.get())。
    pub async fn conn(&self) -> Result<Object, StorageError> {
        self.pool
            .get()
            .await
            .map_err(|e| StorageError::Pool(e.to_string()))
    }

    pub fn pool(&self) -> &Pool {
        &self.pool
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn open_leaves_only_hub_events_after_migrations() {
        // Plan 7:legacy 表(events/seq_counters/sessions/kv)都被 003_drop_legacy 删了,
        // 只剩 hub_events 业务表 + rusqlite_migration 的元数据表。
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

        assert!(names.contains(&"hub_events".to_string()));
        assert!(!names.contains(&"events".to_string()));
        assert!(!names.contains(&"events_v2".to_string()));
        assert!(!names.contains(&"seq_counters".to_string()));
        assert!(!names.contains(&"sessions".to_string()));
        assert!(!names.contains(&"kv".to_string()));
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
