//! RecentSessionsStore:session/recentFriends 接待好友列表的本地"头部热缓存"。
//!
//! 设计要点:
//!
//! - **行存**:conversation_id 为 PK,每行同时承载远端 17 字段 + 客户端 3 个本地列。
//!   - V7 引入 `employee_id` 列(非 PK,加索引),防御性隔离:多 employee 切换 +
//!     异常退出场景下,所有读写都 `WHERE employee_id = ?` 兜底。
//! - **写入纪律**:
//!     - `upsert_remote_many` / `upsert_remote_one` 由远端拉取与事件 applier 调,
//!       严格只 UPSERT 远端列(`ON CONFLICT DO UPDATE SET <远端列>=excluded.<列>`)。
//!     - `set_pinned` / `set_draft` 由用户操作 command 调,只 UPDATE 本地列,
//!       SQL 同时校验 employee_id,防止跨 employee 误触发。
//!     - 两路从不重叠,避免远端拉取把"置顶/草稿"抹掉。
//! - **多键 ORDER BY**:`list_top` 内部用
//!   `pinned DESC, pinned_at_ms DESC, MAX(last_message_time_ms, local_draft_at_ms) DESC,
//!   last_message_time_ms DESC` 合成最终顺序。客户端字段全 0 时退化为纯服务端时序。
//! - **trim**:`trim` per-employee 维度执行,只删 `pinned=0` 的尾部行,置顶永不被裁。
//! - **watermark**:沿用 V6 模板"取大不取小",应对 relay redelivery。

use crate::error::StateError;
// D3:复用 messages 模块的 pub(crate) 时间助手,去掉本模块重复副本(同 crate 内收敛)。
use crate::messages::now_unix_ms;
use crate::pool::SqlitePool;
use serde::{Deserialize, Serialize};

/// 单 wecom_account 维度的非置顶行上限。多账号场景下保证每个企微号都有 500 行公平额度,
/// 避免热账号挤掉冷账号。
pub const RECENT_SESSIONS_PER_ACCOUNT_LIMIT: usize = 500;

/// 整 employee 维度的非置顶行总上限(兜底)。一般 4 个以下账号都不会摸到这个限,
/// 5+ 账号才会触发。置顶不计入。
pub const RECENT_SESSIONS_GLOBAL_LIMIT: usize = 2000;

/// 一条最近会话行:17 远端 + employee_id + updated_at_ms + 5 本地
/// (pinned/pinned_at_ms/local_draft_at_ms/local_draft_text + removed/removed_at_ms + muted/muted_at_ms)。
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
    /// LWW 主版本:`lastMessageSortKey` 首段 epoch-ms(缺省回退 `last_message_time_ms`)。
    /// `upsert_remote` 仅当 incoming 版本 ≥ stored 才覆盖远端列。
    pub last_message_sort_key_ms: i64,
    /// LWW 次版本:`gmtModifiedTime` 原样字符串,同 sortKey 时比较。
    pub gmt_modified_time: String,
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
    /// V12:消息免打扰标记。`true` 时该行未读"安静"展示(红点替代数字徽标 + 🔕)。
    /// 不进 WHERE/ORDER BY,只影响渲染;远端 UPSERT 永不触碰(自动保留)。
    pub muted: bool,
    pub muted_at_ms: i64,
    /// V17:用户主动"打开会话"的时间戳。进 list_top/trim 的 MAX(...) 排序(把该行提到
    /// 非置顶区顶部),但不进时间显示。客户端独占列,远端 UPSERT 永不触碰。
    pub opened_at_ms: i64,
    /// V23:本次发送置顶信号。发送一条消息时乐观置 now,把该行提到非置顶区顶部。
    /// 客户端独占列,仅进 list_top/trim 的 MAX(...) 排序,远端 UPSERT 永不触碰。
    pub local_last_sent_at_ms: i64,
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
    /// LWW 主版本(epoch-ms);见 [`RecentSessionRow::last_message_sort_key_ms`]。
    pub last_message_sort_key_ms: i64,
    /// LWW 次版本;见 [`RecentSessionRow::gmt_modified_time`]。
    pub gmt_modified_time: String,
}

/// `SESSION_SUMMARY_UPSERT` 事件携带的摘要数据(规范 §9.2 `sessionSummary{}`)。
///
/// 区别于 [`RecentSessionRemote`]:摘要事件**只**携带"最后一条消息 + 未读 + 排序键"以及
/// 少量可选资料字段;**不**携带 `wecomName/wecomAccount/externalMobile` 等列表展示字段。
/// 故配套的 [`RecentSessionsStore::apply_summary`] 做**分字段部分更新**——只覆盖摘要列与非空
/// 资料列,绝不把缺省的展示字段写成空串去覆盖本地已有值(见该方法注释)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecentSessionSummary {
    pub conversation_id: String,
    pub employee_id: String,
    pub last_local_message_id: String,
    pub last_message_type: i32,
    pub last_message_direction: i32,
    pub last_send_status: i32,
    pub last_message_summary: String,
    pub last_message_time_ms: i64,
    pub unread_count: i64,
    pub has_unread: bool,
    /// LWW 主版本(epoch-ms),取自 `lastSortKey` 首段。
    pub last_message_sort_key_ms: i64,
    /// LWW 次版本。
    pub gmt_modified_time: String,
    /// 可选资料字段:仅当**非空**才覆盖本地(§9.2「资料变化时可返回」)。
    pub external_name: String,
    pub external_avatar: String,
    pub wecom_alias: String,
    /// 静默消息(上游 `sessionSummary.clientSilent=true`)。静默仅影响"是否取消隐藏":
    /// `apply_summary` 对静默消息照常更新摘要,但**绝不**把软删除(`removed=1`)的会话取消隐藏,
    /// 并把 `removed_at_ms` 抬到该消息时间(吸收静默水位)——使同一条静默消息日后即便经
    /// "看不到 clientSilent"的 REST 重拉也不会复活。缺省 `false`(旧推送无此字段 → 行为不变)。
    pub silent: bool,
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
                      removed, removed_at_ms, muted, muted_at_ms, \
                      last_message_sort_key_ms, gmt_modified_time, opened_at_ms, \
                      local_last_sent_at_ms \
                    FROM hub_conversation_recents \
                    WHERE employee_id = ?1 AND removed = 0 \
                      AND (?2 IS NULL OR wecom_account_id = ?2) \
                    ORDER BY \
                      pinned DESC, \
                      pinned_at_ms DESC, \
                      MAX(last_message_time_ms, local_draft_at_ms, opened_at_ms, local_last_sent_at_ms) DESC, \
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

    /// 统计当前 scope 的接待会话行数(已过滤 removed)。WHERE 与 `list_top` 完全一致,
    /// 供水位预填判定"本地是否已达目标深度"。`account_filter=None` 统计全部账号。
    pub async fn count(
        &self,
        employee_id: &str,
        account_filter: Option<String>,
    ) -> Result<usize, StateError> {
        let employee_id = employee_id.to_string();
        let conn = self.pool.pool().get().await?;
        let n = conn
            .interact(move |c| -> Result<i64, StateError> {
                let n: i64 = c.query_row(
                    "SELECT COUNT(*) FROM hub_conversation_recents \
                     WHERE employee_id = ?1 AND removed = 0 \
                       AND (?2 IS NULL OR wecom_account_id = ?2)",
                    rusqlite::params![employee_id, account_filter],
                    |r| r.get(0),
                )?;
                Ok(n)
            })
            .await??;
        Ok(n as usize)
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

    /// `SESSION_SUMMARY_UPSERT` 分字段部分更新(规范 §9.3「用服务端 sessionSummary 覆盖本地同字段」)。
    ///
    /// 只 UPDATE 摘要列(last_*/unread/has_unread/sort_key/gmt + updated_at)与**非空**的可选资料列
    /// (external_name/external_avatar/wecom_alias);摘要事件不携带的展示字段
    /// (`wecom_name/wecom_account/external_mobile/external_user_id`)以及全部本地列
    /// (pinned/muted/draft)一律保留不动 —— 故绝不会把这些字段写空。
    ///
    /// 版本门同 [`upsert_remote_in_tx`]:仅当 incoming 复合版本 `(sort_key_ms, gmt_modified)` ≥ stored
    /// 才覆盖,stale 事件 → 0 行受影响。`removed` 在新消息时间晚于移除时间时自动恢复。
    /// 返回是否真正改动了一行(`false` = 行不存在 / 跨员工 / 被版本门拒绝的 stale 事件)。
    ///
    /// **同消息守卫**:出站消息的 CONFIRMED 摘要 sortKey 可能比 PENDING 小(CONFIRMED 用真实平台
    /// 发送时间、早于本地 pending 创建时间)。版本门 OR 链尾追加
    /// `?1 <> '' AND ?1 = last_local_message_id`:同一条消息(同 lastLocalMessageId)的后续状态恒可
    /// 进入,由既有 `last_send_status` 不倒退 CASE 定终值,修掉发送状态卡"发送中"。不同消息的过期
    /// 小 sortKey 仍被拒(守卫只对同 id 生效)。`time_ms`/`sort_key_ms` 取 MAX 防同消息小 sortKey
    /// 拉低展示时间/版本键(正常 `?>stored` 时 MAX 即 `?`,无行为变化)。
    ///
    /// `last_send_status` 按文档 §4 不倒退合并:
    /// - current ≤ 1(无状态/待发送) → 接受任意 incoming
    /// - current = 2(发送中) → 仅接受 3/4(忽略 incoming=1)
    /// - current = 4(失败) → 仅接受 3;忽略 1/2
    /// - current = 3(成功,终态) → 忽略 1/2/4,只接受 3(幂等)
    ///
    /// **已读水位门**(V31):`unread_count`/`has_unread` 仅当 incoming 消息时间 > `read_at_ms`
    /// 才覆写。markRead 后,同版本重放与同消息守卫分支虽可进门更新其余摘要列,但不得把已清零的
    /// 未读回灌(防"切出会话后红标瞬时复活");多端已读同步走 MARK_READ 事件 → [`Self::clear_unread`],
    /// 不经此门,不受影响。
    pub async fn apply_summary(&self, s: RecentSessionSummary) -> Result<bool, StateError> {
        let now = now_unix_ms();
        let conn = self.pool.pool().get().await?;
        let changed = conn
            .interact(move |c| -> Result<bool, StateError> {
                let n = c.execute(
                    "UPDATE hub_conversation_recents SET \
                       last_local_message_id    = ?1, \
                       last_message_type        = ?2, \
                       last_message_direction   = ?3, \
                       last_send_status = CASE \
                           WHEN last_send_status <= 1 THEN ?4 \
                           WHEN last_send_status = 2 AND ?4 IN (3, 4) THEN ?4 \
                           WHEN last_send_status = 4 AND ?4 = 3 THEN 3 \
                           ELSE last_send_status \
                       END, \
                       last_message_summary     = ?5, \
                       last_message_time_ms     = MAX(last_message_time_ms, ?6), \
                       unread_count = CASE WHEN ?6 > read_at_ms THEN ?7 ELSE unread_count END, \
                       has_unread   = CASE WHEN ?6 > read_at_ms THEN ?8 ELSE has_unread   END, \
                       last_message_sort_key_ms = MAX(last_message_sort_key_ms, ?9), \
                       gmt_modified_time        = ?10, \
                       updated_at_ms            = ?11, \
                       external_name   = CASE WHEN ?12 <> '' THEN ?12 ELSE external_name   END, \
                       external_avatar = CASE WHEN ?13 <> '' THEN ?13 ELSE external_avatar END, \
                       wecom_alias     = CASE WHEN ?14 <> '' THEN ?14 ELSE wecom_alias     END, \
                       removed = CASE \
                           WHEN ?17 = 1 THEN removed \
                           WHEN ?6 > removed_at_ms THEN 0 ELSE removed END, \
                       removed_at_ms = CASE \
                           WHEN ?17 = 1 THEN (CASE WHEN removed = 1 AND ?6 > removed_at_ms THEN ?6 ELSE removed_at_ms END) \
                           WHEN ?6 > removed_at_ms THEN 0 ELSE removed_at_ms END \
                     WHERE employee_id = ?15 AND conversation_id = ?16 \
                       AND ( ?9 > last_message_sort_key_ms \
                             OR (?9 = last_message_sort_key_ms \
                                 AND (?10 = '' OR ?10 >= gmt_modified_time)) \
                             OR (?1 <> '' AND ?1 = last_local_message_id) )",
                    rusqlite::params![
                        s.last_local_message_id,
                        s.last_message_type as i64,
                        s.last_message_direction as i64,
                        s.last_send_status as i64,
                        s.last_message_summary,
                        s.last_message_time_ms,
                        s.unread_count,
                        s.has_unread as i64,
                        s.last_message_sort_key_ms,
                        s.gmt_modified_time,
                        now,
                        s.external_name,
                        s.external_avatar,
                        s.wecom_alias,
                        s.employee_id,
                        s.conversation_id,
                        s.silent as i64,
                    ],
                )?;
                Ok(n > 0)
            })
            .await??;
        Ok(changed)
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

    /// 按 (账号, 客户) 查本地接待行的 `conversation_id`;无则 `None`。
    /// 用于 `open_friend_conversation` 短路:本地已有记录时直接拿真实会话 ID,免一次网络往返
    /// (含已被软删除 `removed=1` 的行 —— "打开"语义随后会 un-remove 它,故此处不按 removed 过滤)。
    pub async fn find_conversation_id(
        &self,
        employee_id: &str,
        wecom_account_id: &str,
        external_user_id: &str,
    ) -> Result<Option<String>, StateError> {
        let employee_id = employee_id.to_string();
        let account = wecom_account_id.to_string();
        let user = external_user_id.to_string();
        let conn = self.pool.pool().get().await?;
        let id = conn
            .interact(move |c| -> Result<Option<String>, StateError> {
                let res: rusqlite::Result<String> = c.query_row(
                    "SELECT conversation_id FROM hub_conversation_recents \
                     WHERE employee_id = ?1 AND wecom_account_id = ?2 AND external_user_id = ?3 \
                     LIMIT 1",
                    rusqlite::params![employee_id, account, user],
                    |r| r.get(0),
                );
                match res {
                    Ok(v) => Ok(Some(v)),
                    Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                    Err(e) => Err(e.into()),
                }
            })
            .await??;
        Ok(id)
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

    /// 消息免打扰 / 取消免打扰。`muted=true` 时 `muted_at_ms = now`,`false` 时置 0。
    /// 行不存在或 employee_id 不匹配时 no-op(用户只能操作自己 employee 名下的会话)。
    /// muted 不进 WHERE/ORDER BY,只影响前端渲染;远端 UPSERT 永不触碰,自动保留。
    pub async fn set_muted(
        &self,
        employee_id: &str,
        conversation_id: &str,
        muted: bool,
    ) -> Result<(), StateError> {
        let employee_id = employee_id.to_string();
        let id = conversation_id.to_string();
        let now = now_unix_ms();
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            c.execute(
                "UPDATE hub_conversation_recents \
                   SET muted = ?1, muted_at_ms = ?2 \
                 WHERE employee_id = ?3 AND conversation_id = ?4",
                rusqlite::params![muted as i64, if muted { now } else { 0 }, employee_id, id],
            )?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// 用户主动"打开会话"(从搜索点开客户):写 `opened_at_ms = ts_ms`,把该行提到非置顶区顶部。
    /// 独立 UPDATE(始终生效,不受远端列版本门影响,类似 [`Self::set_pinned`]);employee 过滤防越权。
    /// 行不存在时 no-op —— 调用方需先 upsert(空白行 / 远端记录)再 set_opened。
    pub async fn set_opened(
        &self,
        employee_id: &str,
        conversation_id: &str,
        ts_ms: i64,
    ) -> Result<(), StateError> {
        let employee_id = employee_id.to_string();
        let id = conversation_id.to_string();
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            c.execute(
                "UPDATE hub_conversation_recents \
                   SET opened_at_ms = ?1 \
                 WHERE employee_id = ?2 AND conversation_id = ?3",
                rusqlite::params![ts_ms, employee_id, id],
            )?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// 标记会话已读:本地乐观清零未读列(`unread_count=0`、`has_unread=0`),并把已读水位
    /// `read_at_ms` 抬到行内 `last_message_time_ms`(V31,服务端消息时间,不用客户端时钟)。
    /// employee_id 校验,行不存在或跨员工时 no-op。
    ///
    /// 注意 `unread_count`/`has_unread` 是**远端权威列**(不同于 pinned/muted 的纯本地列):
    /// 真正的清除以远端 markRead 接口已成功为前提,本地直写仅为即时 UI 反馈。此后
    /// `last_message_time_ms <= read_at_ms` 的迟到/重放事件不得回灌未读
    /// (见 [`upsert_remote_in_tx`] / [`Self::apply_summary`] 的水位门),根治"切出会话后
    /// 列表红标瞬时复活";时间更新的新消息照常抬未读。
    pub async fn clear_unread(
        &self,
        employee_id: &str,
        conversation_id: &str,
    ) -> Result<(), StateError> {
        let employee_id = employee_id.to_string();
        let id = conversation_id.to_string();
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            c.execute(
                "UPDATE hub_conversation_recents \
                   SET unread_count = 0, has_unread = 0, \
                       read_at_ms = MAX(read_at_ms, last_message_time_ms) \
                 WHERE employee_id = ?1 AND conversation_id = ?2",
                rusqlite::params![employee_id, id],
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

    /// 发送时乐观本地写:预览文案 + 类型/方向 + 本地置顶信号。只更本地可见列,
    /// **不动 last_message_sort_key_ms(版本键)与 last_send_status** —— 由随后的 SESSION_SUMMARY
    /// push(版本门)权威对齐。返回是否命中一行(会话不在 recents 则 no-op)。
    ///
    /// 额外用 `MAX(last_message_time_ms, now_ms)` 抬**显示时间**:列表行右上角时间取
    /// `MAX(last_message_time_ms, local_draft_at_ms)`(前端),不含 `local_last_sent_at_ms`,故
    /// 不补这一列时,「发出但尚无服务端 SESSION_SUMMARY 确认」的会话 `last_message_time_ms` 恒 0 →
    /// 时间空白。此列是显示时间、非版本/水位键,写它不影响 `apply_summary` 的状态收敛;`MAX` 防
    /// 本地 now 倒拉已有的更新服务端时间。
    ///
    /// `last_message_summary` 是乐观覆盖远端列;因不动 `last_message_sort_key_ms`,随后 PENDING 摘要
    /// (sortKey_ms 更大)必过版本门并以权威值覆盖(同文案→无闪),符合"本地动预览、不抬版本键"原则。
    /// `last_message_direction` 取 push 原始出站值(出站=1,不经 to_local_direction 转换),
    /// 避免与权威摘要到达后方向前缀闪变。SQL 校验 employee_id,跨员工 no-op。
    pub async fn mark_local_sent(
        &self,
        employee_id: &str,
        conversation_id: &str,
        last_message_summary: &str,
        last_message_type: i32,
        last_message_direction: i32,
        now_ms: i64,
    ) -> Result<bool, StateError> {
        let employee_id = employee_id.to_string();
        let id = conversation_id.to_string();
        let summary = last_message_summary.to_string();
        let conn = self.pool.pool().get().await?;
        let changed = conn
            .interact(move |c| -> Result<bool, StateError> {
                let n = c.execute(
                    "UPDATE hub_conversation_recents SET \
                       last_message_summary   = ?1, \
                       last_message_type      = ?2, \
                       last_message_direction = ?3, \
                       local_last_sent_at_ms  = ?4, \
                       last_message_time_ms   = MAX(last_message_time_ms, ?4) \
                     WHERE employee_id = ?5 AND conversation_id = ?6",
                    rusqlite::params![
                        summary,
                        last_message_type as i64,
                        last_message_direction as i64,
                        now_ms,
                        employee_id,
                        id,
                    ],
                )?;
                Ok(n > 0)
            })
            .await??;
        Ok(changed)
    }

    /// 出站发送失败的接待列表乐观写:与 mark_local_sent 同款只动展示列,额外写 last_send_status=4。
    /// **不动 last_message_sort_key_ms**(水位/版本键),故随后服务端 SESSION_SUMMARY 经 apply_summary
    /// 不倒退 CASE(4→3 允许)可把状态收敛回正。会话不在 recents 则 no-op(返 false)。
    /// 同 mark_local_sent 抬显示时间 `last_message_time_ms = MAX(.., now_ms)`:失败气泡若是该会话
    /// 唯一活动(无服务端确认消息),否则 `last_message_time_ms` 恒 0 → 列表行时间空白。
    pub async fn mark_local_failed(
        &self,
        employee_id: &str,
        conversation_id: &str,
        last_message_summary: &str,
        last_message_type: i32,
        last_message_direction: i32,
        now_ms: i64,
    ) -> Result<bool, StateError> {
        let employee_id = employee_id.to_string();
        let id = conversation_id.to_string();
        let summary = last_message_summary.to_string();
        let conn = self.pool.pool().get().await?;
        let changed = conn
            .interact(move |c| -> Result<bool, StateError> {
                let n = c.execute(
                    "UPDATE hub_conversation_recents SET \
                       last_message_summary   = ?1, \
                       last_message_type      = ?2, \
                       last_message_direction = ?3, \
                       local_last_sent_at_ms  = ?4, \
                       last_send_status       = 4, \
                       last_message_time_ms   = MAX(last_message_time_ms, ?4) \
                     WHERE employee_id = ?5 AND conversation_id = ?6",
                    rusqlite::params![
                        summary,
                        last_message_type as i64,
                        last_message_direction as i64,
                        now_ms,
                        employee_id,
                        id,
                    ],
                )?;
                Ok(n > 0)
            })
            .await??;
        Ok(changed)
    }

    /// 读单会话远端权威"最新位置"(LWW 主版本 epoch-ms)。不过滤 `removed`,行不存在返 None。
    ///
    /// 供消息页会话水位门用:与消息缓存窗口 `newest_message_time_ms` 比较,够新就跳过 reconcile。
    /// 不过滤 `removed`(软移除后重开仍要有水位;`list_top` 才负责隐藏移除行)。
    pub async fn latest_sort_key_ms(
        &self,
        employee_id: &str,
        conversation_id: &str,
    ) -> Result<Option<i64>, StateError> {
        let employee_id = employee_id.to_string();
        let id = conversation_id.to_string();
        let conn = self.pool.pool().get().await?;
        let v = conn
            .interact(move |c| -> Result<Option<i64>, StateError> {
                let res = c.query_row(
                    "SELECT last_message_sort_key_ms FROM hub_conversation_recents \
                     WHERE employee_id = ?1 AND conversation_id = ?2",
                    rusqlite::params![employee_id, id],
                    |r| r.get::<_, i64>(0),
                );
                match res {
                    Ok(ms) => Ok(Some(ms)),
                    Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                    Err(e) => Err(e.into()),
                }
            })
            .await??;
        Ok(v)
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
                              ORDER BY MAX(last_message_time_ms, local_draft_at_ms, opened_at_ms, local_last_sent_at_ms) DESC \
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
                   ORDER BY MAX(last_message_time_ms, local_draft_at_ms, opened_at_ms, local_last_sent_at_ms) DESC \
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

    /// 清空指定员工的本地缓存(登出 / 切员工时调)。
    /// V7 起按 employee_id 精确 DELETE,不再 TRUNCATE 整表 —— 异常退出后下次登录另一
    /// employee 也不会污染对方数据(读路径 WHERE employee_id 也作兜底)。
    pub async fn clear_for_employee(&self, employee_id: &str) -> Result<(), StateError> {
        let employee_id = employee_id.to_string();
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            c.execute(
                "DELETE FROM hub_conversation_recents WHERE employee_id = ?1",
                rusqlite::params![employee_id],
            )?;
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
        muted: row.get::<_, i64>(25)? != 0,
        muted_at_ms: row.get(26)?,
        last_message_sort_key_ms: row.get(27)?,
        gmt_modified_time: row.get(28)?,
        opened_at_ms: row.get(29)?,
        local_last_sent_at_ms: row.get(30)?,
    })
}

fn upsert_remote_in_tx(
    c: &rusqlite::Connection,
    r: &RecentSessionRemote,
    now_ms: i64,
) -> rusqlite::Result<usize> {
    // version-guard:仅当 incoming 复合版本 (sort_key_ms, gmt_modified_time) ≥ stored 才覆盖
    // 远端列。冷 cursor 旧页(低版本)在实时事件(高版本)之后到达时,WHERE 为假 → DO UPDATE
    // 整体跳过(stale 页被丢弃),修掉"旧页无条件覆盖新行"的 bug。新行(无冲突)照常 INSERT。
    // 已读水位门(V31):unread_count/has_unread 仅当 incoming 消息时间 > read_at_ms 才覆写,
    // 同版本(= sortKey)重放不得把 markRead 已清零的未读回灌(防红标瞬时复活)。
    c.execute(
        "INSERT INTO hub_conversation_recents ( \
           conversation_id, wecom_account_id, employee_id, wecom_name, wecom_account, wecom_alias, \
           external_user_id, external_name, external_avatar, external_mobile, \
           last_local_message_id, last_message_type, last_message_direction, \
           last_send_status, last_message_summary, last_message_time_ms, \
           unread_count, has_unread, updated_at_ms, \
           last_message_sort_key_ms, gmt_modified_time \
         ) VALUES ( \
           ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21 \
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
           unread_count = CASE WHEN excluded.last_message_time_ms > read_at_ms \
                               THEN excluded.unread_count ELSE unread_count END, \
           has_unread   = CASE WHEN excluded.last_message_time_ms > read_at_ms \
                               THEN excluded.has_unread ELSE has_unread END, \
           updated_at_ms          = excluded.updated_at_ms, \
           last_message_sort_key_ms = excluded.last_message_sort_key_ms, \
           gmt_modified_time        = excluded.gmt_modified_time, \
           removed                = CASE \
               WHEN excluded.last_message_time_ms > removed_at_ms THEN 0 \
               ELSE removed END, \
           removed_at_ms          = CASE \
               WHEN excluded.last_message_time_ms > removed_at_ms THEN 0 \
               ELSE removed_at_ms END \
         WHERE excluded.last_message_sort_key_ms > last_message_sort_key_ms \
            OR (excluded.last_message_sort_key_ms = last_message_sort_key_ms \
                AND excluded.gmt_modified_time >= gmt_modified_time)",
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
            r.last_message_sort_key_ms,
            r.gmt_modified_time,
        ],
    )
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
            // 版本默认与 ts_ms 对齐(测试里 ts_ms 越大版本越新)。
            last_message_sort_key_ms: ts_ms,
            gmt_modified_time: String::new(),
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
    async fn find_conversation_id_by_friend() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        // sample_remote 的 external_user_id 默认 = format!("ext_{conv}")。
        store
            .upsert_remote_one(sample_remote("cv-9", "wa-1", 100, 0))
            .await
            .unwrap();
        // 命中:按 (employee, account, user) 拿到真实 conversation_id
        assert_eq!(
            store
                .find_conversation_id(E, "wa-1", "ext_cv-9")
                .await
                .unwrap()
                .as_deref(),
            Some("cv-9"),
        );
        // 未命中客户 → None
        assert_eq!(
            store
                .find_conversation_id(E, "wa-1", "ext_x")
                .await
                .unwrap(),
            None,
        );
        // 跨员工隔离 → None
        assert_eq!(
            store
                .find_conversation_id("other-emp", "wa-1", "ext_cv-9")
                .await
                .unwrap(),
            None,
        );
        // 已软删除的行仍可被找到("打开"语义随后 un-remove 它,故不按 removed 过滤)
        store.set_removed(E, "cv-9", true).await.unwrap();
        assert_eq!(
            store
                .find_conversation_id(E, "wa-1", "ext_cv-9")
                .await
                .unwrap()
                .as_deref(),
            Some("cv-9"),
        );
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
    async fn count_empty_returns_zero() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        assert_eq!(store.count(E, None).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn count_all_accounts() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        store
            .upsert_remote_many(&[
                sample_remote("c1", "wa-1", 100, 0),
                sample_remote("c2", "wa-2", 200, 0),
            ])
            .await
            .unwrap();
        assert_eq!(store.count(E, None).await.unwrap(), 2);
    }

    #[tokio::test]
    async fn count_filters_by_account() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        store
            .upsert_remote_many(&[
                sample_remote("c1", "wa-1", 100, 0),
                sample_remote("c2", "wa-2", 200, 0),
                sample_remote("c3", "wa-1", 300, 0),
            ])
            .await
            .unwrap();
        assert_eq!(store.count(E, Some("wa-1".into())).await.unwrap(), 2);
        assert_eq!(store.count(E, Some("wa-2".into())).await.unwrap(), 1);
    }

    #[tokio::test]
    async fn count_excludes_removed() {
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
        assert_eq!(store.count(E, None).await.unwrap(), 1);
    }

    #[tokio::test]
    async fn count_isolates_by_employee() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        store
            .upsert_remote_many(&[
                sample_remote_for("u-A", "c1", "wa-1", 100, 0),
                sample_remote_for("u-B", "c2", "wa-2", 200, 0),
            ])
            .await
            .unwrap();
        assert_eq!(store.count("u-A", None).await.unwrap(), 1);
        assert_eq!(store.count("u-B", None).await.unwrap(), 1);
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
        store.set_draft(E, "c1", " ").await.unwrap();
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

    fn sample_summary(conv: &str, sort_ms: i64, unread: i64) -> RecentSessionSummary {
        RecentSessionSummary {
            conversation_id: conv.into(),
            employee_id: E.into(),
            last_local_message_id: "LM_new".into(),
            last_message_type: 1,
            last_message_direction: 2,
            last_send_status: 0,
            last_message_summary: "新的客户消息".into(),
            last_message_time_ms: sort_ms,
            unread_count: unread,
            has_unread: unread > 0,
            last_message_sort_key_ms: sort_ms,
            gmt_modified_time: String::new(),
            // 摘要事件通常不带资料字段(资料变化时才返回)。
            external_name: String::new(),
            external_avatar: String::new(),
            wecom_alias: String::new(),
            silent: false,
        }
    }

    #[tokio::test]
    async fn apply_summary_updates_summary_but_preserves_display_fields() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        // 预置一行(自带 wecom_name / external_mobile 等展示字段)。
        store
            .upsert_remote_many(&[sample_remote("c1", "wa-1", 100, 0)])
            .await
            .unwrap();
        // 用户本地置顶 —— 也必须被部分更新保留。
        store.set_pinned(E, "c1", true).await.unwrap();

        let changed = store
            .apply_summary(sample_summary("c1", 999, 5))
            .await
            .unwrap();
        assert!(changed, "更高版本摘要应改动一行");

        let got = store.list_top(E, None, 10).await.unwrap();
        assert_eq!(got.len(), 1);
        let r = &got[0];
        // 摘要列被覆盖。
        assert_eq!(r.last_message_summary, "新的客户消息");
        assert_eq!(r.last_message_time_ms, 999);
        assert_eq!(r.unread_count, 5);
        assert_eq!(r.last_message_sort_key_ms, 999);
        // 展示字段(摘要事件不携带)必须保留,绝不被写空。
        assert_eq!(r.wecom_name, "客服-A", "wecom_name 必须保留");
        assert_eq!(r.external_mobile, "138****0000", "external_mobile 必须保留");
        assert_eq!(r.external_user_id, "ext_c1", "external_user_id 必须保留");
        assert_eq!(r.external_name, "外部-c1", "缺省 externalName 不应清空本地");
        // 本地列保留。
        assert!(r.pinned, "pinned 必须在部分更新后保留");
    }

    #[tokio::test]
    async fn apply_summary_version_guard_rejects_stale() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        store
            .upsert_remote_many(&[sample_remote("c1", "wa-1", 500, 3)])
            .await
            .unwrap();
        // 较旧版本(sort_ms=200 < 500)→ 应被版本门拒绝,0 行改动。
        let changed = store
            .apply_summary(sample_summary("c1", 200, 9))
            .await
            .unwrap();
        assert!(!changed, "stale 摘要应被版本门拒绝");
        let got = store.list_top(E, None, 10).await.unwrap();
        assert_eq!(got[0].last_message_time_ms, 500, "stale 不得覆盖");
        assert_eq!(got[0].unread_count, 3, "stale 不得覆盖未读");
    }

    #[tokio::test]
    async fn apply_summary_same_sortkey_empty_gmt_still_applies() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        // 预置一行:sort_key_ms=500,带非空 gmt(模拟此前由带 gmt 的源写入)。
        let mut seed = sample_remote("c1", "wa-1", 500, 3);
        seed.gmt_modified_time = "2026-05-20 10:00:00".into();
        store.upsert_remote_many(&[seed]).await.unwrap();
        // 摘要事件:同 sort_key_ms=500,但不带 gmt(空串)。旧逻辑下 "" >= "2026-..." 为
        // 假会误拒;修复后空 gmt 视为放行,同版本摘要刷新得以应用。
        let changed = store
            .apply_summary(sample_summary("c1", 500, 7))
            .await
            .unwrap();
        assert!(changed, "同 sort_key + 空 gmt 的摘要应被接受,不得误拒");
        let got = store.list_top(E, None, 10).await.unwrap();
        assert_eq!(got[0].unread_count, 7, "摘要未读应已更新");
        assert_eq!(got[0].last_message_summary, "新的客户消息");
    }

    // ─── 已读水位:markRead 后迟到/重放事件不得回灌未读(防列表红标瞬时复活)──────
    // 场景:切出会话时 markRead → clear_unread 清零;此后同版本(=sortKey)或同消息守卫
    // 分支的迟到/重放摘要若仍带旧 unread_count,会把红标短暂复活,直到更新的事件再清。
    // 修复:clear_unread 把 read_at_ms 抬到行内 last_message_time_ms(服务端时间,不用
    // 客户端时钟);未读列仅当 incoming 消息时间 > read_at_ms 才接受覆写。

    #[tokio::test]
    async fn clear_unread_blocks_same_version_summary_replay() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        store
            .upsert_remote_many(&[sample_remote("c1", "wa-1", 500, 3)])
            .await
            .unwrap();
        store.clear_unread(E, "c1").await.unwrap();
        // 同版本(=sortKey 500,空 gmt 放行)的迟到摘要重放:其余摘要列照常收敛,
        // 未读列必须被已读水位挡住。
        store
            .apply_summary(sample_summary("c1", 500, 3))
            .await
            .unwrap();
        let got = store.list_top(E, None, 10).await.unwrap();
        assert_eq!(got[0].unread_count, 0, "同版本摘要重放不得回灌未读");
        assert!(!got[0].has_unread, "has_unread 同样不得回灌");
    }

    #[tokio::test]
    async fn clear_unread_blocks_same_message_guard_replay() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        store
            .upsert_remote_many(&[sample_remote("c1", "wa-1", 500, 3)])
            .await
            .unwrap();
        store.clear_unread(E, "c1").await.unwrap();
        // 同 lastLocalMessageId(sample_remote 默认 "msg_c1")走「同消息守卫」恒过版本门
        // (即便 sortKey 更小),未读列必须仍被已读水位挡住。
        let mut s = sample_summary("c1", 400, 3);
        s.last_local_message_id = "msg_c1".into();
        store.apply_summary(s).await.unwrap();
        let got = store.list_top(E, None, 10).await.unwrap();
        assert_eq!(got[0].unread_count, 0, "同消息守卫分支不得回灌未读");
        assert!(!got[0].has_unread);
    }

    #[tokio::test]
    async fn clear_unread_blocks_same_version_remote_upsert_replay() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        store
            .upsert_remote_many(&[sample_remote("c1", "wa-1", 500, 3)])
            .await
            .unwrap();
        store.clear_unread(E, "c1").await.unwrap();
        // 同版本整行重放(冷 cursor 页 / 重复事件经 upsert_remote 路径):
        // 版本门(= sortKey,gmt "">="")放行整行覆盖,未读列必须被已读水位挡住。
        store
            .upsert_remote_one(sample_remote("c1", "wa-1", 500, 3))
            .await
            .unwrap();
        let got = store.list_top(E, None, 10).await.unwrap();
        assert_eq!(got[0].unread_count, 0, "同版本 UPSERT 重放不得回灌未读");
        assert!(!got[0].has_unread);
    }

    #[tokio::test]
    async fn new_message_after_clear_unread_still_raises_unread() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        store
            .upsert_remote_many(&[sample_remote("c1", "wa-1", 500, 3)])
            .await
            .unwrap();
        store.clear_unread(E, "c1").await.unwrap();
        // 真正的新消息(时间 > 已读水位)照常抬未读 —— 水位只挡"旧消息的重放",不挡新消息。
        store
            .apply_summary(sample_summary("c1", 600, 1))
            .await
            .unwrap();
        let got = store.list_top(E, None, 10).await.unwrap();
        assert_eq!(got[0].unread_count, 1, "新消息应正常抬未读");
        assert!(got[0].has_unread);
        // upsert_remote 路径同样放行新消息。
        store
            .upsert_remote_one(sample_remote("c1", "wa-1", 700, 2))
            .await
            .unwrap();
        let got = store.list_top(E, None, 10).await.unwrap();
        assert_eq!(got[0].unread_count, 2, "新消息经 UPSERT 路径也应抬未读");
    }

    #[tokio::test]
    async fn apply_summary_overwrites_profile_only_when_present() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        store
            .upsert_remote_many(&[sample_remote("c1", "wa-1", 100, 0)])
            .await
            .unwrap();
        // 资料变化:sessionSummary 带上新的 externalName / wecomAlias。
        let mut s = sample_summary("c1", 999, 0);
        s.external_name = "改名后的客户".into();
        s.wecom_alias = "新别名".into();
        store.apply_summary(s).await.unwrap();
        let got = store.list_top(E, None, 10).await.unwrap();
        assert_eq!(got[0].external_name, "改名后的客户", "非空资料字段应覆盖");
        assert_eq!(got[0].wecom_alias, "新别名");
        // external_avatar 仍为空串(摘要没带,本地原本也空)。
        assert_eq!(got[0].external_avatar, "");
    }

    #[tokio::test]
    async fn apply_summary_no_row_returns_false() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        // 行不存在 → false(applier 据此走 fallback)。
        let changed = store
            .apply_summary(sample_summary("nope", 999, 1))
            .await
            .unwrap();
        assert!(!changed);
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
        store.set_draft(E, "c1", " ").await.unwrap();
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
        store.trim(E, 2, 2).await.unwrap();
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
        store.trim("u-A", 1, 1).await.unwrap();
        let a = store.list_top("u-A", None, 10).await.unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].conversation_id, "a2");
        let b = store.list_top("u-B", None, 10).await.unwrap();
        assert_eq!(b.len(), 2, "trim must not affect other employee");
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

    // ─── 复合版本 version-guard ─────────────────────────────────────────────

    /// 冷 cursor 旧页(低 sort_key_ms)在实时事件(高版本)之后到达 → 必须被丢弃,
    /// 不能覆盖更新的远端列。这是 version-guard 修的核心 bug。
    #[tokio::test]
    async fn version_guard_discards_stale_cold_page() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        store
            .upsert_remote_many(&[sample_remote("c1", "wa-1", 1000, 0)])
            .await
            .unwrap();
        // 实时事件:更高版本 + 新内容
        let mut fresh = sample_remote("c1", "wa-1", 2000, 3);
        fresh.last_message_summary = "fresh".into();
        store.upsert_remote_one(fresh).await.unwrap();
        // 冷 cursor 旧页:更低版本 + 陈旧内容,晚到
        let mut stale = sample_remote("c1", "wa-1", 1000, 0);
        stale.last_message_summary = "stale-cold-page".into();
        store.upsert_remote_one(stale).await.unwrap();
        let got = store.list_top(E, None, 10).await.unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(
            got[0].last_message_time_ms, 2000,
            "fresh remote cols must survive stale page"
        );
        assert_eq!(got[0].last_message_summary, "fresh");
        assert_eq!(got[0].unread_count, 3);
    }

    /// 同 sort_key_ms 时由 gmt_modified_time 决胜:更新的 gmt 覆盖,更旧的 gmt 丢弃。
    #[tokio::test]
    async fn version_guard_gmt_tiebreak() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        let mut a = sample_remote("c1", "wa-1", 1000, 0);
        a.gmt_modified_time = "2026-05-18 10:00:00".into();
        a.last_message_summary = "v1".into();
        store.upsert_remote_one(a).await.unwrap();
        // 同 sortKey,gmt 更新 → 覆盖
        let mut b = sample_remote("c1", "wa-1", 1000, 0);
        b.gmt_modified_time = "2026-05-18 10:05:00".into();
        b.last_message_summary = "v2".into();
        store.upsert_remote_one(b).await.unwrap();
        assert_eq!(
            store.list_top(E, None, 10).await.unwrap()[0].last_message_summary,
            "v2"
        );
        // 同 sortKey,gmt 更旧 → 丢弃
        let mut c = sample_remote("c1", "wa-1", 1000, 0);
        c.gmt_modified_time = "2026-05-18 09:00:00".into();
        c.last_message_summary = "stale".into();
        store.upsert_remote_one(c).await.unwrap();
        assert_eq!(
            store.list_top(E, None, 10).await.unwrap()[0].last_message_summary,
            "v2",
            "older gmt at same sortKey must be discarded"
        );
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

    // ─── 静默消息不复活被软删除会话(apply_summary 静默感知)──────────────────
    #[tokio::test]
    async fn apply_summary_silent_does_not_unremove_soft_deleted() {
        // 先删再静默:被软删除的会话收到静默 SESSION_SUMMARY_UPSERT,绝不取消隐藏;
        // 但接待数据照常更新(水位推进)。
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        store
            .upsert_remote_many(&[sample_remote("c1", "wa-1", 100, 0)])
            .await
            .unwrap();
        store.set_removed(E, "c1", true).await.unwrap();
        assert!(
            store.list_top(E, None, 10).await.unwrap().is_empty(),
            "软删除后应从 list_top 消失"
        );
        // 静默消息(明显晚于 removed_at_ms)
        let future_ts = now_unix_ms() + 60_000;
        let mut s = sample_summary("c1", future_ts, 0);
        s.silent = true;
        let changed = store.apply_summary(s).await.unwrap();
        assert!(changed, "静默消息仍应更新接待数据(返回 changed)");
        assert!(
            store.list_top(E, None, 10).await.unwrap().is_empty(),
            "静默消息不得复活被删会话"
        );
        // 接待数据照常更新:水位推进到该消息(读隐藏行,latest_sort_key_ms 不过滤 removed)。
        assert_eq!(
            store.latest_sort_key_ms(E, "c1").await.unwrap(),
            Some(future_ts),
            "静默消息应更新摘要水位(数据仍维护)"
        );
    }

    #[tokio::test]
    async fn apply_summary_silent_bumps_removed_at_ms_blocking_blind_repull() {
        // 静默把 removed_at_ms 抬到消息时间 → 同一条消息日后经"看不到 clientSilent"的 REST 重拉
        // (此处用同 ts 的非静默 apply 模拟)也不会复活。
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        store
            .upsert_remote_many(&[sample_remote("c1", "wa-1", 100, 0)])
            .await
            .unwrap();
        store.set_removed(E, "c1", true).await.unwrap();
        let silent_ts = now_unix_ms() + 60_000;
        let mut s = sample_summary("c1", silent_ts, 0);
        s.silent = true;
        store.apply_summary(s).await.unwrap();
        // 模拟 silence-blind 重拉同一条(非静默、同 ts)
        let blind = sample_summary("c1", silent_ts, 0); // silent=false
        store.apply_summary(blind).await.unwrap();
        assert!(
            store.list_top(E, None, 10).await.unwrap().is_empty(),
            "removed_at_ms 已抬到静默消息时间,同 ts 的 silence-blind 重拉不得复活"
        );
    }

    #[tokio::test]
    async fn apply_summary_nonsilent_newer_still_unremoves_after_silent() {
        // 回归:真正更新的非静默消息(严格晚于静默水位)仍应复活会话。
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        store
            .upsert_remote_many(&[sample_remote("c1", "wa-1", 100, 0)])
            .await
            .unwrap();
        store.set_removed(E, "c1", true).await.unwrap();
        let silent_ts = now_unix_ms() + 60_000;
        let mut s = sample_summary("c1", silent_ts, 0);
        s.silent = true;
        store.apply_summary(s).await.unwrap();
        // 之后来一条真正的非静默新消息(严格更晚)
        let real = sample_summary("c1", silent_ts + 1_000, 1); // silent=false
        store.apply_summary(real).await.unwrap();
        let got = store.list_top(E, None, 10).await.unwrap();
        assert_eq!(got.len(), 1, "非静默新消息应复活会话");
        assert!(!got[0].removed);
    }

    #[tokio::test]
    async fn apply_summary_silent_on_visible_row_keeps_visible() {
        // 可见会话收到静默消息:照常更新,保持可见(不误隐藏)。
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        store
            .upsert_remote_many(&[sample_remote("c1", "wa-1", 100, 0)])
            .await
            .unwrap();
        let mut s = sample_summary("c1", 999, 0);
        s.silent = true;
        store.apply_summary(s).await.unwrap();
        let got = store.list_top(E, None, 10).await.unwrap();
        assert_eq!(got.len(), 1, "可见会话收到静默消息应保持可见");
        assert!(!got[0].removed);
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

    // ─── V12: muted/muted_at_ms 行为 ────────────────────────────────────────

    #[tokio::test]
    async fn set_muted_round_trip() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        store
            .upsert_remote_many(&[sample_remote("c1", "wa-1", 100, 3)])
            .await
            .unwrap();
        store.set_muted(E, "c1", true).await.unwrap();
        let got = store.list_top(E, None, 10).await.unwrap();
        assert_eq!(got.len(), 1, "muted row still shows in list_top");
        assert!(got[0].muted);
        assert!(got[0].muted_at_ms > 0);
        // muted 不改未读量级,只影响渲染
        assert_eq!(got[0].unread_count, 3);
    }

    #[tokio::test]
    async fn set_muted_false_clears_muted_at_ms() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        store
            .upsert_remote_many(&[sample_remote("c1", "wa-1", 100, 0)])
            .await
            .unwrap();
        store.set_muted(E, "c1", true).await.unwrap();
        store.set_muted(E, "c1", false).await.unwrap();
        let got = store.list_top(E, None, 10).await.unwrap();
        assert!(!got[0].muted);
        assert_eq!(got[0].muted_at_ms, 0);
    }

    #[tokio::test]
    async fn set_muted_rejects_wrong_employee() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        store
            .upsert_remote_many(&[sample_remote("c1", "wa-1", 100, 0)])
            .await
            .unwrap();
        store.set_muted("u-other", "c1", true).await.unwrap();
        let got = store.list_top(E, None, 10).await.unwrap();
        assert!(!got[0].muted, "wrong-employee mute must not affect row");
    }

    #[tokio::test]
    async fn muted_preserved_through_remote_upsert() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        store
            .upsert_remote_many(&[sample_remote("c1", "wa-1", 100, 0)])
            .await
            .unwrap();
        store.set_muted(E, "c1", true).await.unwrap();
        // 远端事件推一条新消息;远端列覆盖,本地 muted 不被抹掉
        store
            .upsert_remote_many(&[sample_remote("c1", "wa-1", 999, 5)])
            .await
            .unwrap();
        let got = store.list_top(E, None, 10).await.unwrap();
        assert_eq!(got[0].last_message_time_ms, 999, "remote col updated");
        assert!(got[0].muted, "muted must survive remote upsert");
        assert!(got[0].muted_at_ms > 0);
    }

    // ─── V17: opened_at_ms 行为 ─────────────────────────────────────────────

    #[tokio::test]
    async fn set_opened_lifts_row_above_newer_unpinned() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        store
            .upsert_remote_many(&[
                sample_remote("c1", "wa-1", 100, 0), // 旧
                sample_remote("c2", "wa-1", 999, 0), // 新
            ])
            .await
            .unwrap();
        // 打开旧的 c1(opened_at = now,必然 > 999)→ 排到非置顶顶部
        store.set_opened(E, "c1", now_unix_ms()).await.unwrap();
        let got = store.list_top(E, None, 10).await.unwrap();
        assert_eq!(
            got[0].conversation_id, "c1",
            "opened row should lift to top"
        );
        assert!(got[0].opened_at_ms > 0);
    }

    #[tokio::test]
    async fn pinned_sorts_above_opened() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        store
            .upsert_remote_many(&[
                sample_remote("c1", "wa-1", 100, 0),
                sample_remote("c2", "wa-1", 200, 0),
            ])
            .await
            .unwrap();
        // c1 置顶;c2 打开(opened_at=now)。置顶必须仍在打开行之上。
        store.set_pinned(E, "c1", true).await.unwrap();
        store.set_opened(E, "c2", now_unix_ms()).await.unwrap();
        let got = store.list_top(E, None, 10).await.unwrap();
        assert_eq!(got[0].conversation_id, "c1", "pinned stays on top");
        assert_eq!(got[1].conversation_id, "c2", "opened row just below pinned");
    }

    #[tokio::test]
    async fn opened_preserved_through_remote_upsert() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        store
            .upsert_remote_many(&[sample_remote("c1", "wa-1", 100, 0)])
            .await
            .unwrap();
        store.set_opened(E, "c1", now_unix_ms()).await.unwrap();
        // 远端事件推一条新消息;远端列覆盖,本地 opened_at 不被抹掉。
        store
            .upsert_remote_many(&[sample_remote("c1", "wa-1", 999, 5)])
            .await
            .unwrap();
        let got = store.list_top(E, None, 10).await.unwrap();
        assert_eq!(got[0].last_message_time_ms, 999, "remote col updated");
        assert!(
            got[0].opened_at_ms > 0,
            "opened_at must survive remote upsert"
        );
    }

    #[tokio::test]
    async fn set_opened_rejects_wrong_employee() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        store
            .upsert_remote_many(&[sample_remote("c1", "wa-1", 100, 0)])
            .await
            .unwrap();
        store
            .set_opened("u-other", "c1", now_unix_ms())
            .await
            .unwrap();
        let got = store.list_top(E, None, 10).await.unwrap();
        assert_eq!(
            got[0].opened_at_ms, 0,
            "wrong-employee open must not affect row"
        );
    }

    /// 空白行(sort_key_ms=0)被打开后,真实远端记录(sort_key>0)到达仍能覆盖远端列,不被版本门挡。
    #[tokio::test]
    async fn blank_opened_row_overwritten_by_real_record() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        // 合成空白行:消息字段空、sort_key_ms=0(模拟 open_friend_conversation 的无记录路径)。
        let mut blank = sample_remote("c-blank", "wa-1", 0, 0);
        blank.last_message_summary = String::new();
        blank.last_local_message_id = String::new();
        blank.last_message_sort_key_ms = 0;
        store.upsert_remote_one(blank).await.unwrap();
        store.set_opened(E, "c-blank", now_unix_ms()).await.unwrap();
        // 真实记录(sort_key 大)到达:远端列被覆盖,opened_at 仍保留。
        let mut real = sample_remote("c-blank", "wa-1", 500, 2);
        real.last_message_summary = "真实首条".into();
        real.last_message_sort_key_ms = 500;
        store.upsert_remote_one(real).await.unwrap();
        let got = store.list_top(E, None, 10).await.unwrap();
        assert_eq!(got.len(), 1, "must be the same row (no duplicate)");
        assert_eq!(got[0].last_message_summary, "真实首条");
        assert!(got[0].opened_at_ms > 0);
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
        store.clear_for_employee("u-A").await.unwrap();
        // u-A 数据全清
        assert!(store.list_top("u-A", None, 10).await.unwrap().is_empty());
        // u-B 数据完全不动
        assert_eq!(store.list_top("u-B", None, 10).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn latest_sort_key_ms_round_trip() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        store
            .upsert_remote_many(&[sample_remote("c1", "wa-1", 12345, 0)])
            .await
            .unwrap();
        // sample_remote 把 last_message_sort_key_ms 与 ts_ms 对齐
        assert_eq!(
            store.latest_sort_key_ms(E, "c1").await.unwrap(),
            Some(12345)
        );
    }

    #[tokio::test]
    async fn latest_sort_key_ms_missing_is_none() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        assert_eq!(store.latest_sort_key_ms(E, "nope").await.unwrap(), None);
    }

    #[tokio::test]
    async fn latest_sort_key_ms_wrong_employee_is_none() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        store
            .upsert_remote_many(&[sample_remote_for("u-A", "c1", "wa-1", 500, 0)])
            .await
            .unwrap();
        assert_eq!(store.latest_sort_key_ms("u-B", "c1").await.unwrap(), None);
    }

    #[tokio::test]
    async fn latest_sort_key_ms_ignores_removed() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        store
            .upsert_remote_many(&[sample_remote("c1", "wa-1", 777, 0)])
            .await
            .unwrap();
        store.set_removed(E, "c1", true).await.unwrap();
        // 软移除后 list_top 隐藏,但水位仍可读(供重开会话水位门)
        assert!(store.list_top(E, None, 10).await.unwrap().is_empty());
        assert_eq!(store.latest_sort_key_ms(E, "c1").await.unwrap(), Some(777));
    }

    // ─── §4 发送状态不倒退 ──────────────────────────────────────────────────

    /// apply_summary 的 last_send_status 必须遵守 §4 状态机:已是终/中间态时不被 stale 事件倒退。
    ///
    /// 场景一:行当前 last_send_status=3(成功,终态) → apply_summary 送来 2(发送中) → 应保持 3。
    /// 场景二:行当前 last_send_status=4(失败) → apply_summary 送来 3(成功) → 应变 3(4→3 被允许)。
    ///
    /// 版本门放行策略:incoming sort_key_ms 与种子相等 + gmt="" → 版本门在相等 sortKey 下放行,
    /// 把判定权交给 §4 CASE 表达式。
    #[tokio::test]
    async fn apply_summary_send_status_does_not_regress() {
        // ── 场景一:3(成功) 收到 2(发送中) → 应保持 3 ─────────────────────────
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);

        // 种子行:conv=cv-1,last_send_status=3,sort_key_ms=K=1000。
        // sample_remote 默认 last_send_status=3,sort_key_ms=ts_ms。
        store
            .upsert_remote_many(&[sample_remote("cv-1", "wa-1", 1000, 0)])
            .await
            .unwrap();
        // 确认种子 send_status=3。
        let seed = store.list_top(E, None, 10).await.unwrap();
        assert_eq!(seed[0].last_send_status, 3, "种子 last_send_status 应为 3");

        // apply_summary:相同 sort_key_ms=1000,gmt="" → 版本门放行;incoming last_send_status=2。
        let mut s = sample_summary("cv-1", 1000, 0);
        s.last_send_status = 2; // §4: 3 收到 2 → 应保持 3
        s.gmt_modified_time = String::new(); // 让版本门在相等 sortKey 下放行
        let changed = store.apply_summary(s).await.unwrap();
        assert!(changed, "版本门应放行同 sortKey + gmt='' 的摘要");

        let got = store.list_top(E, None, 10).await.unwrap();
        assert_eq!(
            got[0].last_send_status, 3,
            "§4: status=3(终态)收到 2(发送中)应保持 3,不得倒退"
        );

        // ── 场景二:4(失败) 收到 3(成功) → 应变 3 ──────────────────────────────
        let pool2 = SqlitePool::in_memory().await.unwrap();
        let store2 = RecentSessionsStore::new(pool2);

        // 种子行:last_send_status=4(失败),sort_key_ms=2000。
        let mut seed2 = sample_remote("cv-2", "wa-1", 2000, 0);
        seed2.last_send_status = 4;
        store2.upsert_remote_many(&[seed2]).await.unwrap();
        let seed_row = store2.list_top(E, None, 10).await.unwrap();
        assert_eq!(
            seed_row[0].last_send_status, 4,
            "种子 last_send_status 应为 4"
        );

        // apply_summary:同 sort_key_ms=2000,gmt="",incoming last_send_status=3。
        let mut s2 = sample_summary("cv-2", 2000, 0);
        s2.last_send_status = 3; // §4: 4 收到 3 → 应变 3
        s2.gmt_modified_time = String::new();
        let changed2 = store2.apply_summary(s2).await.unwrap();
        assert!(changed2, "版本门应放行同 sortKey + gmt='' 的摘要");

        let got2 = store2.list_top(E, None, 10).await.unwrap();
        assert_eq!(
            got2[0].last_send_status, 3,
            "§4: status=4(失败)收到 3(成功)应变 3"
        );

        // ── 场景三:3(成功) 收到 4(失败) → 应保持 3(终态不接受失败) ────────────
        let pool3 = SqlitePool::in_memory().await.unwrap();
        let store3 = RecentSessionsStore::new(pool3);

        let seed3 = sample_remote("cv-3", "wa-1", 3000, 0); // last_send_status=3
        store3.upsert_remote_many(&[seed3]).await.unwrap();

        let mut s3 = sample_summary("cv-3", 3000, 0);
        s3.last_send_status = 4; // §4: 3 收到 4 → 应保持 3
        s3.gmt_modified_time = String::new();
        store3.apply_summary(s3).await.unwrap();

        let got3 = store3.list_top(E, None, 10).await.unwrap();
        assert_eq!(
            got3[0].last_send_status, 3,
            "§4: status=3(终态)收到 4(失败)应保持 3"
        );
    }

    // ─── B: 同消息守卫(CONFIRMED sortKey < PENDING)放行 + MAX 防回退 ─────────

    /// 同一条消息(同 lastLocalMessageId):先 PENDING(status2, sortKey=A=大),
    /// 再 CONFIRMED(status3, sortKey=B<A) → 终态 status=3,且 time/sort_key 未被拉低(取 MAX)。
    /// 实证根因:出站 CONFIRMED 用真实平台时间,前导 ms 比本地 PENDING 创建时间小。
    #[tokio::test]
    async fn apply_summary_same_message_confirmed_smaller_sortkey_advances() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        // 种子行(status<=1,让 PENDING 能进)。
        let mut seed = sample_remote("cv-1", "wa-1", 100, 0);
        seed.last_send_status = 0;
        seed.last_local_message_id = "L".into();
        seed.last_message_sort_key_ms = 100;
        store.upsert_remote_many(&[seed]).await.unwrap();

        // PENDING:status=2,sortKey=A=1780390520611(大),同消息 "L"。
        let mut pending = sample_summary("cv-1", 1_780_390_520_611, 0);
        pending.last_local_message_id = "L".into();
        pending.last_send_status = 2;
        let c1 = store.apply_summary(pending).await.unwrap();
        assert!(c1, "PENDING 应被接受(sortKey 大于种子)");
        let got = store.list_top(E, None, 10).await.unwrap();
        assert_eq!(got[0].last_send_status, 2, "PENDING 后应为发送中");
        assert_eq!(got[0].last_message_sort_key_ms, 1_780_390_520_611);

        // CONFIRMED:status=3,sortKey=B=1780390519000(< A),同消息 "L"。
        let mut confirmed = sample_summary("cv-1", 1_780_390_519_000, 0);
        confirmed.last_local_message_id = "L".into();
        confirmed.last_send_status = 3;
        let c2 = store.apply_summary(confirmed).await.unwrap();
        assert!(c2, "同消息 CONFIRMED(小 sortKey)应被同消息守卫放行");

        let got = store.list_top(E, None, 10).await.unwrap();
        assert_eq!(
            got[0].last_send_status, 3,
            "同消息 CONFIRMED 应把发送状态推进到成功"
        );
        // time / sort_key 未被小 sortKey 拉低(取 MAX)。
        assert_eq!(
            got[0].last_message_sort_key_ms, 1_780_390_520_611,
            "sort_key 不得被同消息小 sortKey 拉低"
        );
        assert_eq!(
            got[0].last_message_time_ms, 1_780_390_520_611,
            "time 不得被同消息小 sortKey 拉低"
        );
    }

    /// 回归:不同 lastLocalMessageId 的更小 sortKey 摘要仍被拒(同消息守卫只对同 id 生效)。
    #[tokio::test]
    async fn apply_summary_different_message_smaller_sortkey_rejected() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        let mut seed = sample_remote("cv-1", "wa-1", 500, 3);
        seed.last_local_message_id = "L_seed".into();
        store.upsert_remote_many(&[seed]).await.unwrap();

        // 不同消息("L_other"),更小 sortKey=200 → 应被拒。
        let mut other = sample_summary("cv-1", 200, 9);
        other.last_local_message_id = "L_other".into();
        other.last_send_status = 3;
        let changed = store.apply_summary(other).await.unwrap();
        assert!(!changed, "不同消息的过期小 sortKey 摘要应被版本门拒绝");
        let got = store.list_top(E, None, 10).await.unwrap();
        assert_eq!(got[0].last_message_time_ms, 500, "stale 不得覆盖");
        assert_eq!(got[0].unread_count, 3, "stale 不得覆盖未读");
        assert_eq!(got[0].last_message_sort_key_ms, 500, "版本键不得被拉低");
    }

    /// 同消息 SEND_FAILED(status4)放行 → last_send_status=4。
    #[tokio::test]
    async fn apply_summary_same_message_send_failed_applies() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        let mut seed = sample_remote("cv-1", "wa-1", 100, 0);
        seed.last_send_status = 2; // 发送中
        seed.last_local_message_id = "L".into();
        seed.last_message_sort_key_ms = 1_780_390_520_611;
        store.upsert_remote_many(&[seed]).await.unwrap();

        // 同消息 CONFIRMED-FAILED:status=4,sortKey 更小,同 "L"。
        let mut failed = sample_summary("cv-1", 1_780_390_519_000, 0);
        failed.last_local_message_id = "L".into();
        failed.last_send_status = 4;
        let changed = store.apply_summary(failed).await.unwrap();
        assert!(changed, "同消息 SEND_FAILED 应被守卫放行");
        let got = store.list_top(E, None, 10).await.unwrap();
        assert_eq!(got[0].last_send_status, 4, "发送中收到失败应变 4");
    }

    // ─── A: mark_local_sent 乐观本地写 ─────────────────────────────────────

    /// 发送乐观写:更新 summary/type/direction/local_last_sent_at_ms,
    /// **不动** last_message_sort_key_ms 与 last_send_status。
    #[tokio::test]
    async fn mark_local_sent_updates_local_cols_only() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        // 种子:type=1,direction=1,status=3,sort_key=500。
        store
            .upsert_remote_many(&[sample_remote("c1", "wa-1", 500, 0)])
            .await
            .unwrap();
        let before = store.list_top(E, None, 10).await.unwrap();
        assert_eq!(before[0].last_send_status, 3);
        assert_eq!(before[0].last_message_sort_key_ms, 500);

        let hit = store
            .mark_local_sent(E, "c1", "我发的新消息", 2, 1, 9999)
            .await
            .unwrap();
        assert!(hit, "会话存在应命中一行");

        let got = store.list_top(E, None, 10).await.unwrap();
        // 本地可见列被更新。
        assert_eq!(got[0].last_message_summary, "我发的新消息");
        assert_eq!(got[0].last_message_type, 2);
        assert_eq!(got[0].last_message_direction, 1);
        assert_eq!(got[0].local_last_sent_at_ms, 9999);
        // 显示时间随本地发送抬到 now(MAX(种子 500, 9999)=9999),否则列表行时间空白。
        assert_eq!(
            got[0].last_message_time_ms, 9999,
            "mark_local_sent 须抬显示时间 last_message_time_ms"
        );
        // 版本键与发送状态绝不被动。
        assert_eq!(
            got[0].last_message_sort_key_ms, 500,
            "mark_local_sent 不得动版本键"
        );
        assert_eq!(got[0].last_send_status, 3, "mark_local_sent 不得动发送状态");
    }

    /// 会话不在 recents → mark_local_sent 返回 false(no-op,回退到事件补全)。
    #[tokio::test]
    async fn mark_local_sent_missing_returns_false() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        let hit = store
            .mark_local_sent(E, "nope", "x", 1, 1, 1)
            .await
            .unwrap();
        assert!(!hit);
    }

    #[tokio::test]
    async fn mark_local_failed_sets_status_4_without_touching_version_key() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        store
            .upsert_remote_many(&[sample_remote("c1", "wa-1", 500, 0)])
            .await
            .unwrap(); // status=3, sort_key=500
        let hit = store
            .mark_local_failed(E, "c1", "发失败的消息", 1, 1, 9999)
            .await
            .unwrap();
        assert!(hit);
        let got = store.list_top(E, None, 10).await.unwrap();
        assert_eq!(got[0].last_message_summary, "发失败的消息");
        assert_eq!(
            got[0].last_send_status, 4,
            "失败态必须写 last_send_status=4"
        );
        assert_eq!(got[0].local_last_sent_at_ms, 9999);
        // 失败气泡同样抬显示时间(MAX(种子 500, 9999)=9999)。
        assert_eq!(
            got[0].last_message_time_ms, 9999,
            "mark_local_failed 须抬显示时间 last_message_time_ms"
        );
        assert_eq!(
            got[0].last_message_sort_key_ms, 500,
            "绝不动版本/水位键(否则破坏 apply_summary 回正)"
        );
    }

    /// mark_local_sent 写 local_last_sent_at_ms → 把会话顶到前(其它排序信号为 0 时)。
    #[tokio::test]
    async fn mark_local_sent_lifts_row_above_newer() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = RecentSessionsStore::new(pool);
        store
            .upsert_remote_many(&[
                sample_remote("c1", "wa-1", 100, 0), // 旧
                sample_remote("c2", "wa-1", 999, 0), // 新
            ])
            .await
            .unwrap();
        // 给旧的 c1 发一条(local_last_sent_at = now,必然 > 999)→ 顶到前。
        store
            .mark_local_sent(E, "c1", "刚发出", 1, 1, now_unix_ms())
            .await
            .unwrap();
        let got = store.list_top(E, None, 10).await.unwrap();
        assert_eq!(got[0].conversation_id, "c1", "发送行应顶到非置顶区顶部");
    }
}
