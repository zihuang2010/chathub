//! SqlitePool:WAL-mode SQLite 连接池,启动时跑迁移。

use crate::error::StateError;
use deadpool_sqlite::{Config, Pool, Runtime};
use rusqlite_migration::{Migrations, M};
use std::path::Path;

#[derive(Clone)]
pub struct SqlitePool {
    pool: Pool,
}

impl SqlitePool {
    /// 打开磁盘 SQLite,自动建文件 + 跑迁移 + 开 WAL。
    pub async fn open(path: impl AsRef<Path>) -> Result<Self, StateError> {
        let cfg = Config::new(path.as_ref().to_path_buf());
        let pool = cfg
            .create_pool(Runtime::Tokio1)
            .map_err(|e| StateError::Pool(e.to_string()))?;
        let me = Self { pool };
        me.apply_migrations().await?;
        me.set_pragma_wal().await?;
        Ok(me)
    }

    /// 内存 SQLite,跑迁移。仅供测试用。
    pub async fn in_memory() -> Result<Self, StateError> {
        let cfg = Config::new(":memory:");
        let pool = cfg
            .create_pool(Runtime::Tokio1)
            .map_err(|e| StateError::Pool(e.to_string()))?;
        let me = Self { pool };
        me.apply_migrations().await?;
        Ok(me)
    }

    pub fn pool(&self) -> &Pool {
        &self.pool
    }

    async fn apply_migrations(&self) -> Result<(), StateError> {
        let conn = self.pool.get().await?;
        conn.interact(|c| {
            let migrations = Migrations::new(vec![
                M::up(include_str!("../migrations/V1__init.sql")),
                M::up(include_str!("../migrations/V2__seqs.sql")),
            ]);
            migrations
                .to_latest(c)
                .map_err(|e| StateError::Migration(e.to_string()))
        })
        .await??;
        Ok(())
    }

    async fn set_pragma_wal(&self) -> Result<(), StateError> {
        let conn = self.pool.get().await?;
        conn.interact(|c| -> Result<(), rusqlite::Error> {
            c.pragma_update(None, "journal_mode", "WAL")?;
            c.pragma_update(None, "foreign_keys", "ON")?;
            Ok(())
        })
        .await??;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn in_memory_pool_applies_all_migrations() {
        let pool = SqlitePool::in_memory().await.expect("pool open");

        let conn = pool.pool().get().await.expect("get conn");
        let table_count: i64 = conn.interact(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('current_session', 'wecom_accounts', 'wecom_account_seqs')",
                [],
                |r| r.get(0),
            )
        }).await.expect("interact").expect("query");

        assert_eq!(
            table_count, 3,
            "V1+V2 migrations should create three tables"
        );
    }

    #[tokio::test]
    async fn in_memory_pool_supports_repeated_open() {
        // 再开一次:迁移已 idempotent,不应报错(rusqlite_migration 会比对版本)
        let _p1 = SqlitePool::in_memory().await.expect("first");
        let _p2 = SqlitePool::in_memory().await.expect("second");
    }
}
