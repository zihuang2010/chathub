//! MessagesStore:消息页单会话消息流的本地持久化。
//!
//! 两张表(见 V14 迁移):
//!   - `hub_conversation_messages`:消息行,`local_message_id` PK。
//!     UPSERT 只刷可变列(send_status / content / attachments / gmt_modified),
//!     位置列(sort_key / message_time_ms / 方向 / 类型)不动。
//!   - `hub_conversation_message_window`:每会话一行 = 连续性"水位"。
//!     `[oldest_sort_key, newest_sort_key] + older_cursor + has_more_older` 描述单连续窗口;
//!     `newest_message_time_ms`(epoch-ms)是跨源新鲜度键,供会话水位门比 recents 行。
//!
//! 所有读写都 `WHERE employee_id = ?` 兜底(防御性多员工隔离,抄 recent_sessions 纪律)。

use crate::error::StateError;
use crate::pool::SqlitePool;
use serde::{Deserialize, Serialize};

/// per-employee 热会话数上限。超出按 last_accessed_ms 整会话 LRU 淘汰(不切单会话尾)。
pub const MESSAGE_HOT_CONVERSATIONS_LIMIT: usize = 40;

/// 单条缓存消息行。JSON camelCase 直接喂前端。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRow {
    pub local_message_id: String,
    pub conversation_id: String,
    pub employee_id: String,
    pub wecom_account_id: String,
    pub sort_key: String,
    pub message_time_ms: i64,
    pub message_direction: i32,
    pub message_type: i32,
    pub content_text: String,
    pub send_status: i32,
    /// 附件元数据 JSON 数组串(不下载二进制)。
    pub attachments_json: String,
    pub gmt_modified_time: String,
    pub revoked: bool,
    pub fail_reason: String,
    pub request_message_id: String,
    pub updated_at_ms: i64,
}

/// 每会话连续性水位行。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageWindow {
    pub conversation_id: String,
    pub employee_id: String,
    pub wecom_account_id: String,
    pub external_user_id: String,
    pub newest_sort_key: String,
    pub oldest_sort_key: String,
    pub older_cursor: String,
    pub has_more_older: bool,
    /// 窗口最新一条的 epoch-ms。会话水位门比较键(sort_key 不可跨源比)。
    pub newest_message_time_ms: i64,
    pub last_accessed_ms: i64,
    pub reconciled_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Clone)]
pub struct MessagesStore {
    pool: SqlitePool,
}

impl MessagesStore {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// 批量 UPSERT 消息行。`ON CONFLICT(local_message_id)` 只刷可变列
    /// (send_status / content_text / attachments_json / gmt_modified_time / updated_at_ms);
    /// 位置列(sort_key / message_time_ms / 方向 / 类型)与 employee/account/conversation 不动。
    /// send_status 按文档§4 不倒退合并(0/1→任意,2→3/4,4→3,3 终态)、revoked 黏住(一旦为真不可逆)。
    pub async fn upsert_messages(&self, rows: &[MessageRow]) -> Result<(), StateError> {
        if rows.is_empty() {
            return Ok(());
        }
        let rows = rows.to_vec();
        let now = now_unix_ms();
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            let tx = c.transaction()?;
            for r in &rows {
                tx.execute(
                    "INSERT INTO hub_conversation_messages ( \
                       local_message_id, conversation_id, employee_id, wecom_account_id, sort_key, \
                       message_time_ms, message_direction, message_type, content_text, send_status, \
                       attachments_json, gmt_modified_time, revoked, fail_reason, request_message_id, \
                       updated_at_ms \
                     ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16) \
                     ON CONFLICT(local_message_id) DO UPDATE SET \
                       message_direction = excluded.message_direction, \
                       content_text      = excluded.content_text, \
                       send_status = CASE \
                           WHEN send_status <= 1 THEN excluded.send_status \
                           WHEN send_status = 2 AND excluded.send_status IN (3, 4) THEN excluded.send_status \
                           WHEN send_status = 4 AND excluded.send_status = 3 THEN 3 \
                           ELSE send_status \
                       END, \
                       attachments_json  = excluded.attachments_json, \
                       gmt_modified_time = excluded.gmt_modified_time, \
                       revoked           = revoked OR excluded.revoked, \
                       fail_reason = CASE \
                           WHEN send_status <= 1 THEN excluded.fail_reason \
                           WHEN send_status = 2 AND excluded.send_status IN (3, 4) THEN excluded.fail_reason \
                           WHEN send_status = 4 AND excluded.send_status = 3 THEN excluded.fail_reason \
                           ELSE fail_reason \
                       END, \
                       updated_at_ms     = excluded.updated_at_ms",
                    rusqlite::params![
                        r.local_message_id,
                        r.conversation_id,
                        r.employee_id,
                        r.wecom_account_id,
                        r.sort_key,
                        r.message_time_ms,
                        r.message_direction as i64,
                        r.message_type as i64,
                        r.content_text,
                        r.send_status as i64,
                        r.attachments_json,
                        r.gmt_modified_time,
                        r.revoked as i64,
                        r.fail_reason,
                        r.request_message_id,
                        now,
                    ],
                )?;
                // 去重:把同一逻辑消息(request_message_id 相同)的「client 键失败行」塌缩进刚入库的
                // server 行。仅删 send_status=4,绝不碰 server 多态行(PENDING/CONFIRMED 同 reqid 共存)。
                // request_message_id 空(inbound/老行)跳过,防空串互删。
                if !r.request_message_id.is_empty() {
                    tx.execute(
                        "DELETE FROM hub_conversation_messages \
                         WHERE employee_id = ?1 AND request_message_id = ?2 \
                           AND request_message_id <> '' AND send_status = 4 \
                           AND local_message_id <> ?3",
                        rusqlite::params![r.employee_id, r.request_message_id, r.local_message_id],
                    )?;
                }
            }
            tx.commit()?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// 写一条出站失败气泡行(send_status=4)。client_msg_id 同时作 local_message_id 与
    /// request_message_id(收敛桥)。sort_key 复刻服务端失败态形态:13位ms_20位零_id(下划线三段);
    /// 方向写列 2(out)——新 sort_key 不含 direction 段。先 ensure_window 保证有落脚窗口。
    /// 不 bump window.newest(避免扰动会话水位门)。
    #[allow(clippy::too_many_arguments)]
    pub async fn insert_failed_outbox(
        &self,
        employee_id: &str,
        conversation_id: &str,
        wecom_account_id: &str,
        external_user_id: &str,
        client_msg_id: &str,
        sent_at_ms: i64,
        message_type: i32,
        content_text: &str,
        fail_reason: &str,
        attachments_json: &str,
    ) -> Result<(), StateError> {
        self.ensure_window(
            employee_id,
            conversation_id,
            wecom_account_id,
            external_user_id,
        )
        .await?;
        let row = MessageRow {
            local_message_id: client_msg_id.to_string(),
            conversation_id: conversation_id.to_string(),
            employee_id: employee_id.to_string(),
            wecom_account_id: wecom_account_id.to_string(),
            sort_key: format!("{:013}_{:020}_{}", sent_at_ms, 0, client_msg_id),
            message_time_ms: sent_at_ms,
            message_direction: 2,
            message_type,
            content_text: content_text.to_string(),
            send_status: 4,
            attachments_json: attachments_json.to_string(),
            gmt_modified_time: String::new(),
            revoked: false,
            fail_reason: fail_reason.to_string(),
            request_message_id: client_msg_id.to_string(),
            updated_at_ms: 0,
        };
        self.upsert_messages(&[row]).await
    }

    /// 读最新 `limit` 条,返回 **newest→oldest**(`ORDER BY sort_key DESC`)。
    /// 命令层返前端前会 `.rev()` 成升序(server records 与前端渲染都升序)。
    /// `employee_id` 强制过滤。
    pub async fn list_recent(
        &self,
        employee_id: &str,
        conversation_id: &str,
        limit: usize,
    ) -> Result<Vec<MessageRow>, StateError> {
        let employee_id = employee_id.to_string();
        let conversation_id = conversation_id.to_string();
        let limit = limit as i64;
        let conn = self.pool.pool().get().await?;
        let rows = conn
            .interact(move |c| -> Result<Vec<MessageRow>, StateError> {
                let mut stmt = c.prepare(
                    "SELECT local_message_id, conversation_id, employee_id, wecom_account_id, sort_key, \
                            message_time_ms, message_direction, message_type, content_text, send_status, \
                            attachments_json, gmt_modified_time, revoked, fail_reason, request_message_id, \
                            updated_at_ms \
                     FROM hub_conversation_messages \
                     WHERE employee_id = ?1 AND conversation_id = ?2 \
                     ORDER BY sort_key DESC LIMIT ?3",
                )?;
                let rows = stmt
                    .query_map(rusqlite::params![employee_id, conversation_id, limit], map_row)?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .await??;
        Ok(rows)
    }

    /// 读某会话**全部**缓存行,返回 oldest→newest(`ORDER BY sort_key ASC`)。
    /// 缓存=持久化窗口 `[oldest_sort_key, newest_sort_key]`(始终连续),故整窗返回后
    /// 前端显示尾恒等于 window.oldest,`load_older`(网络拉 window.oldest 之下)永远接得上,
    /// 不会出现"显示尾 > 窗口底"导致翻页跳段留洞。`employee_id` 强制过滤。
    pub async fn list_conversation_asc(
        &self,
        employee_id: &str,
        conversation_id: &str,
    ) -> Result<Vec<MessageRow>, StateError> {
        let employee_id = employee_id.to_string();
        let conversation_id = conversation_id.to_string();
        let conn = self.pool.pool().get().await?;
        let rows = conn
            .interact(move |c| -> Result<Vec<MessageRow>, StateError> {
                let mut stmt = c.prepare(
                    "SELECT local_message_id, conversation_id, employee_id, wecom_account_id, sort_key, \
                            message_time_ms, message_direction, message_type, content_text, send_status, \
                            attachments_json, gmt_modified_time, revoked, fail_reason, request_message_id, \
                            updated_at_ms \
                     FROM hub_conversation_messages \
                     WHERE employee_id = ?1 AND conversation_id = ?2 \
                     ORDER BY sort_key ASC",
                )?;
                let rows = stmt
                    .query_map(rusqlite::params![employee_id, conversation_id], map_row)?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .await??;
        Ok(rows)
    }

    /// 发送路径引导:确保会话有一扇窗(bootstrap 热会话),使后续 push 气泡不被冷会话门控跳过。
    /// 已存在则不动;不存在则建空窗(newest/oldest/older_cursor 空串、has_more_older=true 保守、
    /// newest_message_time_ms=0、时间戳取 now)。INSERT OR IGNORE 幂等。
    pub async fn ensure_window(
        &self,
        employee_id: &str,
        conversation_id: &str,
        wecom_account_id: &str,
        external_user_id: &str,
    ) -> Result<(), StateError> {
        let employee_id = employee_id.to_string();
        let conversation_id = conversation_id.to_string();
        let wecom_account_id = wecom_account_id.to_string();
        let external_user_id = external_user_id.to_string();
        let now = now_unix_ms();
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            c.execute(
                "INSERT OR IGNORE INTO hub_conversation_message_window ( \
                   conversation_id, employee_id, wecom_account_id, external_user_id, \
                   newest_sort_key, oldest_sort_key, older_cursor, has_more_older, \
                   newest_message_time_ms, last_accessed_ms, reconciled_at_ms, updated_at_ms \
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
                rusqlite::params![
                    conversation_id,
                    employee_id,
                    wecom_account_id,
                    external_user_id,
                    "",
                    "",
                    "",
                    1i64,
                    0i64,
                    now,
                    now,
                    now,
                ],
            )?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// 整行 UPSERT 水位(boundary 全量替换)。重对齐 / load_older 算好新 window 后调。
    pub async fn upsert_window(&self, w: MessageWindow) -> Result<(), StateError> {
        let now = now_unix_ms();
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            c.execute(
                "INSERT INTO hub_conversation_message_window ( \
                   conversation_id, employee_id, wecom_account_id, external_user_id, \
                   newest_sort_key, oldest_sort_key, older_cursor, has_more_older, \
                   newest_message_time_ms, last_accessed_ms, reconciled_at_ms, updated_at_ms \
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12) \
                 ON CONFLICT(conversation_id) DO UPDATE SET \
                   employee_id            = excluded.employee_id, \
                   wecom_account_id       = excluded.wecom_account_id, \
                   external_user_id       = excluded.external_user_id, \
                   newest_sort_key        = excluded.newest_sort_key, \
                   oldest_sort_key        = excluded.oldest_sort_key, \
                   older_cursor           = excluded.older_cursor, \
                   has_more_older         = excluded.has_more_older, \
                   newest_message_time_ms = excluded.newest_message_time_ms, \
                   reconciled_at_ms       = excluded.reconciled_at_ms, \
                   updated_at_ms          = excluded.updated_at_ms",
                rusqlite::params![
                    w.conversation_id,
                    w.employee_id,
                    w.wecom_account_id,
                    w.external_user_id,
                    w.newest_sort_key,
                    w.oldest_sort_key,
                    w.older_cursor,
                    w.has_more_older as i64,
                    w.newest_message_time_ms,
                    w.last_accessed_ms,
                    w.reconciled_at_ms,
                    now,
                ],
            )?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// 读水位(employee_id 过滤;不存在返 None)。会话水位门直接复用此读 newest_message_time_ms。
    pub async fn get_window(
        &self,
        employee_id: &str,
        conversation_id: &str,
    ) -> Result<Option<MessageWindow>, StateError> {
        let employee_id = employee_id.to_string();
        let conversation_id = conversation_id.to_string();
        let conn = self.pool.pool().get().await?;
        let w = conn
            .interact(move |c| -> Result<Option<MessageWindow>, StateError> {
                let res = c.query_row(
                    "SELECT conversation_id, employee_id, wecom_account_id, external_user_id, \
                            newest_sort_key, oldest_sort_key, older_cursor, has_more_older, \
                            newest_message_time_ms, last_accessed_ms, reconciled_at_ms, updated_at_ms \
                     FROM hub_conversation_message_window \
                     WHERE employee_id = ?1 AND conversation_id = ?2",
                    rusqlite::params![employee_id, conversation_id],
                    map_window,
                );
                match res {
                    Ok(w) => Ok(Some(w)),
                    Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                    Err(e) => Err(e.into()),
                }
            })
            .await??;
        Ok(w)
    }

    /// 刷新 last_accessed_ms(行不存在则 no-op)。打开会话时 bump 热度。
    pub async fn touch_accessed(
        &self,
        employee_id: &str,
        conversation_id: &str,
        now_ms: i64,
    ) -> Result<(), StateError> {
        let employee_id = employee_id.to_string();
        let conversation_id = conversation_id.to_string();
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            c.execute(
                "UPDATE hub_conversation_message_window SET last_accessed_ms = ?1 \
                 WHERE employee_id = ?2 AND conversation_id = ?3",
                rusqlite::params![now_ms, employee_id, conversation_id],
            )?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// 删除某会话的全部消息行 + 水位行(遇洞丢旧 / LRU 淘汰共用)。employee_id 过滤防越权。
    pub async fn delete_conversation(
        &self,
        employee_id: &str,
        conversation_id: &str,
    ) -> Result<(), StateError> {
        let employee_id = employee_id.to_string();
        let conversation_id = conversation_id.to_string();
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            let tx = c.transaction()?;
            tx.execute(
                "DELETE FROM hub_conversation_messages WHERE employee_id = ?1 AND conversation_id = ?2",
                rusqlite::params![employee_id, conversation_id],
            )?;
            tx.execute(
                "DELETE FROM hub_conversation_message_window WHERE employee_id = ?1 AND conversation_id = ?2",
                rusqlite::params![employee_id, conversation_id],
            )?;
            tx.commit()?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// 整会话 LRU:per-employee 保留 last_accessed_ms 最大的 `max` 个会话,其余整会话删
    /// (消息 + window)。不切单会话尾。
    pub async fn trim_conversations(
        &self,
        employee_id: &str,
        max: usize,
    ) -> Result<(), StateError> {
        let employee_id = employee_id.to_string();
        let max = max as i64;
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            let tx = c.transaction()?;
            let victims: Vec<String> = {
                let mut stmt = tx.prepare(
                    "SELECT conversation_id FROM hub_conversation_message_window \
                     WHERE employee_id = ?1 \
                       AND conversation_id NOT IN ( \
                         SELECT DISTINCT conversation_id FROM hub_conversation_messages \
                         WHERE employee_id = ?1 AND send_status = 4 AND request_message_id <> '' \
                       ) \
                     ORDER BY last_accessed_ms DESC LIMIT -1 OFFSET ?2",
                )?;
                let v = stmt
                    .query_map(rusqlite::params![employee_id, max], |r| r.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                v
            };
            for conv in &victims {
                tx.execute(
                    "DELETE FROM hub_conversation_messages WHERE employee_id = ?1 AND conversation_id = ?2",
                    rusqlite::params![employee_id, conv],
                )?;
                tx.execute(
                    "DELETE FROM hub_conversation_message_window WHERE employee_id = ?1 AND conversation_id = ?2",
                    rusqlite::params![employee_id, conv],
                )?;
            }
            tx.commit()?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// 删一条本地行(重发前清掉失败行,让气泡回纯乐观 sending)。按 employee_id 校验防越权。
    pub async fn clear_outbox_row(
        &self,
        employee_id: &str,
        local_message_id: &str,
    ) -> Result<(), StateError> {
        let employee_id = employee_id.to_string();
        let local_message_id = local_message_id.to_string();
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            c.execute(
                "DELETE FROM hub_conversation_messages \
                 WHERE employee_id = ?1 AND local_message_id = ?2",
                rusqlite::params![employee_id, local_message_id],
            )?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// 列某会话未收敛的本地失败行(send_status=4 且 request_message_id 非空)。供 reconcile/trim 保活。
    pub async fn list_failed_outbox(
        &self,
        employee_id: &str,
        conversation_id: &str,
    ) -> Result<Vec<MessageRow>, StateError> {
        let employee_id = employee_id.to_string();
        let conversation_id = conversation_id.to_string();
        let conn = self.pool.pool().get().await?;
        let rows = conn
            .interact(move |c| -> Result<Vec<MessageRow>, StateError> {
                let mut stmt = c.prepare(
                    "SELECT local_message_id, conversation_id, employee_id, wecom_account_id, \
                            sort_key, message_time_ms, message_direction, message_type, \
                            content_text, send_status, attachments_json, gmt_modified_time, \
                            revoked, fail_reason, request_message_id, updated_at_ms \
                     FROM hub_conversation_messages \
                     WHERE employee_id = ?1 AND conversation_id = ?2 \
                       AND send_status = 4 AND request_message_id <> ''",
                )?;
                let rows = stmt
                    .query_map(rusqlite::params![employee_id, conversation_id], map_row)?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .await??;
        Ok(rows)
    }

    /// 清除聊天记录(「清除聊天记录」按钮唯一调用):删该 employee 全部消息行 +
    /// **折叠**水位窗(不删)。
    ///
    /// 为何折叠而非删窗:会话水位门(`load_conversation_messages`)用 window.newest 比 recents 行判
    /// fresh —— 删窗会让门判 not-fresh → 同步 reconcile 把旧史从服务端拉回(清除形同无效)。保留
    /// `newest_sort_key` / `newest_message_time_ms` 作 fresh 依据(c>=r → 零网络),旧史不回拉;同时
    /// 清空向下翻页能力(`older_cursor=''` + `has_more_older=0`)并把 oldest 收敛到 newest,堵住上滑
    /// 经 older_cursor 回拉更旧页。性质:本地软清除,不动服务端(换设备 / 真冷启动仍会回来)。
    pub async fn clear_for_employee(&self, employee_id: &str) -> Result<(), StateError> {
        let employee_id = employee_id.to_string();
        let now = now_unix_ms();
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            let tx = c.transaction()?;
            tx.execute(
                "DELETE FROM hub_conversation_messages WHERE employee_id = ?1",
                rusqlite::params![employee_id],
            )?;
            tx.execute(
                "UPDATE hub_conversation_message_window \
                 SET oldest_sort_key = newest_sort_key, older_cursor = '', has_more_older = 0, \
                     updated_at_ms = ?2 \
                 WHERE employee_id = ?1",
                rusqlite::params![employee_id, now],
            )?;
            tx.commit()?;
            Ok(())
        })
        .await??;
        Ok(())
    }
}

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MessageRow> {
    Ok(MessageRow {
        local_message_id: row.get(0)?,
        conversation_id: row.get(1)?,
        employee_id: row.get(2)?,
        wecom_account_id: row.get(3)?,
        sort_key: row.get(4)?,
        message_time_ms: row.get(5)?,
        message_direction: row.get::<_, i64>(6)? as i32,
        message_type: row.get::<_, i64>(7)? as i32,
        content_text: row.get(8)?,
        send_status: row.get::<_, i64>(9)? as i32,
        attachments_json: row.get(10)?,
        gmt_modified_time: row.get(11)?,
        revoked: row.get::<_, i64>(12)? != 0,
        fail_reason: row.get(13)?,
        request_message_id: row.get(14)?,
        updated_at_ms: row.get(15)?,
    })
}

fn map_window(row: &rusqlite::Row<'_>) -> rusqlite::Result<MessageWindow> {
    Ok(MessageWindow {
        conversation_id: row.get(0)?,
        employee_id: row.get(1)?,
        wecom_account_id: row.get(2)?,
        external_user_id: row.get(3)?,
        newest_sort_key: row.get(4)?,
        oldest_sort_key: row.get(5)?,
        older_cursor: row.get(6)?,
        has_more_older: row.get::<_, i64>(7)? != 0,
        newest_message_time_ms: row.get(8)?,
        last_accessed_ms: row.get(9)?,
        reconciled_at_ms: row.get(10)?,
        updated_at_ms: row.get(11)?,
    })
}

pub(crate) fn now_unix_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_row(conv: &str, lid: &str, sk: &str, ts: i64) -> MessageRow {
        MessageRow {
            local_message_id: lid.into(),
            conversation_id: conv.into(),
            employee_id: "u-1".into(),
            wecom_account_id: "wa-1".into(),
            sort_key: sk.into(),
            message_time_ms: ts,
            message_direction: 1,
            message_type: 1,
            content_text: "hi".into(),
            send_status: 3,
            attachments_json: "[]".into(),
            gmt_modified_time: "".into(),
            revoked: false,
            fail_reason: String::new(),
            request_message_id: String::new(),
            updated_at_ms: 0,
        }
    }

    fn sample_window(conv: &str) -> MessageWindow {
        MessageWindow {
            conversation_id: conv.into(),
            employee_id: "u-1".into(),
            wecom_account_id: "wa-1".into(),
            external_user_id: "ext-1".into(),
            newest_sort_key: "sort_0003".into(),
            oldest_sort_key: "sort_0001".into(),
            older_cursor: "cur-1".into(),
            has_more_older: true,
            newest_message_time_ms: 300,
            last_accessed_ms: 0,
            reconciled_at_ms: 0,
            updated_at_ms: 0,
        }
    }

    #[tokio::test]
    async fn upsert_then_list_recent_desc() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = MessagesStore::new(pool);
        store
            .upsert_messages(&[
                sample_row("c1", "m1", "sort_0001", 100),
                sample_row("c1", "m2", "sort_0002", 200),
                sample_row("c1", "m3", "sort_0003", 300),
            ])
            .await
            .unwrap();
        let got = store.list_recent("u-1", "c1", 2).await.unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].local_message_id, "m3");
        assert_eq!(got[1].local_message_id, "m2");
    }

    #[tokio::test]
    async fn list_conversation_asc_returns_full_window_ordered() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = MessagesStore::new(pool);
        store
            .upsert_messages(&[
                sample_row("c1", "m3", "sort_0003", 300),
                sample_row("c1", "m1", "sort_0001", 100),
                sample_row("c1", "m2", "sort_0002", 200),
                sample_row("c2", "x1", "sort_0001", 100),
            ])
            .await
            .unwrap();
        let got = store.list_conversation_asc("u-1", "c1").await.unwrap();
        assert_eq!(got.len(), 3, "返回该会话全部行,不受 limit 截断");
        assert_eq!(got[0].local_message_id, "m1", "升序:最旧在前");
        assert_eq!(got[1].local_message_id, "m2");
        assert_eq!(got[2].local_message_id, "m3", "升序:最新在尾");
        assert!(
            store
                .list_conversation_asc("u-other", "c1")
                .await
                .unwrap()
                .is_empty(),
            "employee_id 隔离"
        );
    }

    #[tokio::test]
    async fn upsert_updates_mutable_keeps_position() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = MessagesStore::new(pool);
        store
            .upsert_messages(&[sample_row("c1", "m1", "sort_0001", 100)])
            .await
            .unwrap();
        let mut updated = sample_row("c1", "m1", "sort_DIFFERENT", 999);
        updated.send_status = 4;
        updated.content_text = "edited".into();
        store.upsert_messages(&[updated]).await.unwrap();
        let got = store.list_recent("u-1", "c1", 10).await.unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(
            got[0].send_status, 3,
            "send_status=3 是终态,§4 忽略后到的 4(不倒退);可变内容刷新见下"
        );
        assert_eq!(got[0].content_text, "edited", "可变内容列被刷新");
        assert_eq!(got[0].sort_key, "sort_0001", "位置列 sort_key 不动");
        assert_eq!(got[0].message_time_ms, 100, "位置列 message_time_ms 不动");
    }

    #[tokio::test]
    async fn window_upsert_get_round_trip() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = MessagesStore::new(pool);
        assert!(store.get_window("u-1", "c1").await.unwrap().is_none());
        store.upsert_window(sample_window("c1")).await.unwrap();
        let w = store
            .get_window("u-1", "c1")
            .await
            .unwrap()
            .expect("exists");
        assert_eq!(w.newest_sort_key, "sort_0003");
        assert_eq!(w.older_cursor, "cur-1");
        assert!(w.has_more_older);
        assert_eq!(w.newest_message_time_ms, 300);
        assert!(store.get_window("u-other", "c1").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn ensure_window_bootstraps_empty_window_idempotent() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = MessagesStore::new(pool);
        // 空库:建空窗。
        assert!(store.get_window("u-1", "c1").await.unwrap().is_none());
        store
            .ensure_window("u-1", "c1", "wa-1", "ext-1")
            .await
            .unwrap();
        let w = store
            .get_window("u-1", "c1")
            .await
            .unwrap()
            .expect("应建出空窗");
        assert_eq!(w.newest_sort_key, "", "空窗 newest 为空");
        assert_eq!(w.oldest_sort_key, "");
        assert_eq!(w.older_cursor, "");
        assert!(w.has_more_older, "保守 has_more_older=true");
        assert_eq!(w.newest_message_time_ms, 0);
        assert_eq!(w.external_user_id, "ext-1");
        assert_eq!(w.wecom_account_id, "wa-1");

        // 再调一次:幂等,不报错、不覆盖。
        store
            .ensure_window("u-1", "c1", "wa-1", "ext-1")
            .await
            .unwrap();
        let w2 = store.get_window("u-1", "c1").await.unwrap().expect("仍在");
        assert_eq!(w2.newest_sort_key, "");
        assert!(w2.has_more_older);
    }

    #[tokio::test]
    async fn touch_accessed_updates_only_existing() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = MessagesStore::new(pool);
        store.touch_accessed("u-1", "c1", 555).await.unwrap();
        assert!(store.get_window("u-1", "c1").await.unwrap().is_none());
        store.upsert_window(sample_window("c1")).await.unwrap();
        store.touch_accessed("u-1", "c1", 555).await.unwrap();
        let w = store.get_window("u-1", "c1").await.unwrap().unwrap();
        assert_eq!(w.last_accessed_ms, 555);
    }

    #[tokio::test]
    async fn delete_conversation_drops_rows_and_window() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = MessagesStore::new(pool);
        store
            .upsert_messages(&[sample_row("c1", "m1", "sort_0001", 100)])
            .await
            .unwrap();
        store.upsert_window(sample_window("c1")).await.unwrap();
        store.delete_conversation("u-1", "c1").await.unwrap();
        assert!(store.list_recent("u-1", "c1", 10).await.unwrap().is_empty());
        assert!(store.get_window("u-1", "c1").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn trim_conversations_evicts_coldest_whole() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = MessagesStore::new(pool);
        for (conv, acc) in [("c1", 10i64), ("c2", 20), ("c3", 30)] {
            store
                .upsert_messages(&[sample_row(conv, &format!("{conv}-m"), "sort_0001", 100)])
                .await
                .unwrap();
            let mut w = sample_window(conv);
            w.last_accessed_ms = acc;
            store.upsert_window(w).await.unwrap();
        }
        store.trim_conversations("u-1", 2).await.unwrap();
        assert!(store.get_window("u-1", "c1").await.unwrap().is_none());
        assert!(store.list_recent("u-1", "c1", 10).await.unwrap().is_empty());
        assert!(store.get_window("u-1", "c2").await.unwrap().is_some());
        assert!(store.get_window("u-1", "c3").await.unwrap().is_some());
    }

    #[tokio::test]
    async fn clear_for_employee_isolates() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = MessagesStore::new(pool);
        let mut other = sample_row("cB", "mB", "sort_0001", 100);
        other.employee_id = "u-2".into();
        store
            .upsert_messages(&[sample_row("cA", "mA", "sort_0001", 100), other])
            .await
            .unwrap();
        store.clear_for_employee("u-1").await.unwrap();
        assert!(store.list_recent("u-1", "cA", 10).await.unwrap().is_empty());
        assert_eq!(store.list_recent("u-2", "cB", 10).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn clear_for_employee_collapses_window_keeps_watermark() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = MessagesStore::new(pool);
        store
            .upsert_messages(&[sample_row("c1", "m1", "sort_0001", 100)])
            .await
            .unwrap();
        store.upsert_window(sample_window("c1")).await.unwrap();

        store.clear_for_employee("u-1").await.unwrap();

        // 消息行清空。
        assert!(store.list_recent("u-1", "c1", 10).await.unwrap().is_empty());
        // 水位窗保留但折叠:newest 水位仍在(会话水位门 fresh 依据,旧史不被 reconcile 回拉);
        // 翻页能力清零(older_cursor 空 + has_more_older=false + oldest 收敛到 newest)。
        let w = store
            .get_window("u-1", "c1")
            .await
            .unwrap()
            .expect("水位窗应保留(折叠而非删除)");
        assert_eq!(w.newest_sort_key, "sort_0003");
        assert_eq!(w.newest_message_time_ms, 300);
        assert_eq!(w.oldest_sort_key, "sort_0003");
        assert_eq!(w.older_cursor, "");
        assert!(!w.has_more_older);
    }

    #[tokio::test]
    async fn upsert_messages_merges_send_status_without_regression() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = MessagesStore::new(pool);
        let emp = "42";
        let conv = "conv-1";
        let mk = |lmid: &str, status: i32, revoked: bool, fail: &str| MessageRow {
            local_message_id: lmid.into(),
            conversation_id: conv.into(),
            employee_id: emp.into(),
            wecom_account_id: "acct".into(),
            sort_key: format!("1780000000000:1:0:{lmid}"),
            message_time_ms: 1780000000000,
            message_direction: 2,
            message_type: 1,
            content_text: "hi".into(),
            send_status: status,
            attachments_json: "[]".into(),
            gmt_modified_time: "".into(),
            revoked,
            fail_reason: fail.into(),
            request_message_id: "".into(),
            updated_at_ms: 0,
        };
        let read_one = |store: &MessagesStore, lmid: &'static str| {
            let store = store.clone();
            async move {
                store
                    .list_recent(emp, conv, 50)
                    .await
                    .unwrap()
                    .into_iter()
                    .find(|r| r.local_message_id == lmid)
                    .unwrap()
            }
        };

        // 1) 3(成功)后到 2(发送中)→ 不倒退,保持 3。
        store
            .upsert_messages(&[mk("LM1", 3, false, "")])
            .await
            .unwrap();
        store
            .upsert_messages(&[mk("LM1", 2, false, "")])
            .await
            .unwrap();
        assert_eq!(
            read_one(&store, "LM1").await.send_status,
            3,
            "3 不应被 2 倒退"
        );

        // 2) 4(失败)后到 3(成功)→ 接受 3。
        store
            .upsert_messages(&[mk("LM2", 4, false, "net")])
            .await
            .unwrap();
        store
            .upsert_messages(&[mk("LM2", 3, false, "")])
            .await
            .unwrap();
        let lm2 = read_one(&store, "LM2").await;
        assert_eq!(lm2.send_status, 3, "4→3 应接受");
        assert_eq!(
            lm2.fail_reason, "",
            "4→3 接受时 fail_reason 随状态更新(清空)"
        );

        // 3) 撤回后到未撤回 → 黏住撤回。
        store
            .upsert_messages(&[mk("LM3", 3, true, "")])
            .await
            .unwrap();
        store
            .upsert_messages(&[mk("LM3", 3, false, "")])
            .await
            .unwrap();
        assert!(read_one(&store, "LM3").await.revoked, "撤回一旦为真应黏住");

        // 4) 3 收到 4 → 忽略(严格,本轮不触发历史校验)。
        store
            .upsert_messages(&[mk("LM4", 3, false, "")])
            .await
            .unwrap();
        store
            .upsert_messages(&[mk("LM4", 4, false, "x")])
            .await
            .unwrap();
        let lm4 = read_one(&store, "LM4").await;
        assert_eq!(lm4.send_status, 3, "3 收到 4 严格忽略");
        assert_eq!(lm4.fail_reason, "", "3 终态忽略 4 时 fail_reason 不被污染");
    }

    #[tokio::test]
    async fn upsert_heals_message_direction() {
        // 验证 ON CONFLICT 能纠正已缓存的错误方向（自愈反向老行）
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = MessagesStore::new(pool);
        // 先落一条方向错误(2)的行
        let mut bad = sample_row("c1", "m1", "sort_0001", 100);
        bad.message_direction = 2;
        store.upsert_messages(&[bad]).await.unwrap();
        // 再以正确方向(1)重 upsert 同 id
        let mut fixed = sample_row("c1", "m1", "sort_0001", 100);
        fixed.message_direction = 1;
        store.upsert_messages(&[fixed]).await.unwrap();
        let got = store.list_recent("u-1", "c1", 10).await.unwrap();
        assert_eq!(got[0].message_direction, 1, "ON CONFLICT 应纠正方向");
    }

    fn row(local: &str, reqid: &str, status: i32) -> MessageRow {
        MessageRow {
            local_message_id: local.into(),
            conversation_id: "c1".into(),
            employee_id: "E".into(),
            wecom_account_id: "wa".into(),
            sort_key: format!("1780000000000_00000000000000000000_{local}"),
            message_time_ms: 1_780_000_000_000,
            message_direction: 2,
            message_type: 1,
            content_text: "hi".into(),
            send_status: status,
            attachments_json: "[]".into(),
            gmt_modified_time: String::new(),
            revoked: false,
            fail_reason: String::new(),
            request_message_id: reqid.into(),
            updated_at_ms: 0,
        }
    }

    #[tokio::test]
    async fn dedup_collapses_failed_client_row_into_server_confirmed_row() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = MessagesStore::new(pool);
        store
            .upsert_messages(&[row("cid", "cid", 4)])
            .await
            .unwrap();
        store
            .upsert_messages(&[row("server-1", "cid", 3)])
            .await
            .unwrap();
        let got = store.list_conversation_asc("E", "c1").await.unwrap();
        let ids: Vec<_> = got.iter().map(|r| r.local_message_id.as_str()).collect();
        assert_eq!(ids, ["server-1"], "失败行应被同 reqid 的 server 行塌缩");
    }

    #[tokio::test]
    async fn dedup_never_deletes_server_multistate_rows_same_reqid() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = MessagesStore::new(pool);
        store
            .upsert_messages(&[
                row("server-pending", "cid", 2),
                row("server-confirmed", "cid", 3),
            ])
            .await
            .unwrap();
        let got = store.list_conversation_asc("E", "c1").await.unwrap();
        assert_eq!(
            got.len(),
            2,
            "server 多态行(status≠4)绝不能被去重 DELETE 误删"
        );
    }

    #[tokio::test]
    async fn clear_outbox_row_deletes_only_that_local_id() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = MessagesStore::new(pool);
        store
            .insert_failed_outbox(
                "E",
                "c1",
                "wa",
                "x",
                "m1",
                1_780_000_000_000,
                1,
                "a",
                "r",
                "[]",
            )
            .await
            .unwrap();
        store
            .insert_failed_outbox(
                "E",
                "c1",
                "wa",
                "x",
                "m2",
                1_780_000_000_001,
                1,
                "b",
                "r",
                "[]",
            )
            .await
            .unwrap();
        store.clear_outbox_row("E", "m1").await.unwrap();
        let got = store.list_conversation_asc("E", "c1").await.unwrap();
        let ids: Vec<_> = got.iter().map(|r| r.local_message_id.as_str()).collect();
        assert_eq!(ids, ["m2"]);
    }

    #[tokio::test]
    async fn list_failed_outbox_returns_only_failed_outbound_rows() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = MessagesStore::new(pool);
        store
            .insert_failed_outbox(
                "E",
                "c1",
                "wa",
                "x",
                "f1",
                1_780_000_000_000,
                1,
                "a",
                "r",
                "[]",
            )
            .await
            .unwrap();
        store
            .upsert_messages(&[row("server-1", "", 3)])
            .await
            .unwrap(); // 正常 server 行,reqid 空
        let failed = store.list_failed_outbox("E", "c1").await.unwrap();
        let ids: Vec<_> = failed.iter().map(|r| r.local_message_id.as_str()).collect();
        assert_eq!(ids, ["f1"]);
    }

    #[tokio::test]
    async fn trim_exempts_conversations_with_failed_outbox_rows() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = MessagesStore::new(pool);
        // cFail:有失败行,last_accessed 最旧(本该最先被淘汰)
        store
            .insert_failed_outbox("E", "cFail", "wa", "x", "f1", 1, 1, "a", "r", "[]")
            .await
            .unwrap();
        store.touch_accessed("E", "cFail", 1).await.unwrap();
        // cHot:无失败行,last_accessed 最新
        store.ensure_window("E", "cHot", "wa", "x").await.unwrap();
        store.touch_accessed("E", "cHot", 999).await.unwrap();
        // 上限=1 → 正常会淘汰最旧的 cFail,但它有失败行应豁免(不进 victim)
        store.trim_conversations("E", 1).await.unwrap();
        let failed = store.list_failed_outbox("E", "cFail").await.unwrap();
        assert_eq!(failed.len(), 1, "含失败行的会话必须豁免 LRU 淘汰");
    }

    #[tokio::test]
    async fn insert_failed_outbox_writes_client_keyed_failed_row() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = MessagesStore::new(pool);
        store
            .insert_failed_outbox(
                "E",
                "c1",
                "wa",
                "ext-1",
                "local-uuid-1",
                1_780_000_000_000,
                1,
                "你好",
                "网络断开",
                "[]",
            )
            .await
            .unwrap();
        let got = store.list_conversation_asc("E", "c1").await.unwrap();
        assert_eq!(got.len(), 1);
        let r = &got[0];
        assert_eq!(r.local_message_id, "local-uuid-1");
        assert_eq!(r.request_message_id, "local-uuid-1");
        assert_eq!(r.send_status, 4);
        assert_eq!(
            r.message_direction, 2,
            "出站方向必须写列(下划线 sort_key 不兜底方向)"
        );
        assert_eq!(
            r.message_time_ms, 1_780_000_000_000,
            "message_time_ms 须 == 乐观 sentAt 同源"
        );
        assert_eq!(r.fail_reason, "网络断开");
        assert_eq!(
            r.sort_key,
            "1780000000000_00000000000000000000_local-uuid-1"
        );
    }
}
