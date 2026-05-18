//! SessionStore:UserProfile 当前会话 → SQLite。
//!
//! 2026-05-17 起,wecom_accounts 镜像不再在 login 时由 SessionStore 写入
//! (LoginResp.wecom_accounts 已永远为空,前端通过 `list_accounts` 命令走
//! `AccountCacheStore` 独立同步)。SessionStore 只负责 UserProfile 单行。

use crate::error::StateError;
use crate::pool::SqlitePool;
use chathub_proto::v1::UserProfile;

#[derive(Clone)]
pub struct SessionStore {
    pool: SqlitePool,
}

impl SessionStore {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// 写入(或覆盖)当前用户会话。
    /// 同一时刻只允许一个 session(由 current_session.id = 1 约束)。
    pub async fn upsert_session(&self, profile: &UserProfile) -> Result<(), StateError> {
        let profile = profile.clone();
        let now = now_unix_ms();

        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            c.execute(
                "INSERT INTO current_session (id, user_id, display_name, avatar_url, role, tenant_id, logged_in_at_ms) \
                 VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6) \
                 ON CONFLICT(id) DO UPDATE SET \
                   user_id = excluded.user_id, \
                   display_name = excluded.display_name, \
                   avatar_url = excluded.avatar_url, \
                   role = excluded.role, \
                   tenant_id = excluded.tenant_id, \
                   logged_in_at_ms = excluded.logged_in_at_ms",
                rusqlite::params![
                    profile.user_id, profile.display_name, profile.avatar_url,
                    profile.role, profile.tenant_id, now,
                ],
            )?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    pub async fn read_current(&self) -> Result<Option<UserProfile>, StateError> {
        let conn = self.pool.pool().get().await?;
        let profile: Option<UserProfile> = conn.interact(move |c| -> Result<Option<UserProfile>, StateError> {
            c.query_row(
                "SELECT user_id, display_name, avatar_url, role, tenant_id FROM current_session WHERE id = 1",
                [],
                |row| {
                    Ok(UserProfile {
                        user_id:      row.get(0)?,
                        display_name: row.get(1)?,
                        avatar_url:   row.get(2)?,
                        role:         row.get(3)?,
                        tenant_id:    row.get(4)?,
                    })
                },
            )
            .map(Some)
            .or_else(|e| if matches!(e, rusqlite::Error::QueryReturnedNoRows) { Ok(None) } else { Err(e.into()) })
        }).await??;
        Ok(profile)
    }

    /// 登出 / 切账号时清空当前 session 镜像 + 账号缓存 + 账号水位。
    /// 账号缓存与水位由 `AccountCacheStore` 管,但 SessionStore::clear() 一起清
    /// 是登出语义的自然一部分 —— 三件事必须原子完成。
    pub async fn clear(&self) -> Result<(), StateError> {
        let conn = self.pool.pool().get().await?;
        conn.interact(|c| -> Result<(), rusqlite::Error> {
            let tx = c.transaction()?;
            tx.execute("DELETE FROM current_session", [])?;
            tx.execute("DELETE FROM wecom_accounts", [])?;
            tx.execute("DELETE FROM wecom_account_watermark", [])?;
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

    fn sample_profile() -> UserProfile {
        UserProfile {
            user_id: "u-1".into(),
            display_name: "Alice".into(),
            avatar_url: "".into(),
            role: "operator".into(),
            tenant_id: "t-42".into(),
        }
    }

    #[tokio::test]
    async fn upsert_then_read_round_trip() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = SessionStore::new(pool);
        store.upsert_session(&sample_profile()).await.unwrap();

        let p = store.read_current().await.unwrap().expect("profile");
        assert_eq!(p, sample_profile());
    }

    #[tokio::test]
    async fn clear_removes_session() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = SessionStore::new(pool);
        store.upsert_session(&sample_profile()).await.unwrap();
        store.clear().await.unwrap();

        assert!(store.read_current().await.unwrap().is_none());
    }

    // clear() 同时清 wecom_accounts + wecom_account_watermark 的行为
    // 在 `account_cache::tests` 里通过 AccountCacheStore 高层 API 校验,
    // 避免在这里手插 SQL(deadpool-sqlite + ":memory:" 多 conn 状态不共享)。
}
