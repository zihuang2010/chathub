//! ConnectionRouter — 单实例 in-process 路由表(spec §7)。
//!
//! **锁序固定**:`Router.users.write()` BEFORE `Router.accounts.write()`,严禁反向。
//! `fanout` 只取 `accounts.read()`,与 register/drop_stream 互不阻塞。

use chathub_proto::v1::ServerEvent;
use parking_lot::RwLock;
use std::collections::HashMap;
use tokio::sync::mpsc;
use tonic::Status;

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
    #[allow(dead_code)]
    user_id: String,
    #[allow(dead_code)]
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

pub struct Router {
    users: RwLock<HashMap<String, UserStream>>,
    accounts: RwLock<HashMap<String, ChannelEntry>>,
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
}
