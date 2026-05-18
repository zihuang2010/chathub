//! FriendsStore:listFriends 的本地行存 + 全量同步状态 + 事件水位。
//!
//! 设计要点:
//!   - 行粒度(`wecom_account_id` + `external_user_id` PK),每行知道自己归属哪个账号,
//!     多账号查询时 chip 数字、tabCounts、accountCounts 都能精确计算。
//!   - **全量同步**:Tauri `list_friends` 命令通过 `is_fresh()` 判 TTL,失效则调
//!     `HubClient::list_all_friends_for_account()` 循环拉所有页 → `replace_all_for_account` 入库。
//!   - **增量事件**:`FriendBindingAction` 走 `apply_binding`(对照 `account_cache::BindingAction`)。
//!   - **水位**:`hub_wecom_friend_watermark`,"取大不取小"UPSERT,应对 relay redelivery。
//!
//! 文件名 `friends_cache.rs` 沿用(避免改 mod.rs / lib.rs 导出),但实际语义已经从
//! "响应级缓存" 升级到"行存 + 增量同步"。

use crate::error::StateError;
use crate::pool::SqlitePool;
use serde::{Deserialize, Serialize};

/// 一条好友(客户)行,字段形态对照业务后台 listFriends 响应 + 多加 `wecom_account_id` 归属。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WecomFriendRow {
    pub wecom_account_id: String,
    pub external_user_id: String,
    pub external_name: String,
    pub external_position: String,
    pub external_avatar: String,
    pub external_corp_name: String,
    pub external_corp_full_name: String,
    pub external_type: i32,
    pub external_gender: i32,
    pub external_mobile: String,
    pub follow_remark: String,
    pub follow_description: String,
    pub remark_corp_name: String,
    pub add_time: String,
    pub add_way: i32,
    pub follow_state: String,
    pub wechat_channels_nickname: String,
    pub wechat_channels_source: i32,
    pub last_sync_time: String,
    pub sync_status: i32,
}

/// FRIEND_BINDING_CHANGE 推送事件的 reason → 客户端动作。
///
/// reason 字符串(占位,联调时核对业务后台契约):
///   `FRIEND_ADDED` / `FRIEND_UPDATED` / `FRIEND_REMOVED`。
///
/// 未知 reason / payload 缺字段 → applier 走 fallback(全量重拉该 wecom_account_id)。
#[derive(Debug, Clone)]
pub enum FriendBindingAction {
    /// 新增好友。payload 必带全 21 字段。
    Added(WecomFriendRow),
    /// 好友信息变更。INSERT OR REPLACE,跟 Added 一致。
    Updated(WecomFriendRow),
    /// 删除好友(取消关注 / 删除好友 / 跨账号迁移走时,从源账号下 DELETE)。
    Removed {
        wecom_account_id: String,
        external_user_id: String,
    },
}

#[derive(Clone)]
pub struct FriendsStore {
    pool: SqlitePool,
}

impl FriendsStore {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// 按账号 ID 集合查全量行,按 `(wecom_account_id, add_time DESC)` 索引排序。
    /// 空入参 → 返空集合(不报错)。
    pub async fn read_for_account_ids(
        &self,
        wecom_account_ids: &[String],
    ) -> Result<Vec<WecomFriendRow>, StateError> {
        if wecom_account_ids.is_empty() {
            return Ok(Vec::new());
        }
        let ids: Vec<String> = wecom_account_ids.to_vec();
        let conn = self.pool.pool().get().await?;
        let rows = conn
            .interact(move |c| -> Result<Vec<WecomFriendRow>, StateError> {
                let placeholders = (0..ids.len())
                    .map(|_| "?")
                    .collect::<Vec<_>>()
                    .join(",");
                let sql = format!(
                    "SELECT wecom_account_id, external_user_id, external_name, external_position, \
                            external_avatar, external_corp_name, external_corp_full_name, \
                            external_type, external_gender, external_mobile, follow_remark, \
                            follow_description, remark_corp_name, add_time, add_way, follow_state, \
                            wechat_channels_nickname, wechat_channels_source, last_sync_time, sync_status \
                     FROM hub_wecom_friends WHERE wecom_account_id IN ({placeholders}) \
                     ORDER BY wecom_account_id, add_time DESC"
                );
                let mut stmt = c.prepare(&sql)?;
                let params = rusqlite::params_from_iter(ids.iter());
                let rows = stmt
                    .query_map(params, |row| {
                        Ok(WecomFriendRow {
                            wecom_account_id: row.get(0)?,
                            external_user_id: row.get(1)?,
                            external_name: row.get(2)?,
                            external_position: row.get(3)?,
                            external_avatar: row.get(4)?,
                            external_corp_name: row.get(5)?,
                            external_corp_full_name: row.get(6)?,
                            external_type: row.get::<_, i64>(7)? as i32,
                            external_gender: row.get::<_, i64>(8)? as i32,
                            external_mobile: row.get(9)?,
                            follow_remark: row.get(10)?,
                            follow_description: row.get(11)?,
                            remark_corp_name: row.get(12)?,
                            add_time: row.get(13)?,
                            add_way: row.get::<_, i64>(14)? as i32,
                            follow_state: row.get(15)?,
                            wechat_channels_nickname: row.get(16)?,
                            wechat_channels_source: row.get::<_, i64>(17)? as i32,
                            last_sync_time: row.get(18)?,
                            sync_status: row.get::<_, i64>(19)? as i32,
                        })
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(rows)
            })
            .await??;
        Ok(rows)
    }

    /// 全量替换单个账号的好友缓存。**事务内 DELETE + 批量 INSERT**,中间无可见态。
    pub async fn replace_all_for_account(
        &self,
        wecom_account_id: &str,
        rows: &[WecomFriendRow],
    ) -> Result<(), StateError> {
        let account_id = wecom_account_id.to_string();
        let rows: Vec<WecomFriendRow> = rows.to_vec();
        let now = now_unix_ms();
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            let tx = c.transaction()?;
            tx.execute(
                "DELETE FROM hub_wecom_friends WHERE wecom_account_id = ?1",
                rusqlite::params![account_id],
            )?;
            for r in &rows {
                insert_or_replace_row(&tx, r, now)?;
            }
            tx.commit()?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// 应用一条增量绑定事件。`apply_binding` 内 SQL 都天然幂等(INSERT OR REPLACE /
    /// DELETE-absent),应对 relay redelivery。
    pub async fn apply_binding(&self, action: FriendBindingAction) -> Result<(), StateError> {
        let now = now_unix_ms();
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            match action {
                FriendBindingAction::Added(r) | FriendBindingAction::Updated(r) => {
                    insert_or_replace_row(c, &r, now)?;
                }
                FriendBindingAction::Removed {
                    wecom_account_id,
                    external_user_id,
                } => {
                    c.execute(
                        "DELETE FROM hub_wecom_friends \
                         WHERE wecom_account_id = ?1 AND external_user_id = ?2",
                        rusqlite::params![wecom_account_id, external_user_id],
                    )?;
                }
            }
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// 判 wecom_account_id 的全量同步是否 fresh(在 TTL 内)。无 sync_state 行 → 视为不 fresh。
    pub async fn is_fresh(&self, wecom_account_id: &str, ttl_ms: i64) -> Result<bool, StateError> {
        let account_id = wecom_account_id.to_string();
        let now = now_unix_ms();
        let conn = self.pool.pool().get().await?;
        let fresh = conn
            .interact(move |c| -> Result<bool, StateError> {
                let res: rusqlite::Result<i64> = c.query_row(
                    "SELECT full_synced_at_ms FROM hub_wecom_friend_sync_state \
                     WHERE wecom_account_id = ?1",
                    rusqlite::params![account_id],
                    |r| r.get(0),
                );
                match res {
                    Ok(ts) => Ok(now.saturating_sub(ts) < ttl_ms),
                    Err(rusqlite::Error::QueryReturnedNoRows) => Ok(false),
                    Err(e) => Err(e.into()),
                }
            })
            .await??;
        Ok(fresh)
    }

    /// 标记 wecom_account_id 完成一次全量同步,UPSERT sync_state。
    pub async fn mark_synced(
        &self,
        wecom_account_id: &str,
        employee_id: &str,
        total: u64,
    ) -> Result<(), StateError> {
        let account_id = wecom_account_id.to_string();
        let employee_id = employee_id.to_string();
        let total = total as i64;
        let now = now_unix_ms();
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            c.execute(
                "INSERT INTO hub_wecom_friend_sync_state \
                   (wecom_account_id, employee_id, full_synced_at_ms, last_total) \
                 VALUES (?1, ?2, ?3, ?4) \
                 ON CONFLICT(wecom_account_id) DO UPDATE SET \
                   employee_id = excluded.employee_id, \
                   full_synced_at_ms = excluded.full_synced_at_ms, \
                   last_total = excluded.last_total",
                rusqlite::params![account_id, employee_id, now, total],
            )?;
            Ok(())
        })
        .await??;
        Ok(())
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

    /// 清掉该员工管理账号下所有 friend 数据 + sync_state + watermark。登出 / 换员工时调。
    pub async fn clear_for_employee(&self, employee_id: &str) -> Result<(), StateError> {
        let employee_id = employee_id.to_string();
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            let tx = c.transaction()?;
            // 删 sync_state 的同时把对应 wecom_account_id 下的 friends 也删掉
            tx.execute(
                "DELETE FROM hub_wecom_friends WHERE wecom_account_id IN \
                   (SELECT wecom_account_id FROM hub_wecom_friend_sync_state WHERE employee_id = ?1)",
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

fn insert_or_replace_row(
    c: &rusqlite::Connection,
    r: &WecomFriendRow,
    now_ms: i64,
) -> rusqlite::Result<usize> {
    c.execute(
        "INSERT OR REPLACE INTO hub_wecom_friends ( \
           wecom_account_id, external_user_id, external_name, external_position, \
           external_avatar, external_corp_name, external_corp_full_name, external_type, \
           external_gender, external_mobile, follow_remark, follow_description, \
           remark_corp_name, add_time, add_way, follow_state, wechat_channels_nickname, \
           wechat_channels_source, last_sync_time, sync_status, updated_at_ms \
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21)",
        rusqlite::params![
            r.wecom_account_id,
            r.external_user_id,
            r.external_name,
            r.external_position,
            r.external_avatar,
            r.external_corp_name,
            r.external_corp_full_name,
            r.external_type as i64,
            r.external_gender as i64,
            r.external_mobile,
            r.follow_remark,
            r.follow_description,
            r.remark_corp_name,
            r.add_time,
            r.add_way as i64,
            r.follow_state,
            r.wechat_channels_nickname,
            r.wechat_channels_source as i64,
            r.last_sync_time,
            r.sync_status as i64,
            now_ms,
        ],
    )
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

    fn sample_row(acct: &str, uid: &str, name: &str) -> WecomFriendRow {
        WecomFriendRow {
            wecom_account_id: acct.into(),
            external_user_id: uid.into(),
            external_name: name.into(),
            external_position: "产品经理".into(),
            external_avatar: format!("https://example.com/{uid}.png"),
            external_corp_name: "某科技".into(),
            external_corp_full_name: "某科技有限公司".into(),
            external_type: 1,
            external_gender: 1,
            external_mobile: "138****0001".into(),
            follow_remark: "".into(),
            follow_description: "".into(),
            remark_corp_name: "".into(),
            add_time: "2025-01-01 09:00:00".into(),
            add_way: 1,
            follow_state: "channel_state_001".into(),
            wechat_channels_nickname: "".into(),
            wechat_channels_source: 0,
            last_sync_time: "2025-01-01 09:00:00".into(),
            sync_status: 1,
        }
    }

    #[tokio::test]
    async fn replace_then_read_round_trip() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = FriendsStore::new(pool);
        let rows = vec![
            sample_row("wa-1", "wo-1", "张三"),
            sample_row("wa-1", "wo-2", "李四"),
        ];
        store.replace_all_for_account("wa-1", &rows).await.unwrap();
        let got = store.read_for_account_ids(&["wa-1".into()]).await.unwrap();
        assert_eq!(got.len(), 2);
        assert!(got.iter().any(|r| r.external_user_id == "wo-1"));
        assert!(got.iter().any(|r| r.external_user_id == "wo-2"));
    }

    #[tokio::test]
    async fn replace_isolates_per_account() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = FriendsStore::new(pool);
        store
            .replace_all_for_account("wa-1", &[sample_row("wa-1", "wo-a", "甲")])
            .await
            .unwrap();
        store
            .replace_all_for_account("wa-2", &[sample_row("wa-2", "wo-b", "乙")])
            .await
            .unwrap();
        // wa-1 不应被 wa-2 的 replace 触碰
        let wa1 = store.read_for_account_ids(&["wa-1".into()]).await.unwrap();
        assert_eq!(wa1.len(), 1);
        assert_eq!(wa1[0].external_user_id, "wo-a");
    }

    #[tokio::test]
    async fn read_multi_account_returns_all() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = FriendsStore::new(pool);
        store
            .replace_all_for_account("wa-1", &[sample_row("wa-1", "wo-1", "甲")])
            .await
            .unwrap();
        store
            .replace_all_for_account("wa-2", &[sample_row("wa-2", "wo-2", "乙")])
            .await
            .unwrap();
        let all = store
            .read_for_account_ids(&["wa-1".into(), "wa-2".into()])
            .await
            .unwrap();
        assert_eq!(all.len(), 2);
        // 每行带 wecom_account_id 归属,验证多选场景前端能拿到归属
        assert!(all.iter().any(|r| r.wecom_account_id == "wa-1"));
        assert!(all.iter().any(|r| r.wecom_account_id == "wa-2"));
    }

    #[tokio::test]
    async fn read_empty_account_ids_returns_empty() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = FriendsStore::new(pool);
        store
            .replace_all_for_account("wa-1", &[sample_row("wa-1", "wo-1", "甲")])
            .await
            .unwrap();
        let got = store.read_for_account_ids(&[]).await.unwrap();
        assert!(got.is_empty());
    }

    #[tokio::test]
    async fn apply_binding_added_inserts_row() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = FriendsStore::new(pool);
        let row = sample_row("wa-1", "wo-new", "新好友");
        store
            .apply_binding(FriendBindingAction::Added(row.clone()))
            .await
            .unwrap();
        let got = store.read_for_account_ids(&["wa-1".into()]).await.unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].external_user_id, "wo-new");
    }

    #[tokio::test]
    async fn apply_binding_updated_overwrites() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = FriendsStore::new(pool);
        store
            .replace_all_for_account("wa-1", &[sample_row("wa-1", "wo-1", "张三")])
            .await
            .unwrap();
        let mut updated = sample_row("wa-1", "wo-1", "张三");
        updated.follow_remark = "已成交".into();
        store
            .apply_binding(FriendBindingAction::Updated(updated))
            .await
            .unwrap();
        let got = store.read_for_account_ids(&["wa-1".into()]).await.unwrap();
        assert_eq!(got[0].follow_remark, "已成交");
    }

    #[tokio::test]
    async fn apply_binding_removed_deletes_row() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = FriendsStore::new(pool);
        store
            .replace_all_for_account("wa-1", &[sample_row("wa-1", "wo-1", "张三")])
            .await
            .unwrap();
        store
            .apply_binding(FriendBindingAction::Removed {
                wecom_account_id: "wa-1".into(),
                external_user_id: "wo-1".into(),
            })
            .await
            .unwrap();
        let got = store.read_for_account_ids(&["wa-1".into()]).await.unwrap();
        assert!(got.is_empty());
    }

    #[tokio::test]
    async fn apply_binding_is_idempotent() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = FriendsStore::new(pool);
        let row = sample_row("wa-1", "wo-1", "张三");
        for _ in 0..3 {
            store
                .apply_binding(FriendBindingAction::Added(row.clone()))
                .await
                .unwrap();
        }
        let got = store.read_for_account_ids(&["wa-1".into()]).await.unwrap();
        assert_eq!(got.len(), 1);
    }

    #[tokio::test]
    async fn is_fresh_false_when_not_synced() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = FriendsStore::new(pool);
        assert!(!store.is_fresh("wa-1", 60_000).await.unwrap());
    }

    #[tokio::test]
    async fn is_fresh_true_after_mark_synced_within_ttl() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = FriendsStore::new(pool);
        store.mark_synced("wa-1", "u-1", 10).await.unwrap();
        assert!(store.is_fresh("wa-1", 60_000).await.unwrap());
    }

    #[tokio::test]
    async fn is_fresh_false_after_ttl_zero() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = FriendsStore::new(pool);
        store.mark_synced("wa-1", "u-1", 10).await.unwrap();
        // ttl_ms = 0 → 立即视为过期
        assert!(!store.is_fresh("wa-1", 0).await.unwrap());
    }

    #[tokio::test]
    async fn mark_synced_upserts_existing_row() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = FriendsStore::new(pool);
        store.mark_synced("wa-1", "u-1", 5).await.unwrap();
        store.mark_synced("wa-1", "u-1", 8).await.unwrap();
        assert!(store.is_fresh("wa-1", 60_000).await.unwrap());
    }

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
    async fn clear_for_employee_wipes_all_state() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = FriendsStore::new(pool);
        store.mark_synced("wa-1", "u-1", 1).await.unwrap();
        store
            .replace_all_for_account("wa-1", &[sample_row("wa-1", "wo-1", "甲")])
            .await
            .unwrap();
        store.advance_watermark("c1", "u-1", 42).await.unwrap();

        store.clear_for_employee("u-1").await.unwrap();

        assert!(store
            .read_for_account_ids(&["wa-1".into()])
            .await
            .unwrap()
            .is_empty());
        assert!(!store.is_fresh("wa-1", 60_000).await.unwrap());
        assert_eq!(store.get_watermark("c1", "u-1").await.unwrap(), 0);
    }
}
