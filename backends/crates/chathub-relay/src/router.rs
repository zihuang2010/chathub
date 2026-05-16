//! ConnectionRouter(Plan 7 — employee-scope 唯一索引)。
//!
//! 数据结构:
//!   - `employees: RwLock<HashMap<employee_id, Vec<EmployeeStream>>>` 主索引
//!   - `ack_marks: DashMap<employee_id, AtomicU64>` 每员工已确认 notify_seq 水位(P1-4)
//!
//! 设计要点:
//!   - 一员工可有多条 stream(多端共存,业务后台用 CONNECTION_FORCE_CLOSE 决定踢谁)
//!   - fanout 时复制 Arc<tx> 出锁,try_send 非阻塞,慢客户端不拖垮 fanout 主路径
//!   - `connection_id` 是 relay 内部 UUID,不暴露给客户端/业务后台
//!   - 与 SQLite 锁、TokenAuthenticator 锁完全独立,无锁序约束

use chathub_proto::v1::ServerEvent;
use dashmap::DashMap;
use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::mpsc;
use tonic::Status;
use uuid::Uuid;

pub type EventSender = mpsc::Sender<Result<ServerEvent, Status>>;

/// 单条 employee 维度的连接。
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

/// `fanout_employee` 结果:成功送达的连接数 + 需要清理的连接 id 列表。
pub struct FanoutOutcome {
    pub delivered: usize,
    /// 队列已满 — 这些 connection 应该被发 RESYNC_REQUIRED 信号 + 清理。
    pub backpressure: Vec<String>,
    /// 接收端已关 — 这些 connection 应该被清理。
    pub closed: Vec<String>,
}

pub struct Router {
    employees: RwLock<HashMap<i64, Vec<EmployeeStream>>>,
    /// per-key 细粒度锁 + 无锁 CAS,Ack 高 QPS 不被全表锁串行化(P1-4)
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
            employees: RwLock::new(HashMap::new()),
            ack_marks: DashMap::new(),
        }
    }

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
    pub fn fanout_employee(&self, employee_id: i64, event: ServerEvent) -> FanoutOutcome {
        // 复制 Vec(浅拷贝 Arc-tx),避免 try_send 期间持读锁
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

    /// 当前该 employee 的在线连接数。
    pub fn employee_connection_count(&self, employee_id: i64) -> usize {
        self.employees
            .read()
            .get(&employee_id)
            .map(|v| v.len())
            .unwrap_or(0)
    }

    /// Graceful shutdown(P0-6):向所有 employee 连接广播 `SystemSignal::SERVER_DRAIN`。
    /// 返回被通知的连接总数。
    pub fn broadcast_server_drain(&self, detail: &str) -> usize {
        use chathub_proto::v1::server_event::Body;
        use chathub_proto::v1::system_signal::Kind;
        use chathub_proto::v1::SystemSignal;

        let event = ServerEvent {
            body: Some(Body::System(SystemSignal {
                kind: Kind::ServerDrain as i32,
                detail: detail.to_string(),
            })),
        };

        let mut count = 0;
        let employees = self.employees.read();
        for (_emp_id, streams) in employees.iter() {
            for s in streams {
                if s.tx.try_send(Ok(event.clone())).is_ok() {
                    count += 1;
                }
            }
        }
        count
    }

    /// Hub.Ack 处理:更新该 employee 已确认的最高 notify_seq(monotonic,不退)。
    /// DashMap 提供 per-key 锁,fetch_max 原子 CAS,高 QPS 无锁竞争(P1-4)。
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

    fn empty_evt() -> ServerEvent {
        ServerEvent { body: None }
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
        assert!(rx1.recv().await.is_some());
        assert!(rx2.recv().await.is_some());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn fanout_employee_unknown_employee_zero_delivered() {
        let r = Router::new();
        let outcome = r.fanout_employee(999, empty_evt());
        assert_eq!(outcome.delivered, 0);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn fanout_employee_full_channel_reports_backpressure() {
        let r = Router::new();
        let (tx, _rx) = mpsc::channel(1);
        let o = r.register_employee(42, "dev-A".into(), tx);
        r.fanout_employee(42, empty_evt());
        let outcome = r.fanout_employee(42, empty_evt());
        assert_eq!(outcome.delivered, 0);
        assert_eq!(outcome.backpressure, vec![o.connection_id]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn fanout_employee_closed_channel_reports_closed() {
        let r = Router::new();
        let (tx, rx) = mpsc::channel(4);
        let o = r.register_employee(42, "dev-A".into(), tx);
        drop(rx);
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
        let _o2 = r.register_employee(42, "dev-B".into(), tx2);
        r.drop_employee_stream(42, &o1.connection_id);
        assert_eq!(r.employee_connection_count(42), 1);
        let outcome = r.fanout_employee(42, empty_evt());
        assert_eq!(outcome.delivered, 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn drop_employee_stream_cleans_empty_vec_entry() {
        let r = Router::new();
        let (tx, _rx) = mpsc::channel(4);
        let o = r.register_employee(42, "dev-A".into(), tx);
        r.drop_employee_stream(42, &o.connection_id);
        assert_eq!(r.employee_connection_count(42), 0);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn drop_all_employee_streams_returns_dropped_conn_ids() {
        let r = Router::new();
        let (tx1, _rx1) = mpsc::channel(4);
        let (tx2, _rx2) = mpsc::channel(4);
        let o1 = r.register_employee(42, "dev-A".into(), tx1);
        let o2 = r.register_employee(42, "dev-B".into(), tx2);
        let dropped = r.drop_all_employee_streams(42);
        assert_eq!(dropped.len(), 2);
        assert!(dropped.contains(&o1.connection_id));
        assert!(dropped.contains(&o2.connection_id));
        assert_eq!(r.employee_connection_count(42), 0);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn ack_mark_starts_at_zero_and_is_monotonic() {
        let r = Router::new();
        assert_eq!(r.get_ack_mark(42), 0);
        r.update_ack_mark(42, 100);
        assert_eq!(r.get_ack_mark(42), 100);
        r.update_ack_mark(42, 50); // 单调,不退
        assert_eq!(r.get_ack_mark(42), 100);
        r.update_ack_mark(42, 200);
        assert_eq!(r.get_ack_mark(42), 200);
        assert_eq!(r.get_ack_mark(99), 0);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn broadcast_server_drain_hits_all_employee_streams() {
        let r = Router::new();
        let (tx1, mut rx1) = mpsc::channel(4);
        let (tx2, mut rx2) = mpsc::channel(4);
        r.register_employee(42, "dev-A".into(), tx1);
        r.register_employee(42, "dev-B".into(), tx2);
        let count = r.broadcast_server_drain("test-drain");
        assert_eq!(count, 2);

        use chathub_proto::v1::server_event::Body;
        use chathub_proto::v1::system_signal::Kind;
        for rx in [&mut rx1, &mut rx2] {
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
}
