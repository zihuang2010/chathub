//! events 表(ring buffer):record / replay_after。
//! 每 account 保留最近 1000 条;每次 record 后修剪。

use super::{Storage, StorageError};

const RING_SIZE: i64 = 1000;

#[derive(Clone)]
pub struct EventStore {
    storage: Storage,
}

impl EventStore {
    pub fn new(storage: Storage) -> Self {
        Self { storage }
    }

    pub async fn record(
        &self,
        account_id: &str,
        seq: i64,
        payload: Vec<u8>,
        created_at_ms: i64,
    ) -> Result<(), StorageError> {
        let a = account_id.to_string();
        let conn = self
            .storage
            .pool()
            .get()
            .await
            .map_err(|e| StorageError::Pool(e.to_string()))?;
        conn.interact(move |c| -> Result<(), rusqlite::Error> {
            let tx = c.transaction()?;
            tx.execute(
                "INSERT INTO events(wecom_account_id, seq, payload, created_at_ms) \
                 VALUES(?1, ?2, ?3, ?4)",
                rusqlite::params![a, seq, payload, created_at_ms],
            )?;
            // ring 修剪
            tx.execute(
                "DELETE FROM events WHERE wecom_account_id = ?1 AND seq <= ?2 - ?3",
                rusqlite::params![a, seq, RING_SIZE],
            )?;
            tx.commit()?;
            Ok(())
        })
        .await
        .map_err(|e| StorageError::Interact(e.to_string()))??;
        Ok(())
    }

    /// 返回 seq > since 的 events,按 seq 升序,limit 限定。
    pub async fn replay_after(
        &self,
        account_id: &str,
        since: i64,
        limit: i64,
    ) -> Result<Vec<(i64, Vec<u8>)>, StorageError> {
        let a = account_id.to_string();
        let conn = self
            .storage
            .pool()
            .get()
            .await
            .map_err(|e| StorageError::Pool(e.to_string()))?;
        let rows = conn
            .interact(move |c| -> Result<Vec<(i64, Vec<u8>)>, rusqlite::Error> {
                let mut stmt = c.prepare(
                    "SELECT seq, payload FROM events \
                     WHERE wecom_account_id = ?1 AND seq > ?2 \
                     ORDER BY seq ASC LIMIT ?3",
                )?;
                let rows = stmt
                    .query_map(rusqlite::params![a, since, limit], |r| {
                        Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?))
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(rows)
            })
            .await
            .map_err(|e| StorageError::Interact(e.to_string()))??;
        Ok(rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn make() -> EventStore {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("t.db");
        let storage = Storage::open(&db).await.unwrap();
        std::mem::forget(tmp);
        EventStore::new(storage)
    }

    #[tokio::test]
    async fn record_then_replay_ascending() {
        let es = make().await;
        for s in 1..=5_i64 {
            es.record("wa-1", s, vec![s as u8], s).await.unwrap();
        }
        let out = es.replay_after("wa-1", 2, 200).await.unwrap();
        assert_eq!(out, vec![(3, vec![3]), (4, vec![4]), (5, vec![5])]);
    }

    #[tokio::test]
    async fn replay_respects_limit() {
        let es = make().await;
        for s in 1..=10_i64 {
            es.record("wa-1", s, vec![s as u8], s).await.unwrap();
        }
        let out = es.replay_after("wa-1", 0, 3).await.unwrap();
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].0, 1);
        assert_eq!(out[2].0, 3);
    }

    #[tokio::test]
    async fn replay_isolates_per_account() {
        let es = make().await;
        es.record("wa-1", 1, vec![1], 1).await.unwrap();
        es.record("wa-2", 1, vec![9], 1).await.unwrap();
        let out = es.replay_after("wa-1", 0, 200).await.unwrap();
        assert_eq!(out, vec![(1, vec![1])]);
    }

    #[tokio::test]
    async fn ring_trims_to_thousand() {
        let es = make().await;
        for s in 1..=1100_i64 {
            es.record("wa-1", s, vec![0xAB], s).await.unwrap();
        }
        // 余下应为 seq 101..=1100
        let all = es.replay_after("wa-1", 0, 2000).await.unwrap();
        assert_eq!(all.len(), 1000);
        assert_eq!(all.first().unwrap().0, 101);
        assert_eq!(all.last().unwrap().0, 1100);
    }
}
