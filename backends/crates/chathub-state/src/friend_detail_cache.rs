//! FriendDetailCacheStore:好友(客户)详情的本地缓存(`hub_friend_detail_cache`)。
//!
//! 设计要点:
//! - **当天缓存**:命中条件为「写入时刻与当前为同一本地日历日」,判定用 SQLite
//!   `date(cached_at_ms/1000,'unixepoch','localtime')` 与 `date('now','localtime')` 比较,
//!   随系统时区,无需后端引入时区库。跨天即视为未命中,由调用方走远程重拉。
//! - **不感知详情结构**:只存不透明的 `detail_json`(WecomFriendDetail 的 camelCase JSON),
//!   crate 间解耦,详情字段变化无需改本表。
//! - **按归属账号隔离**:复合主键 `(wecom_account_id, external_user_id)`,同一外部联系人被多账号
//!   添加时分别缓存。

use crate::error::StateError;
use crate::pool::SqlitePool;
use rusqlite::OptionalExtension;

pub struct FriendDetailCacheStore {
    pool: SqlitePool,
}

impl FriendDetailCacheStore {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// 读「当天有效」的详情 JSON。命中返回 `Some(json)`;不存在或跨天返回 `None`。
    pub async fn get_fresh_today(
        &self,
        wecom_account_id: &str,
        external_user_id: &str,
    ) -> Result<Option<String>, StateError> {
        let wecom_account_id = wecom_account_id.to_string();
        let external_user_id = external_user_id.to_string();
        let conn = self.pool.pool().get().await?;
        let json = conn
            .interact(move |c| -> Result<Option<String>, StateError> {
                let json = c
                    .query_row(
                        "SELECT detail_json FROM hub_friend_detail_cache \
                         WHERE wecom_account_id = ?1 AND external_user_id = ?2 \
                           AND date(cached_at_ms / 1000, 'unixepoch', 'localtime') \
                               = date('now', 'localtime')",
                        rusqlite::params![wecom_account_id, external_user_id],
                        |r| r.get::<_, String>(0),
                    )
                    .optional()?;
                Ok(json)
            })
            .await??;
        Ok(json)
    }

    /// 写入 / 覆盖一条详情缓存,`cached_at_ms` 取当前时刻。
    pub async fn upsert(
        &self,
        wecom_account_id: &str,
        external_user_id: &str,
        detail_json: &str,
    ) -> Result<(), StateError> {
        self.upsert_with_ts(
            wecom_account_id,
            external_user_id,
            detail_json,
            now_unix_ms(),
        )
        .await
    }

    /// 指定写入时刻的内部实现(供测试构造跨天数据)。
    async fn upsert_with_ts(
        &self,
        wecom_account_id: &str,
        external_user_id: &str,
        detail_json: &str,
        cached_at_ms: i64,
    ) -> Result<(), StateError> {
        let wecom_account_id = wecom_account_id.to_string();
        let external_user_id = external_user_id.to_string();
        let detail_json = detail_json.to_string();
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            c.execute(
                "INSERT INTO hub_friend_detail_cache \
                   (wecom_account_id, external_user_id, detail_json, cached_at_ms) \
                 VALUES (?1, ?2, ?3, ?4) \
                 ON CONFLICT(wecom_account_id, external_user_id) DO UPDATE SET \
                   detail_json = excluded.detail_json, \
                   cached_at_ms = excluded.cached_at_ms",
                rusqlite::params![
                    wecom_account_id,
                    external_user_id,
                    detail_json,
                    cached_at_ms
                ],
            )?;
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

    const ACC: &str = "acc-1";
    const EXT: &str = "ext-1";

    #[tokio::test]
    async fn upsert_then_hit_same_day() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = FriendDetailCacheStore::new(pool);

        store
            .upsert(ACC, EXT, r#"{"externalName":"张三"}"#)
            .await
            .unwrap();

        let got = store.get_fresh_today(ACC, EXT).await.unwrap();
        assert_eq!(got.as_deref(), Some(r#"{"externalName":"张三"}"#));
    }

    #[tokio::test]
    async fn miss_when_absent() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = FriendDetailCacheStore::new(pool);
        assert_eq!(store.get_fresh_today(ACC, EXT).await.unwrap(), None);
    }

    #[tokio::test]
    async fn expires_across_calendar_day() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = FriendDetailCacheStore::new(pool);

        // 写一条 3 天前的缓存 → 必然跨本地日历日 → 视为未命中。
        let three_days_ago = now_unix_ms() - 3 * 24 * 60 * 60 * 1000;
        store
            .upsert_with_ts(ACC, EXT, r#"{"externalName":"旧"}"#, three_days_ago)
            .await
            .unwrap();
        assert_eq!(store.get_fresh_today(ACC, EXT).await.unwrap(), None);

        // 覆盖为当天 → 命中。
        store
            .upsert(ACC, EXT, r#"{"externalName":"新"}"#)
            .await
            .unwrap();
        assert_eq!(
            store.get_fresh_today(ACC, EXT).await.unwrap().as_deref(),
            Some(r#"{"externalName":"新"}"#)
        );
    }

    #[tokio::test]
    async fn isolates_by_account_and_contact() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = FriendDetailCacheStore::new(pool);
        store.upsert("acc-A", EXT, r#"{"n":"A"}"#).await.unwrap();
        store.upsert("acc-B", EXT, r#"{"n":"B"}"#).await.unwrap();

        assert_eq!(
            store
                .get_fresh_today("acc-A", EXT)
                .await
                .unwrap()
                .as_deref(),
            Some(r#"{"n":"A"}"#)
        );
        assert_eq!(
            store
                .get_fresh_today("acc-B", EXT)
                .await
                .unwrap()
                .as_deref(),
            Some(r#"{"n":"B"}"#)
        );
    }
}
