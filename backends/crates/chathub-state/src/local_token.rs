//! LocalTokenStore:把 device_id 与业务后台 token 存进 SQLite kv 表。
//!
//! 替代原 KeyringTokenStore(macOS Keychain),消除启动时的钥匙串授权弹窗。
//!
//! kv key 约定:
//!   - "device_id" → 持久 UUIDv4(本地设备唯一标识)
//!   - "token"     → 业务后台签发的 token 串

use crate::error::StateError;
use crate::pool::SqlitePool;

const KEY_DEVICE_ID: &str = "device_id";
const KEY_TOKEN: &str = "token";

#[derive(Clone)]
pub struct LocalTokenStore {
    pool: SqlitePool,
}

impl LocalTokenStore {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// 取 device_id;不存在则生成 UUIDv4 写入并返回。幂等(并发下首个写入者胜出)。
    pub async fn ensure_device_id(&self) -> Result<String, StateError> {
        let conn = self.pool.pool().get().await?;
        let id = conn
            .interact(|c| -> Result<String, StateError> {
                c.execute(
                    "INSERT INTO kv (key, value, updated_at) VALUES (?1, ?2, ?3) \
                     ON CONFLICT(key) DO NOTHING",
                    rusqlite::params![
                        KEY_DEVICE_ID,
                        uuid::Uuid::new_v4().to_string(),
                        now_unix_ms()
                    ],
                )?;
                let id: String = c.query_row(
                    "SELECT value FROM kv WHERE key = ?1",
                    rusqlite::params![KEY_DEVICE_ID],
                    |r| r.get(0),
                )?;
                Ok(id)
            })
            .await??;
        Ok(id)
    }

    pub async fn read_token(&self) -> Result<Option<String>, StateError> {
        let conn = self.pool.pool().get().await?;
        let val = conn
            .interact(|c| -> Result<Option<String>, StateError> {
                c.query_row(
                    "SELECT value FROM kv WHERE key = ?1",
                    rusqlite::params![KEY_TOKEN],
                    |r| r.get::<_, String>(0),
                )
                .map(Some)
                .or_else(|e| {
                    if matches!(e, rusqlite::Error::QueryReturnedNoRows) {
                        Ok(None)
                    } else {
                        Err(e.into())
                    }
                })
            })
            .await??;
        Ok(val)
    }

    pub async fn write_token(&self, token: &str) -> Result<(), StateError> {
        let token = token.to_string();
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            c.execute(
                "INSERT INTO kv (key, value, updated_at) VALUES (?1, ?2, ?3) \
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                rusqlite::params![KEY_TOKEN, token, now_unix_ms()],
            )?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    pub async fn clear_token(&self) -> Result<(), StateError> {
        let conn = self.pool.pool().get().await?;
        conn.interact(|c| -> Result<(), rusqlite::Error> {
            c.execute(
                "DELETE FROM kv WHERE key = ?1",
                rusqlite::params![KEY_TOKEN],
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

    #[tokio::test]
    async fn ensure_device_id_is_idempotent() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = LocalTokenStore::new(pool);
        let id1 = store.ensure_device_id().await.expect("first");
        let id2 = store.ensure_device_id().await.expect("second");
        assert_eq!(id1, id2);
        assert!(
            uuid::Uuid::parse_str(&id1).is_ok(),
            "should be valid UUIDv4"
        );
    }

    #[tokio::test]
    async fn token_round_trip() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = LocalTokenStore::new(pool);
        assert!(store.read_token().await.unwrap().is_none(), "starts empty");
        store.write_token("tok-abc").await.expect("write");
        assert_eq!(
            store.read_token().await.unwrap().as_deref(),
            Some("tok-abc")
        );
        store.write_token("tok-xyz").await.expect("overwrite");
        assert_eq!(
            store.read_token().await.unwrap().as_deref(),
            Some("tok-xyz")
        );
        store.clear_token().await.expect("clear");
        assert!(store.read_token().await.unwrap().is_none(), "cleared");
    }

    #[tokio::test]
    async fn clear_when_absent_is_ok() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = LocalTokenStore::new(pool);
        assert!(store.clear_token().await.is_ok());
    }

    #[tokio::test]
    async fn device_id_and_token_are_independent() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = LocalTokenStore::new(pool);
        let id = store.ensure_device_id().await.expect("device_id");
        store.write_token("tok-1").await.expect("write");
        store.clear_token().await.expect("clear");
        // clear token 不应影响 device_id
        assert_eq!(store.ensure_device_id().await.expect("reread"), id);
    }
}
