//! SyncEngine — 数据同步层(2026-06-03 从 `ConnectionManager.run_loop` 抽出)。
//!
//! 职责边界(与连接层**完全单向隔离**):
//!   - 输入:连接层逐帧喂入的 `ServerEvent`(见 [`SyncEngine::handle_frame`])。SyncEngine 只读帧、
//!     不持有连接句柄,**绝不触发重连、绝不修改连接态**。需要"重拉"时只广播 ResyncSignal /
//!     resync ChangeNotice,由上层走 REST 全量软重拉。
//!   - 做三件事:① `PushBatch` → 四个 applier 落库 + apply-then-advance 推进 notify_seq 水位;
//!     ② `SubscribeAck.resync_required` / `SystemSignal::ResyncRequired` → 广播 ResyncSignal +
//!     给所有 topic 发 resync ChangeNotice;③ 暴露 [`SyncEngine::durable_seq`] 供连接层读已落库
//!     水位发 ack。
//!   - 不做:连接生命周期、在线状态机、是否断重连——那是连接层的事。SyncEngine 通过
//!     [`FrameOutcome`] 把"这是首帧 ack"回报给连接层,由连接层决策(单向)。
//!
//! D4 不变量(跨层拆分后仍须成立):`durable_seq()` 是 `NotifySeqStore::read()` 的薄包装、直读
//! SQLite,本结构**不持有任何内存水位字段**,故连接层永远读不到"超前于已落库"的 seq;水位推进
//! 只在 applier 落库之后(apply-then-advance)。

use crate::account_event::AccountEventApplier;
use crate::change_notice::{ChangeNotice, ChangeScope, ChangeTopic};
use crate::friend_event::FriendEventApplier;
use crate::hub::ResyncSignal;
use crate::message_event::MessageEventApplier;
use crate::recent_session_event::RecentSessionEventApplier;
use crate::token::TokenStore;
use chathub_proto::v1::ServerEvent;
use chathub_state::NotifySeqStore;
use std::sync::Arc;
use tokio::sync::broadcast;

/// resync 全量对齐时需广播 BulkInvalidate 的 topic 集合(安全网 §6.4)。
/// 含 ConversationMessages:B2 跳重放后,打开会话气泡的 reconcile 触发恰依赖被跳的
/// MESSAGE_UPSERT push,故 resync 必须显式覆盖此 topic 让前端主动 reconcile。
const RESYNC_BROADCAST_TOPICS: [ChangeTopic; 4] = [
    ChangeTopic::Accounts,
    ChangeTopic::Friends,
    ChangeTopic::RecentSessions,
    ChangeTopic::ConversationMessages,
];

/// B1(spec §6.1):订阅首帧 `SubscribeAck` 后,该不该从 ack 提前推进 notify_seq 游标?
///
/// - `resync_required == true`:返回 `Some(replayed_to_seq)` —— 跳到 head/水位。该路径
///   B2 不发重放帧、且已广播 ResyncSignal 让上层走 REST 全量兜底,提前推进安全。
/// - `resync_required == false`:返回 `None` —— **不**从 ack 推,维持 apply-then-advance
///   (只靠 PushBatch 经 applier 落库后 `upsert_if_greater(pb.notify_seq)`)。在 false 小回放
///   路径从 ack 提前推 = 落库前推进 → 崩溃重启跳过该批且无兜底 → 永久丢。
///
/// 纯函数无副作用,便于单测(run_loop 无假流夹具)。
pub(crate) fn cursor_after_subscribe_ack(
    resync_required: bool,
    replayed_to_seq: u64,
) -> Option<u64> {
    if resync_required {
        Some(replayed_to_seq)
    } else {
        None
    }
}

/// [`SyncEngine::handle_frame`] 回报给连接层的决策信息(SyncEngine → 连接层,单向)。
#[derive(Default)]
pub(crate) struct FrameOutcome {
    /// 本帧是否 `SubscribeAck`。连接层据此把在线态收紧到"收到首个 ack"(防"流开了但 ack 没回"的假在线)。
    pub is_subscribe_ack: bool,
}

/// 数据同步层。详见模块文档。
pub(crate) struct SyncEngine {
    notify_seq_store: NotifySeqStore,
    /// 仅用于 [`SyncEngine::broadcast_resync_to_all_topics`] 取当前会话 user_id;与连接层共享同一 Arc。
    token_store: Arc<TokenStore>,
    /// SubscribeAck.resync_required / SystemSignal::ResyncRequired 触发,上层桥接 → app.emit。
    resync_tx: broadcast::Sender<ResyncSignal>,
    /// 统一变更通知通道 — applier / 用户命令 / resync 都往这里发,上层桥接 → app.emit("hub:change")。
    change_notice_tx: broadcast::Sender<ChangeNotice>,
    account_event_applier: Option<Arc<AccountEventApplier>>,
    friend_event_applier: Option<Arc<FriendEventApplier>>,
    recent_session_event_applier: Option<Arc<RecentSessionEventApplier>>,
    message_event_applier: Option<Arc<MessageEventApplier>>,
}

impl SyncEngine {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        notify_seq_store: NotifySeqStore,
        token_store: Arc<TokenStore>,
        change_notice_tx: broadcast::Sender<ChangeNotice>,
        account_event_applier: Option<Arc<AccountEventApplier>>,
        friend_event_applier: Option<Arc<FriendEventApplier>>,
        recent_session_event_applier: Option<Arc<RecentSessionEventApplier>>,
        message_event_applier: Option<Arc<MessageEventApplier>>,
    ) -> Self {
        let (resync_tx, _) = broadcast::channel(16);
        Self {
            notify_seq_store,
            token_store,
            resync_tx,
            change_notice_tx,
            account_event_applier,
            friend_event_applier,
            recent_session_event_applier,
            message_event_applier,
        }
    }

    /// 订阅"请全量重拉"信号。两条触发路径(SubscribeAck.resync_required /
    /// SystemSignal::ResyncRequired)都汇聚到这里。上层调一次首页对齐即可。
    pub(crate) fn resync_subscribe(&self) -> broadcast::Receiver<ResyncSignal> {
        self.resync_tx.subscribe()
    }

    /// 订阅统一变更通知。setup 阶段桥接到 app.emit("hub:change")。
    pub(crate) fn change_notice_subscribe(&self) -> broadcast::Receiver<ChangeNotice> {
        self.change_notice_tx.subscribe()
    }

    /// 读已落库水位(= 已 apply-then-advance 的最高 seq)。
    /// D4:纯 SQLite 薄包装、不缓存,故连接层经此发 ack 永远读不到"超前于已落库"的 seq。
    pub(crate) async fn durable_seq(&self) -> u64 {
        self.notify_seq_store.read().await.unwrap_or(0)
    }

    /// 处理一帧 `ServerEvent`:applier 落库 + apply-then-advance 水位 + resync 编排。
    /// 返回 [`FrameOutcome`] 供连接层做在线态 / 回放上界决策。**绝不触发重连、不改连接态。**
    pub(crate) async fn handle_frame(&self, event: &ServerEvent) -> FrameOutcome {
        use chathub_proto::v1::server_event::Body;
        use chathub_proto::v1::system_signal::Kind;

        let mut outcome = FrameOutcome::default();

        // 标记首帧 ack(连接层据此把在线态置 Subscribed)。
        if let Some(Body::SubscribeAck(_)) = &event.body {
            outcome.is_subscribe_ack = true;
        }

        // resync 信号汇聚:两条路径都触发上层全量重拉(走 REST,不碰连接)。
        //   1) Subscribe 首帧 ack.resync_required=true(超 retention 或积压截断)
        //   2) 实时流 SystemSignal::ResyncRequired(服务端主动)
        match &event.body {
            Some(Body::SubscribeAck(ack)) if ack.resync_required => {
                tracing::info!(
                    target: "chathub_net::sync",
                    reason = %ack.resync_reason,
                    resumed_from_seq = ack.resumed_from_seq,
                    replayed_to_seq = ack.replayed_to_seq,
                    "SubscribeAck.resync_required=true; broadcasting ResyncSignal"
                );
                let _ = self.resync_tx.send(ResyncSignal {
                    reason: ack.resync_reason.clone(),
                });
                self.broadcast_resync_to_all_topics();
                // B1(spec §6.1):仅 resync 路径从 ack 推进游标到 head/水位。该路径 B2 不发重放帧、
                // 已广播 ResyncSignal 走 REST 全量兜底,提前推进安全。false 路径不进此分支,游标仍靠
                // PushBatch 落库后推进(apply-then-advance,见下方 upsert_if_greater)。
                if let Some(advance) = cursor_after_subscribe_ack(true, ack.replayed_to_seq) {
                    if let Err(e) = self.notify_seq_store.upsert_if_greater(advance).await {
                        tracing::warn!(
                            target: "chathub_net::sync",
                            ?e,
                            advance,
                            "resync ack cursor advance upsert failed, ignored"
                        );
                    } else {
                        tracing::info!(
                            target: "chathub_net::sync",
                            advance,
                            "resync ack: notify_seq cursor advanced to head"
                        );
                    }
                }
            }
            Some(Body::System(s)) if s.kind == Kind::ResyncRequired as i32 => {
                tracing::info!(
                    target: "chathub_net::sync",
                    detail = %s.detail,
                    "SystemSignal::ResyncRequired received; broadcasting ResyncSignal"
                );
                let _ = self.resync_tx.send(ResyncSignal {
                    reason: s.detail.clone(),
                });
                self.broadcast_resync_to_all_topics();
            }
            _ => {}
        }

        // PushBatchOut → 账号/好友/会话/消息 applier 应用 → **应用后**推进水位(apply-then-advance)。
        // 水位必须在 appliers 提交 SQLite 之后才前进:否则崩溃重启会用一个超前的 since 重订阅,
        // 跳过尚未落库的批次(数据丢失到下次 resync)。
        if let Some(Body::PushBatch(pb)) = &event.body {
            if let Some(applier) = &self.account_event_applier {
                applier.apply_push_batch(pb).await;
            }
            if let Some(applier) = &self.friend_event_applier {
                applier.apply_push_batch(pb).await;
            }
            if let Some(applier) = &self.recent_session_event_applier {
                applier.apply_push_batch(pb).await;
            }
            if let Some(applier) = &self.message_event_applier {
                applier.apply_push_batch(pb).await;
            }
            // 四个 applier 都已 best-effort 应用(失败内部 log + 安排 fallback),现在才推进全局水位。
            if let Err(e) = self.notify_seq_store.upsert_if_greater(pb.notify_seq).await {
                tracing::warn!(target: "chathub_net::sync", ?e, "notify_seq_store upsert failed, ignored");
            }
        }

        outcome
    }

    /// Resync 路径触发 — 给所有已知 topic 各发一条 BulkInvalidate ChangeNotice。
    /// employee_id 取 token_store 当前会话的 user_id;若未登录(异常路径),不发。
    fn broadcast_resync_to_all_topics(&self) {
        let employee_id = match self.token_store.current_user_id() {
            Some(uid) if !uid.is_empty() => uid,
            _ => return,
        };
        let scope = ChangeScope::employee(employee_id);
        for topic in RESYNC_BROADCAST_TOPICS {
            let _ = self
                .change_notice_tx
                .send(ChangeNotice::resync(topic, scope.clone()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ack_cursor_advances_only_when_resync_required() {
        // resync_required=true:游标跳到 ack.replayed_to_seq(head/水位),提前推进安全。
        assert_eq!(cursor_after_subscribe_ack(true, 948), Some(948));
        // resync_required=false:不从 ack 推(维持 apply-then-advance,靠 PushBatch 落库后推进)。
        assert_eq!(cursor_after_subscribe_ack(false, 152), None);
        // resync_required=true 但 head=0(空表回退 since=0 的换机场景):推进到 0 无害(单调存储不回退)。
        assert_eq!(cursor_after_subscribe_ack(true, 0), Some(0));
    }

    #[test]
    fn resync_broadcast_covers_conversation_messages() {
        // 安全网 #4(spec §6.4-4):resync 必须覆盖 ConversationMessages,否则 B2 跳重放后
        // 打开会话气泡不触发 reconcile。
        assert!(RESYNC_BROADCAST_TOPICS.contains(&ChangeTopic::ConversationMessages));
        assert!(RESYNC_BROADCAST_TOPICS.contains(&ChangeTopic::Accounts));
        assert!(RESYNC_BROADCAST_TOPICS.contains(&ChangeTopic::Friends));
        assert!(RESYNC_BROADCAST_TOPICS.contains(&ChangeTopic::RecentSessions));
    }
}
