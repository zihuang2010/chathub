//! AccountCacheStore:企微账号列表的本地 SQLite 镜像 + 账号事件水位。
//!
//! 设计要点:
//!   - 全量拉取(首次登录 / `resync_required` / 用户手动刷新)走 `replace_all_for_employee`;
//!     单 employee 范围内 DELETE + 批量 INSERT,事务内完成,无中间态。
//!   - 增量事件(`ACCOUNT_BINDING_CHANGE` 的 4 个 reason)走 `apply_binding`,
//!     每个 reason 对应一种 SQL 动作。INSERT OR REPLACE / UPDATE / 不存在行的 DELETE 都自然幂等。
//!   - 水位(`wecom_account_watermark`)走 `advance_watermark`,套 [`crate::NotifySeqStore`] 的
//!     "取大不取小" UPSERT 套路,应对 relay redelivery。
//!
//! 命名:内部字段 `employee_id`(= `UserProfile.user_id`,同一个 String)。

use crate::error::StateError;
use crate::pool::SqlitePool;
use serde::{Deserialize, Serialize};

/// 一条 wecom 账号缓存行,字段形态跟业务后台 listMine 响应一致(camelCase JSON ↔ snake_case Rust)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WecomAccountRow {
    pub wecom_account_id: String,
    pub employee_id: String,
    pub wecom_name: String,
    pub wecom_account: String,
    pub wecom_alias: String,
    pub wecom_avatar: String,
    pub wecom_status: i32,
    pub gender: i32,
    pub position: String,
}

/// `ACCOUNT_BINDING_CHANGE` 事件的 4 个 reason → 客户端动作。
/// 后台已确认的 reason 集合(2026-05-17 口径):
/// `ACCOUNT_ADDED` / `ACCOUNT_DISABLED` / `ACCOUNT_TRANSFERRED` / `ACCOUNT_ALIAS_CHANGED`。
#[derive(Debug, Clone)]
pub enum BindingAction {
    /// 员工新增可管理企微账号。payload 必带全 8 字段。
    Added(WecomAccountRow),
    /// 单个企微账号绑定禁用。只需 `wecom_account_id`,UPDATE wecom_status=0。
    Disabled { wecom_account_id: String },
    /// 企微账号转移到其他员工。从当前 employee 下 DELETE。
    Transferred {
        wecom_account_id: String,
        employee_id: String,
    },
    /// 企微账号别名变化。
    AliasChanged {
        wecom_account_id: String,
        wecom_alias: String,
    },
}

#[derive(Clone)]
pub struct AccountCacheStore {
    pool: SqlitePool,
}

impl AccountCacheStore {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn read_for_employee(
        &self,
        employee_id: &str,
    ) -> Result<Vec<WecomAccountRow>, StateError> {
        let employee_id = employee_id.to_string();
        let conn = self.pool.pool().get().await?;
        let rows = conn
            .interact(move |c| -> Result<Vec<WecomAccountRow>, StateError> {
                let mut stmt = c.prepare(
                    "SELECT wecom_account_id, employee_id, wecom_name, wecom_account, wecom_alias, \
                            wecom_avatar, wecom_status, gender, position \
                     FROM wecom_accounts WHERE employee_id = ?1 ORDER BY wecom_account_id",
                )?;
                let rows = stmt
                    .query_map(rusqlite::params![employee_id], |row| {
                        Ok(WecomAccountRow {
                            wecom_account_id: row.get(0)?,
                            employee_id: row.get(1)?,
                            wecom_name: row.get(2)?,
                            wecom_account: row.get(3)?,
                            wecom_alias: row.get(4)?,
                            wecom_avatar: row.get(5)?,
                            wecom_status: row.get::<_, i64>(6)? as i32,
                            gender: row.get::<_, i64>(7)? as i32,
                            position: row.get(8)?,
                        })
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(rows)
            })
            .await??;
        Ok(rows)
    }

    /// 全量替换 employee 名下账号缓存。**事务内 DELETE + 批量 INSERT**,中间无可见态。
    pub async fn replace_all_for_employee(
        &self,
        employee_id: &str,
        rows: &[WecomAccountRow],
    ) -> Result<(), StateError> {
        let employee_id = employee_id.to_string();
        let rows: Vec<WecomAccountRow> = rows.to_vec();
        let now = now_unix_ms();
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            let tx = c.transaction()?;
            tx.execute(
                "DELETE FROM wecom_accounts WHERE employee_id = ?1",
                rusqlite::params![employee_id],
            )?;
            for r in &rows {
                tx.execute(
                    "INSERT OR REPLACE INTO wecom_accounts (wecom_account_id, employee_id, wecom_name, wecom_account, wecom_alias, wecom_avatar, wecom_status, gender, position, updated_at_ms) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                    rusqlite::params![
                        r.wecom_account_id, r.employee_id, r.wecom_name, r.wecom_account,
                        r.wecom_alias, r.wecom_avatar, r.wecom_status as i64,
                        r.gender as i64, r.position, now,
                    ],
                )?;
            }
            tx.commit()?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// 应用 `ACCOUNT_BINDING_CHANGE` 事件。
    pub async fn apply_binding(&self, action: BindingAction) -> Result<(), StateError> {
        let now = now_unix_ms();
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            match action {
                BindingAction::Added(r) => {
                    c.execute(
                        "INSERT OR REPLACE INTO wecom_accounts (wecom_account_id, employee_id, wecom_name, wecom_account, wecom_alias, wecom_avatar, wecom_status, gender, position, updated_at_ms) \
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                        rusqlite::params![
                            r.wecom_account_id, r.employee_id, r.wecom_name, r.wecom_account,
                            r.wecom_alias, r.wecom_avatar, r.wecom_status as i64,
                            r.gender as i64, r.position, now,
                        ],
                    )?;
                }
                BindingAction::Disabled { wecom_account_id } => {
                    c.execute(
                        "UPDATE wecom_accounts SET wecom_status = 0, updated_at_ms = ?2 \
                         WHERE wecom_account_id = ?1",
                        rusqlite::params![wecom_account_id, now],
                    )?;
                }
                BindingAction::Transferred { wecom_account_id, employee_id } => {
                    c.execute(
                        "DELETE FROM wecom_accounts WHERE wecom_account_id = ?1 AND employee_id = ?2",
                        rusqlite::params![wecom_account_id, employee_id],
                    )?;
                }
                BindingAction::AliasChanged { wecom_account_id, wecom_alias } => {
                    c.execute(
                        "UPDATE wecom_accounts SET wecom_alias = ?2, updated_at_ms = ?3 \
                         WHERE wecom_account_id = ?1",
                        rusqlite::params![wecom_account_id, wecom_alias, now],
                    )?;
                }
            }
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// 推进水位:`UPSERT` "取大不取小",应对 relay redelivery 同 notify_seq 多次到。
    /// 套路同 [`crate::NotifySeqStore::upsert_if_greater`]。
    pub async fn advance_watermark(
        &self,
        client_id: &str,
        employee_id: &str,
        notify_seq: u64,
    ) -> Result<(), StateError> {
        let client_id = client_id.to_string();
        let employee_id = employee_id.to_string();
        let now = now_unix_ms();
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            c.execute(
                "INSERT INTO wecom_account_watermark (client_id, employee_id, last_seq, updated_at_ms) \
                 VALUES (?1, ?2, ?3, ?4) \
                 ON CONFLICT(client_id, employee_id) DO UPDATE SET \
                   last_seq = CASE WHEN excluded.last_seq > last_seq THEN excluded.last_seq ELSE last_seq END, \
                   updated_at_ms = excluded.updated_at_ms",
                rusqlite::params![client_id, employee_id, notify_seq as i64, now],
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
                    "SELECT last_seq FROM wecom_account_watermark \
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

    /// 单 employee 范围清账号缓存(用于切账号场景;`SessionStore::clear` 是全表清,这是细粒度版)。
    pub async fn clear_for_employee(&self, employee_id: &str) -> Result<(), StateError> {
        let employee_id = employee_id.to_string();
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            let tx = c.transaction()?;
            tx.execute(
                "DELETE FROM wecom_accounts WHERE employee_id = ?1",
                rusqlite::params![employee_id],
            )?;
            tx.execute(
                "DELETE FROM wecom_account_watermark WHERE employee_id = ?1",
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

    fn sample_row(id: &str, employee: &str, alias: &str, status: i32) -> WecomAccountRow {
        WecomAccountRow {
            wecom_account_id: id.into(),
            employee_id: employee.into(),
            wecom_name: format!("name-{id}"),
            wecom_account: format!("acc-{id}"),
            wecom_alias: alias.into(),
            wecom_avatar: format!("https://example.com/{id}.png"),
            wecom_status: status,
            gender: 1,
            position: "工程师".into(),
        }
    }

    #[tokio::test]
    async fn replace_then_read_round_trip() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = AccountCacheStore::new(pool);
        let rows = vec![
            sample_row("wa-1", "u-1", "alpha", 1),
            sample_row("wa-2", "u-1", "beta", 0),
        ];
        store.replace_all_for_employee("u-1", &rows).await.unwrap();
        let got = store.read_for_employee("u-1").await.unwrap();
        assert_eq!(got, rows);
    }

    #[tokio::test]
    async fn replace_isolates_per_employee() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = AccountCacheStore::new(pool);
        store
            .replace_all_for_employee("u-1", &[sample_row("wa-1", "u-1", "alpha", 1)])
            .await
            .unwrap();
        store
            .replace_all_for_employee("u-2", &[sample_row("wa-9", "u-2", "zulu", 1)])
            .await
            .unwrap();
        // u-1 不应被 u-2 的 replace 触碰
        let u1 = store.read_for_employee("u-1").await.unwrap();
        assert_eq!(u1.len(), 1);
        assert_eq!(u1[0].wecom_account_id, "wa-1");
    }

    #[tokio::test]
    async fn apply_binding_added_inserts_row() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = AccountCacheStore::new(pool);
        let row = sample_row("wa-new", "u-1", "fresh", 1);
        store
            .apply_binding(BindingAction::Added(row.clone()))
            .await
            .unwrap();
        let got = store.read_for_employee("u-1").await.unwrap();
        assert_eq!(got, vec![row]);
    }

    #[tokio::test]
    async fn apply_binding_disabled_flips_status() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = AccountCacheStore::new(pool);
        store
            .replace_all_for_employee("u-1", &[sample_row("wa-1", "u-1", "alpha", 1)])
            .await
            .unwrap();
        store
            .apply_binding(BindingAction::Disabled {
                wecom_account_id: "wa-1".into(),
            })
            .await
            .unwrap();
        let got = store.read_for_employee("u-1").await.unwrap();
        assert_eq!(got[0].wecom_status, 0);
    }

    #[tokio::test]
    async fn apply_binding_transferred_removes_row_only_for_owner() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = AccountCacheStore::new(pool);
        store
            .replace_all_for_employee("u-1", &[sample_row("wa-shared", "u-1", "alpha", 1)])
            .await
            .unwrap();
        // 转走给 u-2 — 当前 employee=u-1 的镜像应该被 DELETE
        store
            .apply_binding(BindingAction::Transferred {
                wecom_account_id: "wa-shared".into(),
                employee_id: "u-1".into(),
            })
            .await
            .unwrap();
        assert!(store.read_for_employee("u-1").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn apply_binding_alias_changed_updates_only_alias() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = AccountCacheStore::new(pool);
        store
            .replace_all_for_employee("u-1", &[sample_row("wa-1", "u-1", "alpha", 1)])
            .await
            .unwrap();
        store
            .apply_binding(BindingAction::AliasChanged {
                wecom_account_id: "wa-1".into(),
                wecom_alias: "renamed".into(),
            })
            .await
            .unwrap();
        let got = store.read_for_employee("u-1").await.unwrap();
        assert_eq!(got[0].wecom_alias, "renamed");
        assert_eq!(got[0].wecom_status, 1); // 其他字段不动
    }

    #[tokio::test]
    async fn apply_binding_is_idempotent_under_redelivery() {
        // INSERT OR REPLACE / UPDATE / DELETE-absent 都天然幂等
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = AccountCacheStore::new(pool);
        for _ in 0..3 {
            store
                .apply_binding(BindingAction::Added(sample_row("wa-1", "u-1", "alpha", 1)))
                .await
                .unwrap();
        }
        let got = store.read_for_employee("u-1").await.unwrap();
        assert_eq!(got.len(), 1);
    }

    #[tokio::test]
    async fn watermark_monotonic_upsert() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = AccountCacheStore::new(pool);
        store.advance_watermark("c1", "u-1", 10).await.unwrap();
        store.advance_watermark("c1", "u-1", 5).await.unwrap(); // 取大不取小,被吞
        store.advance_watermark("c1", "u-1", 20).await.unwrap();
        assert_eq!(store.get_watermark("c1", "u-1").await.unwrap(), 20);
    }

    #[tokio::test]
    async fn watermark_isolated_per_client_and_employee() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = AccountCacheStore::new(pool);
        store.advance_watermark("c1", "u-1", 100).await.unwrap();
        store.advance_watermark("c2", "u-1", 50).await.unwrap();
        store.advance_watermark("c1", "u-2", 30).await.unwrap();
        assert_eq!(store.get_watermark("c1", "u-1").await.unwrap(), 100);
        assert_eq!(store.get_watermark("c2", "u-1").await.unwrap(), 50);
        assert_eq!(store.get_watermark("c1", "u-2").await.unwrap(), 30);
        assert_eq!(store.get_watermark("c1", "u-unknown").await.unwrap(), 0);
    }

    #[tokio::test]
    async fn clear_for_employee_wipes_both_cache_and_watermark() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = AccountCacheStore::new(pool);
        store
            .replace_all_for_employee("u-1", &[sample_row("wa-1", "u-1", "alpha", 1)])
            .await
            .unwrap();
        store.advance_watermark("c1", "u-1", 42).await.unwrap();
        store.clear_for_employee("u-1").await.unwrap();
        assert!(store.read_for_employee("u-1").await.unwrap().is_empty());
        assert_eq!(store.get_watermark("c1", "u-1").await.unwrap(), 0);
    }
}
