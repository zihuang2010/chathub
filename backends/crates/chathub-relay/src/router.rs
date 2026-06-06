//! ConnectionRouter — F6 极致性能版:`ArcSwap<im::HashMap>` 替代 `RwLock<HashMap>`。
//!
//! 数据结构:
//!   - `employees: ArcSwap<im::HashMap<i64, Vec<EmployeeStream>>>`
//!     fanout 路径完全无锁(原子 Arc load),read-mostly 场景理想。register/drop 走 RCU
//!     (read-clone-update-swap),`im::HashMap::clone` 是 O(1) refcount + lazy CoW。
//!   - `ack_marks: DashMap<employee_id, AtomicU64>` 已确认 notify_seq 水位。
//!
//! 性能特点:
//!   - 5000 conn × 1000 push/s = 5M fanout/s 无任何锁开销
//!   - register/drop 极少(每 Subscribe 1 次),RCU 重试代价可忽略
//!   - 缺点:同时 N 个 register 会有 N-1 次 RCU 重试,但 N 通常 1-2,无忧
//!
//! 与 SQLite 锁、TokenAuthenticator 锁完全独立,无锁序约束。

use arc_swap::ArcSwap;
use chathub_proto::v1::ServerEvent;
use dashmap::DashMap;
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(test)]
use std::sync::Arc;
use tokio::sync::mpsc;
use tonic::Status;
use uuid::Uuid;

pub type EventSender = mpsc::Sender<Result<ServerEvent, Status>>;

type EmployeesMap = im::HashMap<i64, Vec<EmployeeStream>>;

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
    /// 队列已满(256 缓冲)— 客户端落后太多。调用方摘除其 router 注册即可:
    /// 缓冲已满无法再 try_send RESYNC 帧,且摘注册不会立即关流(subscribe spawn 仍持
    /// tx 至 tx.closed()),客户端靠自身重连超时重订阅 + resync 续点兜底恢复。
    pub backpressure: Vec<String>,
    /// 接收端已关 — 这些 connection 应该被清理。
    pub closed: Vec<String>,
}

pub struct Router {
    employees: ArcSwap<EmployeesMap>,
    /// per-key 细粒度锁 + 无锁 CAS,Ack 高 QPS 不被全表锁串行化
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
            employees: ArcSwap::from_pointee(im::HashMap::new()),
            ack_marks: DashMap::new(),
        }
    }

    /// 注册一条 employee 维度的 Subscribe 连接,返回 relay 分配的 connection_id。
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
        // RCU:read → clone (O(1) refcount) → mutate copy → CAS swap;并发时自动重试
        self.employees.rcu(|cur| {
            let mut next: EmployeesMap = (**cur).clone();
            next.entry(employee_id).or_default().push(stream.clone());
            next
        });
        EmployeeRegisterOutcome { connection_id }
    }

    /// Fanout 一个事件给某 employee 的所有在线连接。**完全无锁**,原子 load Arc。
    pub fn fanout_employee(&self, employee_id: i64, event: ServerEvent) -> FanoutOutcome {
        // 持 load guard 直接迭代,不再 clone 整个 Vec + 每条 connection_id/device_id String。
        // try_send 非阻塞、无 await;register/drop 走 rcu(copy-on-write)不依赖此 guard,
        // 故跨 send 持有 guard 无锁序风险。connection_id 仅在 send 失败(罕见)时才 clone。
        let table = self.employees.load();
        let mut delivered = 0;
        let mut backpressure = Vec::new();
        let mut closed = Vec::new();
        if let Some(conns) = table.get(&employee_id) {
            for c in conns {
                // event.clone() 是 Bytes refcount bump(F6),不深拷贝 events_json
                match c.tx.try_send(Ok(event.clone())) {
                    Ok(()) => delivered += 1,
                    Err(mpsc::error::TrySendError::Full(_)) => {
                        backpressure.push(c.connection_id.clone())
                    }
                    Err(mpsc::error::TrySendError::Closed(_)) => {
                        closed.push(c.connection_id.clone())
                    }
                }
            }
        }
        FanoutOutcome {
            delivered,
            backpressure,
            closed,
        }
    }

    /// 按 connection_id 摘除某 employee 的一条流。
    pub fn drop_employee_stream(&self, employee_id: i64, connection_id: &str) {
        self.employees.rcu(|cur| {
            let mut next: EmployeesMap = (**cur).clone();
            if let Some(streams) = next.get_mut(&employee_id) {
                streams.retain(|s| s.connection_id != connection_id);
                if streams.is_empty() {
                    next.remove(&employee_id);
                }
            }
            next
        });
    }

    /// CONNECTION_FORCE_CLOSE grace 后摘除该 employee 的所有流。
    /// 返回摘除的 connection_id 列表(给调用方记日志/观测用)。
    pub fn drop_all_employee_streams(&self, employee_id: i64) -> Vec<String> {
        // Snapshot first to extract IDs(rcu 闭包可能多次调用,不能在里面收集副作用)
        let cur = self.employees.load_full();
        let removed_ids: Vec<String> = cur
            .get(&employee_id)
            .map(|streams| streams.iter().map(|s| s.connection_id.clone()).collect())
            .unwrap_or_default();
        if removed_ids.is_empty() {
            return Vec::new();
        }
        self.employees.rcu(|cur| {
            let mut next: EmployeesMap = (**cur).clone();
            next.remove(&employee_id);
            next
        });
        removed_ids
    }

    /// 当前该 employee 的在线连接数。
    pub fn employee_connection_count(&self, employee_id: i64) -> usize {
        self.employees
            .load()
            .get(&employee_id)
            .map(|v| v.len())
            .unwrap_or(0)
    }

    /// Graceful shutdown:向所有 employee 连接广播 `SystemSignal::SERVER_DRAIN`。
    /// 返回被通知的连接总数。
    ///
    /// 【契约约束】这是 relay 唯一通过实时流主动下发的 `SystemSignal`。**不得**在实时流下发
    /// `KIND_RESYNC_REQUIRED`(resync 走 Subscribe 首帧 ack.resync_required):客户端已"完全单向
    /// 隔离",实时 RESYNC_REQUIRED 不再断连、会丢失水位重锚点。详见 proto event.proto 的
    /// KIND_RESYNC_REQUIRED 注释与解耦设计 D3。
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
        let table = self.employees.load();
        for (_emp_id, streams) in table.iter() {
            for s in streams {
                if s.tx.try_send(Ok(event.clone())).is_ok() {
                    count += 1;
                }
            }
        }
        count
    }

    /// Hub.Ack 处理:更新该 employee 已确认的最高 notify_seq(monotonic,不退)。
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

    #[tokio::test(flavor = "multi_thread")]
    async fn concurrent_register_no_data_loss() {
        // ArcSwap RCU 关键性质:N 并发 register 不丢任何一个
        let r = Arc::new(Router::new());
        let mut handles = vec![];
        for i in 0..100 {
            let r = r.clone();
            handles.push(tokio::spawn(async move {
                let (tx, _rx) = mpsc::channel(4);
                r.register_employee(42, format!("dev-{i}"), tx);
            }));
        }
        for h in handles {
            h.await.unwrap();
        }
        assert_eq!(r.employee_connection_count(42), 100);
    }
}
