//! ConnectionRouter — 单实例 in-process 路由表(spec §7 + Plan 6)。
//!
//! 现状是新旧两套索引并存:
//!
//! ## 旧:wecom_account 维度(legacy)
//! 老 `/internal/push` 用 `accounts: account_id → ChannelEntry`,
//! Subscribe 通过 `StreamTicket.accounts` 注册多账号反向索引。
//! **锁序固定**:`users.write()` BEFORE `accounts.write()`,严禁反向。
//! `fanout` 只取 `accounts.read()`,与 register/drop_stream 互不阻塞。
//!
//! ## 新:employee 维度(Plan 6)
//! 新 `/internal/push/v2` 用 `employees: employee_id → Vec<EmployeeStream>`,
//! Subscribe 通过 `register_employee()` 把 connection_id 加入该 employee 的 Vec。
//! `ack_marks: employee_id → last_acked_notify_seq` 由 Hub.Ack 更新,仅观测。
//! 锁序:`employees` 与 `ack_marks` 互相独立,不与旧锁交叉。

use chathub_proto::v1::ServerEvent;
use dashmap::DashMap;
use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::mpsc;
use tonic::Status;
use uuid::Uuid;

pub type EventSender = mpsc::Sender<Result<ServerEvent, Status>>;

#[derive(Clone, Debug)]
pub struct StreamTicket {
    pub user_id: String,
    pub device_id: String,
    pub accounts: Vec<String>,
}

#[derive(Clone)]
struct ChannelEntry {
    tx: EventSender,
    user_id: String,
    device_id: String,
}

#[derive(Clone)]
struct UserStream {
    device_id: String,
    accounts: Vec<String>,
    tx: EventSender,
}

#[derive(thiserror::Error, Debug)]
pub enum RouterError {
    #[error("no stream")]
    NoStream,
    #[error("backpressure")]
    Backpressure,
}

/// register 返回:被踢的 prev sender 列表 + 是否为"真多端踢"(kicked=true)
/// 同 device 自重连:Vec 非空但 kicked=false。
pub struct RegisterOutcome {
    pub prev_senders: Vec<EventSender>,
    pub kicked: bool,
}

// ─── Plan 6 employee-scope routing ─────────────────────────────────────

/// 单条 employee 维度的连接(stage 3.5 起新 Subscribe 走这里)。
#[derive(Clone)]
pub struct EmployeeStream {
    /// Relay 内部 ID(UUID)。不暴露给客户端、不暴露给业务后台。
    pub connection_id: String,
    pub device_id: String,
    pub tx: EventSender,
}

/// `register_employee` 返回:本次分配的 connection_id。
pub struct EmployeeRegisterOutcome {
    pub connection_id: String,
}

/// fanout 结果:成功送达的连接数 + 反压/已关闭的连接 ID 列表(供调用方清理)。
pub struct FanoutOutcome {
    pub delivered: usize,
    /// 队列已满 — 这些 connection 应该被发 RESYNC_REQUIRED 信号 + 清理。
    pub backpressure: Vec<String>,
    /// 接收端已关 — 这些 connection 应该被清理。
    pub closed: Vec<String>,
}

pub struct Router {
    // 旧:account 索引(兼容期保留)
    users: RwLock<HashMap<String, UserStream>>,
    accounts: RwLock<HashMap<String, ChannelEntry>>,
    // 新:employee 索引(Plan 6)
    employees: RwLock<HashMap<i64, Vec<EmployeeStream>>>,
    // P1-4:ack_marks 用 DashMap + AtomicU64,per-key 细粒度锁 + 无锁 CAS,
    // 高 Ack QPS 下不再被整张 HashMap 写锁串行化
    ack_marks: DashMap<i64, AtomicU64>,
}

impl Default for Router {
    fn default() -> Self {
        Self::new()
    }
}

impl Router {
    pub fn new() -> Self {
        Self {
            users: RwLock::new(HashMap::new()),
            accounts: RwLock::new(HashMap::new()),
            employees: RwLock::new(HashMap::new()),
            ack_marks: DashMap::new(),
        }
    }

    /// **锁序:users 先,accounts 后**。
    pub fn register(&self, t: StreamTicket, tx: EventSender) -> RegisterOutcome {
        let mut users = self.users.write();
        let mut accounts = self.accounts.write();

        let mut prev_senders = Vec::new();
        let mut kicked = false;
        if let Some(existing) = users.get(&t.user_id) {
            kicked = existing.device_id != t.device_id;
            prev_senders.push(existing.tx.clone());
            for acc in &existing.accounts {
                accounts.remove(acc);
            }
        }
        users.insert(
            t.user_id.clone(),
            UserStream {
                device_id: t.device_id.clone(),
                accounts: t.accounts.clone(),
                tx: tx.clone(),
            },
        );
        for acc in &t.accounts {
            accounts.insert(
                acc.clone(),
                ChannelEntry {
                    tx: tx.clone(),
                    user_id: t.user_id.clone(),
                    device_id: t.device_id.clone(),
                },
            );
        }
        RegisterOutcome {
            prev_senders,
            kicked,
        }
    }

    /// fanout:try_send 非阻塞。Full → Backpressure;Closed/无映射 → NoStream。
    pub fn fanout(&self, account_id: &str, event: ServerEvent) -> Result<(), RouterError> {
        let entry = {
            let accounts = self.accounts.read();
            accounts.get(account_id).cloned()
        };
        match entry {
            None => Err(RouterError::NoStream),
            Some(e) => match e.tx.try_send(Ok(event)) {
                Ok(()) => Ok(()),
                Err(mpsc::error::TrySendError::Closed(_)) => Err(RouterError::NoStream),
                Err(mpsc::error::TrySendError::Full(_)) => Err(RouterError::Backpressure),
            },
        }
    }

    pub fn drop_stream(&self, user_id: &str, device_id: &str) {
        let mut users = self.users.write();
        let mut accounts = self.accounts.write();
        let should_remove = users
            .get(user_id)
            .map(|u| u.device_id == device_id)
            .unwrap_or(false);
        if should_remove {
            if let Some(u) = users.remove(user_id) {
                for acc in u.accounts {
                    accounts.remove(&acc);
                }
            }
        }
    }

    /// 原子驱逐:best-effort 发送 `drain_event` 后 drop 该账号的流。
    ///
    /// 步骤:
    /// 1. 在 `accounts` 读锁下查出 `(user_id, device_id, tx)`;
    /// 2. 释放读锁后 `try_send` drain_event(忽略结果);
    /// 3. 调 `drop_stream` 清理注册表。
    ///
    /// 若账号不存在则直接返回 `None`。
    pub fn evict_account(
        &self,
        account_id: &str,
        drain_event: ServerEvent,
    ) -> Option<(String, String)> {
        let entry = {
            let accounts = self.accounts.read();
            accounts.get(account_id).cloned()
        };
        let entry = entry?;
        let user_id = entry.user_id.clone();
        let device_id = entry.device_id.clone();
        // best-effort — 队列可能已满,忽略错误
        let _ = entry.tx.try_send(Ok(drain_event));
        self.drop_stream(&user_id, &device_id);
        Some((user_id, device_id))
    }

    // ─── Plan 6 employee-scope methods ────────────────────────────────

    /// 注册一条 employee 维度的 Subscribe 连接,返回 relay 分配的 connection_id。
    /// 同 employee 多次注册(多设备)允许 —— 同 Vec 里多条 EmployeeStream 共存。
    /// 真正的"多端互踢"由业务后台决定(发 CONNECTION_FORCE_CLOSE 给 relay,relay 才关连接)。
    pub fn register_employee(
        &self,
        employee_id: i64,
        device_id: String,
        tx: EventSender,
    ) -> EmployeeRegisterOutcome {
        let connection_id = Uuid::new_v4().to_string();
        let stream = EmployeeStream {
            connection_id: connection_id.clone(),
            device_id,
            tx,
        };
        let mut employees = self.employees.write();
        employees.entry(employee_id).or_default().push(stream);
        EmployeeRegisterOutcome { connection_id }
    }

    /// Fanout 一个事件给某 employee 的所有在线连接。
    /// - delivered:成功 try_send 的连接数
    /// - backpressure:队列已满的连接 ID(stage 4 会借此发 RESYNC_REQUIRED + 清理)
    /// - closed:接收端已关闭的连接 ID(需要清理)
    pub fn fanout_employee(&self, employee_id: i64, event: ServerEvent) -> FanoutOutcome {
        // 复制 Vec(浅拷贝 Arc-tx),避免在 try_send 期间持有读锁
        let conns: Vec<EmployeeStream> = {
            let employees = self.employees.read();
            employees.get(&employee_id).cloned().unwrap_or_default()
        };
        let mut delivered = 0;
        let mut backpressure = Vec::new();
        let mut closed = Vec::new();
        for c in conns {
            match c.tx.try_send(Ok(event.clone())) {
                Ok(()) => delivered += 1,
                Err(mpsc::error::TrySendError::Full(_)) => backpressure.push(c.connection_id),
                Err(mpsc::error::TrySendError::Closed(_)) => closed.push(c.connection_id),
            }
        }
        FanoutOutcome {
            delivered,
            backpressure,
            closed,
        }
    }

    /// 按 connection_id 摘除某 employee 的一条流。Subscribe stream 结束 / force_close
    /// 完成时调用。
    pub fn drop_employee_stream(&self, employee_id: i64, connection_id: &str) {
        let mut employees = self.employees.write();
        if let Some(streams) = employees.get_mut(&employee_id) {
            streams.retain(|s| s.connection_id != connection_id);
            if streams.is_empty() {
                employees.remove(&employee_id);
            }
        }
    }

    /// CONNECTION_FORCE_CLOSE grace 后摘除该 employee 的所有流。
    /// 返回摘除的 connection_id 列表(给调用方记日志/观测用)。
    pub fn drop_all_employee_streams(&self, employee_id: i64) -> Vec<String> {
        let mut employees = self.employees.write();
        match employees.remove(&employee_id) {
            None => Vec::new(),
            Some(streams) => streams.into_iter().map(|s| s.connection_id).collect(),
        }
    }

    /// Graceful shutdown(P0-6):向所有连接(legacy account + employee 两套)
    /// 广播 `SystemSignal::SERVER_DRAIN`,客户端收到后会主动断开 + 重连别的实例。
    /// 返回 `(legacy_count, employee_count)` 给调用方记日志。
    pub fn broadcast_server_drain(&self, detail: &str) -> (usize, usize) {
        use chathub_proto::v1::server_event::Body;
        use chathub_proto::v1::system_signal::Kind;
        use chathub_proto::v1::{ServerEvent, SystemSignal};

        let make_event = |account: String| ServerEvent {
            wecom_account_id: account,
            seq: 0,
            body: Some(Body::System(SystemSignal {
                kind: Kind::ServerDrain as i32,
                detail: detail.to_string(),
            })),
        };

        // Legacy account 维度
        let mut legacy_count = 0;
        {
            let accounts = self.accounts.read();
            for (acc, entry) in accounts.iter() {
                if entry.tx.try_send(Ok(make_event(acc.clone()))).is_ok() {
                    legacy_count += 1;
                }
            }
        }

        // Employee 维度
        let mut employee_count = 0;
        {
            let employees = self.employees.read();
            for (_emp_id, streams) in employees.iter() {
                for s in streams {
                    if s.tx.try_send(Ok(make_event(String::new()))).is_ok() {
                        employee_count += 1;
                    }
                }
            }
        }

        (legacy_count, employee_count)
    }

    /// 当前该 employee 的在线连接数。
    pub fn employee_connection_count(&self, employee_id: i64) -> usize {
        self.employees
            .read()
            .get(&employee_id)
            .map(|v| v.len())
            .unwrap_or(0)
    }

    /// Hub.Ack 处理:更新该 employee 已确认的最高 notify_seq(monotonic,不退)。
    /// 仅供内部观测;事件日志清理走 TTL,不依赖此值。
    ///
    /// P1-4 实现:DashMap 提供 per-key 锁,fetch_max 原子 CAS,
    /// 高 QPS 不再受全局写锁串行化拖累。
    pub fn update_ack_mark(&self, employee_id: i64, notify_seq: u64) {
        let entry = self
            .ack_marks
            .entry(employee_id)
            .or_insert_with(|| AtomicU64::new(0));
        let _ = entry.fetch_max(notify_seq, Ordering::Relaxed);
    }

    /// 取该 employee 当前已确认水位(无记录返 0)。
    pub fn get_ack_mark(&self, employee_id: i64) -> u64 {
        self.ack_marks
            .get(&employee_id)
            .map(|e| e.load(Ordering::Relaxed))
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chathub_proto::v1::server_event::Body;
    use chathub_proto::v1::{system_signal::Kind, SystemSignal};

    fn evt(seq: i64) -> ServerEvent {
        ServerEvent {
            wecom_account_id: "wa-1".into(),
            seq,
            body: Some(Body::System(SystemSignal {
                kind: Kind::Unspecified as i32,
                detail: String::new(),
            })),
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn register_first_returns_no_prev() {
        let r = Router::new();
        let (tx, _rx) = mpsc::channel(32);
        let out = r.register(
            StreamTicket {
                user_id: "u".into(),
                device_id: "d".into(),
                accounts: vec!["wa-1".into()],
            },
            tx,
        );
        assert!(out.prev_senders.is_empty());
        assert!(!out.kicked);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn register_different_device_marks_kicked() {
        let r = Router::new();
        let (tx1, _rx1) = mpsc::channel(32);
        let (tx2, _rx2) = mpsc::channel(32);
        r.register(
            StreamTicket {
                user_id: "u".into(),
                device_id: "d1".into(),
                accounts: vec!["wa-1".into()],
            },
            tx1,
        );
        let out = r.register(
            StreamTicket {
                user_id: "u".into(),
                device_id: "d2".into(),
                accounts: vec!["wa-1".into()],
            },
            tx2,
        );
        assert_eq!(out.prev_senders.len(), 1);
        assert!(out.kicked);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn register_same_device_silent_replace() {
        let r = Router::new();
        let (tx1, _rx1) = mpsc::channel(32);
        let (tx2, _rx2) = mpsc::channel(32);
        r.register(
            StreamTicket {
                user_id: "u".into(),
                device_id: "d".into(),
                accounts: vec!["wa-1".into()],
            },
            tx1,
        );
        let out = r.register(
            StreamTicket {
                user_id: "u".into(),
                device_id: "d".into(),
                accounts: vec!["wa-1".into()],
            },
            tx2,
        );
        assert_eq!(out.prev_senders.len(), 1);
        assert!(!out.kicked);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn fanout_unknown_account_no_stream() {
        let r = Router::new();
        let err = r.fanout("wa-X", evt(1)).unwrap_err();
        assert!(matches!(err, RouterError::NoStream));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn fanout_to_registered_delivers() {
        let r = Router::new();
        let (tx, mut rx) = mpsc::channel(32);
        r.register(
            StreamTicket {
                user_id: "u".into(),
                device_id: "d".into(),
                accounts: vec!["wa-1".into()],
            },
            tx,
        );
        r.fanout("wa-1", evt(5)).unwrap();
        let got = rx.recv().await.unwrap().unwrap();
        assert_eq!(got.seq, 5);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn fanout_full_channel_returns_backpressure() {
        let r = Router::new();
        // 容量 1:填满后再 fanout 触发 Backpressure
        let (tx, _rx) = mpsc::channel(1);
        r.register(
            StreamTicket {
                user_id: "u".into(),
                device_id: "d".into(),
                accounts: vec!["wa-1".into()],
            },
            tx,
        );
        // 填满
        r.fanout("wa-1", evt(1)).unwrap();
        // 再推 → Backpressure
        let err = r.fanout("wa-1", evt(2)).unwrap_err();
        assert!(matches!(err, RouterError::Backpressure));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn evict_account_sends_drain_and_removes_stream() {
        let r = Router::new();
        let (tx, mut rx) = mpsc::channel(4);
        r.register(
            StreamTicket {
                user_id: "u".into(),
                device_id: "d".into(),
                accounts: vec!["wa-1".into()],
            },
            tx,
        );
        let drain_evt = ServerEvent {
            wecom_account_id: "wa-1".into(),
            seq: 0,
            body: Some(chathub_proto::v1::server_event::Body::System(
                SystemSignal {
                    kind: Kind::ServerDrain as i32,
                    detail: String::new(),
                },
            )),
        };
        let result = r.evict_account("wa-1", drain_evt);
        assert!(result.is_some());
        let (uid, did) = result.unwrap();
        assert_eq!(uid, "u");
        assert_eq!(did, "d");
        // drain event が届いているはず
        let got = rx.recv().await.unwrap().unwrap();
        assert_eq!(
            got.body,
            Some(chathub_proto::v1::server_event::Body::System(
                SystemSignal {
                    kind: Kind::ServerDrain as i32,
                    detail: String::new(),
                }
            ))
        );
        // ストリームが削除された
        let err = r.fanout("wa-1", evt(99)).unwrap_err();
        assert!(matches!(err, RouterError::NoStream));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn evict_account_unknown_returns_none() {
        let r = Router::new();
        let result = r.evict_account("wa-unknown", evt(1));
        assert!(result.is_none());
    }

    // ─── Plan 6 employee-scope tests ──────────────────────────────────

    fn empty_evt() -> ServerEvent {
        ServerEvent {
            wecom_account_id: String::new(),
            seq: 0,
            body: None,
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn register_employee_returns_unique_connection_id() {
        let r = Router::new();
        let (tx1, _rx1) = mpsc::channel(4);
        let (tx2, _rx2) = mpsc::channel(4);
        let o1 = r.register_employee(42, "dev-A".into(), tx1);
        let o2 = r.register_employee(42, "dev-B".into(), tx2);
        assert_ne!(o1.connection_id, o2.connection_id);
        assert_eq!(r.employee_connection_count(42), 2);
        assert_eq!(r.employee_connection_count(99), 0);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn fanout_employee_delivers_to_all_connections() {
        let r = Router::new();
        let (tx1, mut rx1) = mpsc::channel(4);
        let (tx2, mut rx2) = mpsc::channel(4);
        r.register_employee(42, "dev-A".into(), tx1);
        r.register_employee(42, "dev-B".into(), tx2);

        let outcome = r.fanout_employee(42, empty_evt());
        assert_eq!(outcome.delivered, 2);
        assert!(outcome.backpressure.is_empty());
        assert!(outcome.closed.is_empty());

        // 两条 channel 都收到了
        assert!(rx1.recv().await.is_some());
        assert!(rx2.recv().await.is_some());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn fanout_employee_unknown_employee_zero_delivered() {
        let r = Router::new();
        let outcome = r.fanout_employee(999, empty_evt());
        assert_eq!(outcome.delivered, 0);
        assert!(outcome.backpressure.is_empty());
        assert!(outcome.closed.is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn fanout_employee_full_channel_reports_backpressure() {
        let r = Router::new();
        // 容量 1,先填一条
        let (tx, _rx) = mpsc::channel(1);
        let o = r.register_employee(42, "dev-A".into(), tx);
        r.fanout_employee(42, empty_evt());

        // 再 fanout 一次:满 → backpressure
        let outcome = r.fanout_employee(42, empty_evt());
        assert_eq!(outcome.delivered, 0);
        assert_eq!(outcome.backpressure, vec![o.connection_id]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn fanout_employee_closed_channel_reports_closed() {
        let r = Router::new();
        let (tx, rx) = mpsc::channel(4);
        let o = r.register_employee(42, "dev-A".into(), tx);
        drop(rx); // 接收端关闭 → tx 后续 try_send 报 Closed

        let outcome = r.fanout_employee(42, empty_evt());
        assert_eq!(outcome.delivered, 0);
        assert_eq!(outcome.closed, vec![o.connection_id]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn drop_employee_stream_removes_only_specified_connection() {
        let r = Router::new();
        let (tx1, _rx1) = mpsc::channel(4);
        let (tx2, _rx2) = mpsc::channel(4);
        let o1 = r.register_employee(42, "dev-A".into(), tx1);
        let o2 = r.register_employee(42, "dev-B".into(), tx2);

        r.drop_employee_stream(42, &o1.connection_id);
        assert_eq!(r.employee_connection_count(42), 1);

        // 剩下的应该是 o2
        let outcome = r.fanout_employee(42, empty_evt());
        assert_eq!(outcome.delivered, 1);
        let _ = o2; // 仅保留语义,不需要再断言连接 id
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn drop_employee_stream_cleans_empty_vec_entry() {
        let r = Router::new();
        let (tx, _rx) = mpsc::channel(4);
        let o = r.register_employee(42, "dev-A".into(), tx);
        r.drop_employee_stream(42, &o.connection_id);
        // employees map 应该不再包含 42
        assert_eq!(r.employee_connection_count(42), 0);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn ack_mark_starts_at_zero_and_is_monotonic() {
        let r = Router::new();
        assert_eq!(r.get_ack_mark(42), 0);

        r.update_ack_mark(42, 100);
        assert_eq!(r.get_ack_mark(42), 100);

        // 单调:更小的不会覆盖
        r.update_ack_mark(42, 50);
        assert_eq!(r.get_ack_mark(42), 100);

        // 单调:更大的覆盖
        r.update_ack_mark(42, 200);
        assert_eq!(r.get_ack_mark(42), 200);

        // 其他 employee 独立
        assert_eq!(r.get_ack_mark(99), 0);
        r.update_ack_mark(99, 5);
        assert_eq!(r.get_ack_mark(99), 5);
        assert_eq!(r.get_ack_mark(42), 200);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn broadcast_server_drain_hits_both_legacy_and_employee_streams() {
        let r = Router::new();
        // legacy account
        let (tx_l, mut rx_l) = mpsc::channel(4);
        r.register(
            StreamTicket {
                user_id: "u-1".into(),
                device_id: "d-1".into(),
                accounts: vec!["wa-1".into()],
            },
            tx_l,
        );
        // employee
        let (tx_e1, mut rx_e1) = mpsc::channel(4);
        let (tx_e2, mut rx_e2) = mpsc::channel(4);
        r.register_employee(42, "dev-A".into(), tx_e1);
        r.register_employee(42, "dev-B".into(), tx_e2);

        let (legacy, employee) = r.broadcast_server_drain("test-drain");
        assert_eq!(legacy, 1);
        assert_eq!(employee, 2);

        use chathub_proto::v1::server_event::Body;
        use chathub_proto::v1::system_signal::Kind;

        for rx in [&mut rx_l, &mut rx_e1, &mut rx_e2] {
            let frame = rx.recv().await.unwrap().unwrap();
            match frame.body {
                Some(Body::System(sig)) => {
                    assert_eq!(sig.kind, Kind::ServerDrain as i32);
                    assert_eq!(sig.detail, "test-drain");
                }
                other => panic!("expected SERVER_DRAIN, got {other:?}"),
            }
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn fanout_employee_mixed_outcome_per_connection() {
        let r = Router::new();
        let (tx_ok, mut rx_ok) = mpsc::channel(4);
        let (tx_full, _rx_full) = mpsc::channel(1);
        let (tx_closed, rx_closed) = mpsc::channel(4);
        let o_ok = r.register_employee(42, "dev-A".into(), tx_ok);
        let o_full = r.register_employee(42, "dev-B".into(), tx_full);
        let o_closed = r.register_employee(42, "dev-C".into(), tx_closed);
        // 先把 full 那条填满
        r.fanout_employee(42, empty_evt());
        // 1 条 delivered(ok),1 backpressure(full),1 closed?不,closed 还没 drop rx
        let _ = rx_ok.recv().await; // drain
        drop(rx_closed);

        let outcome = r.fanout_employee(42, empty_evt());
        assert_eq!(outcome.delivered, 1);
        assert_eq!(outcome.backpressure, vec![o_full.connection_id]);
        assert_eq!(outcome.closed, vec![o_closed.connection_id]);
        let _ = o_ok;
    }
}
