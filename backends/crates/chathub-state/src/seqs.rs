//! SeqStore:每账号 last_seq 持久化(Plan 3)。
//! 单表 wecom_account_seqs;UPSERT 写在 ConnectionManager 热路径,
//! WAL+UPSERT 单条亚毫秒,YAGNI 不批量。

use crate::error::StateError;
use crate::pool::SqlitePool;
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone)]
pub struct SeqStore {
    pool: SqlitePool,
}

impl SeqStore {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// 读全部 (wecom_account_id, last_seq) 拼成 since_seqs map。
    /// 空表返回空 map。
    pub async fn read_all(&self) -> Result<HashMap<String, i64>, StateError> {
        let conn = self.pool.pool().get().await?;
        let map = conn
            .interact(|c| -> Result<HashMap<String, i64>, rusqlite::Error> {
                let mut stmt =
                    c.prepare("SELECT wecom_account_id, last_seq FROM wecom_account_seqs")?;
                let rows =
                    stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
                let mut out = HashMap::new();
                for row in rows {
                    let (k, v) = row?;
                    out.insert(k, v);
                }
                Ok(out)
            })
            .await??;
        Ok(map)
    }

    /// UPSERT 单条:存在则覆盖 last_seq + updated_at_ms。
    pub async fn upsert(&self, account_id: &str, seq: i64) -> Result<(), StateError> {
        let now = now_ms();
        let aid = account_id.to_string();
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), rusqlite::Error> {
            c.execute(
                "INSERT INTO wecom_account_seqs(wecom_account_id, last_seq, updated_at_ms) \
                 VALUES (?1, ?2, ?3) \
                 ON CONFLICT(wecom_account_id) DO UPDATE SET \
                   last_seq = excluded.last_seq, \
                   updated_at_ms = excluded.updated_at_ms",
                rusqlite::params![aid, seq, now],
            )?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// 清空表。logout / 切租户使用。
    pub async fn clear(&self) -> Result<(), StateError> {
        let conn = self.pool.pool().get().await?;
        conn.interact(|c| -> Result<(), rusqlite::Error> {
            c.execute("DELETE FROM wecom_account_seqs", [])?;
            Ok(())
        })
        .await??;
        Ok(())
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn seq_store_upsert_then_read_all_round_trips() {
        let pool = SqlitePool::in_memory().await.expect("pool");
        let store = SeqStore::new(pool);

        store.upsert("wxa1", 10).await.expect("upsert wxa1");
        store.upsert("wxa2", 20).await.expect("upsert wxa2");
        store.upsert("wxa3", 30).await.expect("upsert wxa3");

        let map = store.read_all().await.expect("read_all");
        assert_eq!(map.get("wxa1"), Some(&10));
        assert_eq!(map.get("wxa2"), Some(&20));
        assert_eq!(map.get("wxa3"), Some(&30));
        assert_eq!(map.len(), 3);
    }

    #[tokio::test]
    async fn seq_store_upsert_overwrites_existing_account() {
        let pool = SqlitePool::in_memory().await.expect("pool");
        let store = SeqStore::new(pool);

        store.upsert("wxa1", 10).await.expect("upsert v1");
        store.upsert("wxa1", 25).await.expect("upsert v2");

        let map = store.read_all().await.expect("read_all");
        assert_eq!(map.get("wxa1"), Some(&25));
        assert_eq!(map.len(), 1);
    }

    #[tokio::test]
    async fn seq_store_clear_empties_table() {
        let pool = SqlitePool::in_memory().await.expect("pool");
        let store = SeqStore::new(pool);

        store.upsert("wxa1", 10).await.expect("upsert");
        store.upsert("wxa2", 20).await.expect("upsert");
        store.clear().await.expect("clear");

        let map = store.read_all().await.expect("read_all");
        assert!(map.is_empty(), "after clear: {map:?}");
    }

    #[tokio::test]
    async fn seq_store_in_memory_pool_works() {
        let pool = SqlitePool::in_memory().await.expect("pool");
        let store = SeqStore::new(pool);

        store.upsert("wxa1", 1).await.expect("ok");
        let map = store.read_all().await.expect("ok");
        assert_eq!(map.get("wxa1"), Some(&1));
    }
}
