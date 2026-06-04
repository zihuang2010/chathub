//! NotifySeqStore(Plan 7)— **按 employee_id 分键**的最高已处理 notify_seq 水位。
//!
//! Subscribe v2 时客户端把这个值作为 `since_notify_seq` 传给 relay,relay 用它续点。
//! 写入热路径在 ConnectionManager 收到 PushBatchOut 处理完之后,WAL+UPSERT 亚毫秒。
//!
//! 存储:`hub_settings` 表(key=`notify_seq:<employee_id>`),与 LocalTokenStore 的
//! `hub_secrets` 同库不同表(见 docs/db/conventions.md §3 KV 拆分约定)。
//!
//! 【按账号分键的理由】本地多账号数据全部按 employee_id 隔离共存(recents/messages/
//! windows/accounts 皆然)。水位若用全局单键,切换账号后新账号会读到旧账号的高水位 →
//! 用错误的 `since` 订阅 → relay 反复判定 resync。故水位也必须按 employee_id 分键。

use crate::error::StateError;
use crate::pool::SqlitePool;
use std::time::{SystemTime, UNIX_EPOCH};

/// 水位键:按 employee_id 分键,各账号独立续点。
fn notify_seq_key(employee_id: &str) -> String {
    format!("notify_seq:{employee_id}")
}

#[derive(Clone)]
pub struct NotifySeqStore {
    pool: SqlitePool,
}

impl NotifySeqStore {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// 读某账号已记录的水位。无记录返 0(对应该账号首连)。
    pub async fn read(&self, employee_id: &str) -> Result<u64, StateError> {
        let key = notify_seq_key(employee_id);
        let conn = self.pool.pool().get().await?;
        let val = conn
            .interact(move |c| -> Result<u64, StateError> {
                let result: Result<String, _> = c.query_row(
                    "SELECT value FROM hub_settings WHERE key = ?1",
                    rusqlite::params![key],
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

    /// 单调写入:仅当 `notify_seq` 大于该账号已记录值时覆盖。
    pub async fn upsert_if_greater(
        &self,
        employee_id: &str,
        notify_seq: u64,
    ) -> Result<(), StateError> {
        let key = notify_seq_key(employee_id);
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
                rusqlite::params![key, notify_seq.to_string(), now],
            )?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// 清空某账号的水位(回到 0)。
    pub async fn clear(&self, employee_id: &str) -> Result<(), StateError> {
        let key = notify_seq_key(employee_id);
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), rusqlite::Error> {
            c.execute(
                "DELETE FROM hub_settings WHERE key = ?1",
                rusqlite::params![key],
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
        assert_eq!(store.read("emp-1").await.unwrap(), 0);
    }

    #[tokio::test]
    async fn notify_seq_upsert_then_read_roundtrips() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = NotifySeqStore::new(pool);
        store.upsert_if_greater("emp-1", 100).await.unwrap();
        assert_eq!(store.read("emp-1").await.unwrap(), 100);
    }

    #[tokio::test]
    async fn notify_seq_upsert_is_monotonic() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = NotifySeqStore::new(pool);
        store.upsert_if_greater("emp-1", 100).await.unwrap();
        store.upsert_if_greater("emp-1", 50).await.unwrap(); // 小的不覆盖
        assert_eq!(store.read("emp-1").await.unwrap(), 100);
        store.upsert_if_greater("emp-1", 200).await.unwrap();
        assert_eq!(store.read("emp-1").await.unwrap(), 200);
    }

    #[tokio::test]
    async fn notify_seq_clear_resets_to_zero() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = NotifySeqStore::new(pool);
        store.upsert_if_greater("emp-1", 100).await.unwrap();
        store.clear("emp-1").await.unwrap();
        assert_eq!(store.read("emp-1").await.unwrap(), 0);
    }

    /// 本 bug 的回归测试:两个账号水位互相独立,切号不串。
    #[tokio::test]
    async fn notify_seq_is_isolated_per_employee() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = NotifySeqStore::new(pool);
        store.upsert_if_greater("emp-1", 171).await.unwrap();
        // 另一账号未记录 → 不被 emp-1 的 171 污染(全局单键时这里会错读成 171)。
        assert_eq!(store.read("emp-2").await.unwrap(), 0);
        store.upsert_if_greater("emp-2", 13).await.unwrap();
        assert_eq!(store.read("emp-2").await.unwrap(), 13);
        assert_eq!(store.read("emp-1").await.unwrap(), 171);
        // 清一个不影响另一个
        store.clear("emp-1").await.unwrap();
        assert_eq!(store.read("emp-1").await.unwrap(), 0);
        assert_eq!(store.read("emp-2").await.unwrap(), 13);
    }
}
