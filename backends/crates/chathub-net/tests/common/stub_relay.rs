//! Stub Relay:进程内 tonic Server 实现 chathub.v1.Auth 三个 method。
//! 测试通过共享的 Arc<Mutex<StubState>> 控制返回值。

#![allow(dead_code)]

use chathub_proto::v1::auth_server::{Auth, AuthServer};
use chathub_proto::v1::{
    LoginRequest, LoginResponse, LogoutRequest, LogoutResponse, UserProfile, WecomAccount,
};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use tokio_stream::wrappers::TcpListenerStream;
use tonic::{transport::Server, Request, Response, Status};

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

/// Plan 2 兼容版本:返回 (addr, auth_state, handle),丢弃 hub_state。
pub async fn start_stub() -> (SocketAddr, Arc<Mutex<StubState>>, JoinHandle<()>) {
    let (addr, auth_state, _hub_state, handle) = start_stub_full().await;
    (addr, auth_state, handle)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn uuid_seed(seed: i64) -> String {
    // 让每次返回的 token 字面值不同(便于断言"换新")
    format!("{seed:x}-{}", uuid::Uuid::new_v4().simple())
}

fn default_profile() -> UserProfile {
    UserProfile {
        user_id: "u-stub".into(),
        display_name: "Stub User".into(),
        avatar_url: "".into(),
        role: "operator".into(),
        tenant_id: "t-stub".into(),
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

// ============================ Plan 3:StubHub ============================

use chathub_proto::v1::hub_server::{Hub, HubServer};
use chathub_proto::v1::{
    AckReadRequest, AckReadResponse, FetchHistoryRequest, FetchHistoryResponse, RecallRequest,
    RecallResponse, SendRequest, SendResponse, ServerEvent, SubscribeRequest,
};
use std::collections::HashMap;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

#[derive(Clone, Default)]
pub enum SubscribeOutcome {
    /// 默认:接受 Subscribe,创建 mpsc + ReceiverStream,等测试 inject
    #[default]
    Stream,
    /// 拒绝 Subscribe(RejectOnce 一次性,RPC 返回 Status 后会自动 reset 为 Stream)
    RejectOnce(Status),
    /// 持续拒绝(每次 Subscribe 都返回此 Status)
    RejectAlways(Status),
}

#[derive(Clone)]
pub enum SendStubOutcome {
    Ok(SendResponse),
    Status(Status),
}

impl Default for SendStubOutcome {
    fn default() -> Self {
        SendStubOutcome::Ok(SendResponse {
            server_msg_id: "sm-default".into(),
            sent_at_ms: 0,
        })
    }
}

#[derive(Default)]
pub struct StubHubState {
    /// Subscribe RPC 被调用时,记录传入的 since_seqs(用于断言客户端续接行为)
    pub subscribes: Vec<HashMap<String, i64>>,
    /// 当前活跃 Subscribe stream 的 mpsc::Sender,测试代码用它推 event/status
    pub event_tx: Option<mpsc::Sender<Result<ServerEvent, Status>>>,
    /// Subscribe RPC 的初始结果策略
    pub subscribe_outcome: SubscribeOutcome,
    /// Send RPC 的固定结果
    pub send_outcome: SendStubOutcome,
    /// Send RPC 收到的全部请求(用于断言 client_msg_id 等)
    pub sends: Vec<SendRequest>,

    // Plan 4 新增
    pub recalls: Vec<RecallRequest>,
    pub recall_outcome: RecallStubOutcome,
    pub ack_reads: Vec<AckReadRequest>,
    pub ack_read_outcome: AckReadStubOutcome,
    pub fetch_history_reqs: Vec<FetchHistoryRequest>,
    pub fetch_history_outcome: FetchHistoryStubOutcome,
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
        let mut s = self.state.lock().unwrap();
        s.subscribes.push(req.into_inner().since_seqs);
        match s.subscribe_outcome.clone() {
            SubscribeOutcome::Stream => {
                s.event_tx = Some(tx);
                Ok(Response::new(ReceiverStream::new(rx)))
            }
            SubscribeOutcome::RejectOnce(st) => {
                s.subscribe_outcome = SubscribeOutcome::Stream;
                Err(st)
            }
            SubscribeOutcome::RejectAlways(st) => Err(st),
        }
    }

    async fn send(&self, req: Request<SendRequest>) -> Result<Response<SendResponse>, Status> {
        let mut s = self.state.lock().unwrap();
        s.sends.push(req.into_inner());
        match s.send_outcome.clone() {
            SendStubOutcome::Ok(r) => Ok(Response::new(r)),
            SendStubOutcome::Status(st) => Err(st),
        }
    }

    async fn recall(
        &self,
        req: Request<RecallRequest>,
    ) -> Result<Response<RecallResponse>, Status> {
        let mut s = self.state.lock().unwrap();
        s.recalls.push(req.into_inner());
        match s.recall_outcome.clone() {
            RecallStubOutcome::Ok(r) => Ok(Response::new(r)),
            RecallStubOutcome::Status(st) => Err(st),
        }
    }

    async fn ack_read(
        &self,
        req: Request<AckReadRequest>,
    ) -> Result<Response<AckReadResponse>, Status> {
        let mut s = self.state.lock().unwrap();
        s.ack_reads.push(req.into_inner());
        match s.ack_read_outcome.clone() {
            AckReadStubOutcome::Ok(r) => Ok(Response::new(r)),
            AckReadStubOutcome::Status(st) => Err(st),
        }
    }

    async fn fetch_history(
        &self,
        req: Request<FetchHistoryRequest>,
    ) -> Result<Response<FetchHistoryResponse>, Status> {
        let mut s = self.state.lock().unwrap();
        s.fetch_history_reqs.push(req.into_inner());
        match s.fetch_history_outcome.clone() {
            FetchHistoryStubOutcome::Ok(r) => Ok(Response::new(r)),
            FetchHistoryStubOutcome::Status(st) => Err(st),
        }
    }
}

// ============================ Plan 4:Recall / AckRead / FetchHistory ============================

#[derive(Clone)]
pub enum RecallStubOutcome {
    Ok(RecallResponse),
    Status(Status),
}
impl Default for RecallStubOutcome {
    fn default() -> Self {
        Self::Ok(RecallResponse { recalled_at_ms: 0 })
    }
}

#[derive(Clone)]
pub enum AckReadStubOutcome {
    Ok(AckReadResponse),
    Status(Status),
}
impl Default for AckReadStubOutcome {
    fn default() -> Self {
        Self::Ok(AckReadResponse { acked_at_ms: 0 })
    }
}

#[derive(Clone)]
pub enum FetchHistoryStubOutcome {
    Ok(FetchHistoryResponse),
    Status(Status),
}
impl Default for FetchHistoryStubOutcome {
    fn default() -> Self {
        Self::Ok(FetchHistoryResponse {
            messages: vec![],
            next_cursor: String::new(),
        })
    }
}

/// Plan 3 新版本:同进程注册 AuthServer + HubServer。
/// `start_stub` 转调本函数 + 丢弃 hub_state,Plan 2 测试 0 改动。
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
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("local_addr");
    let stream = TcpListenerStream::new(listener);
    let handle = tokio::spawn(async move {
        let _ = Server::builder()
            .add_service(AuthServer::new(auth))
            .add_service(HubServer::new(hub))
            .serve_with_incoming(stream)
            .await;
    });
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    (addr, auth_state, hub_state, handle)
}
