//! hub_events 表:employee_id 维度,带完整 batch 字段。
//! 主键 (employee_id, notify_seq, event_index);INSERT OR IGNORE 天然幂等。
//! Plan 7 — 旧 ring-buffer EventStore 已删,统一走 EventLog。

use super::{Storage, StorageError};

/// 一条事件的所有列(对应 hub_events 表)。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EventRow {
    pub employee_id: i64,
    pub notify_seq: i64,
    pub event_index: i64,
    pub event_type: String,
    pub event_reason: Option<String>,
    pub conversation_id: Option<String>,
    pub customer_user_id: Option<String>,
    pub external_user_id: Option<String>,
    pub client_id: String,
    pub batch_id: Option<String>,
    pub batch_time: Option<String>,
    pub event_time: Option<String>,
    /// 整个 event 的原始 JSON(relay 不解析业务字段);
    /// 客户端拿到后 JSON.parse 按 eventType 分支。
    pub payload_json: String,
    pub created_at_ms: i64,
}

#[derive(Clone)]
pub struct EventLog {
    storage: Storage,
}

impl EventLog {
    pub fn new(storage: Storage) -> Self {
        Self { storage }
    }

    /// 批量 `INSERT OR IGNORE`(同主键忽略)。返回实际插入行数。
    /// 业务后台重投同 notify_seq 时,IGNORE 提供天然幂等。
    pub async fn insert_batch(&self, rows: Vec<EventRow>) -> Result<usize, StorageError> {
        if rows.is_empty() {
            return Ok(0);
        }
        let conn = self.storage.conn().await?;
        let inserted = conn
            .interact(move |c| -> Result<usize, rusqlite::Error> {
                let tx = c.transaction()?;
                let mut total = 0usize;
                {
                    let mut stmt = tx.prepare(
                        "INSERT OR IGNORE INTO hub_events(\
                           employee_id, notify_seq, event_index, event_type, event_reason,\
                           conversation_id, customer_user_id, external_user_id,\
                           client_id, batch_id, batch_time, event_time,\
                           payload_json, created_at_ms\
                         ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
                    )?;
                    for r in &rows {
                        total += stmt.execute(rusqlite::params![
                            r.employee_id,
                            r.notify_seq,
                            r.event_index,
                            r.event_type,
                            r.event_reason,
                            r.conversation_id,
                            r.customer_user_id,
                            r.external_user_id,
                            r.client_id,
                            r.batch_id,
                            r.batch_time,
                            r.event_time,
                            r.payload_json,
                            r.created_at_ms,
                        ])?;
                    }
                }
                tx.commit()?;
                Ok(total)
            })
            .await
            .map_err(|e| StorageError::Interact(e.to_string()))??;
        Ok(inserted)
    }

    /// 续点查询:返回 notify_seq > since 的所有 events,
    /// 按 (notify_seq ASC, event_index ASC) 排序,limit 限定。
    pub async fn query_since(
        &self,
        employee_id: i64,
        since_notify_seq: i64,
        limit: i64,
    ) -> Result<Vec<EventRow>, StorageError> {
        let conn = self.storage.conn().await?;
        let rows = conn
            .interact(move |c| -> Result<Vec<EventRow>, rusqlite::Error> {
                let mut stmt = c.prepare(
                    "SELECT employee_id, notify_seq, event_index, event_type, event_reason,\
                            conversation_id, customer_user_id, external_user_id,\
                            client_id, batch_id, batch_time, event_time,\
                            payload_json, created_at_ms \
                     FROM hub_events \
                     WHERE employee_id = ?1 AND notify_seq > ?2 \
                     ORDER BY notify_seq ASC, event_index ASC \
                     LIMIT ?3",
                )?;
                let rows = stmt
                    .query_map(
                        rusqlite::params![employee_id, since_notify_seq, limit],
                        |r| {
                            Ok(EventRow {
                                employee_id: r.get(0)?,
                                notify_seq: r.get(1)?,
                                event_index: r.get(2)?,
                                event_type: r.get(3)?,
                                event_reason: r.get(4)?,
                                conversation_id: r.get(5)?,
                                customer_user_id: r.get(6)?,
                                external_user_id: r.get(7)?,
                                client_id: r.get(8)?,
                                batch_id: r.get(9)?,
                                batch_time: r.get(10)?,
                                event_time: r.get(11)?,
                                payload_json: r.get(12)?,
                                created_at_ms: r.get(13)?,
                            })
                        },
                    )?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(rows)
            })
            .await
            .map_err(|e| StorageError::Interact(e.to_string()))??;
        Ok(rows)
    }

    /// 返回该 employee 当前事件日志中最早一行的 (notify_seq, created_at_ms)。
    /// 用于判断客户端 since_notify_seq 是否已经超出 relay 保留窗口
    /// (since < earliest.notify_seq - 1 → 需要 resync_required)。
    pub async fn earliest_for(&self, employee_id: i64) -> Result<Option<(i64, i64)>, StorageError> {
        let conn = self.storage.conn().await?;
        let row = conn
            .interact(move |c| -> Result<Option<(i64, i64)>, rusqlite::Error> {
                let mut stmt = c.prepare(
                    "SELECT notify_seq, created_at_ms FROM hub_events \
                     WHERE employee_id = ?1 \
                     ORDER BY notify_seq ASC LIMIT 1",
                )?;
                let mut rows = stmt.query_map(rusqlite::params![employee_id], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
                })?;
                match rows.next() {
                    Some(r) => Ok(Some(r?)),
                    None => Ok(None),
                }
            })
            .await
            .map_err(|e| StorageError::Interact(e.to_string()))??;
        Ok(row)
    }

    /// 返回该 employee 当前事件日志中最大的 notify_seq(head 水位)。
    /// 用于 resync 路径:`replayed_to_seq` 直接跳到 head,跳过逐帧重放。
    /// 空表 / 该 employee 无任何行时 `SELECT MAX(...)` 返回 NULL → `None`
    /// (调用方据此回退为 `since`,覆盖换机 / 日志全损场景)。
    pub async fn latest_for(&self, employee_id: i64) -> Result<Option<i64>, StorageError> {
        let conn = self.storage.conn().await?;
        let row = conn
            .interact(move |c| -> Result<Option<i64>, rusqlite::Error> {
                let mut stmt =
                    c.prepare("SELECT MAX(notify_seq) FROM hub_events WHERE employee_id = ?1")?;
                // MAX 在空集上返回一行 NULL → Option<i64> 列读取得 None。
                let max: Option<i64> =
                    stmt.query_row(rusqlite::params![employee_id], |r| r.get(0))?;
                Ok(max)
            })
            .await
            .map_err(|e| StorageError::Interact(e.to_string()))??;
        Ok(row)
    }

    /// TTL 清理:删除 created_at_ms < cutoff 的记录,单次最多 batch_limit 行。
    /// 主循环按固定间隔重复调用,直到返回 0(无更多可删)。
    pub async fn cleanup_older_than(
        &self,
        cutoff_ms: i64,
        batch_limit: i64,
    ) -> Result<usize, StorageError> {
        let conn = self.storage.conn().await?;
        let deleted = conn
            .interact(move |c| -> Result<usize, rusqlite::Error> {
                c.execute(
                    "DELETE FROM hub_events WHERE rowid IN (\
                       SELECT rowid FROM hub_events \
                       WHERE created_at_ms < ?1 \
                       LIMIT ?2\
                     )",
                    rusqlite::params![cutoff_ms, batch_limit],
                )
            })
            .await
            .map_err(|e| StorageError::Interact(e.to_string()))??;
        Ok(deleted)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn make_log() -> EventLog {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("t.db");
        let storage = Storage::open(&db).await.unwrap();
        std::mem::forget(tmp);
        EventLog::new(storage)
    }

    fn row(employee_id: i64, notify_seq: i64, event_index: i64, event_type: &str) -> EventRow {
        EventRow {
            employee_id,
            notify_seq,
            event_index,
            event_type: event_type.to_string(),
            event_reason: None,
            conversation_id: None,
            customer_user_id: None,
            external_user_id: None,
            client_id: "rh_wxchat".to_string(),
            batch_id: None,
            batch_time: None,
            event_time: None,
            payload_json: "{}".to_string(),
            created_at_ms: notify_seq * 1000, // 简化:用 notify_seq 推时间便于断言
        }
    }

    #[tokio::test]
    async fn event_log_insert_batch_returns_inserted_count() {
        let log = make_log().await;
        let n = log
            .insert_batch(vec![
                row(1, 100, 0, "MESSAGE_UPSERT"),
                row(1, 100, 1, "SESSION_SUMMARY_UPSERT"),
            ])
            .await
            .unwrap();
        assert_eq!(n, 2);
    }

    #[tokio::test]
    async fn event_log_insert_batch_is_idempotent_on_duplicate_primary_key() {
        let log = make_log().await;
        let _ = log
            .insert_batch(vec![row(1, 100, 0, "MESSAGE_UPSERT")])
            .await
            .unwrap();
        // 业务后台重投同 notify_seq 同 event_index → IGNORE,inserted=0
        let n = log
            .insert_batch(vec![row(1, 100, 0, "MESSAGE_UPSERT")])
            .await
            .unwrap();
        assert_eq!(n, 0);
        // 但同 notify_seq 不同 event_index 可以新增(batch 内有新事件)
        let n = log
            .insert_batch(vec![row(1, 100, 1, "SESSION_SUMMARY_UPSERT")])
            .await
            .unwrap();
        assert_eq!(n, 1);
    }

    #[tokio::test]
    async fn event_log_query_since_returns_ordered_events() {
        let log = make_log().await;
        log.insert_batch(vec![
            row(1, 100, 0, "MESSAGE_UPSERT"),
            row(1, 100, 1, "SESSION_SUMMARY_UPSERT"),
            row(1, 101, 0, "MESSAGE_UPSERT"),
            row(1, 102, 0, "FRIEND_UPSERT"),
        ])
        .await
        .unwrap();
        let out = log.query_since(1, 100, 100).await.unwrap();
        // since=100 → 排除 100,返回 101 + 102
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].notify_seq, 101);
        assert_eq!(out[1].notify_seq, 102);
    }

    #[tokio::test]
    async fn event_log_query_since_includes_batch_internal_order() {
        let log = make_log().await;
        log.insert_batch(vec![
            row(1, 50, 1, "SESSION_SUMMARY_UPSERT"), // 故意倒序插入
            row(1, 50, 0, "MESSAGE_UPSERT"),
        ])
        .await
        .unwrap();
        let out = log.query_since(1, 0, 100).await.unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].event_index, 0);
        assert_eq!(out[1].event_index, 1);
    }

    #[tokio::test]
    async fn event_log_isolates_per_employee() {
        let log = make_log().await;
        log.insert_batch(vec![row(1, 100, 0, "MESSAGE_UPSERT")])
            .await
            .unwrap();
        log.insert_batch(vec![row(2, 100, 0, "MESSAGE_UPSERT")])
            .await
            .unwrap();
        let out = log.query_since(1, 0, 100).await.unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].employee_id, 1);
    }

    #[tokio::test]
    async fn event_log_earliest_for_returns_min_notify_seq() {
        let log = make_log().await;
        log.insert_batch(vec![
            row(1, 200, 0, "MESSAGE_UPSERT"),
            row(1, 100, 0, "MESSAGE_UPSERT"),
            row(1, 150, 0, "MESSAGE_UPSERT"),
        ])
        .await
        .unwrap();
        let (seq, ts) = log.earliest_for(1).await.unwrap().unwrap();
        assert_eq!(seq, 100);
        assert_eq!(ts, 100_000); // row() 内部 created_at_ms = notify_seq * 1000
        assert!(log.earliest_for(999).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn event_log_latest_for_returns_max_notify_seq() {
        let log = make_log().await;
        log.insert_batch(vec![
            row(1, 200, 0, "MESSAGE_UPSERT"),
            row(1, 100, 0, "MESSAGE_UPSERT"),
            row(1, 150, 0, "MESSAGE_UPSERT"),
        ])
        .await
        .unwrap();
        // 同一 notify_seq 多 event_index 不应改变 MAX。
        log.insert_batch(vec![row(1, 200, 1, "SESSION_SUMMARY_UPSERT")])
            .await
            .unwrap();
        assert_eq!(log.latest_for(1).await.unwrap(), Some(200));
    }

    #[tokio::test]
    async fn event_log_latest_for_empty_returns_none() {
        let log = make_log().await;
        // 空表 / 该 employee 无任何行:MAX(notify_seq) 返回 NULL → None。
        assert_eq!(log.latest_for(999).await.unwrap(), None);
    }

    #[tokio::test]
    async fn event_log_latest_for_isolates_per_employee() {
        let log = make_log().await;
        log.insert_batch(vec![row(1, 100, 0, "MESSAGE_UPSERT")])
            .await
            .unwrap();
        log.insert_batch(vec![row(2, 500, 0, "MESSAGE_UPSERT")])
            .await
            .unwrap();
        // employee 2 的 head 不污染 employee 1。
        assert_eq!(log.latest_for(1).await.unwrap(), Some(100));
        assert_eq!(log.latest_for(2).await.unwrap(), Some(500));
    }

    #[tokio::test]
    async fn event_log_cleanup_deletes_old_rows_up_to_limit() {
        let log = make_log().await;
        let mut rows = vec![];
        for seq in 1..=20_i64 {
            rows.push(row(1, seq, 0, "MESSAGE_UPSERT")); // created_at_ms = seq * 1000
        }
        log.insert_batch(rows).await.unwrap();

        // cutoff = 11_000 → 删除 seq < 11 的共 10 行,limit 5 → 一次最多 5 行
        let deleted = log.cleanup_older_than(11_000, 5).await.unwrap();
        assert_eq!(deleted, 5);

        // 再来一次,清完剩下的 5 行
        let deleted = log.cleanup_older_than(11_000, 100).await.unwrap();
        assert_eq!(deleted, 5);

        // 第三次,已无可删
        let deleted = log.cleanup_older_than(11_000, 100).await.unwrap();
        assert_eq!(deleted, 0);

        // 剩下 seq 11..=20 共 10 行
        let remaining = log.query_since(1, 0, 100).await.unwrap();
        assert_eq!(remaining.len(), 10);
        assert_eq!(remaining[0].notify_seq, 11);
        assert_eq!(remaining[9].notify_seq, 20);
    }
}
