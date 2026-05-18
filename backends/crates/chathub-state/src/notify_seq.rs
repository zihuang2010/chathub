//! NotifySeqStore(Plan 7)— per-客户端的最高已处理 notify_seq 水位。
//!
//! Subscribe v2 时客户端把这个值作为 `since_notify_seq` 传给 relay,relay 用它续点。
//! 写入热路径在 ConnectionManager 收到 PushBatchOut 处理完之后,WAL+UPSERT 亚毫秒。
//!
//! 存储:`hub_settings` 表(key="notify_seq"),与 LocalTokenStore 的
//! `hub_secrets` 同库不同表(见 docs/db/conventions.md §3 KV 拆分约定)。

use crate::error::StateError;
use crate::pool::SqlitePool;
use std::time::{SystemTime, UNIX_EPOCH};

const KEY_NOTIFY_SEQ: &str = "notify_seq";

#[derive(Clone)]
pub struct NotifySeqStore {
    pool: SqlitePool,
}

impl NotifySeqStore {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// 读已记录的水位。无记录返 0(对应客户端首连)。
    pub async fn read(&self) -> Result<u64, StateError> {
        let conn = self.pool.pool().get().await?;
        let val = conn
            .interact(|c| -> Result<u64, StateError> {
                let result: Result<String, _> = c.query_row(
                    "SELECT value FROM hub_settings WHERE key = ?1",
                    rusqlite::params![KEY_NOTIFY_SEQ],
                    |r| r.get(0),
                );
                match result {
                    Ok(s) => Ok(s.parse().unwrap_or(0)),
                    Err(rusqlite::Error::QueryReturnedNoRows) => Ok(0),
                    Err(e) => Err(e.into()),
                }
            })
            .await??;
        Ok(val)
    }

    /// 单调写入:仅当 `notify_seq` 大于已记录值时覆盖。
    pub async fn upsert_if_greater(&self, notify_seq: u64) -> Result<(), StateError> {
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            let now = now_unix_ms();
            // 用 CASE 在 SQL 内做"取 max"语义,避免 read-then-write race
            c.execute(
                "INSERT INTO hub_settings (key, value, updated_at) VALUES (?1, ?2, ?3) \
                 ON CONFLICT(key) DO UPDATE SET \
                   value = CASE WHEN CAST(excluded.value AS INTEGER) > CAST(value AS INTEGER) \
                                THEN excluded.value ELSE value END, \
                   updated_at = excluded.updated_at",
                rusqlite::params![KEY_NOTIFY_SEQ, notify_seq.to_string(), now],
            )?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    pub async fn clear(&self) -> Result<(), StateError> {
        let conn = self.pool.pool().get().await?;
        conn.interact(|c| -> Result<(), rusqlite::Error> {
            c.execute(
                "DELETE FROM hub_settings WHERE key = ?1",
                rusqlite::params![KEY_NOTIFY_SEQ],
            )?;
            Ok(())
        })
        .await??;
        Ok(())
    }
}

fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn notify_seq_starts_at_zero() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = NotifySeqStore::new(pool);
        assert_eq!(store.read().await.unwrap(), 0);
    }

    #[tokio::test]
    async fn notify_seq_upsert_then_read_roundtrips() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = NotifySeqStore::new(pool);
        store.upsert_if_greater(100).await.unwrap();
        assert_eq!(store.read().await.unwrap(), 100);
    }

    #[tokio::test]
    async fn notify_seq_upsert_is_monotonic() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = NotifySeqStore::new(pool);
        store.upsert_if_greater(100).await.unwrap();
        store.upsert_if_greater(50).await.unwrap(); // 小的不覆盖
        assert_eq!(store.read().await.unwrap(), 100);
        store.upsert_if_greater(200).await.unwrap();
        assert_eq!(store.read().await.unwrap(), 200);
    }

    #[tokio::test]
    async fn notify_seq_clear_resets_to_zero() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = NotifySeqStore::new(pool);
        store.upsert_if_greater(100).await.unwrap();
        store.clear().await.unwrap();
        assert_eq!(store.read().await.unwrap(), 0);
    }
}
