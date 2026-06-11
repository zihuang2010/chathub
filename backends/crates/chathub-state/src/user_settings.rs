//! UserSettingsStore:设置页的本地偏好 KV(`hub_user_settings`)。
//!
//! 设计要点:
//! - **纯客户端**:无远端来源,CRUD 全在本地 SQLite;语义(默认值/DTO 结构)在 Tauri 层,
//!   本 store 只做按账号分键的通用 KV 行存。
//! - **按 employee 隔离**:所有读写都 `WHERE employee_id = ?`,切登录账号互不可见。
//! - **value 存 JSON 字面量**(布尔/数字/字符串),序列化与回填默认值由调用方负责。

use crate::error::StateError;
use crate::pool::SqlitePool;

#[derive(Clone)]
pub struct UserSettingsStore {
    pool: SqlitePool,
}

impl UserSettingsStore {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// 读某账号的全部设置项,返回 `(key, value)` 列表。无记录返回空列表。
    pub async fn read_all(&self, employee_id: &str) -> Result<Vec<(String, String)>, StateError> {
        let employee_id = employee_id.to_string();
        let conn = self.pool.pool().get().await?;
        let rows = conn
            .interact(move |c| -> Result<Vec<(String, String)>, StateError> {
                let mut stmt =
                    c.prepare("SELECT key, value FROM hub_user_settings WHERE employee_id = ?1")?;
                let rows = stmt
                    .query_map(rusqlite::params![employee_id], |r| {
                        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .await??;
        Ok(rows)
    }

    /// 批量 UPSERT 若干设置项(同 key 覆盖,带 updated_at_ms)。单事务,要么全成要么全不成。
    pub async fn upsert_many(
        &self,
        employee_id: &str,
        entries: &[(String, String)],
    ) -> Result<(), StateError> {
        let employee_id = employee_id.to_string();
        let entries = entries.to_vec();
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            let now = now_unix_ms();
            let tx = c.transaction()?;
            {
                let mut stmt = tx.prepare(
                    "INSERT INTO hub_user_settings (employee_id, key, value, updated_at_ms) \
                     VALUES (?1, ?2, ?3, ?4) \
                     ON CONFLICT(employee_id, key) DO UPDATE SET \
                       value = excluded.value, updated_at_ms = excluded.updated_at_ms",
                )?;
                for (key, value) in &entries {
                    stmt.execute(rusqlite::params![employee_id, key, value, now])?;
                }
            }
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

    const E: &str = "emp-1";

    fn kv(k: &str, v: &str) -> (String, String) {
        (k.to_string(), v.to_string())
    }

    #[tokio::test]
    async fn read_all_empty_returns_empty_list() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = UserSettingsStore::new(pool);
        assert!(store.read_all(E).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn upsert_then_read_all_roundtrips() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = UserSettingsStore::new(pool);
        store
            .upsert_many(
                E,
                &[
                    kv("notify.sound", "false"),
                    kv("app.closeAction", "\"quit\""),
                ],
            )
            .await
            .unwrap();
        let mut rows = store.read_all(E).await.unwrap();
        rows.sort();
        assert_eq!(
            rows,
            vec![
                kv("app.closeAction", "\"quit\""),
                kv("notify.sound", "false")
            ]
        );
    }

    #[tokio::test]
    async fn upsert_same_key_overwrites_value() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = UserSettingsStore::new(pool);
        store
            .upsert_many(E, &[kv("net.silenceTimeoutSecs", "45")])
            .await
            .unwrap();
        store
            .upsert_many(E, &[kv("net.silenceTimeoutSecs", "60")])
            .await
            .unwrap();
        let rows = store.read_all(E).await.unwrap();
        assert_eq!(rows, vec![kv("net.silenceTimeoutSecs", "60")]);
    }

    /// 切登录账号设置不串台:两个账号各存各的,互不可见。
    #[tokio::test]
    async fn isolates_by_employee() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = UserSettingsStore::new(pool);
        store
            .upsert_many("emp-A", &[kv("notify.sound", "false")])
            .await
            .unwrap();
        store
            .upsert_many("emp-B", &[kv("notify.sound", "true")])
            .await
            .unwrap();
        assert_eq!(
            store.read_all("emp-A").await.unwrap(),
            vec![kv("notify.sound", "false")]
        );
        assert_eq!(
            store.read_all("emp-B").await.unwrap(),
            vec![kv("notify.sound", "true")]
        );
    }
}
