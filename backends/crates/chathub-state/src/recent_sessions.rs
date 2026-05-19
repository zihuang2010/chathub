//! RecentSessionsStore:session/recentFriends 接待好友列表的本地"头部热缓存"。
//!
//! 设计要点(对照 `friends_cache.rs`):
//!
//! - **行存**:conversation_id 为 PK,每行同时承载远端 17 字段 + 客户端 3 个本地列。
//!   - V7 引入 `employee_id` 列(非 PK,加索引),防御性隔离:多 employee 切换 +
//!     异常退出场景下,所有读写都 `WHERE employee_id = ?` 兜底。
//! - **写入纪律**:
//!     - `upsert_remote_many` / `upsert_remote_one` 由远端拉取与事件 applier 调,
//!       严格只 UPSERT 远端列(`ON CONFLICT DO UPDATE SET <远端列>=excluded.<列>`)。
//!     - `set_pinned` / `set_draft_at` 由用户操作 command 调,只 UPDATE 本地列,
//!       SQL 同时校验 employee_id,防止跨 employee 误触发。
//!     - 两路从不重叠,避免远端拉取把"置顶/草稿"抹掉。
//! - **多键 ORDER BY**:`list_top` 内部用
//!   `pinned DESC, pinned_at_ms DESC, MAX(last_message_time_ms, local_draft_at_ms) DESC,
//!   last_message_time_ms DESC` 合成最终顺序。客户端字段全 0 时退化为纯服务端时序。
//! - **trim**:`trim_to_max` per-employee 维度执行,只删 `pinned=0` 的尾部行,置顶永不被裁。
//! - **watermark**:沿用 V6 模板"取大不取小",应对 relay redelivery。

use crate::error::StateError;
use crate::pool::SqlitePool;
use serde::{Deserialize, Serialize};

/// 单 wecom_account 维度的非置顶行上限。多账号场景下保证每个企微号都有 500 行公平额度,
/// 避免热账号挤掉冷账号。
pub const RECENT_SESSIONS_PER_ACCOUNT_LIMIT: usize = 500;

/// 整 employee 维度的非置顶行总上限(兜底)。一般 4 个以下账号都不会摸到这个限,
/// 5+ 账号才会触发。置顶不计入。
pub const RECENT_SESSIONS_GLOBAL_LIMIT: usize = 2000;

/// 向后兼容别名,= GLOBAL_LIMIT;若有外部 import 用旧名也不会断。
pub const RECENT_SESSIONS_MAX_ROWS: usize = RECENT_SESSIONS_GLOBAL_LIMIT;

/// 一条最近会话行,22 字段:17 远端 + employee_id + updated_at_ms + 3 本地。
///
/// JSON 序列化用 camelCase,直接喂给 Tauri command 返回 / 前端 RecentFriendItem。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentSessionRow {
    // ─── 远端权威列 ────────────────────────────────────────────────────────
    pub conversation_id: String,
    pub wecom_account_id: String,
    /// 防御性隔离列,见模块注释。
    pub employee_id: String,
    pub wecom_name: String,
    pub wecom_account: String,
    pub wecom_alias: String,
    pub external_user_id: String,
    pub external_name: String,
    pub external_avatar: String,
    pub external_mobile: String,
    pub last_local_message_id: String,
    pub last_message_type: i32,
    pub last_message_direction: i32,
    pub last_send_status: i32,
    pub last_message_summary: String,
    /// `lastMessageTime` ISO 8601 解析后的 epoch ms;解析失败置 0(行仍写入)。
    pub last_message_time_ms: i64,
    pub unread_count: i64,
    pub has_unread: bool,
    pub updated_at_ms: i64,
    // ─── 客户端独占列 ──────────────────────────────────────────────────────
    pub pinned: bool,
    pub pinned_at_ms: i64,
    pub local_draft_at_ms: i64,
    /// V10:草稿文本。空串表示无草稿;非空时 `local_draft_at_ms` 应同时被设为 now。
    pub local_draft_text: String,
    /// V11:软移除标记。`true` 时被 [`list_top`] 过滤;远端事件带来
    /// `last_message_time_ms > removed_at_ms` 时由 UPSERT 自动清零(自动恢复)。
    pub removed: bool,
    pub removed_at_ms: i64,
}

/// 远端拉取 / 事件 applier 携带的远端列数据(无本地列)。
///
/// 单独类型是为了让 store 的 upsert 接口在签名层面**就**禁止误写本地列。
/// `employee_id` 由调用方(applier / Tauri 命令)从当前会话注入。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecentSessionRemote {
    pub conversation_id: String,
    pub wecom_account_id: String,
    pub employee_id: String,
    pub wecom_name: String,
    pub wecom_account: String,
    pub wecom_alias: String,
    pub external_user_id: String,
    pub external_name: String,
    pub external_avatar: String,
    pub external_mobile: String,
    pub last_local_message_id: String,
    pub last_message_type: i32,
    pub last_message_direction: i32,
    pub last_send_status: i32,
    pub last_message_summary: String,
    pub last_message_time_ms: i64,
    pub unread_count: i64,
    pub has_unread: bool,
}

#[derive(Clone)]
pub struct RecentSessionsStore {
    pool: SqlitePool,
}

impl RecentSessionsStore {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// 多键 ORDER BY 读头部 N 行。
    /// `employee_id` 强制过滤(防御);`account_filter=None` 表示该员工全部账号合并。
    pub async fn list_top(
        &self,
        employee_id: &str,
        account_filter: Option<String>,
        limit: usize,
    ) -> Result<Vec<RecentSessionRow>, StateError> {
        let employee_id = employee_id.to_string();
        let limit = limit as i64;
        let conn = self.pool.pool().get().await?;
        let rows = conn
            .interact(move |c| -> Result<Vec<RecentSessionRow>, StateError> {
                // 单条 SQL 双路:?2 IS NULL 时跳过账号过滤;否则按 wecom_account_id 等值。
                let sql = "\
                    SELECT \
                      conversation_id, wecom_account_id, employee_id, wecom_name, wecom_account, wecom_alias, \
                      external_user_id, external_name, external_avatar, external_mobile, \
                      last_local_message_id, last_message_type, last_message_direction, \
                      last_send_status, last_message_summary, last_message_time_ms, \
                      unread_count, has_unread, updated_at_ms, \
                      pinned, pinned_at_ms, local_draft_at_ms, local_draft_text, \
                      removed, removed_at_ms \
                    FROM hub_conversation_recents \
                    WHERE employee_id = ?1 AND removed = 0 \
                      AND (?2 IS NULL OR wecom_account_id = ?2) \
                    ORDER BY \
                      pinned DESC, \
                      pinned_at_ms DESC, \
                      MAX(last_message_time_ms, local_draft_at_ms) DESC, \
                      last_message_time_ms DESC \
                    LIMIT ?3";
                let mut stmt = c.prepare(sql)?;
                let rows = stmt
                    .query_map(rusqlite::params![employee_id, account_filter, limit], map_row)?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .await??;
        Ok(rows)
    }

    /// 远端拉取批量 UPSERT —— 只写远端列与 updated_at_ms,本地列(pinned/pinned_at_ms/
    /// local_draft_at_ms)在 ON CONFLICT 时保持原值不动。
    /// `employee_id` 由每行携带(`RecentSessionRemote.employee_id`)。
    pub async fn upsert_remote_many(&self, rows: &[RecentSessionRemote]) -> Result<(), StateError> {
        if rows.is_empty() {
            return Ok(());
        }
        let rows = rows.to_vec();
        let now = now_unix_ms();
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            let tx = c.transaction()?;
            for r in &rows {
                upsert_remote_in_tx(&tx, r, now)?;
            }
            tx.commit()?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// 事件 applier 单行 UPSERT。语义同 `upsert_remote_many` 单元素版。
    pub async fn upsert_remote_one(&self, row: RecentSessionRemote) -> Result<(), StateError> {
        let now = now_unix_ms();
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            upsert_remote_in_tx(c, &row, now)?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// 判某 conversation_id 是否已经在本地行存中(给事件 applier 用,判 unknown 走 fallback)。
    /// 按 employee_id 过滤,防止跨员工误判。
    pub async fn exists(
        &self,
        employee_id: &str,
        conversation_id: &str,
    ) -> Result<bool, StateError> {
        let employee_id = employee_id.to_string();
        let id = conversation_id.to_string();
        let conn = self.pool.pool().get().await?;
        let exists = conn
            .interact(move |c| -> Result<bool, StateError> {
                let res: rusqlite::Result<i64> = c.query_row(
                    "SELECT 1 FROM hub_conversation_recents \
                     WHERE employee_id = ?1 AND conversation_id = ?2",
                    rusqlite::params![employee_id, id],
                    |r| r.get(0),
                );
                match res {
                    Ok(_) => Ok(true),
                    Err(rusqlite::Error::QueryReturnedNoRows) => Ok(false),
                    Err(e) => Err(e.into()),
                }
            })
            .await??;
        Ok(exists)
    }

    /// 置顶 / 取消置顶。`pinned=true` 时 `pinned_at_ms = now`,`false` 时置 0。
    /// 行不存在或 employee_id 不匹配时 no-op(用户只能操作自己 employee 名下的会话)。
    pub async fn set_pinned(
        &self,
        employee_id: &str,
        conversation_id: &str,
        pinned: bool,
    ) -> Result<(), StateError> {
        let employee_id = employee_id.to_string();
        let id = conversation_id.to_string();
        let now = now_unix_ms();
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            c.execute(
                "UPDATE hub_conversation_recents \
                   SET pinned = ?1, pinned_at_ms = ?2 \
                 WHERE employee_id = ?3 AND conversation_id = ?4",
                rusqlite::params![pinned as i64, if pinned { now } else { 0 }, employee_id, id],
            )?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// 软移除 / 取消移除。`removed=true` 时 `removed_at_ms = now`,`false` 时置 0。
    /// employee_id 过滤防越权,跨员工 no-op。
    /// 移除的行被 [`Self::list_top`] 过滤;远端事件后续若带来 `last_message_time_ms > removed_at_ms`,
    /// `upsert_remote_in_tx` 的 ON CONFLICT 会自动 `removed=0`(自动恢复)。
    pub async fn set_removed(
        &self,
        employee_id: &str,
        conversation_id: &str,
        removed: bool,
    ) -> Result<(), StateError> {
        let employee_id = employee_id.to_string();
        let id = conversation_id.to_string();
        let now = now_unix_ms();
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            c.execute(
                "UPDATE hub_conversation_recents \
                   SET removed = ?1, removed_at_ms = ?2 \
                 WHERE employee_id = ?3 AND conversation_id = ?4",
                rusqlite::params![
                    removed as i64,
                    if removed { now } else { 0 },
                    employee_id,
                    id
                ],
            )?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// 草稿写入(V10:连同 text 一起存)。
    /// - `text=""` → 清草稿(`local_draft_text=''`、`local_draft_at_ms=0`)
    /// - 非空 → `local_draft_text=text`、`local_draft_at_ms=now`
    ///
    /// SQL 校验 employee_id,跨员工 no-op。
    pub async fn set_draft(
        &self,
        employee_id: &str,
        conversation_id: &str,
        text: &str,
    ) -> Result<(), StateError> {
        let employee_id = employee_id.to_string();
        let id = conversation_id.to_string();
        let text = text.to_string();
        let now = now_unix_ms();
        let ts = if text.is_empty() { 0 } else { now };
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            c.execute(
                "UPDATE hub_conversation_recents \
                   SET local_draft_text = ?1, local_draft_at_ms = ?2 \
                 WHERE employee_id = ?3 AND conversation_id = ?4",
                rusqlite::params![text, ts, employee_id, id],
            )?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// 向后兼容:`set_draft_at(emp, conv, has_draft)` → `set_draft(emp, conv, "<placeholder>")`。
    /// `has_draft=true` 时草稿文本为占位空串(实际生产应直接调 `set_draft` 传文本)。
    pub async fn set_draft_at(
        &self,
        employee_id: &str,
        conversation_id: &str,
        has_draft: bool,
    ) -> Result<(), StateError> {
        // has_draft=true 但无 text 时,用单字符 " " 兜底,避免被视为"清空草稿"
        let placeholder = if has_draft { " " } else { "" };
        self.set_draft(employee_id, conversation_id, placeholder)
            .await
    }

    /// 头部缓存上限:**两层硬限**(置顶行永不被裁)
    ///   1. **每 wecom_account 500 行**(`per_account_limit`):多账号公平,热账号挤不到冷账号
    ///   2. **整 employee 2000 行总额**(`global_limit`):>4 账号时兜底(4×500=2000 已锁住)
    ///
    /// 两步事务内执行:
    ///   - Step 1: 按 wecom_account_id 分桶,ROW_NUMBER 取每桶非置顶尾部 > per_account_limit 删
    ///   - Step 2: 该员工非置顶总数若仍 > global_limit - pinned_count,继续按活跃时间 DESC 裁
    pub async fn trim(
        &self,
        employee_id: &str,
        per_account_limit: usize,
        global_limit: usize,
    ) -> Result<(), StateError> {
        let employee_id = employee_id.to_string();
        let per_account = per_account_limit as i64;
        let global = global_limit as i64;
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            let tx = c.transaction()?;

            // Step 1:每桶超 per_account_limit 的非置顶尾部
            tx.execute(
                "DELETE FROM hub_conversation_recents WHERE conversation_id IN ( \
                   SELECT conversation_id FROM ( \
                     SELECT conversation_id, \
                            ROW_NUMBER() OVER ( \
                              PARTITION BY wecom_account_id \
                              ORDER BY MAX(last_message_time_ms, local_draft_at_ms) DESC \
                            ) AS rn \
                     FROM hub_conversation_recents \
                     WHERE employee_id = ?1 AND pinned = 0 \
                   ) WHERE rn > ?2 \
                 )",
                rusqlite::params![employee_id, per_account],
            )?;

            // Step 2:全员兜底 — 该 employee 非置顶总数仍超 global_limit-pinned 时继续裁
            let pinned_count: i64 = tx.query_row(
                "SELECT COUNT(*) FROM hub_conversation_recents \
                 WHERE employee_id = ?1 AND pinned = 1",
                rusqlite::params![employee_id],
                |r| r.get(0),
            )?;
            let non_pinned_keep = std::cmp::max(0, global - pinned_count);
            tx.execute(
                "DELETE FROM hub_conversation_recents \
                 WHERE conversation_id IN ( \
                   SELECT conversation_id FROM hub_conversation_recents \
                   WHERE employee_id = ?1 AND pinned = 0 \
                   ORDER BY MAX(last_message_time_ms, local_draft_at_ms) DESC \
                   LIMIT -1 OFFSET ?2 \
                 )",
                rusqlite::params![employee_id, non_pinned_keep],
            )?;

            tx.commit()?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// 向后兼容:单参数版本,等价于 `trim(employee_id, max, max)`(即只裁全员总数,
    /// 不按 account 分桶)。新代码请用 [`trim`]。
    pub async fn trim_to_max(&self, employee_id: &str, max: usize) -> Result<(), StateError> {
        self.trim(employee_id, max, max).await
    }

    /// 推进水位:UPSERT "取大不取小"(模板抄自 V6 friends watermark)。
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
                "INSERT INTO hub_recent_session_watermark (client_id, employee_id, last_seq, updated_at_ms) \
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
                    "SELECT last_seq FROM hub_recent_session_watermark \
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

    /// 清空指定员工的本地缓存(登出 / 切员工时调)。
    /// V7 起按 employee_id 精确 DELETE,不再 TRUNCATE 整表 —— 异常退出后下次登录另一
    /// employee 也不会污染对方数据(读路径 WHERE employee_id 也作兜底)。
    pub async fn clear_for_employee(&self, employee_id: &str) -> Result<(), StateError> {
        let employee_id = employee_id.to_string();
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            let tx = c.transaction()?;
            tx.execute(
                "DELETE FROM hub_conversation_recents WHERE employee_id = ?1",
                rusqlite::params![employee_id],
            )?;
            tx.execute(
                "DELETE FROM hub_recent_session_watermark WHERE employee_id = ?1",
                rusqlite::params![employee_id],
            )?;
            tx.commit()?;
            Ok(())
        })
        .await??;
        Ok(())
    }
}

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RecentSessionRow> {
    Ok(RecentSessionRow {
        conversation_id: row.get(0)?,
        wecom_account_id: row.get(1)?,
        employee_id: row.get(2)?,
        wecom_name: row.get(3)?,
        wecom_account: row.get(4)?,
        wecom_alias: row.get(5)?,
        external_user_id: row.get(6)?,
        external_name: row.get(7)?,
        external_avatar: row.get(8)?,
        external_mobile: row.get(9)?,
        last_local_message_id: row.get(10)?,
        last_message_type: row.get::<_, i64>(11)? as i32,
        last_message_direction: row.get::<_, i64>(12)? as i32,
        last_send_status: row.get::<_, i64>(13)? as i32,
        last_message_summary: row.get(14)?,
        last_message_time_ms: row.get(15)?,
        unread_count: row.get(16)?,
        has_unread: row.get::<_, i64>(17)? != 0,
        updated_at_ms: row.get(18)?,
        pinned: row.get::<_, i64>(19)? != 0,
        pinned_at_ms: row.get(20)?,
        local_draft_at_ms: row.get(21)?,
        local_draft_text: row.get(22)?,
        removed: row.get::<_, i64>(23)? != 0,
        removed_at_ms: row.get(24)?,
    })
}

fn upsert_remote_in_tx(
    c: &rusqlite::Connection,
    r: &RecentSessionRemote,
    now_ms: i64,
) -> rusqlite::Result<usize> {
    c.execute(
        "INSERT INTO hub_conversation_recents ( \
           conversation_id, wecom_account_id, employee_id, wecom_name, wecom_account, wecom_alias, \
           external_user_id, external_name, external_avatar, external_mobile, \
           last_local_message_id, last_message_type, last_message_direction, \
           last_send_status, last_message_summary, last_message_time_ms, \
           unread_count, has_unread, updated_at_ms \
         ) VALUES ( \
           ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19 \
         ) \
         ON CONFLICT(conversation_id) DO UPDATE SET \
           wecom_account_id       = excluded.wecom_account_id, \
           employee_id            = excluded.employee_id, \
           wecom_name             = excluded.wecom_name, \
           wecom_account          = excluded.wecom_account, \
           wecom_alias            = excluded.wecom_alias, \
           external_user_id       = excluded.external_user_id, \
           external_name          = excluded.external_name, \
           external_avatar        = excluded.external_avatar, \
           external_mobile        = excluded.external_mobile, \
           last_local_message_id  = excluded.last_local_message_id, \
           last_message_type      = excluded.last_message_type, \
           last_message_direction = excluded.last_message_direction, \
           last_send_status       = excluded.last_send_status, \
           last_message_summary   = excluded.last_message_summary, \
           last_message_time_ms   = excluded.last_message_time_ms, \
           unread_count           = excluded.unread_count, \
           has_unread             = excluded.has_unread, \
           updated_at_ms          = excluded.updated_at_ms, \
           removed                = CASE \
               WHEN excluded.last_message_time_ms > removed_at_ms THEN 0 \
               ELSE removed END, \
           removed_at_ms          = CASE \
               WHEN excluded.last_message_time_ms > removed_at_ms THEN 0 \
               ELSE removed_at_ms END",
        rusqlite::params![
            r.conversation_id,
            r.wecom_account_id,
            r.employee_id,
            r.wecom_name,
            r.wecom_account,
            r.wecom_alias,
            r.external_user_id,
            r.external_name,
            r.external_avatar,
            r.external_mobile,
            r.last_local_message_id,
            r.last_message_type as i64,
            r.last_message_direction as i64,
            r.last_send_status as i64,
            r.last_message_summary,
            r.last_message_time_ms,
            r.unread_count,
            r.has_unread as i64,
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

    /// 默认 employee 占位,大多数测试只测单 employee 场景。
    const E: &str = "u-1";

    fn sample_remote(conv: &str, acct: &str, ts_ms: i64, unread: i64) -> RecentSessionRemote {
        sample_remote_for(E, conv, acct, ts_ms, unread)
    }

    fn sample_remote_for(
        emp: &str,
        conv: &str,
        acct: &str,
        ts_ms: i64,
        unread: i64,
    ) -> RecentSessionRemote {
        RecentSessionRemote {
            conversation_id: conv.into(),
            wecom_account_id: acct.into(),
            employee_id: emp.into(),
            wecom_name: "客服-A".into(),
            wecom_account: "wxid_a".into(),
            wecom_alias: "客服 A".into(),
            external_user_id: format!("ext_{conv}"),
            external_name: format!("外部-{conv}"),
            external_avatar: "".into(),
            external_mobile: "138****0000".into(),
            last_local_message_id: format!("msg_{conv}"),
            last_message_type: 1,
            last_message_direction: 1,
            last_send_status: 3,
            last_message_summary: "hello".into(),
            last_message_time_ms: ts_ms,
            unread_count: unread,
            has_unread: unread > 0,
        }
    }

    #[tokio::test]
    async fn upsert_then_list_round_trip() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        store
            .upsert_remote_many(&[
                sample_remote("c1", "wa-1", 100, 0),
                sample_remote("c2", "wa-1", 200, 1),
            ])
            .await
            .unwrap();
        let got = store.list_top(E, None, 10).await.unwrap();
        assert_eq!(got.len(), 2);
        // 默认按时序倒序:c2 在前
        assert_eq!(got[0].conversation_id, "c2");
        assert_eq!(got[1].conversation_id, "c1");
    }

    #[tokio::test]
    async fn list_top_filters_by_account() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        store
            .upsert_remote_many(&[
                sample_remote("c1", "wa-1", 100, 0),
                sample_remote("c2", "wa-2", 200, 0),
            ])
            .await
            .unwrap();
        let only_wa1 = store.list_top(E, Some("wa-1".into()), 10).await.unwrap();
        assert_eq!(only_wa1.len(), 1);
        assert_eq!(only_wa1[0].wecom_account_id, "wa-1");
    }

    #[tokio::test]
    async fn list_top_isolates_by_employee() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        store
            .upsert_remote_many(&[
                sample_remote_for("u-A", "c1", "wa-1", 100, 0),
                sample_remote_for("u-B", "c2", "wa-2", 200, 0),
            ])
            .await
            .unwrap();
        let a = store.list_top("u-A", None, 10).await.unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].conversation_id, "c1");
        let b = store.list_top("u-B", None, 10).await.unwrap();
        assert_eq!(b.len(), 1);
        assert_eq!(b[0].conversation_id, "c2");
    }

    #[tokio::test]
    async fn upsert_preserves_local_columns() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        store
            .upsert_remote_many(&[sample_remote("c1", "wa-1", 100, 0)])
            .await
            .unwrap();
        // 用户置顶
        store.set_pinned(E, "c1", true).await.unwrap();
        store.set_draft_at(E, "c1", true).await.unwrap();
        // 再次 UPSERT 远端列(模拟事件 applier 推一条新消息)
        store
            .upsert_remote_many(&[sample_remote("c1", "wa-1", 999, 5)])
            .await
            .unwrap();
        let got = store.list_top(E, None, 10).await.unwrap();
        assert_eq!(got.len(), 1);
        // 远端列被更新
        assert_eq!(got[0].last_message_time_ms, 999);
        assert_eq!(got[0].unread_count, 5);
        // 本地列保留
        assert!(got[0].pinned, "pinned must survive remote upsert");
        assert!(got[0].pinned_at_ms > 0);
        assert!(
            got[0].local_draft_at_ms > 0,
            "draft must survive remote upsert"
        );
    }

    #[tokio::test]
    async fn pinned_rows_sort_above_non_pinned() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        store
            .upsert_remote_many(&[
                sample_remote("c1", "wa-1", 100, 0), // 旧
                sample_remote("c2", "wa-1", 999, 0), // 新
            ])
            .await
            .unwrap();
        // 给旧的置顶
        store.set_pinned(E, "c1", true).await.unwrap();
        let got = store.list_top(E, None, 10).await.unwrap();
        assert_eq!(got[0].conversation_id, "c1", "pinned row should be on top");
        assert_eq!(got[1].conversation_id, "c2");
    }

    #[tokio::test]
    async fn draft_lifts_row_above_newer_message() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        store
            .upsert_remote_many(&[
                sample_remote("c1", "wa-1", 100, 0),
                sample_remote("c2", "wa-1", 200, 0),
            ])
            .await
            .unwrap();
        // c1 起草草稿(now_ms 必然 > 200,这条会跑赢)
        store.set_draft_at(E, "c1", true).await.unwrap();
        let got = store.list_top(E, None, 10).await.unwrap();
        assert_eq!(got[0].conversation_id, "c1");
    }

    #[tokio::test]
    async fn set_pinned_false_clears_pinned_at_ms() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        store
            .upsert_remote_many(&[sample_remote("c1", "wa-1", 100, 0)])
            .await
            .unwrap();
        store.set_pinned(E, "c1", true).await.unwrap();
        store.set_pinned(E, "c1", false).await.unwrap();
        let got = store.list_top(E, None, 10).await.unwrap();
        assert!(!got[0].pinned);
        assert_eq!(got[0].pinned_at_ms, 0);
    }

    #[tokio::test]
    async fn set_pinned_rejects_wrong_employee() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        store
            .upsert_remote_many(&[sample_remote("c1", "wa-1", 100, 0)])
            .await
            .unwrap();
        // 错员工尝试置顶 c1 → no-op
        store.set_pinned("u-other", "c1", true).await.unwrap();
        let got = store.list_top(E, None, 10).await.unwrap();
        assert!(!got[0].pinned, "wrong-employee pin must not affect row");
    }

    #[tokio::test]
    async fn exists_reports_membership() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        store
            .upsert_remote_many(&[sample_remote("c1", "wa-1", 100, 0)])
            .await
            .unwrap();
        assert!(store.exists(E, "c1").await.unwrap());
        assert!(!store.exists(E, "c-missing").await.unwrap());
        // 另一个员工不应该看到 c1
        assert!(!store.exists("u-other", "c1").await.unwrap());
    }

    #[tokio::test]
    async fn trim_keeps_pinned_drops_oldest_unpinned() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        // 4 行:c1 最旧 c4 最新
        store
            .upsert_remote_many(&[
                sample_remote("c1", "wa-1", 100, 0),
                sample_remote("c2", "wa-1", 200, 0),
                sample_remote("c3", "wa-1", 300, 0),
                sample_remote("c4", "wa-1", 400, 0),
            ])
            .await
            .unwrap();
        // 把最旧的 c1 置顶,即使被裁也不该真的被删
        store.set_pinned(E, "c1", true).await.unwrap();
        // 上限 2 → c1(置顶不裁)+ c4(非置顶最新)= 共 2 行
        store.trim_to_max(E, 2).await.unwrap();
        let got = store.list_top(E, None, 10).await.unwrap();
        let ids: Vec<String> = got.iter().map(|r| r.conversation_id.clone()).collect();
        assert!(ids.contains(&"c1".to_string()), "pinned must survive trim");
        assert!(
            ids.contains(&"c4".to_string()),
            "newest unpinned must survive"
        );
        assert!(!ids.contains(&"c2".to_string()));
        assert!(!ids.contains(&"c3".to_string()));
    }

    #[tokio::test]
    async fn trim_isolates_by_employee() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        store
            .upsert_remote_many(&[
                sample_remote_for("u-A", "a1", "wa-1", 100, 0),
                sample_remote_for("u-A", "a2", "wa-1", 200, 0),
                sample_remote_for("u-B", "b1", "wa-2", 300, 0),
                sample_remote_for("u-B", "b2", "wa-2", 400, 0),
            ])
            .await
            .unwrap();
        // 只裁 u-A 到 1 行,u-B 必须完全不动
        store.trim_to_max("u-A", 1).await.unwrap();
        let a = store.list_top("u-A", None, 10).await.unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].conversation_id, "a2");
        let b = store.list_top("u-B", None, 10).await.unwrap();
        assert_eq!(b.len(), 2, "trim must not affect other employee");
    }

    #[tokio::test]
    async fn watermark_monotonic_upsert() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        store.advance_watermark("c1", "u-1", 10).await.unwrap();
        store.advance_watermark("c1", "u-1", 5).await.unwrap(); // 取大不取小,被吞
        store.advance_watermark("c1", "u-1", 20).await.unwrap();
        assert_eq!(store.get_watermark("c1", "u-1").await.unwrap(), 20);
        assert_eq!(store.get_watermark("c1", "u-unknown").await.unwrap(), 0);
    }

    #[tokio::test]
    async fn upsert_one_is_idempotent() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        let row = sample_remote("c1", "wa-1", 100, 0);
        for _ in 0..3 {
            store.upsert_remote_one(row.clone()).await.unwrap();
        }
        let got = store.list_top(E, None, 10).await.unwrap();
        assert_eq!(got.len(), 1);
    }

    // ─── R6: 草稿文本测试 ──────────────────────────────────────────────────

    #[tokio::test]
    async fn set_draft_round_trip() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        store
            .upsert_remote_many(&[sample_remote("c1", "wa-1", 100, 0)])
            .await
            .unwrap();
        store.set_draft(E, "c1", "你好世界").await.unwrap();
        let got = store.list_top(E, None, 10).await.unwrap();
        assert_eq!(got[0].local_draft_text, "你好世界");
        assert!(got[0].local_draft_at_ms > 0);
    }

    #[tokio::test]
    async fn set_draft_empty_clears() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        store
            .upsert_remote_many(&[sample_remote("c1", "wa-1", 100, 0)])
            .await
            .unwrap();
        store.set_draft(E, "c1", "稿件").await.unwrap();
        store.set_draft(E, "c1", "").await.unwrap();
        let got = store.list_top(E, None, 10).await.unwrap();
        assert_eq!(got[0].local_draft_text, "");
        assert_eq!(got[0].local_draft_at_ms, 0);
    }

    #[tokio::test]
    async fn set_draft_preserved_through_remote_upsert() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        store
            .upsert_remote_many(&[sample_remote("c1", "wa-1", 100, 0)])
            .await
            .unwrap();
        store.set_draft(E, "c1", "未发出").await.unwrap();
        // 模拟事件 applier 推一条新消息;远端列覆盖,但本地草稿保留
        store
            .upsert_remote_many(&[sample_remote("c1", "wa-1", 999, 0)])
            .await
            .unwrap();
        let got = store.list_top(E, None, 10).await.unwrap();
        assert_eq!(got[0].last_message_time_ms, 999, "remote col updated");
        assert_eq!(got[0].local_draft_text, "未发出", "draft text must survive");
    }

    // ─── R3: 分桶 trim 测试 ────────────────────────────────────────────────

    /// 1 account × 600 行 → 桶限 500 触发,留 500;全员限不触发。
    #[tokio::test]
    async fn trim_per_account_one_bucket_capped() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        let rows: Vec<_> = (0..600)
            .map(|i| sample_remote(&format!("c-{i:04}"), "wa-1", 1000 + i as i64, 0))
            .collect();
        store.upsert_remote_many(&rows).await.unwrap();
        store.trim(E, 500, 2000).await.unwrap();
        let got = store.list_top(E, Some("wa-1".into()), 1000).await.unwrap();
        assert_eq!(got.len(), 500, "single bucket should be capped at 500");
        // 保留的应该是最新的 500 条(c-100 ~ c-599)
        assert!(got.iter().any(|r| r.conversation_id == "c-0599"));
        assert!(!got.iter().any(|r| r.conversation_id == "c-0000"));
    }

    /// 4 accounts × 600 → 每桶各裁到 500,总 2000,全员限恰好不触发。
    #[tokio::test]
    async fn trim_four_accounts_each_capped_at_500() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        let mut rows = Vec::new();
        for acct in &["wa-1", "wa-2", "wa-3", "wa-4"] {
            for i in 0..600 {
                rows.push(sample_remote(
                    &format!("c-{acct}-{i:04}"),
                    acct,
                    1000 + i as i64,
                    0,
                ));
            }
        }
        store.upsert_remote_many(&rows).await.unwrap();
        store.trim(E, 500, 2000).await.unwrap();
        for acct in &["wa-1", "wa-2", "wa-3", "wa-4"] {
            let got = store.list_top(E, Some((*acct).into()), 1000).await.unwrap();
            assert_eq!(got.len(), 500, "{acct} should be capped at 500");
        }
        let total = store.list_top(E, None, 10000).await.unwrap();
        assert_eq!(total.len(), 2000, "global total should be 4×500=2000");
    }

    /// 5 accounts × 600 → 桶限剩 2500,全员限再裁 500,最终总 2000。
    #[tokio::test]
    async fn trim_five_accounts_global_kicks_in() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        // 给不同 account 用不同时间偏移,确保 wa-1 最旧(最先被全员限裁掉)
        let mut rows = Vec::new();
        for (idx, acct) in ["wa-1", "wa-2", "wa-3", "wa-4", "wa-5"].iter().enumerate() {
            let base = 1000 + idx as i64 * 10_000; // wa-1 最旧
            for i in 0..600 {
                rows.push(sample_remote(
                    &format!("c-{acct}-{i:04}"),
                    acct,
                    base + i as i64,
                    0,
                ));
            }
        }
        store.upsert_remote_many(&rows).await.unwrap();
        store.trim(E, 500, 2000).await.unwrap();
        let total = store.list_top(E, None, 10000).await.unwrap();
        assert_eq!(total.len(), 2000, "global limit 2000 must enforce");
        // 检查 wa-1 (最旧)被全员限多裁了 100 行(剩 400),其它各账号留 500 / 400
        let wa1 = store.list_top(E, Some("wa-1".into()), 1000).await.unwrap();
        assert!(
            wa1.len() <= 500,
            "wa-1 (oldest) should be ≤500 after global trim, got {}",
            wa1.len()
        );
    }

    /// 置顶行不参与裁:1 个桶 800 行 + 100 行置顶 → 桶裁后非置顶 500 + 置顶 100 = 600
    #[tokio::test]
    async fn trim_pinned_never_culled() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        let rows: Vec<_> = (0..800)
            .map(|i| sample_remote(&format!("c-{i:04}"), "wa-1", 1000 + i as i64, 0))
            .collect();
        store.upsert_remote_many(&rows).await.unwrap();
        // 把最旧的 100 条置顶 — 即使按时间排序它们是尾部,置顶豁免不被裁
        for i in 0..100 {
            store
                .set_pinned(E, &format!("c-{i:04}"), true)
                .await
                .unwrap();
        }
        store.trim(E, 500, 2000).await.unwrap();
        let got = store.list_top(E, None, 10000).await.unwrap();
        assert_eq!(got.len(), 600, "100 pinned + 500 non-pinned = 600");
        // 全部 100 个置顶都还在
        let pinned_count = got.iter().filter(|r| r.pinned).count();
        assert_eq!(pinned_count, 100);
    }

    // ─── V11: removed/removed_at_ms 行为 ────────────────────────────────────

    #[tokio::test]
    async fn pinned_row_set_removed_excluded_but_pin_preserved() {
        // 移除"胜出"于置顶:list_top 看不到;但 pinned/pinned_at_ms 不被破坏,
        // 后续若被自动恢复(或显式 set_removed(false)),置顶状态依旧。
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        store
            .upsert_remote_many(&[sample_remote("c1", "wa-1", 100, 0)])
            .await
            .unwrap();
        store.set_pinned(E, "c1", true).await.unwrap();
        store.set_removed(E, "c1", true).await.unwrap();
        // 不出现在默认列表
        assert!(store.list_top(E, None, 10).await.unwrap().is_empty());
        // 取消移除 → 置顶仍在
        store.set_removed(E, "c1", false).await.unwrap();
        let got = store.list_top(E, None, 10).await.unwrap();
        assert_eq!(got.len(), 1);
        assert!(got[0].pinned, "pin must survive a remove/unremove cycle");
        assert!(got[0].pinned_at_ms > 0);
    }

    #[tokio::test]
    async fn set_removed_rejects_wrong_employee() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        store
            .upsert_remote_many(&[sample_remote("c1", "wa-1", 100, 0)])
            .await
            .unwrap();
        store.set_removed("u-other", "c1", true).await.unwrap();
        // 行仍可被本 employee 看见
        let got = store.list_top(E, None, 10).await.unwrap();
        assert_eq!(got.len(), 1);
        assert!(!got[0].removed);
    }

    #[tokio::test]
    async fn upsert_with_newer_ts_clears_removed() {
        // 远端事件带来 last_message_time_ms > removed_at_ms 时,UPSERT 应自动取消 hidden
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        // 初始一行,旧时间戳
        store
            .upsert_remote_many(&[sample_remote("c1", "wa-1", 100, 0)])
            .await
            .unwrap();
        // 用户移除(此时 removed_at_ms ≈ now,远大于 100)
        store.set_removed(E, "c1", true).await.unwrap();
        assert!(
            store.list_top(E, None, 10).await.unwrap().is_empty(),
            "hidden row must not appear in list_top"
        );
        // 模拟事件 applier 推一条远端"未来"消息:lastMessageTime 取一个明显大于 removed_at_ms 的值
        let future_ts = now_unix_ms() + 60_000;
        store
            .upsert_remote_many(&[sample_remote("c1", "wa-1", future_ts, 1)])
            .await
            .unwrap();
        let got = store.list_top(E, None, 10).await.unwrap();
        assert_eq!(got.len(), 1, "newer event must auto-unhide the row");
        assert!(!got[0].removed);
        assert_eq!(
            got[0].removed_at_ms, 0,
            "removed_at_ms must be cleared on auto-unhide"
        );
    }

    #[tokio::test]
    async fn upsert_with_older_ts_keeps_removed() {
        // Relay redelivery 场景:旧事件的 last_message_time_ms <= removed_at_ms,UPSERT 不能误唤醒
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        let future_ts = now_unix_ms() + 60_000;
        // 初始一行,时间戳已经"现在 + 60s"
        store
            .upsert_remote_many(&[sample_remote("c1", "wa-1", future_ts, 0)])
            .await
            .unwrap();
        // 用户移除 → removed_at_ms = now;但 last_message_time_ms 仍是 future_ts(>removed_at_ms)
        // 为了真正测"旧事件",先把已有行时间设到极远过去:用一个第二次 UPSERT 推一条 ts=10 的"假新事件"
        // 但 ts=10 严格小于 removed_at_ms,所以不该唤醒
        store.set_removed(E, "c1", true).await.unwrap();
        store
            .upsert_remote_many(&[sample_remote("c1", "wa-1", 10, 0)])
            .await
            .unwrap();
        let got = store.list_top(E, None, 10).await.unwrap();
        assert!(
            got.is_empty(),
            "redelivered/old event must NOT unhide a removed row"
        );
    }

    #[tokio::test]
    async fn set_removed_then_list_excludes_row() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        store
            .upsert_remote_many(&[
                sample_remote("c1", "wa-1", 100, 0),
                sample_remote("c2", "wa-1", 200, 0),
            ])
            .await
            .unwrap();
        store.set_removed(E, "c1", true).await.unwrap();
        let got = store.list_top(E, None, 10).await.unwrap();
        assert_eq!(got.len(), 1, "removed row must be excluded from list_top");
        assert_eq!(got[0].conversation_id, "c2");
    }

    #[tokio::test]
    async fn clear_for_employee_only_deletes_that_employee() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        store
            .upsert_remote_many(&[
                sample_remote_for("u-A", "a1", "wa-1", 100, 0),
                sample_remote_for("u-B", "b1", "wa-2", 200, 0),
            ])
            .await
            .unwrap();
        store.advance_watermark("cli", "u-A", 42).await.unwrap();
        store.advance_watermark("cli", "u-B", 99).await.unwrap();
        store.clear_for_employee("u-A").await.unwrap();
        // u-A 数据全清
        assert!(store.list_top("u-A", None, 10).await.unwrap().is_empty());
        assert_eq!(store.get_watermark("cli", "u-A").await.unwrap(), 0);
        // u-B 数据完全不动
        assert_eq!(store.list_top("u-B", None, 10).await.unwrap().len(), 1);
        assert_eq!(store.get_watermark("cli", "u-B").await.unwrap(), 99);
    }
}
