//! seqs 仓:`next_seq(account)` 通过 `UPDATE...RETURNING` 单语句原子递增。

use super::{Storage, StorageError};

#[derive(Clone)]
pub struct SeqAllocator {
    storage: Storage,
}

impl SeqAllocator {
    pub fn new(storage: Storage) -> Self {
        Self { storage }
    }

    /// 原子分配 next_seq:不存在则插入 next_seq=2 并返回 1;存在则 +1 返回新值。
    pub async fn next_seq(&self, account_id: &str) -> Result<i64, StorageError> {
        let a = account_id.to_string();
        let conn = self.storage.conn().await?;
        let seq = conn
            .interact(move |c| -> Result<i64, rusqlite::Error> {
                // 单事务原子;UPSERT 用 RETURNING 拿到新值
                let tx = c.transaction()?;
                let assigned: i64 = tx.query_row(
                    "INSERT INTO seq_counters(wecom_account_id, next_seq) VALUES(?1, 2) \
                     ON CONFLICT(wecom_account_id) DO UPDATE SET next_seq=next_seq+1 \
                     RETURNING next_seq - 1",
                    rusqlite::params![a],
                    |r| r.get::<_, i64>(0),
                )?;
                tx.commit()?;
                Ok(assigned)
            })
            .await
            .map_err(|e| StorageError::Interact(e.to_string()))??;
        Ok(seq)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn make() -> SeqAllocator {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("t.db");
        let storage = Storage::open(&db).await.unwrap();
        std::mem::forget(tmp);
        SeqAllocator::new(storage)
    }

    #[tokio::test]
    async fn first_call_returns_one() {
        let alloc = make().await;
        assert_eq!(alloc.next_seq("wa-1").await.unwrap(), 1);
        assert_eq!(alloc.next_seq("wa-1").await.unwrap(), 2);
        assert_eq!(alloc.next_seq("wa-1").await.unwrap(), 3);
    }

    #[tokio::test]
    async fn different_accounts_independent() {
        let alloc = make().await;
        assert_eq!(alloc.next_seq("wa-1").await.unwrap(), 1);
        assert_eq!(alloc.next_seq("wa-2").await.unwrap(), 1);
        assert_eq!(alloc.next_seq("wa-1").await.unwrap(), 2);
    }

    #[tokio::test]
    async fn hundred_concurrent_no_gaps() {
        let alloc = make().await;
        let mut handles = Vec::new();
        for _ in 0..100 {
            let a = alloc.clone();
            handles.push(tokio::spawn(
                async move { a.next_seq("wa-1").await.unwrap() },
            ));
        }
        let mut got: Vec<i64> = Vec::new();
        for h in handles {
            got.push(h.await.unwrap());
        }
        got.sort();
        assert_eq!(got, (1..=100).collect::<Vec<i64>>());
    }
}
