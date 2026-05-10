//! SessionStore:UserProfile 当前会话 + WecomAccount 镜像 → SQLite。

use crate::error::StateError;
use crate::pool::SqlitePool;
use chathub_proto::v1::{UserProfile, WecomAccount};

#[derive(Clone)]
pub struct SessionStore {
    pool: SqlitePool,
}

impl SessionStore {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// 写入(或覆盖)当前用户会话与其授权账号镜像。
    /// 同一时刻只允许一个 session(由 current_session.id = 1 约束)。
    pub async fn upsert_session(
        &self,
        profile: &UserProfile,
        accounts: &[WecomAccount],
    ) -> Result<(), StateError> {
        let profile = profile.clone();
        let accounts: Vec<WecomAccount> = accounts.to_vec();
        let now = now_unix_ms();

        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            let tx = c.transaction()?;
            // current_session 永远只有一行(id = 1)
            tx.execute(
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
            // wecom_accounts:全表替换为该 user 的最新列表
            tx.execute(
                "DELETE FROM wecom_accounts WHERE user_id = ?1",
                rusqlite::params![profile.user_id],
            )?;
            for acc in &accounts {
                tx.execute(
                    "INSERT OR REPLACE INTO wecom_accounts (wecom_account_id, user_id, corp_id, agent_id, display_name, enabled, cached_at_ms) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    rusqlite::params![
                        acc.wecom_account_id, profile.user_id, acc.corp_id,
                        acc.agent_id, acc.display_name, acc.enabled as i64, now,
                    ],
                )?;
            }
            tx.commit()?;
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

    pub async fn read_wecom_accounts(
        &self,
        user_id: &str,
    ) -> Result<Vec<WecomAccount>, StateError> {
        let user_id = user_id.to_string();
        let conn = self.pool.pool().get().await?;
        let accounts: Vec<WecomAccount> = conn
            .interact(move |c| -> Result<Vec<WecomAccount>, StateError> {
                let mut stmt = c.prepare(
                    "SELECT wecom_account_id, corp_id, agent_id, display_name, enabled \
                 FROM wecom_accounts WHERE user_id = ?1 ORDER BY wecom_account_id",
                )?;
                let rows = stmt
                    .query_map(rusqlite::params![user_id], |row| {
                        Ok(WecomAccount {
                            wecom_account_id: row.get(0)?,
                            corp_id: row.get(1)?,
                            agent_id: row.get::<_, i64>(2)? as u32,
                            display_name: row.get(3)?,
                            enabled: row.get::<_, i64>(4)? != 0,
                        })
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(rows)
            })
            .await??;
        Ok(accounts)
    }

    pub async fn clear(&self) -> Result<(), StateError> {
        let conn = self.pool.pool().get().await?;
        conn.interact(|c| -> Result<(), rusqlite::Error> {
            c.execute("DELETE FROM current_session", [])?;
            c.execute("DELETE FROM wecom_accounts", [])?;
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

    fn sample_accounts() -> Vec<WecomAccount> {
        vec![
            WecomAccount {
                wecom_account_id: "wa-1".into(),
                corp_id: "wwd00".into(),
                agent_id: 1000001,
                display_name: "杭州企微-小美".into(),
                enabled: true,
            },
            WecomAccount {
                wecom_account_id: "wa-2".into(),
                corp_id: "wwd00".into(),
                agent_id: 1000002,
                display_name: "上海企微-大白".into(),
                enabled: false,
            },
        ]
    }

    #[tokio::test]
    async fn upsert_then_read_round_trip() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = SessionStore::new(pool);
        store
            .upsert_session(&sample_profile(), &sample_accounts())
            .await
            .unwrap();

        let p = store.read_current().await.unwrap().expect("profile");
        assert_eq!(p, sample_profile());

        let accs = store.read_wecom_accounts("u-1").await.unwrap();
        assert_eq!(accs.len(), 2);
        assert_eq!(accs[0].wecom_account_id, "wa-1");
        assert!(!accs[1].enabled);
    }

    #[tokio::test]
    async fn upsert_replaces_existing_accounts_for_same_user() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = SessionStore::new(pool);
        store
            .upsert_session(&sample_profile(), &sample_accounts())
            .await
            .unwrap();

        let new_accounts = vec![WecomAccount {
            wecom_account_id: "wa-9".into(),
            corp_id: "wwd00".into(),
            agent_id: 9000001,
            display_name: "新账号".into(),
            enabled: true,
        }];
        store
            .upsert_session(&sample_profile(), &new_accounts)
            .await
            .unwrap();

        let accs = store.read_wecom_accounts("u-1").await.unwrap();
        assert_eq!(accs.len(), 1);
        assert_eq!(accs[0].wecom_account_id, "wa-9");
    }

    #[tokio::test]
    async fn clear_removes_session_and_accounts() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = SessionStore::new(pool);
        store
            .upsert_session(&sample_profile(), &sample_accounts())
            .await
            .unwrap();
        store.clear().await.unwrap();

        assert!(store.read_current().await.unwrap().is_none());
        assert!(store.read_wecom_accounts("u-1").await.unwrap().is_empty());
    }
}
