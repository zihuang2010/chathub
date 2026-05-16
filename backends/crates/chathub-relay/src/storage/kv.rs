//! kv 表:单行 KV(JWT 私钥 PEM、kid)。

use super::{Storage, StorageError};

#[derive(Clone)]
pub struct KvStore {
    storage: Storage,
}

impl KvStore {
    pub fn new(storage: Storage) -> Self {
        Self { storage }
    }

    pub async fn get(&self, key: &str) -> Result<Option<Vec<u8>>, StorageError> {
        let k = key.to_string();
        let conn = self.storage.conn().await?;
        let v = conn
            .interact(move |c| -> Result<Option<Vec<u8>>, rusqlite::Error> {
                let mut stmt = c.prepare("SELECT value FROM kv WHERE key=?1")?;
                let mut rows = stmt.query(rusqlite::params![k])?;
                if let Some(r) = rows.next()? {
                    Ok(Some(r.get(0)?))
                } else {
                    Ok(None)
                }
            })
            .await
            .map_err(|e| StorageError::Interact(e.to_string()))??;
        Ok(v)
    }

    pub async fn put(&self, key: &str, value: Vec<u8>) -> Result<(), StorageError> {
        let k = key.to_string();
        let conn = self.storage.conn().await?;
        conn.interact(move |c| -> Result<(), rusqlite::Error> {
            c.execute(
                "INSERT INTO kv(key, value) VALUES(?1, ?2) \
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                rusqlite::params![k, value],
            )?;
            Ok(())
        })
        .await
        .map_err(|e| StorageError::Interact(e.to_string()))??;
        Ok(())
    }
}
