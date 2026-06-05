//! QuarantinedEventsStore:异常事件隔离库(异常库)。
//!
//! 存放被判定为「语义矛盾、不入正常消息库」的 push 事件原文(见 V27 迁移 +
//! `MessageEventApplier::apply_push_batch` 的落库前拦截网关)。这类事件若进正常
//! `hub_conversation_messages`,会因方向/状态被误判而在前端无限转圈;隔离到本库后
//! 既止住转圈,又保留原文供后续排查上游契约问题。
//!
//! 读写都 `WHERE employee_id = ?` 兜底(防御性多员工隔离,抄 messages/recent_sessions 纪律)。

use crate::error::StateError;
use crate::pool::SqlitePool;
use serde::{Deserialize, Serialize};

/// 一条被隔离的异常事件行。JSON camelCase,便于后续排查工具直接消费。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuarantinedEventRow {
    pub id: i64,
    pub employee_id: String,
    pub conversation_id: String,
    pub local_message_id: String,
    /// 隔离原因标记(如 "semantic_conflict_in_as_out"),供分类排查。
    pub reason: String,
    /// 原始 push 事件 JSON 串(整条 event,含 message{} 与 eventReason)。
    pub raw_event_json: String,
    pub created_at_ms: i64,
}

#[derive(Clone)]
pub struct QuarantinedEventsStore {
    pool: SqlitePool,
}

impl QuarantinedEventsStore {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// 落一条异常事件。append-only,不去重(同一脏事件重复推送各记一行,反映真实频次)。
    pub async fn insert_event(
        &self,
        employee_id: &str,
        conversation_id: &str,
        local_message_id: &str,
        reason: &str,
        raw_event_json: &str,
    ) -> Result<(), StateError> {
        let employee_id = employee_id.to_string();
        let conversation_id = conversation_id.to_string();
        let local_message_id = local_message_id.to_string();
        let reason = reason.to_string();
        let raw_event_json = raw_event_json.to_string();
        let now = now_unix_ms();
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            c.execute(
                "INSERT INTO hub_quarantined_events ( \
                   employee_id, conversation_id, local_message_id, reason, \
                   raw_event_json, created_at_ms \
                 ) VALUES (?1,?2,?3,?4,?5,?6)",
                rusqlite::params![
                    employee_id,
                    conversation_id,
                    local_message_id,
                    reason,
                    raw_event_json,
                    now,
                ],
            )?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// 列某员工最近的异常事件(新→旧)。供后续排查 / 测试断言。
    pub async fn list_recent(
        &self,
        employee_id: &str,
        limit: usize,
    ) -> Result<Vec<QuarantinedEventRow>, StateError> {
        let employee_id = employee_id.to_string();
        let limit = limit as i64;
        let conn = self.pool.pool().get().await?;
        let rows = conn
            .interact(move |c| -> Result<Vec<QuarantinedEventRow>, StateError> {
                let mut stmt = c.prepare(
                    "SELECT id, employee_id, conversation_id, local_message_id, reason, \
                            raw_event_json, created_at_ms \
                     FROM hub_quarantined_events \
                     WHERE employee_id = ?1 \
                     ORDER BY created_at_ms DESC, id DESC \
                     LIMIT ?2",
                )?;
                let rows = stmt
                    .query_map(rusqlite::params![employee_id, limit], |row| {
                        Ok(QuarantinedEventRow {
                            id: row.get(0)?,
                            employee_id: row.get(1)?,
                            conversation_id: row.get(2)?,
                            local_message_id: row.get(3)?,
                            reason: row.get(4)?,
                            raw_event_json: row.get(5)?,
                            created_at_ms: row.get(6)?,
                        })
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .await??;
        Ok(rows)
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
    async fn insert_and_list_roundtrip_with_employee_isolation() {
        let pool = SqlitePool::in_memory().await.expect("pool");
        let store = QuarantinedEventsStore::new(pool);

        store
            .insert_event(
                "42",
                "conv-1",
                "LM_DIRTY",
                "semantic_conflict_in_as_out",
                r#"{"eventType":"MESSAGE_UPSERT","message":{"messageType":99}}"#,
            )
            .await
            .expect("insert");
        // 另一员工的隔离行不应被本员工读到(WHERE employee_id 兜底)。
        store
            .insert_event("99", "conv-2", "LM_OTHER", "x", "{}")
            .await
            .expect("insert other");

        let rows = store.list_recent("42", 10).await.expect("list");
        assert_eq!(rows.len(), 1, "只读到本员工的异常行");
        assert_eq!(rows[0].employee_id, "42");
        assert_eq!(rows[0].conversation_id, "conv-1");
        assert_eq!(rows[0].local_message_id, "LM_DIRTY");
        assert_eq!(rows[0].reason, "semantic_conflict_in_as_out");
        assert!(
            rows[0].raw_event_json.contains("\"messageType\":99"),
            "原文留存"
        );
        assert!(rows[0].created_at_ms > 0, "created_at_ms 已写入");
    }
}
