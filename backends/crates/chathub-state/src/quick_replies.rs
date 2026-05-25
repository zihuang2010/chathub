//! QuickRepliesStore:快捷回复的本地行存(`hub_quick_replies`)。
//!
//! 设计要点:
//! - **纯客户端**:无远端来源,不接事件 applier / watermark;CRUD 全在本地 SQLite。
//! - **按 employee 隔离**:所有读写都 `WHERE employee_id = ?` 兜底,切员工互不可见。
//! - **id 由调用方注入**(前端 crypto.randomUUID),作 PK;`sort_order` 新建时取 max+1。

use crate::error::StateError;
use crate::pool::SqlitePool;
use serde::{Deserialize, Serialize};

/// 一条快捷回复。JSON 用 camelCase,直接喂给 Tauri command 返回 / 前端消费。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickReplyRow {
    pub id: String,
    pub employee_id: String,
    pub title: String,
    pub content: String,
    pub sort_order: i64,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

pub struct QuickRepliesStore {
    pool: SqlitePool,
}

impl QuickRepliesStore {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// 列出某员工的全部快捷回复,按 `sort_order`、`created_at_ms` 升序。
    pub async fn list_for_employee(
        &self,
        employee_id: &str,
    ) -> Result<Vec<QuickReplyRow>, StateError> {
        let employee_id = employee_id.to_string();
        let conn = self.pool.pool().get().await?;
        let rows = conn
            .interact(move |c| -> Result<Vec<QuickReplyRow>, StateError> {
                let mut stmt = c.prepare(
                    "SELECT id, employee_id, title, content, sort_order, created_at_ms, updated_at_ms \
                     FROM hub_quick_replies \
                     WHERE employee_id = ?1 \
                     ORDER BY sort_order ASC, created_at_ms ASC",
                )?;
                let rows = stmt
                    .query_map(rusqlite::params![employee_id], map_row)?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .await??;
        Ok(rows)
    }

    /// 新建一条快捷回复。`id` 由调用方注入;`sort_order` 取该员工现有 max+1(末尾追加)。
    pub async fn create(
        &self,
        employee_id: &str,
        id: &str,
        title: &str,
        content: &str,
    ) -> Result<(), StateError> {
        let employee_id = employee_id.to_string();
        let id = id.to_string();
        let title = title.to_string();
        let content = content.to_string();
        let now = now_unix_ms();
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            let next_order: i64 = c.query_row(
                "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM hub_quick_replies WHERE employee_id = ?1",
                rusqlite::params![employee_id],
                |r| r.get(0),
            )?;
            c.execute(
                "INSERT INTO hub_quick_replies \
                   (id, employee_id, title, content, sort_order, created_at_ms, updated_at_ms) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                rusqlite::params![id, employee_id, title, content, next_order, now],
            )?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// 修改一条快捷回复的标题 / 正文。employee_id 校验,行不存在或跨员工时 no-op。
    pub async fn update(
        &self,
        employee_id: &str,
        id: &str,
        title: &str,
        content: &str,
    ) -> Result<(), StateError> {
        let employee_id = employee_id.to_string();
        let id = id.to_string();
        let title = title.to_string();
        let content = content.to_string();
        let now = now_unix_ms();
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            c.execute(
                "UPDATE hub_quick_replies \
                   SET title = ?1, content = ?2, updated_at_ms = ?3 \
                 WHERE employee_id = ?4 AND id = ?5",
                rusqlite::params![title, content, now, employee_id, id],
            )?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// 删除一条快捷回复。employee_id 校验,行不存在或跨员工时 no-op。
    pub async fn delete(&self, employee_id: &str, id: &str) -> Result<(), StateError> {
        let employee_id = employee_id.to_string();
        let id = id.to_string();
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            c.execute(
                "DELETE FROM hub_quick_replies WHERE employee_id = ?1 AND id = ?2",
                rusqlite::params![employee_id, id],
            )?;
            Ok(())
        })
        .await??;
        Ok(())
    }
}

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<QuickReplyRow> {
    Ok(QuickReplyRow {
        id: row.get(0)?,
        employee_id: row.get(1)?,
        title: row.get(2)?,
        content: row.get(3)?,
        sort_order: row.get(4)?,
        created_at_ms: row.get(5)?,
        updated_at_ms: row.get(6)?,
    })
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

    const E: &str = "u-1";

    #[tokio::test]
    async fn create_list_update_delete_round_trip() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = QuickRepliesStore::new(pool);

        store.create(E, "q1", "问候", "您好,在的").await.unwrap();
        store.create(E, "q2", "稍等", "稍等一下哈").await.unwrap();

        let rows = store.list_for_employee(E).await.unwrap();
        assert_eq!(rows.len(), 2);
        // 按 sort_order 升序:先建的在前
        assert_eq!(rows[0].id, "q1");
        assert_eq!(rows[1].id, "q2");
        assert!(
            rows[1].sort_order > rows[0].sort_order,
            "sort_order 末尾追加递增"
        );

        store
            .update(E, "q1", "问候语", "您好,请问有什么可以帮您")
            .await
            .unwrap();
        let rows = store.list_for_employee(E).await.unwrap();
        assert_eq!(rows[0].title, "问候语");
        assert_eq!(rows[0].content, "您好,请问有什么可以帮您");

        store.delete(E, "q1").await.unwrap();
        let rows = store.list_for_employee(E).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "q2");
    }

    #[tokio::test]
    async fn isolates_by_employee() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = QuickRepliesStore::new(pool);
        store
            .create("u-A", "qa", "A 的回复", "仅 A 可见")
            .await
            .unwrap();
        store
            .create("u-B", "qb", "B 的回复", "仅 B 可见")
            .await
            .unwrap();

        let a = store.list_for_employee("u-A").await.unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].id, "qa");

        // 跨员工 update / delete 不生效
        store.update("u-A", "qb", "x", "x").await.unwrap();
        store.delete("u-A", "qb").await.unwrap();
        let b = store.list_for_employee("u-B").await.unwrap();
        assert_eq!(b.len(), 1);
        assert_eq!(b[0].content, "仅 B 可见");
    }
}
