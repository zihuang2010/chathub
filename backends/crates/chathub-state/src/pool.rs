//! SqlitePool:WAL-mode SQLite 连接池,启动时跑迁移。

use crate::error::StateError;
use deadpool_sqlite::{Config, Pool, Runtime};
use rusqlite_migration::{Migrations, M};
use std::path::Path;

#[derive(Clone)]
pub struct SqlitePool {
    pool: Pool,
}

impl SqlitePool {
    /// 打开磁盘 SQLite,自动建文件 + 跑迁移 + 开 WAL。
    pub async fn open(path: impl AsRef<Path>) -> Result<Self, StateError> {
        let cfg = Config::new(path.as_ref().to_path_buf());
        let pool = cfg
            .create_pool(Runtime::Tokio1)
            .map_err(|e| StateError::Pool(e.to_string()))?;
        let me = Self { pool };
        me.apply_migrations().await?;
        me.set_pragma_wal().await?;
        Ok(me)
    }

    /// 内存 SQLite,跑迁移。仅供测试用。
    pub async fn in_memory() -> Result<Self, StateError> {
        let cfg = Config::new(":memory:");
        let pool = cfg
            .create_pool(Runtime::Tokio1)
            .map_err(|e| StateError::Pool(e.to_string()))?;
        let me = Self { pool };
        me.apply_migrations().await?;
        Ok(me)
    }

    pub fn pool(&self) -> &Pool {
        &self.pool
    }

    async fn apply_migrations(&self) -> Result<(), StateError> {
        let conn = self.pool.get().await?;
        conn.interact(|c| {
            let migrations = Migrations::new(vec![
                M::up(include_str!("../migrations/V1__init.sql")),
                M::up(include_str!("../migrations/V2__seqs.sql")),
                M::up(include_str!("../migrations/V3__kv.sql")),
                M::up(include_str!("../migrations/V4__account_cache.sql")),
                M::up(include_str!("../migrations/V5__friends_cache.sql")),
                M::up(include_str!("../migrations/V6__friends_store.sql")),
                M::up(include_str!("../migrations/V7__recent_sessions.sql")),
                M::up(include_str!("../migrations/V8__friends_employee_id.sql")),
                M::up(include_str!("../migrations/V9__recents_employee_id.sql")),
                M::up(include_str!("../migrations/V10__local_draft_text.sql")),
                M::up(include_str!("../migrations/V11__recents_removed.sql")),
                M::up(include_str!("../migrations/V12__recents_muted.sql")),
                M::up(include_str!("../migrations/V13__recents_version.sql")),
                M::up(include_str!("../migrations/V14__conversation_messages.sql")),
                M::up(include_str!("../migrations/V15__quick_replies.sql")),
                M::up(include_str!(
                    "../migrations/V16__retire_friends_store_and_watermarks.sql"
                )),
                M::up(include_str!("../migrations/V17__recents_opened_at.sql")),
                M::up(include_str!("../migrations/V18__friend_detail_cache.sql")),
                M::up(include_str!("../migrations/V19__image_meta.sql")),
                M::up(include_str!(
                    "../migrations/V20__normalize_message_direction.sql"
                )),
                M::up(include_str!("../migrations/V21__session_user_fields.sql")),
                M::up(include_str!(
                    "../migrations/V22__messages_revoked_fail_reason.sql"
                )),
                M::up(include_str!(
                    "../migrations/V23__recents_local_last_sent.sql"
                )),
                M::up(include_str!("../migrations/V24__idx_hub_msgs_req.sql")),
                M::up(include_str!(
                    "../migrations/V25__recents_backfill_display_time.sql"
                )),
                M::up(include_str!(
                    "../migrations/V26__recents_backfill_remote_display_time.sql"
                )),
                M::up(include_str!("../migrations/V27__quarantined_events.sql")),
                M::up(include_str!(
                    "../migrations/V28__purge_dirty_unknown_out_bubbles.sql"
                )),
                M::up(include_str!(
                    "../migrations/V29__messages_source_direction.sql"
                )),
                M::up(include_str!("../migrations/V30__session_terminal_id.sql")),
                M::up(include_str!(
                    "../migrations/V31__recents_read_watermark.sql"
                )),
                M::up(include_str!("../migrations/V32__recents_dedup_friend.sql")),
                M::up(include_str!("../migrations/V33__user_settings.sql")),
                M::up(include_str!(
                    "../migrations/V34__purge_resend_dup_failed.sql"
                )),
            ]);
            migrations
                .to_latest(c)
                .map_err(|e| StateError::Migration(e.to_string()))
        })
        .await??;
        Ok(())
    }

    async fn set_pragma_wal(&self) -> Result<(), StateError> {
        let conn = self.pool.get().await?;
        conn.interact(|c| -> Result<(), rusqlite::Error> {
            c.pragma_update(None, "journal_mode", "WAL")?;
            c.pragma_update(None, "foreign_keys", "ON")?;
            Ok(())
        })
        .await??;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn in_memory_pool_applies_all_migrations() {
        let pool = SqlitePool::in_memory().await.expect("pool open");

        let conn = pool.pool().get().await.expect("get conn");
        let table_count: i64 = conn
            .interact(|c| {
                c.query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN (\
                   'hub_current_session', 'hub_wecom_accounts', \
                   'hub_secrets', 'hub_settings', \
                   'hub_conversation_recents', \
                   'hub_conversation_messages', 'hub_conversation_message_window', \
                   'hub_quick_replies', 'hub_image_meta', 'hub_quarantined_events'\
                 )",
                    [],
                    |r| r.get(0),
                )
            })
            .await
            .expect("interact")
            .expect("query");

        assert_eq!(
            table_count, 10,
            "全部迁移跑完应剩 10 张 hub_ 前缀业务表(account_seqs/friends_cache 在 V4/V6 DROP;\
             V16 退役 friends 行存 + 3 张 per-resource 水位表;真正在用的续点水位在 hub_settings.notify_seq;\
             + V19 hub_image_meta;V20/V28 仅修数据;+ V27 hub_quarantined_events 异常库)"
        );
    }

    #[tokio::test]
    async fn in_memory_pool_supports_repeated_open() {
        // 再开一次:迁移已 idempotent,不应报错(rusqlite_migration 会比对版本)
        let _p1 = SqlitePool::in_memory().await.expect("first");
        let _p2 = SqlitePool::in_memory().await.expect("second");
    }

    #[test]
    fn v20_migration_repairs_cached_message_direction_from_source_sort_key() {
        let conn = rusqlite::Connection::open_in_memory().expect("open in-memory sqlite");
        conn.execute_batch(include_str!("../migrations/V14__conversation_messages.sql"))
            .expect("create conversation message tables");
        conn.execute(
            "INSERT INTO hub_conversation_messages ( \
               local_message_id, conversation_id, employee_id, wecom_account_id, sort_key, \
               message_time_ms, message_direction, message_type, content_text, send_status, \
               attachments_json, gmt_modified_time, updated_at_ms \
             ) VALUES (?1, 'c1', 'u1', 'wa1', ?2, 0, ?3, 1, 'hi', 3, '[]', '', 0)",
            rusqlite::params!["m-in", "1770000000000:2:00000000000000009001:m-in", 2],
        )
        .expect("insert incoming row with wrong cached direction");
        conn.execute(
            "INSERT INTO hub_conversation_messages ( \
               local_message_id, conversation_id, employee_id, wecom_account_id, sort_key, \
               message_time_ms, message_direction, message_type, content_text, send_status, \
               attachments_json, gmt_modified_time, updated_at_ms \
             ) VALUES (?1, 'c1', 'u1', 'wa1', ?2, 0, ?3, 1, 'hi', 3, '[]', '', 0)",
            rusqlite::params!["m-out", "1770000000001:1:00000000000000009002:m-out", 1],
        )
        .expect("insert outgoing row with wrong cached direction");
        conn.execute(
            "INSERT INTO hub_conversation_messages ( \
               local_message_id, conversation_id, employee_id, wecom_account_id, sort_key, \
               message_time_ms, message_direction, message_type, content_text, send_status, \
               attachments_json, gmt_modified_time, updated_at_ms \
             ) VALUES (?1, 'c1', 'u1', 'wa1', ?2, 0, ?3, 1, 'hi', 3, '[]', '', 0)",
            rusqlite::params!["m-sync", "1770000000002:3:00000000000000009003:m-sync", 1],
        )
        .expect("insert sync row with wrong cached direction");

        conn.execute_batch(include_str!(
            "../migrations/V20__normalize_message_direction.sql"
        ))
        .expect("run V20 migration");

        let direction = |id: &str| -> i64 {
            conn.query_row(
                "SELECT message_direction FROM hub_conversation_messages WHERE local_message_id = ?1",
                [id],
                |r| r.get(0),
            )
            .expect("read message_direction")
        };
        assert_eq!(
            direction("m-in"),
            1,
            "source direction 2=客户/接收方,应迁移为本地 in"
        );
        assert_eq!(
            direction("m-out"),
            2,
            "source direction 1=发送方,应迁移为本地 out"
        );
        assert_eq!(
            direction("m-sync"),
            2,
            "source direction 3=多端同步方,应迁移为本地 out"
        );
    }

    #[test]
    fn v28_migration_purges_dirty_unknown_out_bubbles() {
        let conn = rusqlite::Connection::open_in_memory().expect("open in-memory sqlite");
        conn.execute_batch(include_str!("../migrations/V14__conversation_messages.sql"))
            .expect("create conversation message tables");
        let insert = |id: &str, dir: i64, mtype: i64, status: i64| {
            conn.execute(
                "INSERT INTO hub_conversation_messages ( \
                   local_message_id, conversation_id, employee_id, wecom_account_id, sort_key, \
                   message_time_ms, message_direction, message_type, content_text, send_status, \
                   attachments_json, gmt_modified_time, updated_at_ms \
                 ) VALUES (?1, 'c1', 'u1', 'wa1', ?1, 0, ?2, ?3, 'x', ?4, '[]', '', 0)",
                rusqlite::params![id, dir, mtype, status],
            )
            .expect("insert row");
        };
        insert("dirty", 2, 99, 0); // 语义矛盾脏气泡:type=99 + out + send_status=0 → 删
        insert("real_out", 2, 1, 3); // 正常出站文本 → 留
        insert("unknown_in", 1, 99, 0); // 入站未知(direction=1)→ 留(非本类脏行)
        insert("unknown_out_sent", 2, 99, 3); // type=99 出站但已发送(status≠0)→ 留

        conn.execute_batch(include_str!(
            "../migrations/V28__purge_dirty_unknown_out_bubbles.sql"
        ))
        .expect("run V28 migration");

        let exists = |id: &str| -> i64 {
            conn.query_row(
                "SELECT COUNT(*) FROM hub_conversation_messages WHERE local_message_id = ?1",
                [id],
                |r| r.get(0),
            )
            .expect("count row")
        };
        assert_eq!(exists("dirty"), 0, "语义矛盾脏气泡被清除");
        assert_eq!(exists("real_out"), 1, "正常出站消息保留");
        assert_eq!(
            exists("unknown_in"),
            1,
            "入站未知消息(direction=1)不在删除范围"
        );
        assert_eq!(
            exists("unknown_out_sent"),
            1,
            "type=99 出站但已发送(status≠0)保留"
        );
    }

    #[test]
    fn v34_migration_collapses_resend_dup_failed_rows() {
        let conn = rusqlite::Connection::open_in_memory().expect("open in-memory sqlite");
        conn.execute_batch(include_str!("../migrations/V14__conversation_messages.sql"))
            .expect("create conversation message tables");
        conn.execute_batch(include_str!(
            "../migrations/V22__messages_revoked_fail_reason.sql"
        ))
        .expect("add revoked/fail_reason/request_message_id columns");
        let insert = |id: &str, sort: &str, status: i64, text: &str, reqid: &str| {
            conn.execute(
                "INSERT INTO hub_conversation_messages ( \
                   local_message_id, conversation_id, employee_id, wecom_account_id, sort_key, \
                   message_time_ms, message_direction, message_type, content_text, send_status, \
                   attachments_json, gmt_modified_time, updated_at_ms, request_message_id \
                 ) VALUES (?1, 'c1', 'u1', 'wa1', ?2, 0, 2, 1, ?3, ?4, '[]', '', 0, ?5)",
                rusqlite::params![id, sort, text, status, reqid],
            )
            .expect("insert row");
        };
        // 复刻真机 898 链:本地失败行 + 服务端失败行(reqid 被 history 抹空) + 重发成功行(reqid=前任 id)。
        insert("local-991c", "1781184183478_a", 4, "898", "local-991c");
        insert("S-898-fail", "1781184185431_b", 4, "898", "");
        insert("S-898-ok", "1781185781407_c", 3, "898", "S-898-fail");
        // 复刻真机 778 堆积:两条本地失败 + 三条服务端无键失败,内容全同 → 只留 sort_key 最新一条。
        insert("local-1a80", "1781184659000_a", 4, "778", "local-1a80");
        insert("S-778-1", "1781184660906_b", 4, "778", "");
        insert("S-778-2", "1781184669674_c", 4, "778", "");
        insert("local-9a7f", "1781184688000_d", 4, "778", "local-9a7f");
        insert("S-778-3", "1781184702783_e", 4, "778", "");
        // 对照:不同内容的孤立失败行、已送达消息,均不许动。
        insert("lone-fail", "1781184700000_x", 4, "唯一失败", "lone-fail");
        insert("sent-dup-a", "1781184700001_y", 3, "在吗", "");
        insert("sent-dup-b", "1781184700002_z", 3, "在吗", "");

        conn.execute_batch(include_str!(
            "../migrations/V34__purge_resend_dup_failed.sql"
        ))
        .expect("run V34 migration");

        let ids: Vec<String> = conn
            .prepare("SELECT local_message_id FROM hub_conversation_messages ORDER BY sort_key")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        // 898 链:①内容收编把 local-991c 收进最新失败行 S-898-fail;②键链收编再把被成功行
        // reqid 引用的 S-898-fail 收掉 → 最终只剩成功行,不留失败残影。
        // 778 堆积:①同内容五条失败行只留 sort_key 最新的 S-778-3;②无引用,不再删。
        // 孤立失败行与已送达消息(含同内容副本)一律不动。
        assert_eq!(
            ids,
            [
                "lone-fail",
                "sent-dup-a",
                "sent-dup-b",
                "S-778-3",
                "S-898-ok"
            ],
            "迁移后应恰好剩这五行(按 sort_key 升序)"
        );
    }

    #[test]
    fn v25_migration_backfills_display_time_from_local_last_sent() {
        let conn = rusqlite::Connection::open_in_memory().expect("open in-memory sqlite");
        // V25 的 UPDATE 仅引用这两列,建最小表覆盖回填语义即可(真实 recents 表跨多迁移构建)。
        conn.execute_batch(
            "CREATE TABLE hub_conversation_recents ( \
               conversation_id       TEXT NOT NULL, \
               last_message_time_ms  INTEGER NOT NULL DEFAULT 0, \
               local_last_sent_at_ms INTEGER NOT NULL DEFAULT 0 \
             );",
        )
        .expect("create minimal recents table");
        // 四类行:① 只有本地发送/无服务端确认(坏行,待回填)② 真实消息更新(不下调)
        // ③ 本地发送晚于真实消息(抬齐,与写入口 MAX 一致)④ 无任何活动(保持空)。
        conn.execute_batch(
            "INSERT INTO hub_conversation_recents VALUES \
               ('timeless',  0,    9999), \
               ('real_newer',5000, 3000), \
               ('sent_newer',2000, 8000), \
               ('idle',      0,    0);",
        )
        .expect("seed rows");

        conn.execute_batch(include_str!(
            "../migrations/V25__recents_backfill_display_time.sql"
        ))
        .expect("run V25 migration");

        let time_ms = |id: &str| -> i64 {
            conn.query_row(
                "SELECT last_message_time_ms FROM hub_conversation_recents WHERE conversation_id = ?1",
                [id],
                |r| r.get(0),
            )
            .expect("read last_message_time_ms")
        };
        assert_eq!(time_ms("timeless"), 9999, "坏行应用本地发送时间补齐");
        assert_eq!(time_ms("real_newer"), 5000, "更新的真实消息时间不得被下调");
        assert_eq!(
            time_ms("sent_newer"),
            8000,
            "本地发送更晚应抬齐(与写入口 MAX 一致)"
        );
        assert_eq!(
            time_ms("idle"),
            0,
            "无活动行保持空(打开空白会话不应有显示时间)"
        );

        // 幂等:重跑无任何变化。
        conn.execute_batch(include_str!(
            "../migrations/V25__recents_backfill_display_time.sql"
        ))
        .expect("rerun V25 migration");
        assert_eq!(time_ms("timeless"), 9999, "重跑须幂等");
        assert_eq!(time_ms("sent_newer"), 8000, "重跑须幂等");
    }
}
