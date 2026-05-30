//! 图片派生元数据（原始宽高 + 本地缩略图路径），按图片 URL 为键。与服务端附件真相解耦。
//! 数据来源：后台预取任务下载原图时捕获 dimensions，落盘缩略图后写入本表。
//! 读消息时按 URL 批量查，注入到 HistoryAttachment 返回前端（前端按比例渲染 + asset 协议本地读）。
use crate::error::StateError;
use crate::pool::SqlitePool;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// 单张图片的派生元数据。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageMeta {
    /// 完整 https 图片 URL（= filet.jdd51.com + '/' + media_id）。
    pub url: String,
    /// 原图宽（用于前端定比例盒）。
    pub width: i64,
    /// 原图高。
    pub height: i64,
    /// 磁盘缩略图绝对路径（asset 协议读它）。
    pub local_path: String,
    /// 写入时间戳（ms）。
    pub updated_at_ms: i64,
}

/// 图片元数据存储，以 URL 为主键，通过 SQLitePool 访问 hub_image_meta 表。
#[derive(Clone)]
pub struct ImageMetaStore {
    pool: SqlitePool,
}

impl ImageMetaStore {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// 写入或更新一条图片元数据（ON CONFLICT 按 URL 覆盖）。
    pub async fn upsert(&self, m: ImageMeta) -> Result<(), StateError> {
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            c.execute(
                "INSERT INTO hub_image_meta (url,width,height,local_path,updated_at_ms) \
                 VALUES (?1,?2,?3,?4,?5) ON CONFLICT(url) DO UPDATE SET \
                 width=excluded.width, height=excluded.height, \
                 local_path=excluded.local_path, updated_at_ms=excluded.updated_at_ms",
                rusqlite::params![m.url, m.width, m.height, m.local_path, m.updated_at_ms],
            )?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// 批量按 URL 查询元数据，返回命中的 URL → ImageMeta 映射。未命中的 URL 不出现在结果中。
    pub async fn get_many(
        &self,
        urls: Vec<String>,
    ) -> Result<HashMap<String, ImageMeta>, StateError> {
        if urls.is_empty() {
            return Ok(HashMap::new());
        }
        let conn = self.pool.pool().get().await?;
        let out = conn
            .interact(move |c| -> Result<HashMap<String, ImageMeta>, StateError> {
                let mut map = HashMap::new();
                let mut stmt = c.prepare(
                    "SELECT url,width,height,local_path,updated_at_ms \
                     FROM hub_image_meta WHERE url = ?1",
                )?;
                for u in &urls {
                    if let Ok(m) = stmt.query_row(rusqlite::params![u], |r| {
                        Ok(ImageMeta {
                            url: r.get(0)?,
                            width: r.get(1)?,
                            height: r.get(2)?,
                            local_path: r.get(3)?,
                            updated_at_ms: r.get(4)?,
                        })
                    }) {
                        map.insert(u.clone(), m);
                    }
                }
                Ok(map)
            })
            .await??;
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 基本 round-trip：upsert 后 get_many 能取回，未命中 URL 不出现在结果。
    #[tokio::test]
    async fn upsert_get_round_trip() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let s = ImageMetaStore::new(pool);
        s.upsert(ImageMeta {
            url: "u1".into(),
            width: 400,
            height: 200,
            local_path: "/c/a.img".into(),
            updated_at_ms: 1,
        })
        .await
        .unwrap();
        let m = s.get_many(vec!["u1".into(), "u2".into()]).await.unwrap();
        // u1 命中，u2 未命中
        assert_eq!(m.len(), 1, "只有 u1 命中");
        assert_eq!(m["u1"].width, 400);
        assert_eq!(m["u1"].height, 200);
    }

    /// ON CONFLICT 覆盖：重复 upsert 同一 URL 时，新值覆盖旧值。
    #[tokio::test]
    async fn upsert_overwrites_existing() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let s = ImageMetaStore::new(pool);
        s.upsert(ImageMeta {
            url: "u1".into(),
            width: 100,
            height: 50,
            local_path: "/old.img".into(),
            updated_at_ms: 1,
        })
        .await
        .unwrap();
        s.upsert(ImageMeta {
            url: "u1".into(),
            width: 800,
            height: 600,
            local_path: "/new.img".into(),
            updated_at_ms: 2,
        })
        .await
        .unwrap();
        let m = s.get_many(vec!["u1".into()]).await.unwrap();
        assert_eq!(m["u1"].width, 800, "新宽度应覆盖旧值");
        assert_eq!(m["u1"].local_path, "/new.img");
    }

    /// 空 URL 列表返回空 map，不报错。
    #[tokio::test]
    async fn get_many_empty_input() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let s = ImageMetaStore::new(pool);
        let m = s.get_many(vec![]).await.unwrap();
        assert!(m.is_empty());
    }
}
