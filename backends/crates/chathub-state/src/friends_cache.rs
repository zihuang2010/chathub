//! FriendsStore:listFriends 的 notifySeq 水位。
//!
//! **阶段 3:退役全量镜像**。客户列表改纯 cursor 滚动(`list_friends` 直接透传业务后台
//! keyset 分页,不写本地行存),原先的"行存 + 全量同步 + 增量 apply_binding"全部退役。
//! 本 store 现在只剩:
//!   - **水位**:`hub_wecom_friend_watermark`,"取大不取小"UPSERT,应对 relay redelivery
//!     (per-resource watermark 退役分两步,本步先保留)。
//!   - **登出清理**:`clear_for_employee` 兜底清掉该员工的水位 + 任何历史遗留的行存/同步态
//!     (老版本升级上来的存量行,新版本不再读写,清掉避免占用)。
//!
//! 文件名 `friends_cache.rs` 沿用(避免改 mod.rs / lib.rs 导出)。

use crate::error::StateError;
use crate::pool::SqlitePool;

#[derive(Clone)]
pub struct FriendsStore {
    pool: SqlitePool,
}

impl FriendsStore {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// 推进水位:UPSERT "取大不取小"。
    pub async fn advance_watermark(
        &self,
        client_id: &str,
        employee_id: &str,
        notify_seq: u64,
    ) -> Result<(), StateError> {
        let client_id = client_id.to_string();
        let employee_id = employee_id.to_string();
        let seq = notify_seq as i64;
        let now = now_unix_ms();
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            c.execute(
                "INSERT INTO hub_wecom_friend_watermark (client_id, employee_id, last_seq, updated_at_ms) \
                 VALUES (?1, ?2, ?3, ?4) \
                 ON CONFLICT(client_id, employee_id) DO UPDATE SET \
                   last_seq = CASE WHEN excluded.last_seq > last_seq THEN excluded.last_seq ELSE last_seq END, \
                   updated_at_ms = excluded.updated_at_ms",
                rusqlite::params![client_id, employee_id, seq, now],
            )?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// 读水位(未写过返 0)。
    pub async fn get_watermark(
        &self,
        client_id: &str,
        employee_id: &str,
    ) -> Result<u64, StateError> {
        let client_id = client_id.to_string();
        let employee_id = employee_id.to_string();
        let conn = self.pool.pool().get().await?;
        let seq = conn
            .interact(move |c| -> Result<u64, StateError> {
                let res: rusqlite::Result<i64> = c.query_row(
                    "SELECT last_seq FROM hub_wecom_friend_watermark \
                     WHERE client_id = ?1 AND employee_id = ?2",
                    rusqlite::params![client_id, employee_id],
                    |r| r.get(0),
                );
                match res {
                    Ok(v) => Ok(v as u64),
                    Err(rusqlite::Error::QueryReturnedNoRows) => Ok(0),
                    Err(e) => Err(e.into()),
                }
            })
            .await??;
        Ok(seq)
    }

    /// 清掉该员工的水位 + 历史遗留的行存 / 同步态。登出 / 换员工时调。
    /// `hub_wecom_friends` / `hub_wecom_friend_sync_state` 新版已不再读写,
    /// 这里仍 DELETE 是为了清掉老版本升级上来的存量行(防御性,不依赖迁移 drop 表)。
    pub async fn clear_for_employee(&self, employee_id: &str) -> Result<(), StateError> {
        let employee_id = employee_id.to_string();
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            let tx = c.transaction()?;
            tx.execute(
                "DELETE FROM hub_wecom_friends WHERE employee_id = ?1",
                rusqlite::params![employee_id],
            )?;
            tx.execute(
                "DELETE FROM hub_wecom_friend_sync_state WHERE employee_id = ?1",
                rusqlite::params![employee_id],
            )?;
            tx.execute(
                "DELETE FROM hub_wecom_friend_watermark WHERE employee_id = ?1",
                rusqlite::params![employee_id],
            )?;
            tx.commit()?;
            Ok(())
        })
        .await??;
        Ok(())
    }
}

fn now_unix_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn watermark_monotonic_upsert() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = FriendsStore::new(pool);
        store.advance_watermark("c1", "u-1", 10).await.unwrap();
        store.advance_watermark("c1", "u-1", 5).await.unwrap(); // 取大不取小,被吞
        store.advance_watermark("c1", "u-1", 20).await.unwrap();
        assert_eq!(store.get_watermark("c1", "u-1").await.unwrap(), 20);
    }

    #[tokio::test]
    async fn watermark_isolated_per_client_and_employee() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = FriendsStore::new(pool);
        store.advance_watermark("c1", "u-1", 100).await.unwrap();
        store.advance_watermark("c2", "u-1", 50).await.unwrap();
        store.advance_watermark("c1", "u-2", 30).await.unwrap();
        assert_eq!(store.get_watermark("c1", "u-1").await.unwrap(), 100);
        assert_eq!(store.get_watermark("c2", "u-1").await.unwrap(), 50);
        assert_eq!(store.get_watermark("c1", "u-2").await.unwrap(), 30);
        assert_eq!(store.get_watermark("c1", "u-unknown").await.unwrap(), 0);
    }

    #[tokio::test]
    async fn clear_for_employee_wipes_watermark() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = FriendsStore::new(pool);
        store.advance_watermark("c1", "u-1", 42).await.unwrap();
        store.clear_for_employee("u-1").await.unwrap();
        assert_eq!(store.get_watermark("c1", "u-1").await.unwrap(), 0);
    }

    #[tokio::test]
    async fn clear_for_employee_isolates_by_employee() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = FriendsStore::new(pool);
        store.advance_watermark("c1", "u-A", 10).await.unwrap();
        store.advance_watermark("c1", "u-B", 20).await.unwrap();
        store.clear_for_employee("u-A").await.unwrap();
        assert_eq!(store.get_watermark("c1", "u-A").await.unwrap(), 0);
        assert_eq!(store.get_watermark("c1", "u-B").await.unwrap(), 20);
    }
}
