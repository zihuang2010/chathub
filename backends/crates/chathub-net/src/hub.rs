//! Hub client + ConnectionManager(Plan 7 — 只剩 v2 三件套)。
//!
//! 公共 API:
//!   - `HubClient`:封装 tonic-generated client,只暴露 v2 三件套
//!     - `forward(method, body_json)` — 业务 RPC 单一透传入口
//!     - `ack(notify_seq)` — 上报水位
//!     - `subscribe(since_notify_seq, device_id)` — 内部用,ConnectionManager 调
//!   - `ConnectionManager`:状态机 + 后台 task + 事件总线
//!   - `ConnectionState`:Connecting / Subscribed / Disconnected{last_error}

use crate::error::AuthError;
use crate::interceptor::AuthInterceptor;
use crate::token::TokenStore;
use chathub_proto::v1::hub_client::HubClient as RawHubClient;
use chathub_proto::v1::{
    AckRequest, ForwardRequest, ForwardResponse, ServerEvent, SubscribeRequest,
};
use chathub_state::NotifySeqStore;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{broadcast, watch};
use tokio::task::JoinHandle;
use tonic::codegen::InterceptedService;
use tonic::transport::Channel;

#[derive(Clone, Debug)]
pub struct BackoffConfig {
    pub base: Duration,
    pub factor: f64,
    pub cap: Duration,
}

impl Default for BackoffConfig {
    fn default() -> Self {
        Self {
            base: Duration::from_secs(1),
            factor: 2.0,
            cap: Duration::from_secs(15),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum ConnectionState {
    Connecting,
    Subscribed,
    Disconnected {
        #[serde(skip_serializing_if = "Option::is_none")]
        last_error: Option<AuthError>,
    },
}

#[derive(Debug, PartialEq)]
pub(crate) enum Action {
    Logout,
    Terminate,
    Backoff,
}

pub(crate) fn classify(err: &AuthError) -> Action {
    match err {
        AuthError::Unauthenticated => Action::Logout,
        AuthError::UpgradeRequired { .. } => Action::Terminate,
        AuthError::Network { .. } => Action::Backoff,
        AuthError::Storage { .. } => Action::Terminate,
        AuthError::Internal { .. } => Action::Backoff,
        AuthError::AccountDisabled { .. } => Action::Terminate,
        // 协议契约不匹配 → 永久错,客户端不重试不退出登录(token 没问题,接口对不上)
        AuthError::ProtocolMismatch { .. } => Action::Terminate,
    }
}

#[derive(Clone)]
pub struct HubClient {
    inner: RawHubClient<InterceptedService<Channel, AuthInterceptor>>,
}

impl HubClient {
    pub fn new(channel: Channel, interceptor: AuthInterceptor) -> Self {
        let inner = RawHubClient::with_interceptor(channel, interceptor);
        Self { inner }
    }

    /// 业务 RPC 透传(REST 隧道)。客户端只需要构造 body_json 并指定 method。
    /// 4xx 通过 `ForwardResponse.http_status` 返回(不会变成 AuthError);
    /// 只有 5xx / 网络/超时 才映射 AuthError。
    pub async fn forward(
        &self,
        method: &str,
        body_json: Vec<u8>,
    ) -> Result<ForwardResponse, AuthError> {
        let mut client = self.inner.clone();
        let resp = client
            .forward(tonic::Request::new(ForwardRequest {
                method: method.into(),
                body_json: body_json.into(), // F6: Vec<u8> → Bytes
            }))
            .await?;
        Ok(resp.into_inner())
    }

    /// 拉取当前员工可管理的企微账号列表(走 forward 通道,后端 GET listMine)。
    /// 返回业务后台原始 JSON bytes — 字段结构由业务后台定义,调用方自行 parse。
    ///
    /// 用法:登录成功后立刻调一次填充账号选择 UI;失败时返回 ForwardResponse 的
    /// http_status > 200 或 AuthError(网络层错误),UI 提示"加载账号失败,点击重试"
    /// 即可,不影响 token 有效性。
    pub async fn list_accounts(&self) -> Result<ForwardResponse, AuthError> {
        self.forward("list_accounts", Vec::new()).await
    }

    /// 上报 notify_seq 水位(per-employee)。
    pub async fn ack(&self, notify_seq: u64) -> Result<(), AuthError> {
        let mut client = self.inner.clone();
        let _ = client
            .ack(tonic::Request::new(AckRequest { notify_seq }))
            .await?;
        Ok(())
    }

    /// Subscribe v2(employee-scope)。`since_notify_seq=0` 表示首连只接实时。
    pub(crate) async fn subscribe(
        &self,
        since_notify_seq: u64,
        device_id: String,
        client_version: String,
    ) -> Result<tonic::Streaming<ServerEvent>, AuthError> {
        let mut client = self.inner.clone();
        let req = SubscribeRequest {
            since_notify_seq,
            device_id,
            client_version,
        };
        let resp = client.subscribe(tonic::Request::new(req)).await?;
        Ok(resp.into_inner())
    }
}

/// Full jitter 指数退避。
pub(crate) struct ExponentialBackoff {
    base: Duration,
    factor: f64,
    cap: Duration,
    attempt: u32,
}

impl ExponentialBackoff {
    pub fn new(cfg: &BackoffConfig) -> Self {
        Self {
            base: cfg.base,
            factor: cfg.factor,
            cap: cfg.cap,
            attempt: 0,
        }
    }

    pub fn next(&mut self) -> Duration {
        let exp = self.factor.powi(self.attempt as i32);
        let raw_ms = (self.base.as_millis() as f64) * exp;
        let cap_ms = self.cap.as_millis() as f64;
        let bound_ms = raw_ms.min(cap_ms);
        let jittered_ms = rand::random::<f64>() * bound_ms;
        self.attempt = self.attempt.saturating_add(1);
        Duration::from_millis(jittered_ms as u64)
    }

    pub fn reset(&mut self) {
        self.attempt = 0;
    }
}

struct Inner {
    hub: HubClient,
    token_store: Arc<TokenStore>,
    notify_seq_store: NotifySeqStore,
    device_id: String,
    client_version: String,
    backoff: BackoffConfig,
    state_tx: watch::Sender<ConnectionState>,
    event_tx: broadcast::Sender<ServerEvent>,
    task: tokio::sync::Mutex<Option<JoinHandle<()>>>,
}

#[derive(Clone)]
pub struct ConnectionManager {
    inner: Arc<Inner>,
}

impl ConnectionManager {
    pub fn new(
        hub: HubClient,
        token_store: Arc<TokenStore>,
        notify_seq_store: NotifySeqStore,
        device_id: String,
        client_version: String,
        backoff: BackoffConfig,
    ) -> Self {
        let (state_tx, _) = watch::channel(ConnectionState::Disconnected { last_error: None });
        let (event_tx, _) = broadcast::channel(256);
        Self {
            inner: Arc::new(Inner {
                hub,
                token_store,
                notify_seq_store,
                device_id,
                client_version,
                backoff,
                state_tx,
                event_tx,
                task: tokio::sync::Mutex::new(None),
            }),
        }
    }

    pub fn state_subscribe(&self) -> watch::Receiver<ConnectionState> {
        self.inner.state_tx.subscribe()
    }

    pub fn event_subscribe(&self) -> broadcast::Receiver<ServerEvent> {
        self.inner.event_tx.subscribe()
    }

    pub async fn start(&self) {
        let mut guard = self.inner.task.lock().await;
        if guard.as_ref().is_some_and(|h| !h.is_finished()) {
            return;
        }
        let logged_out_rx = self.inner.token_store.logged_out_subscribe();
        let inner = Arc::clone(&self.inner);
        *guard = Some(tokio::spawn(async move {
            Inner::run_loop(inner, logged_out_rx).await;
        }));
    }

    pub async fn stop(&self) {
        let mut guard = self.inner.task.lock().await;
        if let Some(h) = guard.take() {
            h.abort();
            let _ = h.await;
        }
        self.inner
            .state_tx
            .send_replace(ConnectionState::Disconnected { last_error: None });
    }
}

impl Inner {
    async fn run_loop(
        self: Arc<Inner>,
        mut logged_out_rx: broadcast::Receiver<crate::token::LoggedOutReason>,
    ) {
        let mut backoff = ExponentialBackoff::new(&self.backoff);

        'reconnect: loop {
            self.state_tx.send_replace(ConnectionState::Connecting);

            let since = self.notify_seq_store.read().await.unwrap_or(0);

            let mut stream = match self
                .hub
                .subscribe(since, self.device_id.clone(), self.client_version.clone())
                .await
            {
                Ok(s) => s,
                Err(err) => match classify(&err) {
                    Action::Logout => {
                        self.token_store.mark_token_invalid().await;
                        self.state_tx
                            .send_replace(ConnectionState::Disconnected { last_error: None });
                        return;
                    }
                    Action::Terminate => {
                        self.state_tx.send_replace(ConnectionState::Disconnected {
                            last_error: Some(err),
                        });
                        return;
                    }
                    Action::Backoff => {
                        self.state_tx.send_replace(ConnectionState::Disconnected {
                            last_error: Some(err),
                        });
                        tokio::time::sleep(backoff.next()).await;
                        continue 'reconnect;
                    }
                },
            };

            self.state_tx.send_replace(ConnectionState::Subscribed);
            backoff.reset();

            loop {
                tokio::select! {
                    biased;
                    _ = logged_out_rx.recv() => {
                        self.state_tx.send_replace(ConnectionState::Disconnected { last_error: None });
                        return;
                    }
                    msg = stream.message() => match msg {
                        Ok(Some(event)) => {
                            // 处理 v2 三件套
                            use chathub_proto::v1::server_event::Body;
                            use chathub_proto::v1::system_signal::Kind;
                            let should_terminate = matches!(
                                &event.body,
                                Some(Body::System(s))
                                    if s.kind == Kind::ServerDrain as i32
                                       || s.kind == Kind::ResyncRequired as i32
                            );

                            // PushBatchOut → 更新水位
                            if let Some(Body::PushBatch(pb)) = &event.body {
                                if let Err(e) = self.notify_seq_store
                                    .upsert_if_greater(pb.notify_seq).await {
                                    tracing::warn!(?e, "notify_seq_store upsert failed, ignored");
                                }
                            }

                            let _ = self.event_tx.send(event);

                            if should_terminate {
                                // SERVER_DRAIN / RESYNC_REQUIRED → 主动断 + 退避重连
                                self.state_tx.send_replace(
                                    ConnectionState::Disconnected { last_error: None },
                                );
                                tokio::time::sleep(backoff.next()).await;
                                continue 'reconnect;
                            }
                        }
                        Ok(None) => {
                            self.state_tx.send_replace(ConnectionState::Disconnected { last_error: None });
                            tokio::time::sleep(backoff.next()).await;
                            continue 'reconnect;
                        }
                        Err(status) => {
                            let err: AuthError = status.into();
                            match classify(&err) {
                                Action::Logout => {
                                    self.token_store.mark_token_invalid().await;
                                    self.state_tx.send_replace(
                                        ConnectionState::Disconnected { last_error: None },
                                    );
                                    return;
                                }
                                Action::Terminate => {
                                    self.state_tx.send_replace(ConnectionState::Disconnected {
                                        last_error: Some(err),
                                    });
                                    return;
                                }
                                Action::Backoff => {
                                    self.state_tx.send_replace(ConnectionState::Disconnected {
                                        last_error: Some(err),
                                    });
                                    tokio::time::sleep(backoff.next()).await;
                                    continue 'reconnect;
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fast_cfg() -> BackoffConfig {
        BackoffConfig {
            base: Duration::from_millis(10),
            factor: 2.0,
            cap: Duration::from_millis(150),
        }
    }

    #[test]
    fn exponential_backoff_first_call_within_1x_base() {
        let mut b = ExponentialBackoff::new(&fast_cfg());
        let d = b.next();
        assert!(d <= Duration::from_millis(10), "got {d:?}");
    }

    #[test]
    fn exponential_backoff_caps_at_cap() {
        let mut b = ExponentialBackoff::new(&fast_cfg());
        for _ in 0..20 {
            let d = b.next();
            assert!(d <= Duration::from_millis(150), "got {d:?}");
        }
    }

    #[test]
    fn exponential_backoff_reset_zeroes_attempt() {
        let mut b = ExponentialBackoff::new(&fast_cfg());
        for _ in 0..5 {
            let _ = b.next();
        }
        b.reset();
        let d = b.next();
        assert!(d <= Duration::from_millis(10), "got {d:?}");
    }

    #[test]
    fn connection_state_disconnected_no_error_omits_field() {
        let s = ConnectionState::Disconnected { last_error: None };
        let json = serde_json::to_string(&s).unwrap();
        assert_eq!(json, r#"{"state":"disconnected"}"#);
    }

    #[test]
    fn classify_unauthenticated_returns_logout() {
        assert_eq!(classify(&AuthError::Unauthenticated), Action::Logout);
    }

    #[test]
    fn classify_network_returns_backoff() {
        assert_eq!(
            classify(&AuthError::Network {
                message: "down".into()
            }),
            Action::Backoff
        );
    }

    #[test]
    fn classify_protocol_mismatch_returns_terminate() {
        // 关键:防止 verify_token 415/404 死循环
        assert_eq!(
            classify(&AuthError::ProtocolMismatch {
                detail: "downstream_protocol_mismatch:415:verify_token".into()
            }),
            Action::Terminate
        );
    }
}
