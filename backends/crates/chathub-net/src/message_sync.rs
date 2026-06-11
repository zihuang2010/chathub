//! MessageSync:消息页"缓存优先 + 后台重对齐"编排(单连续窗口,缝合则扩、遇洞则丢旧)。
//!
//! 与 recent_session_event.rs 同构:持有 store + hub + change_notice_tx。
//!
//! **记录顺序约定**:进入本模块的 `FetchMessageHistoryResp.records` 会先被收敛为升序
//! (早→晚)。游标分页语义固定 earlier-only(`next_cursor` 用于继续往更旧翻),
//! 故 `older_cursor = next_cursor` / `has_more_older = has_more`。

use crate::change_notice::{ChangeNotice, ChangeScope, ChangeTopic};
use crate::error::AuthError;
use crate::hub::{
    FetchMessageHistoryRequest, FirstConversationHistory, HistoryAttachment, HistoryMessage,
    HubClient, SendMessageRequest, SendMessageResp,
};
use crate::message_event::{normalize_sync_send_status, to_local_direction};
use crate::recent_session_event::split_sort_key_ms;
use chathub_state::{MessageRow, MessageWindow, MessagesStore};
use tokio::sync::broadcast;

/// 重对齐三态(纯函数判定)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReconcileMode {
    /// 首页空 → 不动缓存(防止瞬时异常清空)。
    NoOp,
    /// 冷启动 / 遇洞 → 丢旧重置:删全部 + 首页落库 + 新 window。
    Replace,
    /// 能缝合 → UPSERT 首页,仅扩 newest 上界。
    Stitch,
}

/// 纯判定:`window` = 现有水位(可空);`page_oldest_sort_key` = 新拉首页里**最旧**一条
/// 的 sort_key(records 升序,首条即最旧;空页传 None)。
///
/// - 无窗口 / 窗口空 newest → Replace(冷启动)。
/// - 首页最旧 ≤ 缓存最新 → 首页向下够到缓存顶,连续 → Stitch;否则中间有洞 → Replace。
pub fn classify_reconcile(
    window: Option<&MessageWindow>,
    page_oldest_sort_key: Option<&str>,
) -> ReconcileMode {
    let page_oldest = match page_oldest_sort_key {
        Some(s) if !s.is_empty() => s,
        _ => return ReconcileMode::NoOp,
    };
    match window {
        Some(w) if !w.newest_sort_key.is_empty() => {
            if page_oldest <= w.newest_sort_key.as_str() {
                ReconcileMode::Stitch
            } else {
                ReconcileMode::Replace
            }
        }
        _ => ReconcileMode::Replace,
    }
}

/// 纯判定:本次首页是否把某条「本地原为待转存(transferStatus=1)」的消息推进到了非 pending
/// (成功/失败终态)。转存状态变化不改 sortKey(同一条消息),故水位不推进、Stitch 默认不通知;
/// 此判定让这类「就地升级」也能触发一次通知,杜绝「转存完成但页面不刷新」。
/// 只认「pending → 非 pending」的升级,不认回退(回退已被 upsert 不降级守卫拦下),故不会误通知、
/// 不破坏既有「notify→read→reconcile→notify 自激死循环」的防护。
fn transfer_status_upgraded(existing: &[MessageRow], fetched: &[MessageRow]) -> bool {
    let was_pending: std::collections::HashSet<&str> = existing
        .iter()
        .filter(|r| r.attachments_json.contains("\"transferStatus\":1"))
        .map(|r| r.local_message_id.as_str())
        .collect();
    if was_pending.is_empty() {
        return false;
    }
    fetched.iter().any(|r| {
        was_pending.contains(r.local_message_id.as_str())
            && !r.attachments_json.contains("\"transferStatus\":1")
    })
}

/// 从未收敛失败行中筛出「服务端首页 reqid 集合不含」的那些 —— 它们是服务端尚不知情的本地失败,
/// Replace 清库后必须补回。已被服务端回显(reqid 在页中)的不保活,由 server 行取代。
/// 按 reqid(非 local_message_id)判定,确保补回行与 server 行不同 reqid → 去重 DELETE 不交叉。
pub fn preserve_failed(
    failed: Vec<chathub_state::MessageRow>,
    page_reqids: &std::collections::HashSet<String>,
) -> Vec<chathub_state::MessageRow> {
    failed
        .into_iter()
        .filter(|r| {
            !r.request_message_id.is_empty() && !page_reqids.contains(&r.request_message_id)
        })
        .collect()
}

/// `HistoryMessage`(API 形态)→ `MessageRow`(行存)。附件序列化成 JSON 串。
pub fn history_to_row(
    h: &HistoryMessage,
    conversation_id: &str,
    employee_id: &str,
    wecom_account_id: &str,
) -> MessageRow {
    MessageRow {
        local_message_id: h.local_message_id.clone(),
        conversation_id: conversation_id.to_string(),
        employee_id: employee_id.to_string(),
        wecom_account_id: wecom_account_id.to_string(),
        sort_key: h.sort_key.clone(),
        message_time_ms: parse_server_time_to_ms(&h.message_time),
        message_direction: to_local_direction(h.message_direction as i64),
        // 持久化上游原始方向(1/2/3),供读路径(row_to_history)派生本地方向 + 多端同步标记。
        source_direction: h.message_direction,
        message_type: h.message_type,
        content_text: h.content_text.clone(),
        // 多端同步(源方向 3)历史行 send_status 上游同样可能为 0 → 归一为成功,与 push 路径一致,
        // 避免冷会话首开经 history 落库后出站气泡又转圈。
        send_status: normalize_sync_send_status(h.message_direction as i64, h.send_status),
        attachments_json: serde_json::to_string(&h.attachments).unwrap_or_else(|e| {
            tracing::warn!(
                target: "chathub::msg",
                %conversation_id,
                local_message_id = %h.local_message_id,
                error = %e,
                "附件序列化失败,降级为空数组"
            );
            "[]".into()
        }),
        gmt_modified_time: h.gmt_modified_time.clone(),
        revoked: h.revoked,
        fail_reason: h.fail_reason.clone(),
        request_message_id: h.request_message_id.clone(),
        updated_at_ms: 0,
    }
}

/// `MessageRow`(行存)→ `HistoryMessage`(API 形态;读命令返给前端,复用既有适配器)。
pub fn row_to_history(r: &MessageRow) -> HistoryMessage {
    // 本地方向 + 多端同步标记均由持久化的 source_direction 派生,不解析 opaque 的 sort_key。
    let (message_direction, synced_from_other_device) = local_direction_and_synced(r);
    HistoryMessage {
        local_message_id: r.local_message_id.clone(),
        message_direction,
        message_type: r.message_type,
        content_text: r.content_text.clone(),
        send_status: r.send_status,
        message_time: ms_to_server_time(r.message_time_ms),
        sort_key: r.sort_key.clone(),
        synced_from_other_device,
        attachments: serde_json::from_str::<Vec<HistoryAttachment>>(&r.attachments_json)
            .unwrap_or_default(),
        gmt_modified_time: r.gmt_modified_time.clone(),
        revoked: r.revoked,
        fail_reason: r.fail_reason.clone(),
        request_message_id: r.request_message_id.clone(),
    }
}

/// 由持久化的上游源方向派生 (本地方向, 多端同步标记)。
/// `source_direction`:1=发送方 / 2=客户·接收方 / 3=多端同步方;0=未知(V29 迁移前的老行)。
/// - 已知(1..=3):本地方向 = `to_local_direction`;synced = (源方向==3,即「已在他端发出的成品」)。
/// - 未知(0):回退既有 `message_direction` 列(V20 已修正其本地方向),按非多端同步处理;下次 reconcile
///   重拉历史经 upsert 回填真实源方向后该行自愈。
///
/// 不再从 opaque 的 `sort_key` 反推 —— 真实 sort_key 是「13位ms_20位序列_id」下划线三段、不含方向段。
fn local_direction_and_synced(r: &MessageRow) -> (i32, bool) {
    match r.source_direction {
        direction @ 1..=3 => (to_local_direction(direction as i64), direction == 3),
        _ => (normalize_stored_local_direction(r.message_direction), false),
    }
}

fn normalize_stored_local_direction(stored_direction: i32) -> i32 {
    if stored_direction == 2 {
        2
    } else {
        1
    }
}

/// 单条消息的跨源新鲜度键(epoch-ms):取 sort_key 首段 ms 与 message_time 解析 ms 的较大值。
/// 与 recents `last_message_sort_key_ms` 的 `split_sort_key_ms(..).max(time_ms)` 同构,
/// 保证会话水位门两侧 apples-to-apples;sort_key 格式不符则退化为时间解析(再不行则 0 → 门 fail-open)。
fn message_freshness_ms(h: &HistoryMessage) -> i64 {
    split_sort_key_ms(&h.sort_key).max(parse_server_time_to_ms(&h.message_time))
}

/// 取一页 records 的 (最旧 sort_key, 最新 sort_key, 最新 freshness_ms),**不依赖数组顺序**。
/// 背景:上游 `message/history` 实测按时间**降序**返回(新→旧),与早先代码假设的"升序"
/// 相反;若仍用 `first()=最旧 / last()=最新`,window 的 newest/oldest 边界会取反 ——
/// reconcile 据此误判 Replace(`delete_conversation` 清库重灌),老历史被删 + 反复 churn。
/// sort_key 为定长 ms 前缀的复合键,字典序≈时序,故按 min/max 取边界对升序/降序都正确。
/// 空页返回 (None, None, 0)。
fn page_bounds(records: &[HistoryMessage]) -> (Option<String>, Option<String>, i64) {
    let oldest = records.iter().map(|r| r.sort_key.clone()).min();
    let newest = records.iter().map(|r| r.sort_key.clone()).max();
    let newest_ms = records.iter().map(message_freshness_ms).max().unwrap_or(0);
    (oldest, newest, newest_ms)
}

fn sort_history_records_ascending(records: &mut [HistoryMessage]) {
    records.sort_by(|a, b| {
        a.sort_key
            .cmp(&b.sort_key)
            .then_with(|| {
                parse_server_time_to_ms(&a.message_time)
                    .cmp(&parse_server_time_to_ms(&b.message_time))
            })
            .then_with(|| a.local_message_id.cmp(&b.local_message_id))
    });
}

/// load_older 结果:本次新增的更老消息(升序)+ 翻完后是否还有更老。
#[derive(Debug, Clone)]
pub struct LoadOlderResult {
    pub records: Vec<HistoryMessage>,
    pub has_more_older: bool,
}

#[derive(Clone)]
pub struct MessageSync {
    store: MessagesStore,
    hub: HubClient,
    change_notice_tx: broadcast::Sender<ChangeNotice>,
}

impl MessageSync {
    pub fn new(
        store: MessagesStore,
        hub: HubClient,
        change_notice_tx: broadcast::Sender<ChangeNotice>,
    ) -> Self {
        Self {
            store,
            hub,
            change_notice_tx,
        }
    }

    /// 后台重对齐(朝最新方向)。拉首页 → classify → 缝合 / 丢旧重置 → upsert window →
    /// 发 ChangeNotice 让前端重读。`page_size` 建议 20。
    pub async fn reconcile_newest(
        &self,
        conversation_id: &str,
        wecom_account_id: &str,
        external_user_id: &str,
        employee_id: &str,
        page_size: u32,
    ) -> Result<(), AuthError> {
        let resp = self
            .hub
            .fetch_message_history(FetchMessageHistoryRequest {
                size: page_size,
                wecom_account_id: wecom_account_id.to_string(),
                external_user_id: external_user_id.to_string(),
                cursor: String::new(),
            })
            .await?;

        let mut records = resp.records;
        sort_history_records_ascending(&mut records);
        let (page_oldest, page_newest, page_newest_ms) = page_bounds(&records);

        let window = self
            .store
            .get_window(employee_id, conversation_id)
            .await
            .map_err(state_err)?;
        let mode = classify_reconcile(window.as_ref(), page_oldest.as_deref());
        // 重对齐前缓存的 newest 水位,用于判断本次是否真有更新消息到达(下方 Stitch 用)。
        let prev_newest_sort_key = window.as_ref().map(|w| w.newest_sort_key.clone());

        // 重对齐全过程日志:本次 fetch_message_history 拉回多少条、首页最新/最旧、分类结果。
        tracing::debug!(
            target: "chathub::messages",
            conversation_id,
            fetched = records.len(),
            page_newest_ms,
            page_oldest = ?page_oldest,
            page_newest = ?page_newest,
            prev_newest = ?prev_newest_sort_key,
            mode = ?mode,
            "reconcile_newest:已拉取权威首页(fetch_message_history)并分类",
        );

        let rows: Vec<MessageRow> = records
            .iter()
            .map(|h| history_to_row(h, conversation_id, employee_id, wecom_account_id))
            .collect();

        // should_notify:本次重对齐是否真的写入了新数据,决定是否广播 ChangeNotice 让前端重读。
        // 关键:Stitch 若未推进 newest(首页与缓存最新一致,即无新消息),则**不通知**。否则会与
        // load_conversation_messages 的「水位门 not-fresh → 后台 reconcile」形成
        // notify→read→reconcile→notify 自激死循环 —— 尤以搜索打开、不在接待列表的会话为甚:
        // 其 recents 行为 blank(last_message_sort_key_ms=0),水位门要求 r>0 故恒判 not-fresh,
        // 每次重读都会再 spawn 一次 reconcile,无条件通知就会无限打 message/history。
        let should_notify = match mode {
            ReconcileMode::NoOp => return Ok(()),
            ReconcileMode::Replace => {
                // 保活:Replace 会清库,先捞服务端首页不含其 reqid 的本地失败行,删后补回。
                let page_reqids: std::collections::HashSet<String> =
                    rows.iter().map(|r| r.request_message_id.clone()).collect();
                let preserved = preserve_failed(
                    self.store
                        .list_failed_outbox(employee_id, conversation_id)
                        .await
                        .map_err(state_err)?,
                    &page_reqids,
                );
                self.store
                    .delete_conversation(employee_id, conversation_id)
                    .await
                    .map_err(state_err)?;
                self.store.upsert_messages(&rows).await.map_err(state_err)?;
                if !preserved.is_empty() {
                    self.store
                        .upsert_messages(&preserved)
                        .await
                        .map_err(state_err)?;
                }
                let now = now_ms();
                self.store
                    .upsert_window(MessageWindow {
                        conversation_id: conversation_id.to_string(),
                        employee_id: employee_id.to_string(),
                        wecom_account_id: wecom_account_id.to_string(),
                        external_user_id: external_user_id.to_string(),
                        newest_sort_key: page_newest.unwrap_or_default(),
                        oldest_sort_key: page_oldest.unwrap_or_default(),
                        older_cursor: resp.next_cursor.clone(),
                        has_more_older: resp.has_more,
                        newest_message_time_ms: page_newest_ms,
                        last_accessed_ms: now,
                        reconciled_at_ms: now,
                        updated_at_ms: now,
                    })
                    .await
                    .map_err(state_err)?;
                true
            }
            ReconcileMode::Stitch => {
                // 升级检测须在覆盖前读到本地现状(转存态 1→终态)。limit 取本次首页条数,覆盖重叠区即可。
                let existing_before = self
                    .store
                    .list_recent(employee_id, conversation_id, rows.len().max(1))
                    .await
                    .map_err(state_err)?;
                self.store.upsert_messages(&rows).await.map_err(state_err)?;
                // 首页最新 > 缓存原 newest 才算「有新消息到达」(sort_key 同构,字典序即时序)。
                let advanced = matches!(
                    (prev_newest_sort_key.as_deref(), page_newest.as_deref()),
                    (Some(prev), Some(curr)) if curr > prev
                );
                // 转存「就地升级」(同一条消息、sortKey 不变 → 水位不推进)也要通知,否则会出现
                // 「转存完成但页面不刷新」。只认 pending→终态,回退已被 upsert 不降级守卫拦下,
                // 故不会误通知、不破坏既有自激死循环防护。
                let transfer_upgraded = transfer_status_upgraded(&existing_before, &rows);
                // 只扩 newest 上界,下界 / older_cursor / has_more_older 不动。
                if let (Some(mut w), Some(newest)) = (window, page_newest) {
                    w.newest_sort_key = newest;
                    w.newest_message_time_ms = w.newest_message_time_ms.max(page_newest_ms);
                    let now = now_ms();
                    w.reconciled_at_ms = now;
                    w.last_accessed_ms = now;
                    self.store.upsert_window(w).await.map_err(state_err)?;
                }
                advanced || transfer_upgraded
            }
        };

        tracing::debug!(
            target: "chathub::messages",
            conversation_id,
            should_notify,
            "reconcile_newest:落库完成,should_notify=true 才广播 ChangeNotice 触发前端重读",
        );
        if should_notify {
            let _ = self.change_notice_tx.send(ChangeNotice::server_upsert(
                ChangeTopic::ConversationMessages,
                ChangeScope {
                    employee_id: employee_id.to_string(),
                    conversation_id: Some(conversation_id.to_string()),
                    ..Default::default()
                },
            ));
        }
        Ok(())
    }

    /// 冷写入"首屏历史":打开会话时把 recentFriends 随响应带回的 `firstConversationHistory.records`
    /// 直接落库 + 建窗,免去选中后再走一次 `reconcile_newest` 的网络往返(秒显)。
    ///
    /// 纪律:**仅当会话冷(无 window)时写**——已有窗口说明本地缓存已是权威,跳过以免覆盖更全的历史。
    /// `history.records` 约定升序(早→晚),与 message/history 同形;`has_more` / `next_cursor` 供后续
    /// "加载更早"接续。写完 emit ConversationMessages ChangeNotice 让打开着的会话重读。
    pub async fn seed_first_history(
        &self,
        conversation_id: &str,
        wecom_account_id: &str,
        external_user_id: &str,
        employee_id: &str,
        history: &FirstConversationHistory,
    ) -> Result<(), AuthError> {
        let mut records = history.records.clone();
        sort_history_records_ascending(&mut records);
        if records.is_empty() {
            return Ok(());
        }
        // 已有窗口 = 温缓存,跳过(不覆盖本地更全的历史)。
        if self
            .store
            .get_window(employee_id, conversation_id)
            .await
            .map_err(state_err)?
            .is_some()
        {
            return Ok(());
        }

        let rows: Vec<MessageRow> = records
            .iter()
            .map(|h| history_to_row(h, conversation_id, employee_id, wecom_account_id))
            .collect();
        self.store.upsert_messages(&rows).await.map_err(state_err)?;

        // 不依赖数组顺序(上游可能降序返回):按 sort_key min/max 取最旧/最新。
        let (page_oldest_opt, page_newest_opt, newest_ms) = page_bounds(&records);
        let page_oldest = page_oldest_opt.unwrap_or_default();
        let page_newest = page_newest_opt.unwrap_or_default();
        let older_cursor = history.next_cursor.as_deref().unwrap_or("");
        let now = now_ms();
        self.store
            .upsert_window(MessageWindow {
                conversation_id: conversation_id.to_string(),
                employee_id: employee_id.to_string(),
                wecom_account_id: wecom_account_id.to_string(),
                external_user_id: external_user_id.to_string(),
                newest_sort_key: page_newest,
                oldest_sort_key: page_oldest,
                older_cursor: older_cursor.to_string(),
                has_more_older: history.has_more,
                newest_message_time_ms: newest_ms,
                last_accessed_ms: now,
                reconciled_at_ms: now,
                updated_at_ms: now,
            })
            .await
            .map_err(state_err)?;

        let _ = self.change_notice_tx.send(ChangeNotice::server_upsert(
            ChangeTopic::ConversationMessages,
            ChangeScope {
                employee_id: employee_id.to_string(),
                conversation_id: Some(conversation_id.to_string()),
                ..Default::default()
            },
        ));
        Ok(())
    }

    /// 发送一条消息:**只引导空窗 + 调 hub API**,不再本地写消息行。
    ///
    /// 架构决策(阶段2):消息行的**唯一写者**是回调事件(SEND_PENDING_CREATED/SEND_CONFIRMED)
    /// 的 push applier,幂等靠 `local_message_id` 主键收敛。send 不再构造 MessageRow / bump 水位 /
    /// 发 ConversationMessages ChangeNotice —— 出站气泡的权威重读由 MESSAGE_UPSERT applier
    /// 落库后那条 ChangeNotice 触发。即时 UX 由前端乐观气泡承担(返回的 local_message_id 钉服务端 id)。
    ///
    /// **`ensure_window` 必须在 API 调用之前**:无窗时 push 早到会被 applier 当冷会话跳过 → 不写不
    /// 通知。先建一扇保守空窗(后续 reconcile 缝合真实历史),杜绝这条 readCache 触发链断裂。
    #[allow(clippy::too_many_arguments)]
    pub async fn send_message(
        &self,
        conversation_id: &str,
        wecom_account_id: &str,
        external_user_id: &str,
        employee_id: &str,
        message_type: i32,
        content_text: &str,
        file_path: Option<&str>,
        file_name: Option<&str>,
        file_size: Option<i64>,
        duration_seconds: Option<i32>,
        client_msg_id: &str,
    ) -> Result<SendMessageResp, AuthError> {
        // 引导空窗(API 调用之前):无窗则建,杜绝 push 早到被当冷会话跳过。已有窗则 no-op。
        self.store
            .ensure_window(
                employee_id,
                conversation_id,
                wecom_account_id,
                external_user_id,
            )
            .await
            .map_err(state_err)?;

        // 幂等键:复用前端传入的 client_msg_id 作为 request_message_id,使重复点击 / 网络
        // 重试在服务端按同一键去重,不产生重复消息。空值兜底生成 uuid(向后兼容老调用)。
        let request_message_id = if client_msg_id.is_empty() {
            format!("req-{}", uuid::Uuid::new_v4().simple())
        } else {
            client_msg_id.to_string()
        };
        let resp = self
            .hub
            .send_message(SendMessageRequest {
                request_message_id,
                wecom_account_id: wecom_account_id.to_string(),
                external_user_id: external_user_id.to_string(),
                message_type,
                content_text: content_text.to_string(),
                file_path: file_path.map(str::to_string),
                file_name: file_name.map(str::to_string),
                file_size,
                duration_seconds,
            })
            .await?;

        Ok(resp)
    }

    /// 往更老翻一页(同步返回新增,升序)。无 window 或 has_more_older=false → 返回空。
    pub async fn load_older(
        &self,
        conversation_id: &str,
        employee_id: &str,
        page_size: u32,
    ) -> Result<LoadOlderResult, AuthError> {
        let window = match self
            .store
            .get_window(employee_id, conversation_id)
            .await
            .map_err(state_err)?
        {
            Some(w) if w.has_more_older && !w.older_cursor.is_empty() => w,
            _ => {
                return Ok(LoadOlderResult {
                    records: Vec::new(),
                    has_more_older: false,
                })
            }
        };
        let resp = self
            .hub
            .fetch_message_history(FetchMessageHistoryRequest {
                size: page_size,
                wecom_account_id: window.wecom_account_id.clone(),
                external_user_id: window.external_user_id.clone(),
                cursor: window.older_cursor.clone(),
            })
            .await?;
        let mut records = resp.records;
        sort_history_records_ascending(&mut records);
        if records.is_empty() {
            // 服务端没有更老了:仅翻 has_more_older=false。
            let mut w = window;
            w.has_more_older = false;
            w.updated_at_ms = now_ms();
            self.store.upsert_window(w).await.map_err(state_err)?;
            return Ok(LoadOlderResult {
                records: Vec::new(),
                has_more_older: false,
            });
        }
        let rows: Vec<MessageRow> = records
            .iter()
            .map(|h| history_to_row(h, conversation_id, employee_id, &window.wecom_account_id))
            .collect();
        self.store.upsert_messages(&rows).await.map_err(state_err)?;
        let frontend_records: Vec<HistoryMessage> = rows.iter().map(row_to_history).collect();
        // 推进下界(本页最旧 = sort_key 最小,不依赖数组顺序)+ 游标 + has_more。newest 不动。
        let new_oldest = page_bounds(&records)
            .0
            .unwrap_or_else(|| window.oldest_sort_key.clone());
        let mut w = window;
        w.oldest_sort_key = new_oldest;
        w.older_cursor = resp.next_cursor.clone();
        w.has_more_older = resp.has_more;
        w.updated_at_ms = now_ms();
        self.store.upsert_window(w).await.map_err(state_err)?;
        Ok(LoadOlderResult {
            records: frontend_records,
            has_more_older: resp.has_more,
        })
    }
}

fn state_err(e: chathub_state::StateError) -> AuthError {
    AuthError::Internal {
        message: format!("messages store: {e}"),
    }
}

/// epoch ms(UTC)。crate 内唯一 wall-clock 助手,message_event 等模块复用(D3 收敛重复副本)。
pub(crate) fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 服务端时间串 → epoch ms(UTC)。解析失败返 0。归一后复用定长解析,统一兼容:
///   - 空格分隔:`"2026-05-17 10:01:23"`(旧形态);
///   - `T` 分隔:`"2026-06-02T16:55:20"`(真实 payload ISO-T);
///   - 可选毫秒:`"...:20.611"`(截到秒,丢弃 `.SSS`);
///   - 可选尾 `Z`:有 `Z` 视为 UTC,**不减** 8h;无 `Z` 视为服务端本地(UTC+8),减 8h。
pub(crate) fn parse_server_time_to_ms(s: &str) -> i64 {
    // 入口归一:先剥尾 `Z`(记是否 UTC),再把第 11 位的 `T` 视同空格,最后截断 `.SSS` 毫秒。
    let is_utc = s.ends_with('Z');
    let s = s.trim_end_matches('Z');
    // `T` 分隔形态(第 11 位是 'T')→ 替换成空格,与旧定长解析对齐。
    let normalized = if s.as_bytes().get(10) == Some(&b'T') {
        // 只替换分隔位的单字节 ASCII 'T'(日期/时间其余位不含 'T')。
        format!("{} {}", &s[..10], &s[11..])
    } else {
        s.to_string()
    };
    // 截断可选毫秒:`.611` 等只保留到秒。
    let core = match normalized.find('.') {
        Some(dot) => &normalized[..dot],
        None => normalized.as_str(),
    };

    // 形如 "2026-05-17 10:01:23",定长 19 字节。
    if core.len() < 19 {
        return 0;
    }
    let b = core.as_bytes();
    if b[4] != b'-' || b[7] != b'-' || b[10] != b' ' || b[13] != b':' || b[16] != b':' {
        return 0;
    }
    let take = |start: usize, len: usize| -> Option<i64> {
        std::str::from_utf8(&b[start..start + len])
            .ok()?
            .parse::<i64>()
            .ok()
    };
    let (y, mo, d, h, mi, se) = match (
        take(0, 4),
        take(5, 2),
        take(8, 2),
        take(11, 2),
        take(14, 2),
        take(17, 2),
    ) {
        (Some(y), Some(mo), Some(d), Some(h), Some(mi), Some(se)) => (y, mo, d, h, mi, se),
        _ => return 0,
    };
    if !(1970..=9999).contains(&y) || !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return 0;
    }
    // 无 Z = 服务端本地(UTC+8),转 UTC 减 8 小时;有 Z = 已是 UTC,不减。
    let utc_offset_ms = if is_utc { 0 } else { 8 * 3_600_000 };
    days_from_civil(y as i32, mo as i32, d as i32) * 86_400_000
        + h * 3_600_000
        + mi * 60_000
        + se * 1_000
        - utc_offset_ms
}

/// epoch ms(UTC)→ "yyyy-MM-dd HH:mm:ss"(UTC+8,与 server 形态一致;前端按 +08:00 解析)。
fn ms_to_server_time(ms: i64) -> String {
    if ms <= 0 {
        return String::new();
    }
    let local = ms + 8 * 3_600_000; // 转回 UTC+8 墙钟
    let days = local.div_euclid(86_400_000);
    let rem = local.rem_euclid(86_400_000);
    let (y, mo, d) = civil_from_days(days);
    let h = rem / 3_600_000;
    let mi = (rem % 3_600_000) / 60_000;
    let se = (rem % 60_000) / 1_000;
    format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{se:02}")
}

/// Howard Hinnant 公历日数(epoch 起天数,可为负)。
/// crate 内唯一公历日数助手,recent_session_event 等模块复用(D3 收敛重复副本)。
pub(crate) fn days_from_civil(y: i32, m: i32, d: i32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as i64;
    let doy = (153 * (m as i64 + if m > 2 { -3 } else { 9 }) + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era as i64 * 146097 + doe - 719468
}

/// days_from_civil 的逆:epoch 天数 → (year, month, day)。
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn win(newest: &str) -> MessageWindow {
        MessageWindow {
            conversation_id: "c1".into(),
            employee_id: "u-1".into(),
            wecom_account_id: "wa-1".into(),
            external_user_id: "ext".into(),
            newest_sort_key: newest.into(),
            oldest_sort_key: "sort_0001".into(),
            older_cursor: "cur".into(),
            has_more_older: true,
            newest_message_time_ms: 0,
            last_accessed_ms: 0,
            reconciled_at_ms: 0,
            updated_at_ms: 0,
        }
    }

    #[test]
    fn classify_no_window_is_replace() {
        assert_eq!(
            classify_reconcile(None, Some("sort_0009")),
            ReconcileMode::Replace
        );
    }

    #[test]
    fn classify_empty_page_is_noop() {
        assert_eq!(
            classify_reconcile(Some(&win("sort_0005")), None),
            ReconcileMode::NoOp
        );
        assert_eq!(
            classify_reconcile(Some(&win("sort_0005")), Some("")),
            ReconcileMode::NoOp
        );
    }

    #[test]
    fn classify_overlap_is_stitch() {
        // 首页最旧 sort_0004 ≤ 缓存最新 sort_0005 → 缝合
        assert_eq!(
            classify_reconcile(Some(&win("sort_0005")), Some("sort_0004")),
            ReconcileMode::Stitch
        );
        // 恰好相等也算缝合
        assert_eq!(
            classify_reconcile(Some(&win("sort_0005")), Some("sort_0005")),
            ReconcileMode::Stitch
        );
    }

    #[test]
    fn classify_gap_is_replace() {
        // 首页最旧 sort_0008 > 缓存最新 sort_0005 → 有洞 → 丢旧
        assert_eq!(
            classify_reconcile(Some(&win("sort_0005")), Some("sort_0008")),
            ReconcileMode::Replace
        );
    }

    fn att_row(local: &str, attachments_json: &str) -> MessageRow {
        MessageRow {
            local_message_id: local.into(),
            conversation_id: "c1".into(),
            employee_id: "u-1".into(),
            wecom_account_id: "wa-1".into(),
            sort_key: "sort_0001".into(),
            message_time_ms: 1,
            message_direction: 1,
            source_direction: 2,
            message_type: 4,
            content_text: String::new(),
            send_status: 3,
            attachments_json: attachments_json.into(),
            gmt_modified_time: String::new(),
            revoked: false,
            fail_reason: String::new(),
            request_message_id: String::new(),
            updated_at_ms: 0,
        }
    }

    #[test]
    fn transfer_upgrade_detected_pending_to_terminal() {
        let existing = [att_row("m1", r#"[{"transferStatus":1}]"#)];
        let fetched = [att_row("m1", r#"[{"transferStatus":2}]"#)];
        assert!(
            transfer_status_upgraded(&existing, &fetched),
            "待转存(1)→成功(2) 即使水位未推进也应通知"
        );
    }

    #[test]
    fn transfer_upgrade_false_when_still_pending() {
        let existing = [att_row("m1", r#"[{"transferStatus":1}]"#)];
        let fetched = [att_row("m1", r#"[{"transferStatus":1}]"#)];
        assert!(
            !transfer_status_upgraded(&existing, &fetched),
            "仍是待转存 → 无升级、不通知(防自激死循环)"
        );
    }

    #[test]
    fn transfer_upgrade_false_on_downgrade_and_no_pending() {
        // 回退(2→1)不算升级(且会被 upsert 守卫拦下):不通知。
        let existing = [att_row("m1", r#"[{"transferStatus":2}]"#)];
        let fetched = [att_row("m1", r#"[{"transferStatus":1}]"#)];
        assert!(!transfer_status_upgraded(&existing, &fetched), "回退不通知");
        // 本地无任何 pending → 任何首页都不构成升级。
        let existing2 = [att_row("m1", r#"[{"transferStatus":2}]"#)];
        let fetched2 = [att_row("m1", r#"[{"transferStatus":2}]"#)];
        assert!(!transfer_status_upgraded(&existing2, &fetched2));
    }

    #[test]
    fn transfer_upgrade_false_when_other_message_changed() {
        // 升级发生在另一条(m2),本地 pending 的是 m1 且首页里 m1 仍 pending → 不通知。
        let existing = [att_row("m1", r#"[{"transferStatus":1}]"#)];
        let fetched = [att_row("m2", r#"[{"transferStatus":2}]"#)];
        assert!(!transfer_status_upgraded(&existing, &fetched));
    }

    #[test]
    fn parse_server_time_known() {
        let got = parse_server_time_to_ms("2026-05-17 10:01:23");
        let expected =
            days_from_civil(2026, 5, 17) * 86_400_000 + 10 * 3_600_000 + 60_000 + 23 * 1_000
                - 8 * 3_600_000;
        assert_eq!(got, expected);
    }

    #[test]
    fn parse_server_time_invalid_zero() {
        assert_eq!(parse_server_time_to_ms(""), 0);
        assert_eq!(parse_server_time_to_ms("2026/05/17 10:01:23"), 0);
    }

    #[test]
    fn server_time_round_trip() {
        let ms = parse_server_time_to_ms("2026-05-17 10:01:23");
        assert_eq!(ms_to_server_time(ms), "2026-05-17 10:01:23");
    }

    // 真实 payload 的 ISO-T 形态(`messageTime`):`T` 分隔、无 Z = 服务端本地(UTC+8),
    // 与等价的空格形态解析结果**逐字相等**;原空格用例不回归。
    #[test]
    fn parse_server_time_iso_t_equals_space_form() {
        let iso = parse_server_time_to_ms("2026-06-02T16:55:20");
        let space = parse_server_time_to_ms("2026-06-02 16:55:20");
        assert_eq!(iso, space);
        let expected =
            days_from_civil(2026, 6, 2) * 86_400_000 + 16 * 3_600_000 + 55 * 60_000 + 20 * 1_000
                - 8 * 3_600_000;
        assert_eq!(iso, expected);
    }

    // ISO-T + 可选毫秒(`...:20.611`):截到秒,毫秒丢弃,结果与无毫秒形态相同。
    #[test]
    fn parse_server_time_iso_t_with_millis_truncates_to_second() {
        let with_ms = parse_server_time_to_ms("2026-06-02T16:55:20.611");
        let without_ms = parse_server_time_to_ms("2026-06-02T16:55:20");
        assert_eq!(with_ms, without_ms);
    }

    // 带尾 `Z` = UTC,**不减** 8h:比无 Z 形态(UTC+8)大整整 8 小时。
    #[test]
    fn parse_server_time_trailing_z_is_utc_no_offset() {
        let utc = parse_server_time_to_ms("2026-06-02T16:55:20Z");
        let local = parse_server_time_to_ms("2026-06-02T16:55:20");
        assert_eq!(utc - local, 8 * 3_600_000, "有 Z 不减 8h,比无 Z 大 8 小时");
        let expected =
            days_from_civil(2026, 6, 2) * 86_400_000 + 16 * 3_600_000 + 55 * 60_000 + 20 * 1_000;
        assert_eq!(utc, expected);
    }

    #[test]
    fn freshness_prefers_sort_key_segment() {
        let h = HistoryMessage {
            local_message_id: "m1".into(),
            message_direction: 1,
            message_type: 1,
            content_text: "".into(),
            send_status: 3,
            message_time: "2020-01-01 00:00:00".into(),
            sort_key: "1715836200000:abc".into(),
            synced_from_other_device: false,
            attachments: vec![],
            gmt_modified_time: "".into(),
            revoked: false,
            fail_reason: "".into(),
            request_message_id: "".into(),
        };
        // sort_key 首段 ms(2024)远大于 time 解析 ms(2020)→ 取首段
        assert_eq!(message_freshness_ms(&h), 1715836200000);
    }

    // 回归:上游 message/history 按时间**降序**返回(新→旧),page_bounds 必须按 sort_key
    // min/max 取边界,不被数组顺序带偏 —— 否则 window newest/oldest 反转,reconcile 误删历史。
    #[test]
    fn page_bounds_order_independent_descending() {
        let mk = |sk: &str, t: &str| HistoryMessage {
            local_message_id: sk.into(),
            message_direction: 1,
            message_type: 1,
            content_text: "".into(),
            send_status: 3,
            message_time: t.into(),
            sort_key: sk.into(),
            synced_from_other_device: false,
            attachments: vec![],
            gmt_modified_time: "".into(),
            revoked: false,
            fail_reason: "".into(),
            request_message_id: "".into(),
        };
        // 降序数组:最新在前、最旧在尾(模拟真实上游返回顺序)。
        let recs = vec![
            mk("1780144036000_x", "2026-05-30 20:27:16"),
            mk("1780139423000_x", "2026-05-30 19:10:23"),
            mk("1780131886000_x", "2026-05-30 17:04:46"),
        ];
        let (oldest, newest, newest_ms) = page_bounds(&recs);
        assert_eq!(
            oldest.as_deref(),
            Some("1780131886000_x"),
            "最旧=sort_key 最小"
        );
        assert_eq!(
            newest.as_deref(),
            Some("1780144036000_x"),
            "最新=sort_key 最大"
        );
        // split_sort_key_ms 取前导数字串:`1780144036000_x` → 1780144036000(下划线分隔也能解析)。
        // freshness = max(sort_key 前导 ms, message_time 解析 ms),取最新一条;sort_key 前导 ms
        // (1780144036000)大于 message_time 解析值,故 newest_ms 命中前导 ms。
        let mt = parse_server_time_to_ms("2026-05-30 20:27:16");
        assert_eq!(newest_ms, 1_780_144_036_000i64.max(mt));
        assert_eq!(newest_ms, 1_780_144_036_000);
        assert_eq!(page_bounds(&[]).0, None, "空页 → None");
    }

    // 回归:上游业务后台实时推送/历史的附件原始形态(ossFilePath/fileSuffix/字符串 fileSize)
    // 必须能解析进规范 HistoryAttachment(此前对不上 mediaId/fileType/i64 → 整条附件丢失 → 图片不显示)。
    #[test]
    fn history_attachment_parses_upstream_oss_shape() {
        let raw = r#"{"attachmentType":1,"fileName":"image.png","fileSuffix":"png","fileSize":"176098","ossFilePath":"t/dev/wechat-business-app/2026/05/30/191024_76145588.png","ossPreviewFilePath":"","durationSeconds":null,"transferStatus":2,"transferFailReason":""}"#;
        let a: HistoryAttachment = serde_json::from_str(raw).expect("上游 OSS 附件形态应能解析");
        assert_eq!(
            a.media_id,
            "t/dev/wechat-business-app/2026/05/30/191024_76145588.png"
        );
        assert_eq!(a.file_type, "png");
        assert_eq!(a.file_size, 176098);
        assert_eq!(a.file_name, "image.png");
        assert_eq!(a.transfer_status, 2);
        assert_eq!(a.duration_seconds, None);
        assert_eq!(a.attachment_type, 1, "attachmentType=1 权威图片类型须捕获");
    }

    // 回归(本次 bug):实时推送的图片附件只带 attachmentType + ossFilePath,**无 fileSuffix/fileName**。
    // 此前因 HistoryAttachment 不捕获 attachmentType,前端只能退回空 fileType → 误判成文件。
    // 现在 attachment_type 须落到 1,file_type 允许为空(扩展名仅在文件类时细分)。
    #[test]
    fn history_attachment_parses_realtime_push_image_without_filesuffix() {
        let raw = r#"{"attachmentType":1,"fileMd5":"40ea3324c64fcebd1276cd1abd08655b","fileSize":2341,"imageHeight":125,"imageWidth":162,"ossFilePath":"t/dev/wechat-business-app/wecom/chat/2026/06/04/190543_5ddad58e.jpg","ossPreviewFilePath":"https://filet.jdd51.com/t/dev/wechat-business-app/wecom/chat/2026/06/04/190543_5ddad58e.jpg","transferStatus":2}"#;
        let a: HistoryAttachment = serde_json::from_str(raw).expect("实时推送图片附件应能解析");
        assert_eq!(a.attachment_type, 1, "推送图片 attachmentType=1");
        assert_eq!(
            a.media_id, "t/dev/wechat-business-app/wecom/chat/2026/06/04/190543_5ddad58e.jpg",
            "ossFilePath → media_id"
        );
        assert_eq!(
            a.file_type, "",
            "推送无 fileSuffix → file_type 空,改由 attachment_type 定类"
        );
        assert_eq!(a.file_size, 2341);
        assert_eq!(a.transfer_status, 2);
        // 服务端 imageWidth/imageHeight 须被捕获(经 alias),供前端首帧定比例盒。
        assert_eq!(a.width, Some(162), "imageWidth → width");
        assert_eq!(a.height, Some(125), "imageHeight → height");
    }

    // 规范形态(本地发送回显落库的 mediaId/数字 fileSize)仍正常解析,不被上游兼容改动破坏。
    #[test]
    fn history_attachment_parses_canonical_shape() {
        let raw = r#"{"mediaId":"t/x.png","fileName":"x.png","fileSize":42,"fileType":"png"}"#;
        let a: HistoryAttachment = serde_json::from_str(raw).expect("规范附件形态应能解析");
        assert_eq!(a.media_id, "t/x.png");
        assert_eq!(a.file_size, 42);
        assert_eq!(a.file_type, "png");
        assert_eq!(a.transfer_status, 0);
        assert_eq!(
            a.attachment_type, 0,
            "无 attachmentType → 默认 0(调用方回退扩展名)"
        );
    }

    // 回归:推送原文(含 attachmentType、无 fileSuffix)作为 attachments_json 落库后,
    // 经 row_to_history 读回前端形态时,attachment_type 必须**透传不丢**(此前会被丢弃)。
    #[test]
    fn row_to_history_preserves_attachment_type_from_push_raw() {
        let row = MessageRow {
            local_message_id: "m1".into(),
            conversation_id: "c1".into(),
            employee_id: "u1".into(),
            wecom_account_id: "wa1".into(),
            sort_key: "1780571140000_00000000000011975805_2062490980266803200".into(),
            message_time_ms: 1_780_571_140_000,
            message_direction: 1,
            source_direction: 2,
            message_type: 2,
            content_text: "".into(),
            send_status: 0,
            attachments_json:
                r#"[{"attachmentType":1,"fileSize":2341,"imageHeight":125,"imageWidth":162,"ossFilePath":"t/dev/wechat-business-app/wecom/chat/2026/06/04/190543_5ddad58e.jpg","transferStatus":2}]"#
                    .into(),
            gmt_modified_time: "".into(),
            revoked: false,
            fail_reason: "".into(),
            request_message_id: "".into(),
            updated_at_ms: 0,
        };
        let h = row_to_history(&row);
        assert_eq!(h.attachments.len(), 1);
        assert_eq!(
            h.attachments[0].attachment_type, 1,
            "attachmentType 经 parse→serialize 往返须存活"
        );
        assert_eq!(
            h.attachments[0].file_type, "",
            "推送无 fileSuffix,file_type 留空"
        );
        // 推送原文的 imageWidth/imageHeight 经 parse(alias 捕获)→serialize(规范键 width/height)
        // 往返后须存活,读回前端即带尺寸 → 收图首帧正确比例盒、不依赖 OSS 取尺寸。
        assert_eq!(h.attachments[0].width, Some(162), "imageWidth 往返存活");
        assert_eq!(h.attachments[0].height, Some(125), "imageHeight 往返存活");
    }

    #[test]
    fn history_to_row_translates_source_direction_to_local() {
        // 上游方向契约:1=发送方,2=客户/接收方,3=多端同步方;本地:2=out,1=in。
        let mk = |dir: i32| HistoryMessage {
            local_message_id: "m1".into(),
            message_direction: dir,
            message_type: 1,
            content_text: "hi".into(),
            send_status: 3,
            message_time: "2026-05-30 10:00:00".into(),
            sort_key: "1780000000000_x_m1".into(),
            synced_from_other_device: false,
            attachments: vec![],
            gmt_modified_time: "".into(),
            revoked: false,
            fail_reason: "".into(),
            request_message_id: "".into(),
        };
        assert_eq!(
            history_to_row(&mk(1), "c1", "u1", "wa1").message_direction,
            2,
            "1=发送方 → 本地 2(out)"
        );
        assert_eq!(
            history_to_row(&mk(2), "c1", "u1", "wa1").message_direction,
            1,
            "2=客户/接收方 → 本地 1(in)"
        );
        assert_eq!(
            history_to_row(&mk(3), "c1", "u1", "wa1").message_direction,
            2,
            "3=多端同步方 → 本地 2(out)"
        );
        // 源方向原样持久化(供 row_to_history 派生本地方向 + 多端同步标记,不再靠 sort_key)。
        assert_eq!(
            history_to_row(&mk(1), "c1", "u1", "wa1").source_direction,
            1
        );
        assert_eq!(
            history_to_row(&mk(2), "c1", "u1", "wa1").source_direction,
            2
        );
        assert_eq!(
            history_to_row(&mk(3), "c1", "u1", "wa1").source_direction,
            3
        );
    }

    #[test]
    fn history_to_row_lifts_multi_device_sync_unset_send_status() {
        // 多端同步历史行(message/history 返回源方向 3 + send_status 0):出站(2)且归一为成功(3),
        // 与 push 路径一致 → 冷会话首开经 history 落库后出站气泡不再永久转圈。
        let mk = |dir: i32, status: i32| HistoryMessage {
            local_message_id: "m1".into(),
            message_direction: dir,
            message_type: 1,
            content_text: "123".into(),
            send_status: status,
            message_time: "2026-06-06 14:48:21".into(),
            sort_key: "1780728501000_00000000000005336575_2063150995537395712".into(),
            synced_from_other_device: false,
            attachments: vec![],
            gmt_modified_time: "".into(),
            revoked: false,
            fail_reason: "".into(),
            request_message_id: "".into(),
        };
        let synced = history_to_row(&mk(3, 0), "c1", "u1", "wa1");
        assert_eq!(synced.message_direction, 2, "源方向 3 → out");
        assert_eq!(synced.send_status, 3, "多端同步 sendStatus=0 → 归一成功");
        // 发送方在途(源方向 1 + status 0)绝不被误伤:保持 0(正常发送生命周期未终态)。
        assert_eq!(
            history_to_row(&mk(1, 0), "c1", "u1", "wa1").send_status,
            0,
            "发送方 sendStatus=0 是合法在途,不归一"
        );
    }

    #[test]
    fn row_to_history_derives_direction_and_synced_from_source_direction() {
        // 真实 sort_key 是「13位ms_20位序列_id」下划线三段、不含方向段:故本地方向与「多端同步」
        // 标记一律由持久化的 source_direction 派生,绝不解析 opaque 的 sort_key(用真实下划线 key
        // 作样本,反向证明读路径不依赖它)。
        let mut row = MessageRow {
            local_message_id: "m1".into(),
            conversation_id: "c1".into(),
            employee_id: "u1".into(),
            wecom_account_id: "wa1".into(),
            sort_key: "1770000000000_00000000000000009001_m1".into(),
            message_time_ms: parse_server_time_to_ms("2026-05-30 10:00:00"),
            message_direction: 0,
            source_direction: 2,
            message_type: 1,
            content_text: "hi".into(),
            send_status: 3,
            attachments_json: "[]".into(),
            gmt_modified_time: "".into(),
            revoked: false,
            fail_reason: "".into(),
            request_message_id: "".into(),
            updated_at_ms: 0,
        };

        // 源方向 2=客户/接收方 → 本地 in,非多端同步。
        assert_eq!(
            row_to_history(&row).message_direction,
            1,
            "源方向 2 → 本地 in"
        );
        assert!(
            !row_to_history(&row).synced_from_other_device,
            "源方向 2(客户/接收方)非多端同步"
        );

        // 源方向 1=发送方(本端直发)→ 本地 out,非多端同步。
        row.source_direction = 1;
        assert_eq!(
            row_to_history(&row).message_direction,
            2,
            "源方向 1 → 本地 out"
        );
        assert!(
            !row_to_history(&row).synced_from_other_device,
            "源方向 1(本端发送)非多端同步"
        );

        // 源方向 3=多端同步方 → 本地 out + synced_from_other_device=true(差异化样式据此触发)。
        row.source_direction = 3;
        assert_eq!(
            row_to_history(&row).message_direction,
            2,
            "源方向 3 → 本地 out"
        );
        assert!(
            row_to_history(&row).synced_from_other_device,
            "源方向 3 → 多端同步,synced_from_other_device=true"
        );

        // 老库行(source_direction=0,V29 迁移前):回退到既有 message_direction 列(V20 已修正),
        // 方向不受影响;无从判定多端同步 → false(下次 reconcile 经 upsert 回填源方向后自愈)。
        row.source_direction = 0;
        row.message_direction = 2;
        assert_eq!(
            row_to_history(&row).message_direction,
            2,
            "老行 source_direction=0 → 回退 message_direction(out)"
        );
        assert!(
            !row_to_history(&row).synced_from_other_device,
            "老行无法判定多端同步 → false"
        );
        row.message_direction = 1;
        assert_eq!(
            row_to_history(&row).message_direction,
            1,
            "老行 source_direction=0 → 回退 message_direction(in)"
        );
    }

    #[test]
    fn sort_history_records_ascending_normalizes_descending_pages() {
        let mk = |id: &str, sort_key: &str| HistoryMessage {
            local_message_id: id.into(),
            message_direction: 1,
            message_type: 1,
            content_text: id.into(),
            send_status: 3,
            message_time: "2026-05-30 10:00:00".into(),
            sort_key: sort_key.into(),
            synced_from_other_device: false,
            attachments: vec![],
            gmt_modified_time: "".into(),
            revoked: false,
            fail_reason: "".into(),
            request_message_id: "".into(),
        };
        let mut recs = vec![
            mk("new", "1780144036000:2:00000000000000000003:new"),
            mk("mid", "1780139423000:2:00000000000000000002:mid"),
            mk("old", "1780131886000:1:00000000000000000001:old"),
        ];

        sort_history_records_ascending(&mut recs);

        assert_eq!(
            recs.iter()
                .map(|r| r.local_message_id.as_str())
                .collect::<Vec<_>>(),
            ["old", "mid", "new"],
            "无论上游页是新→旧还是旧→新,入库/返回前都必须规整为旧→新"
        );
    }

    // lazy channel 指向死地址:send_message 的 hub API 调用必然失败,但 ensure_window 在 API
    // 之前已执行 → 即使 API 失败,会话窗口也已建好;且 send 不再本地写消息行 → 行存为空。
    // 这同时验证:① ensure_window 在 API 调用之前(顺序契约,readCache 触发链前提);
    // ② send 不再写消息行(改由 SEND_PENDING_CREATED/SEND_CONFIRMED push 落库)。
    async fn sync_with_dead_hub() -> (MessageSync, MessagesStore) {
        use chathub_state::SqlitePool;
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = MessagesStore::new(pool.clone());
        let ep = crate::channel::build_endpoint("http://127.0.0.1:1").expect("ep");
        let channel = ep.connect_lazy();
        let token_store = std::sync::Arc::new(crate::token::TokenStore::new(
            ep,
            chathub_state::LocalTokenStore::new(pool.clone()),
            "dev-test".into(),
        ));
        let interceptor = crate::interceptor::AuthInterceptor::new(token_store);
        let hub = crate::hub::HubClient::new(channel, interceptor);
        let (tx, _rx) = broadcast::channel(16);
        let sync = MessageSync::new(store.clone(), hub, tx);
        (sync, store)
    }

    #[tokio::test]
    async fn send_message_ensures_window_then_does_not_write_message_row() {
        let (sync, store) = sync_with_dead_hub().await;
        let conv = "2060260503288029184";
        let employee = "1674614956223361024";
        let wecom = "GuoHeZuZi";
        let ext = "wmITqmBgAAZg4SntYu9tFAcrFp1GZrKg";

        // hub API 必然失败(死地址),send_message 返回 Err。
        let res = sync
            .send_message(
                conv,
                wecom,
                ext,
                employee,
                1,
                "hello",
                None,
                None,
                None,
                None,
                "client-msg-1",
            )
            .await;
        assert!(res.is_err(), "死地址 hub API 应失败");

        // 但 ensure_window 在 API 之前已执行 → 该会话已有窗。
        let window = store.get_window(employee, conv).await.expect("get_window");
        assert!(window.is_some(), "ensure_window 必须在 API 调用前建好空窗");

        // send 不再本地写消息行 → 行存为空(消息行改由 push applier 落库)。
        let rows = store
            .list_conversation_asc(employee, conv)
            .await
            .expect("list_conversation_asc");
        assert!(rows.is_empty(), "send_message 不应再本地写任何消息行");
    }

    fn failed_row(local: &str, reqid: &str) -> chathub_state::MessageRow {
        chathub_state::MessageRow {
            local_message_id: local.into(),
            conversation_id: "c1".into(),
            employee_id: "E".into(),
            wecom_account_id: "wa".into(),
            sort_key: format!("1780000000000_00000000000000000000_{local}"),
            message_time_ms: 1_780_000_000_000,
            message_direction: 2,
            source_direction: 1,
            message_type: 1,
            content_text: "x".into(),
            send_status: 4,
            attachments_json: "[]".into(),
            gmt_modified_time: String::new(),
            revoked: false,
            fail_reason: "r".into(),
            request_message_id: reqid.into(),
            updated_at_ms: 0,
        }
    }

    #[test]
    fn preserve_failed_keeps_only_rows_not_in_server_page_reqids() {
        let failed = vec![failed_row("f1", "f1"), failed_row("f2", "f2")];
        let mut page = std::collections::HashSet::new();
        page.insert("f2".to_string());
        let kept = preserve_failed(failed, &page);
        let ids: Vec<_> = kept.iter().map(|r| r.local_message_id.as_str()).collect();
        assert_eq!(ids, ["f1"], "服务端已知 reqid 的失败行不保活,未知的保活");
    }

    #[test]
    fn row_to_history_recovers_out_direction_from_underscore_sort_key() {
        let r = chathub_state::MessageRow {
            local_message_id: "m1".into(),
            conversation_id: "c1".into(),
            employee_id: "E".into(),
            wecom_account_id: "wa".into(),
            sort_key: "1780000000000_00000000000000000000_m1".into(), // 下划线三段,无冒号
            message_time_ms: 1_780_000_000_000,
            message_direction: 2,
            source_direction: 0, // 老行(V29 迁移前):未知源方向 → 读路径回退 stored direction
            message_type: 1,
            content_text: "x".into(),
            send_status: 4,
            attachments_json: "[]".into(),
            gmt_modified_time: String::new(),
            revoked: false,
            fail_reason: "r".into(),
            request_message_id: "m1".into(),
            updated_at_ms: 0,
        };
        // 老行 source_direction=0 → 回落 stored direction=2(out)。HistoryMessage.message_direction=2 即出站。
        // (sort_key 是真实下划线三段,不含方向段;读路径不再解析它。)
        assert_eq!(row_to_history(&r).message_direction, 2);
    }

    fn srv_row(local: &str, reqid: &str, status: i32) -> chathub_state::MessageRow {
        chathub_state::MessageRow {
            local_message_id: local.into(),
            conversation_id: "c1".into(),
            employee_id: "E".into(),
            wecom_account_id: "wa".into(),
            sort_key: format!("1780000000100_00000000000000000001_{local}"),
            message_time_ms: 1_780_000_000_100,
            message_direction: 1,
            source_direction: 2,
            message_type: 1,
            content_text: "s".into(),
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
    async fn reconcile_replace_preserves_unconverged_failed_rows() {
        use chathub_state::{MessagesStore, SqlitePool};
        let pool = SqlitePool::in_memory().await.unwrap();
        let store = MessagesStore::new(pool);
        // 本地两条未收敛失败行(各自 reqid=local)
        store
            .insert_failed_outbox(
                "E",
                "c1",
                "wa",
                "ext",
                "f1",
                1_780_000_000_000,
                1,
                "a",
                "r",
                "[]",
                None,
            )
            .await
            .unwrap();
        store
            .insert_failed_outbox(
                "E",
                "c1",
                "wa",
                "ext",
                "f2",
                1_780_000_000_001,
                1,
                "b",
                "r",
                "[]",
                None,
            )
            .await
            .unwrap();

        // 服务端首页:一条 reqid=f2 的成功行(f2 已被服务端回显/收敛)+ 一条普通 server 行(reqid 空)。
        let page = vec![srv_row("server-A", "f2", 3), srv_row("server-B", "", 3)];
        let page_reqids: std::collections::HashSet<String> =
            page.iter().map(|r| r.request_message_id.clone()).collect();

        // === 复刻 reconcile_newest Replace 保活序列 ===
        let preserved = preserve_failed(
            store.list_failed_outbox("E", "c1").await.unwrap(),
            &page_reqids,
        );
        store.delete_conversation("E", "c1").await.unwrap();
        store.upsert_messages(&page).await.unwrap();
        store.upsert_messages(&preserved).await.unwrap();

        let got = store.list_conversation_asc("E", "c1").await.unwrap();
        let ids: std::collections::HashSet<&str> =
            got.iter().map(|r| r.local_message_id.as_str()).collect();
        // f1 未在服务端首页 reqid 集合 → 保活;f2 已收敛(reqid 在页) → 不保活,由 server-A 取代。
        assert!(ids.contains("f1"), "未收敛失败行 f1 必须保活");
        assert!(
            !ids.contains("f2"),
            "已被服务端回显(reqid 在页)的失败行不保活"
        );
        // server 多态行不被去重 DELETE 误删(server-A status=3≠4,且 f2 已被 delete_conversation 清掉)。
        assert!(
            ids.contains("server-A") && ids.contains("server-B"),
            "server 行不被误删"
        );
        assert_eq!(got.len(), 3, "应为 server-A/server-B/f1 三行,无重影");
    }
}
