//! Stub Relay(Plan 7 — 只剩 Auth.Login/Logout + Hub v2 三件套)。
//!
//! 测试通过共享的 Arc<Mutex<StubState>> 控制返回值。

#![allow(dead_code)]

use chathub_proto::v1::auth_server::{Auth, AuthServer};
use chathub_proto::v1::hub_server::{Hub, HubServer};
use chathub_proto::v1::{
    AckRequest, AckResponse, ForwardRequest, ForwardResponse, LoginRequest, LoginResponse,
    LogoutRequest, LogoutResponse, ServerEvent, SubscribeAck, SubscribeRequest, UserProfile,
    WecomAccount,
};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_stream::wrappers::{ReceiverStream, TcpListenerStream};
use tonic::{transport::Server, Request, Response, Status};

// ─── Auth ────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub enum LoginOutcome {
    #[default]
    Ok,
    Unauthenticated,
    Network,
    UpgradeRequired,
}

#[derive(Default, Clone)]
pub struct StubState {
    pub login_outcome: LoginOutcome,
    pub login_count: usize,
    pub logout_count: usize,
}

pub struct StubAuth {
    pub state: Arc<Mutex<StubState>>,
}

#[tonic::async_trait]
impl Auth for StubAuth {
    async fn login(&self, req: Request<LoginRequest>) -> Result<Response<LoginResponse>, Status> {
        let mut s = self.state.lock().unwrap();
        s.login_count += 1;
        match s.login_outcome {
            LoginOutcome::Unauthenticated => return Err(Status::unauthenticated("bad creds")),
            LoginOutcome::Network => return Err(Status::unavailable("relay down")),
            LoginOutcome::UpgradeRequired => return Err(upgrade_required_status()),
            LoginOutcome::Ok => {}
        }
        let _ = req;
        let now = now_ms();
        Ok(Response::new(LoginResponse {
            access_token: "a-".to_string() + &uuid_seed(now),
            user: Some(default_profile()),
            wecom_accounts: default_accounts(),
        }))
    }

    async fn logout(
        &self,
        _req: Request<LogoutRequest>,
    ) -> Result<Response<LogoutResponse>, Status> {
        let mut s = self.state.lock().unwrap();
        s.logout_count += 1;
        Ok(Response::new(LogoutResponse {}))
    }
}

// ─── Hub(v2 三件套)────────────────────────────────────────────────────

#[derive(Clone, Default)]
pub enum SubscribeOutcome {
    /// 接受 Subscribe,创建 mpsc + ReceiverStream,等测试 inject
    #[default]
    Stream,
    /// 一次性拒绝(Status 返回后会自动 reset 为 Stream)
    RejectOnce(Status),
    /// 持续拒绝
    RejectAlways(Status),
}

#[derive(Clone)]
pub enum ForwardStubOutcome {
    Ok(ForwardResponse),
    Status(Status),
}

impl Default for ForwardStubOutcome {
    fn default() -> Self {
        ForwardStubOutcome::Ok(ForwardResponse {
            body_json: bytes::Bytes::from_static(b"{}"),
            http_status: 200,
        })
    }
}

#[derive(Default)]
pub struct StubHubState {
    /// Subscribe RPC 被调用时,记录传入的 since_notify_seq + device_id
    pub subscribes: Vec<(u64, String)>,
    /// 当前活跃 Subscribe stream 的 tx,测试代码用它推 event
    pub event_tx: Option<mpsc::Sender<Result<ServerEvent, Status>>>,
    pub subscribe_outcome: SubscribeOutcome,
    pub forwards: Vec<ForwardRequest>,
    pub forward_outcome: ForwardStubOutcome,
    pub acks: Vec<AckRequest>,
}

pub struct StubHub {
    pub state: Arc<Mutex<StubHubState>>,
}

#[tonic::async_trait]
impl Hub for StubHub {
    type SubscribeStream = ReceiverStream<Result<ServerEvent, Status>>;

    async fn subscribe(
        &self,
        req: Request<SubscribeRequest>,
    ) -> Result<Response<Self::SubscribeStream>, Status> {
        let (tx, rx) = mpsc::channel(16);
        let inner = req.into_inner();
        // 所有对 state 的同步操作收进块内,块结束即释放 MutexGuard —— 不跨 await(否则 future 非 Send)。
        let outcome = {
            let mut s = self.state.lock().unwrap();
            s.subscribes
                .push((inner.since_notify_seq, inner.device_id.clone()));
            match s.subscribe_outcome.clone() {
                SubscribeOutcome::Stream => {
                    s.event_tx = Some(tx.clone());
                    SubscribeOutcome::Stream
                }
                SubscribeOutcome::RejectOnce(st) => {
                    s.subscribe_outcome = SubscribeOutcome::Stream;
                    SubscribeOutcome::RejectOnce(st)
                }
                SubscribeOutcome::RejectAlways(st) => SubscribeOutcome::RejectAlways(st),
            }
        };
        match outcome {
            SubscribeOutcome::Stream => {
                // 真实 relay 契约:订阅首帧必发 SubscribeAck(见 relay hub_service.rs:590-604)。stub
                // 照做,否则客户端"收到首帧 ack 才置 Subscribed(在线)"会永远停在 Connecting。
                // 空回放:replayed_to_seq = since,resync_required=false。buffer(16) 发单帧不阻塞。
                let ack = ServerEvent {
                    body: Some(chathub_proto::v1::server_event::Body::SubscribeAck(
                        SubscribeAck {
                            resumed_from_seq: inner.since_notify_seq,
                            replayed_to_seq: inner.since_notify_seq,
                            resync_required: false,
                            resync_reason: String::new(),
                        },
                    )),
                };
                let _ = tx.send(Ok(ack)).await;
                Ok(Response::new(ReceiverStream::new(rx)))
            }
            SubscribeOutcome::RejectOnce(st) => Err(st),
            SubscribeOutcome::RejectAlways(st) => Err(st),
        }
    }

    async fn ack(&self, req: Request<AckRequest>) -> Result<Response<AckResponse>, Status> {
        let mut s = self.state.lock().unwrap();
        s.acks.push(req.into_inner());
        Ok(Response::new(AckResponse {}))
    }

    async fn forward(
        &self,
        req: Request<ForwardRequest>,
    ) -> Result<Response<ForwardResponse>, Status> {
        let mut s = self.state.lock().unwrap();
        s.forwards.push(req.into_inner());
        match s.forward_outcome.clone() {
            ForwardStubOutcome::Ok(r) => Ok(Response::new(r)),
            ForwardStubOutcome::Status(st) => Err(st),
        }
    }
}

// ─── 启动整套 stub ───────────────────────────────────────────────────────

pub async fn start_stub() -> (SocketAddr, Arc<Mutex<StubState>>, JoinHandle<()>) {
    let (addr, auth_state, _hub_state, handle) = start_stub_full().await;
    (addr, auth_state, handle)
}

pub async fn start_stub_full() -> (
    SocketAddr,
    Arc<Mutex<StubState>>,
    Arc<Mutex<StubHubState>>,
    JoinHandle<()>,
) {
    let auth_state = Arc::new(Mutex::new(StubState::default()));
    let hub_state = Arc::new(Mutex::new(StubHubState::default()));
    let auth = StubAuth {
        state: auth_state.clone(),
    };
    let hub = StubHub {
        state: hub_state.clone(),
    };

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let stream = TcpListenerStream::new(listener);
    let h = tokio::spawn(async move {
        let _ = Server::builder()
            .add_service(AuthServer::new(auth))
            .add_service(HubServer::new(hub))
            .serve_with_incoming(stream)
            .await;
    });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    (addr, auth_state, hub_state, h)
}

// ─── helpers ────────────────────────────────────────────────────────────

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn uuid_seed(seed: i64) -> String {
    format!("{seed:x}-{}", uuid::Uuid::new_v4().simple())
}

fn default_profile() -> UserProfile {
    UserProfile {
        user_id: "u-stub".into(),
        display_name: "Stub User".into(),
        avatar_url: "".into(),
        role: "operator".into(),
        tenant_id: "t-stub".into(),
        username: "stub".into(),
        mobile: "13800000000".into(),
        terminal_id: "term-stub".into(),
    }
}

fn default_accounts() -> Vec<WecomAccount> {
    vec![WecomAccount {
        wecom_account_id: "wa-stub-1".into(),
        corp_id: "wwd00".into(),
        agent_id: 1,
        display_name: "Stub WeCom".into(),
        enabled: true,
    }]
}

fn upgrade_required_status() -> Status {
    use chathub_proto::v1::{error_detail, ErrorDetail, UpgradeRequired};
    use prost::Message;
    let detail = ErrorDetail {
        body: Some(error_detail::Body::Upgrade(UpgradeRequired {
            min_client_version: "9.9.9".into(),
            download_url: "https://example.com/dl".into(),
        })),
    };
    Status::with_details(
        tonic::Code::FailedPrecondition,
        "upgrade required",
        detail.encode_to_vec().into(),
    )
}
