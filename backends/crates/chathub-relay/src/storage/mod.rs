//! Storage — deadpool_sqlite::Pool 包装 + 启动时跑迁移 + PRAGMA WAL。

pub mod events;
pub mod kv;
pub mod migrations;
pub mod seqs;
pub mod sessions;

use deadpool_sqlite::{Config as PoolCfg, Pool, Runtime};
use std::path::Path;

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

impl Storage {
    pub async fn open(db_path: impl AsRef<Path>) -> Result<Self, StorageError> {
        let cfg = PoolCfg::new(db_path.as_ref().to_path_buf());
        let pool = cfg
            .create_pool(Runtime::Tokio1)
            .map_err(|e| StorageError::Pool(e.to_string()))?;

        // PRAGMA + migrations 在同一个 connection 里跑
        let conn = pool
            .get()
            .await
            .map_err(|e| StorageError::Pool(e.to_string()))?;
        conn.interact(|c| -> Result<(), StorageError> {
            c.pragma_update(None, "journal_mode", "WAL")?;
            c.pragma_update(None, "synchronous", "NORMAL")?;
            c.pragma_update(None, "foreign_keys", "ON")?;
            migrations::migrations().to_latest(c)?;
            Ok(())
        })
        .await
        .map_err(|e| StorageError::Interact(e.to_string()))??;

        Ok(Self { pool })
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
