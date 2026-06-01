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
use crate::message_event::to_local_direction;
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
        message_type: h.message_type,
        content_text: h.content_text.clone(),
        send_status: h.send_status,
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
        updated_at_ms: 0,
    }
}

/// `MessageRow`(行存)→ `HistoryMessage`(API 形态;读命令返给前端,复用既有适配器)。
pub fn row_to_history(r: &MessageRow) -> HistoryMessage {
    HistoryMessage {
        local_message_id: r.local_message_id.clone(),
        message_direction: normalize_local_direction_from_sort_key(
            r.message_direction,
            &r.sort_key,
        ),
        message_type: r.message_type,
        content_text: r.content_text.clone(),
        send_status: r.send_status,
        message_time: ms_to_server_time(r.message_time_ms),
        sort_key: r.sort_key.clone(),
        attachments: serde_json::from_str::<Vec<HistoryAttachment>>(&r.attachments_json)
            .unwrap_or_default(),
        gmt_modified_time: r.gmt_modified_time.clone(),
    }
}

fn normalize_local_direction_from_sort_key(stored_direction: i32, sort_key: &str) -> i32 {
    let source_direction = sort_key
        .split(':')
        .nth(1)
        .and_then(|s| s.parse::<i64>().ok());
    match source_direction {
        Some(direction @ 1..=3) => to_local_direction(direction),
        _ => normalize_stored_local_direction(stored_direction),
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

fn outgoing_sort_key(freshness_ms: i64, now_ms: i64) -> String {
    format!("{freshness_ms:013}:1:{now_ms:020}")
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
                self.store
                    .delete_conversation(employee_id, conversation_id)
                    .await
                    .map_err(state_err)?;
                self.store.upsert_messages(&rows).await.map_err(state_err)?;
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
                self.store.upsert_messages(&rows).await.map_err(state_err)?;
                // 首页最新 > 缓存原 newest 才算「有新消息到达」(sort_key 同构,字典序即时序)。
                let advanced = matches!(
                    (prev_newest_sort_key.as_deref(), page_newest.as_deref()),
                    (Some(prev), Some(curr)) if curr > prev
                );
                // 只扩 newest 上界,下界 / older_cursor / has_more_older 不动。
                if let (Some(mut w), Some(newest)) = (window, page_newest) {
                    w.newest_sort_key = newest;
                    w.newest_message_time_ms = w.newest_message_time_ms.max(page_newest_ms);
                    let now = now_ms();
                    w.reconciled_at_ms = now;
                    w.last_accessed_ms = now;
                    self.store.upsert_window(w).await.map_err(state_err)?;
                }
                advanced
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

    /// 发送一条文本消息(`messageType=1`):调 hub → 落库(出站气泡)→ 推进/建窗 →
    /// 发 ConversationMessages ChangeNotice 让打开着的会话重读缓存追加气泡。
    ///
    /// 排序键用与协议同构的 `{ms:013}:1:{seq:020}`(`1`=发送方),与入站/历史/推送的
    /// `{epochMs}:{dir}:{seq}` 同源可比。**不能再用旧的 `~{ms}` 前缀**:`~`(0x7E)词典序大于
    /// 所有数字开头的 key,会把出站气泡永久钉在最底,导致之后到达的入站消息(数字开头)
    /// 反而排到出站消息上方 → 乱序。改用真实 ms 后,出站气泡按发送时刻与入站消息正确穿插。
    /// UPSERT 冻结 sort_key,后续重对齐(Stitch)不会移位。
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

        let now = now_ms();
        let parsed_ms = parse_server_time_to_ms(&resp.message_time);
        let freshness_ms = if parsed_ms > 0 { parsed_ms } else { now };
        // 与协议同构:{ms:013}:{dir=1}:{seq:020}。ms 取服务端回填时间(无则用 now),保证按真实
        // 发送时刻与入站消息穿插;seq 用 now 这个大值,使同毫秒内本出站气泡排在入站之后(更靠底)。
        let sort_key = outgoing_sort_key(freshness_ms, now);

        // 落库形态按 message_type 分流:
        //   - 文本(1):content_text 落实文本,attachments_json 落空数组。
        //   - 附件(2/3/4):content_text 落空串,attachments_json 落单条 [{mediaId, fileName,
        //     fileSize, fileType}];mediaId 存 objectName(即 file_path),fileType 从文件名后缀
        //     推断。发送成功后的 ChangeNotice → 前端重读缓存 → row_to_history → 前端按附件渲染。
        let (row_content_text, row_attachments_json) = if message_type == 1 {
            (content_text.to_string(), "[]".to_string())
        } else {
            let fname = file_name.unwrap_or("").to_string();
            let att = HistoryAttachment {
                media_id: file_path.unwrap_or("").to_string(),
                file_name: fname.clone(),
                file_size: file_size.unwrap_or(0),
                file_type: file_suffix(&fname),
                // 发送路径无预取元数据，派生字段置 None（读消息时由预取注入）
                width: None,
                height: None,
                local_path: None,
            };
            let json = serde_json::to_string(&vec![att]).unwrap_or_else(|_| "[]".to_string());
            (String::new(), json)
        };
        let row = MessageRow {
            local_message_id: resp.local_message_id.clone(),
            conversation_id: conversation_id.to_string(),
            employee_id: employee_id.to_string(),
            wecom_account_id: wecom_account_id.to_string(),
            sort_key,
            message_time_ms: freshness_ms,
            message_direction: 2,
            message_type,
            content_text: row_content_text,
            send_status: resp.send_status,
            attachments_json: row_attachments_json,
            gmt_modified_time: resp.message_time.clone(),
            updated_at_ms: now,
        };
        // 原子写:单事务内落库出站气泡 + 推进/建窗,消除"行已落但水位未 bump"中间态——
        // 否则并发 reconcile 的 Replace 可能删掉刚发的行(水位 bump 正是会话水位门判 fresh、
        // 跳过会删它的 Replace 重对齐的依据)。窗口不存在则以这条建一扇窗(newest=oldest,
        // 保守 has_more_older=true,后续 reconcile 缝合真实历史)。
        self.store
            .upsert_message_and_bump_window(row, external_user_id.to_string(), freshness_ms)
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

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// "yyyy-MM-dd HH:mm:ss"(服务端本地,假设 UTC+8)→ epoch ms(UTC)。解析失败返 0。
pub(crate) fn parse_server_time_to_ms(s: &str) -> i64 {
    // 形如 "2026-05-17 10:01:23",定长 19 字节。
    if s.len() < 19 {
        return 0;
    }
    let b = s.as_bytes();
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
    // 服务端 UTC+8:转 UTC 要减 8 小时。
    days_from_civil(y as i32, mo as i32, d as i32) * 86_400_000
        + h * 3_600_000
        + mi * 60_000
        + se * 1_000
        - 8 * 3_600_000
}

/// 从文件名取小写后缀(不含点);无后缀返回空串。落库附件的 fileType 用它。
fn file_suffix(file_name: &str) -> String {
    file_name
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .unwrap_or_default()
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
fn days_from_civil(y: i32, m: i32, d: i32) -> i64 {
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
            attachments: vec![],
            gmt_modified_time: "".into(),
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
            attachments: vec![],
            gmt_modified_time: "".into(),
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
        // 下划线 sort_key 无法被冒号分隔解析,freshness 退化到 message_time,取最新一条。
        assert_eq!(newest_ms, parse_server_time_to_ms("2026-05-30 20:27:16"));
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
    }

    // 规范形态(本地发送回显落库的 mediaId/数字 fileSize)仍正常解析,不被上游兼容改动破坏。
    #[test]
    fn history_attachment_parses_canonical_shape() {
        let raw = r#"{"mediaId":"t/x.png","fileName":"x.png","fileSize":42,"fileType":"png"}"#;
        let a: HistoryAttachment = serde_json::from_str(raw).expect("规范附件形态应能解析");
        assert_eq!(a.media_id, "t/x.png");
        assert_eq!(a.file_size, 42);
        assert_eq!(a.file_type, "png");
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
            attachments: vec![],
            gmt_modified_time: "".into(),
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
    }

    #[test]
    fn row_to_history_normalizes_cached_source_direction_from_sort_key() {
        let mut row = MessageRow {
            local_message_id: "m1".into(),
            conversation_id: "c1".into(),
            employee_id: "u1".into(),
            wecom_account_id: "wa1".into(),
            sort_key: "1770000000000:2:00000000000000009001:m1".into(),
            message_time_ms: parse_server_time_to_ms("2026-05-30 10:00:00"),
            message_direction: 2,
            message_type: 1,
            content_text: "hi".into(),
            send_status: 3,
            attachments_json: "[]".into(),
            gmt_modified_time: "".into(),
            updated_at_ms: 0,
        };

        assert_eq!(
            row_to_history(&row).message_direction,
            1,
            "sort_key 第二段 2=客户/接收方,应返回本地 in"
        );

        row.sort_key = "1770000000000:1:00000000000000009001:m1".into();
        row.message_direction = 1;
        assert_eq!(
            row_to_history(&row).message_direction,
            2,
            "sort_key 第二段 1=发送方,应返回本地 out"
        );

        row.sort_key = "1770000000000:3:00000000000000009001:m1".into();
        row.message_direction = 1;
        assert_eq!(
            row_to_history(&row).message_direction,
            2,
            "sort_key 第二段 3=多端同步方,应返回本地 out"
        );

        row.sort_key = "legacy_sort_key_without_direction".into();
        row.message_direction = 2;
        assert_eq!(
            row_to_history(&row).message_direction,
            2,
            "不可解析 sort_key 时保留本地 out,不能再按源方向把 2 翻成 in"
        );
    }

    #[test]
    fn outgoing_sort_key_uses_sender_direction_segment() {
        assert_eq!(
            outgoing_sort_key(1_780_000_000_000, 1_780_000_000_123),
            "1780000000000:1:00000001780000000123",
            "本端发送的合成 sort_key 必须用 1=发送方,不能用 2=接收方"
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
            attachments: vec![],
            gmt_modified_time: "".into(),
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
}
