//! sessions 表:upsert / find_by_refresh_hash / delete / mark_kicked +
//! `hash_refresh_token(pepper, token) -> hex`(HMAC-SHA256)。

use super::{Storage, StorageError};
use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// HMAC-SHA256(pepper, refresh_token) → 64-char hex
pub fn hash_refresh_token(pepper: &str, token: &str) -> String {
    let mut mac =
        HmacSha256::new_from_slice(pepper.as_bytes()).expect("HMAC accepts any key length");
    mac.update(token.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

#[derive(Clone, Debug, PartialEq)]
pub struct Session {
    pub id: i64,
    pub user_id: String,
    pub device_id: String,
    pub refresh_token_hash: String,
    pub refresh_exp_ms: i64,
    pub kicked_at_ms: Option<i64>,
    pub accounts: Vec<String>,
    pub created_at_ms: i64,
}

#[derive(Clone)]
pub struct SessionStore {
    storage: Storage,
}

impl SessionStore {
    pub fn new(storage: Storage) -> Self {
        Self { storage }
    }

    /// UPSERT by (user_id, device_id):同 device 重登覆盖 hash + exp + kicked=NULL + accounts。
    pub async fn upsert(
        &self,
        user_id: &str,
        device_id: &str,
        refresh_token_hash: &str,
        refresh_exp_ms: i64,
        accounts: &[String],
        created_at_ms: i64,
    ) -> Result<(), StorageError> {
        let u = user_id.to_string();
        let d = device_id.to_string();
        let h = refresh_token_hash.to_string();
        let aj =
            serde_json::to_string(accounts).map_err(|e| StorageError::Interact(e.to_string()))?;
        let conn = self
            .storage
            .pool()
            .get()
            .await
            .map_err(|e| StorageError::Pool(e.to_string()))?;
        conn.interact(move |c| -> Result<(), rusqlite::Error> {
            c.execute(
                "INSERT INTO sessions(user_id, device_id, refresh_token_hash, refresh_exp_ms, kicked_at_ms, accounts_json, created_at_ms) \
                 VALUES(?1, ?2, ?3, ?4, NULL, ?5, ?6) \
                 ON CONFLICT(user_id, device_id) DO UPDATE SET \
                   refresh_token_hash=excluded.refresh_token_hash, \
                   refresh_exp_ms=excluded.refresh_exp_ms, \
                   kicked_at_ms=NULL, \
                   accounts_json=excluded.accounts_json",
                rusqlite::params![u, d, h, refresh_exp_ms, aj, created_at_ms],
            )?;
            Ok(())
        })
        .await
        .map_err(|e| StorageError::Interact(e.to_string()))??;
        Ok(())
    }

    pub async fn find_by_refresh_hash(
        &self,
        refresh_token_hash: &str,
    ) -> Result<Option<Session>, StorageError> {
        let h = refresh_token_hash.to_string();
        let conn = self
            .storage
            .pool()
            .get()
            .await
            .map_err(|e| StorageError::Pool(e.to_string()))?;
        let row = conn
            .interact(move |c| -> Result<Option<Session>, rusqlite::Error> {
                let mut stmt = c.prepare(
                    "SELECT id, user_id, device_id, refresh_token_hash, refresh_exp_ms, \
                            kicked_at_ms, accounts_json, created_at_ms \
                     FROM sessions WHERE refresh_token_hash = ?1",
                )?;
                let mut rows = stmt.query(rusqlite::params![h])?;
                if let Some(r) = rows.next()? {
                    let aj: String = r.get(6)?;
                    let accounts: Vec<String> = serde_json::from_str(&aj).map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            6,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?;
                    Ok(Some(Session {
                        id: r.get(0)?,
                        user_id: r.get(1)?,
                        device_id: r.get(2)?,
                        refresh_token_hash: r.get(3)?,
                        refresh_exp_ms: r.get(4)?,
                        kicked_at_ms: r.get(5)?,
                        accounts,
                        created_at_ms: r.get(7)?,
                    }))
                } else {
                    Ok(None)
                }
            })
            .await
            .map_err(|e| StorageError::Interact(e.to_string()))??;
        Ok(row)
    }

    pub async fn delete(&self, refresh_token_hash: &str) -> Result<(), StorageError> {
        let h = refresh_token_hash.to_string();
        let conn = self
            .storage
            .pool()
            .get()
            .await
            .map_err(|e| StorageError::Pool(e.to_string()))?;
        conn.interact(move |c| -> Result<(), rusqlite::Error> {
            c.execute(
                "DELETE FROM sessions WHERE refresh_token_hash = ?1",
                rusqlite::params![h],
            )?;
            Ok(())
        })
        .await
        .map_err(|e| StorageError::Interact(e.to_string()))??;
        Ok(())
    }

    pub async fn mark_kicked(
        &self,
        user_id: &str,
        device_id: &str,
        kicked_at_ms: i64,
    ) -> Result<(), StorageError> {
        let u = user_id.to_string();
        let d = device_id.to_string();
        let conn = self
            .storage
            .pool()
            .get()
            .await
            .map_err(|e| StorageError::Pool(e.to_string()))?;
        conn.interact(move |c| -> Result<(), rusqlite::Error> {
            c.execute(
                "UPDATE sessions SET kicked_at_ms = ?3 \
                 WHERE user_id = ?1 AND device_id = ?2",
                rusqlite::params![u, d, kicked_at_ms],
            )?;
            Ok(())
        })
        .await
        .map_err(|e| StorageError::Interact(e.to_string()))??;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn make() -> SessionStore {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("t.db");
        let storage = Storage::open(&db).await.unwrap();
        // 保留 tempdir 直到测试结束 — leak 即可,test 进程结束自动清
        std::mem::forget(tmp);
        SessionStore::new(storage)
    }

    #[test]
    fn hmac_is_deterministic_and_pepper_dependent() {
        let a = hash_refresh_token("pepperA", "rt-1");
        let b = hash_refresh_token("pepperA", "rt-1");
        let c = hash_refresh_token("pepperB", "rt-1");
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_eq!(a.len(), 64); // hex of 32 bytes
    }

    #[tokio::test]
    async fn upsert_then_find_round_trip() {
        let store = make().await;
        let h = hash_refresh_token("p", "rt-1");
        let accounts = vec!["wa-1".to_string(), "wa-2".to_string()];
        store
            .upsert(
                "u1",
                "dev-1",
                &h,
                1_700_000_000_000,
                &accounts,
                1_699_000_000_000,
            )
            .await
            .unwrap();
        let s = store
            .find_by_refresh_hash(&h)
            .await
            .unwrap()
            .expect("session");
        assert_eq!(s.user_id, "u1");
        assert_eq!(s.device_id, "dev-1");
        assert!(s.kicked_at_ms.is_none());
        assert_eq!(s.accounts, accounts); // JSON round-trip
    }

    #[tokio::test]
    async fn delete_makes_find_return_none() {
        let store = make().await;
        let h = hash_refresh_token("p", "rt-1");
        store.upsert("u1", "dev-1", &h, 1, &[], 1).await.unwrap();
        store.delete(&h).await.unwrap();
        assert!(store.find_by_refresh_hash(&h).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn mark_kicked_sets_tombstone() {
        let store = make().await;
        let h = hash_refresh_token("p", "rt-1");
        store.upsert("u1", "dev-1", &h, 1, &[], 1).await.unwrap();
        store.mark_kicked("u1", "dev-1", 9_999).await.unwrap();
        let s = store
            .find_by_refresh_hash(&h)
            .await
            .unwrap()
            .expect("session");
        assert_eq!(s.kicked_at_ms, Some(9_999));
    }

    #[tokio::test]
    async fn upsert_same_user_device_replaces_hash() {
        let store = make().await;
        let h1 = hash_refresh_token("p", "rt-1");
        let h2 = hash_refresh_token("p", "rt-2");
        store.upsert("u1", "dev-1", &h1, 1, &[], 1).await.unwrap();
        store.upsert("u1", "dev-1", &h2, 2, &[], 2).await.unwrap();
        assert!(store.find_by_refresh_hash(&h1).await.unwrap().is_none());
        assert!(store.find_by_refresh_hash(&h2).await.unwrap().is_some());
    }
}
