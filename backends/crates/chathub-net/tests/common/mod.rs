//! 测试共享代码。Cargo 不会把这个目录当独立 test target。
#![allow(dead_code)]

pub mod stub_relay;

use crate::common::stub_relay::StubHubState;
use chathub_net::hub::ConnectionState;
use chathub_proto::v1::ServerEvent;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::watch;
use tonic::Status;

/// 等到 ConnectionState 满足 pred,带超时。返回最后一次观察到的 state。
pub async fn wait_for_state(
    rx: &mut watch::Receiver<ConnectionState>,
    pred: impl Fn(&ConnectionState) -> bool,
    timeout: Duration,
) -> ConnectionState {
    let deadline = Instant::now() + timeout;
    {
        let cur = rx.borrow().clone();
        if pred(&cur) {
            return cur;
        }
    }
    while Instant::now() < deadline {
        let remaining = deadline - Instant::now();
        if tokio::time::timeout(remaining, rx.changed()).await.is_err() {
            break;
        }
        let cur = rx.borrow().clone();
        if pred(&cur) {
            return cur;
        }
    }
    panic!("wait_for_state timed out; last={:?}", rx.borrow());
}

/// 通过 stub 的当前活跃 mpsc::Sender 推一个 ServerEvent。
pub async fn push_event(stub: &Arc<Mutex<StubHubState>>, event: ServerEvent) {
    let tx = {
        stub.lock()
            .unwrap()
            .event_tx
            .clone()
            .expect("stub has no active event_tx — Subscribe not yet called")
    };
    tx.send(Ok(event)).await.expect("push_event send");
}

/// 通过 stub 的当前活跃 mpsc::Sender 推一个 Status(模拟 stream-level 错误)。
pub async fn push_status(stub: &Arc<Mutex<StubHubState>>, s: Status) {
    let tx = {
        stub.lock()
            .unwrap()
            .event_tx
            .clone()
            .expect("stub has no active event_tx — Subscribe not yet called")
    };
    tx.send(Err(s)).await.expect("push_status send");
}
