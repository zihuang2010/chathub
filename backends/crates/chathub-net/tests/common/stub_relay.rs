//! Stub Relay:进程内 tonic Server 实现 chathub.v1.Auth 三个 method。
//! 测试通过共享的 Arc<Mutex<StubState>> 控制返回值。

#![allow(dead_code)]

use chathub_proto::v1::auth_server::{Auth, AuthServer};
use chathub_proto::v1::{
    LoginRequest, LoginResponse, LogoutRequest, LogoutResponse, RefreshTokenRequest,
    RefreshTokenResponse, UserProfile, WecomAccount,
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

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub enum RefreshOutcome {
    #[default]
    Ok,
    Revoked,
    Network,
}

#[derive(Default, Clone)]
pub struct StubState {
    pub login_outcome: LoginOutcome,
    pub refresh_outcome: RefreshOutcome,
    /// access TTL,默认 30 分钟;测试用小值(如 2_000ms)触发主动刷新
    pub access_ttl_ms: i64,
    /// refresh TTL,默认 30 天
    pub refresh_ttl_ms: i64,
    pub login_count: usize,
    pub refresh_count: usize,
    pub logout_count: usize,
    /// 模拟 KICKED 等场景:置 true 后下一次 refresh 强制返回 Unauthenticated
    pub force_revoke_next_refresh: bool,
}

impl StubState {
    pub fn new_default_ttls() -> Self {
        Self {
            login_outcome: LoginOutcome::Ok,
            refresh_outcome: RefreshOutcome::Ok,
            access_ttl_ms: 30 * 60 * 1000,
            refresh_ttl_ms: 30 * 24 * 60 * 60 * 1000,
            ..Default::default()
        }
    }
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
            access_exp_ms: now + s.access_ttl_ms,
            refresh_token: "r-".to_string() + &uuid_seed(now),
            refresh_exp_ms: now + s.refresh_ttl_ms,
            user: Some(default_profile()),
            wecom_accounts: default_accounts(),
        }))
    }

    async fn refresh_token(
        &self,
        _req: Request<RefreshTokenRequest>,
    ) -> Result<Response<RefreshTokenResponse>, Status> {
        let mut s = self.state.lock().unwrap();
        s.refresh_count += 1;
        if s.force_revoke_next_refresh {
            s.force_revoke_next_refresh = false;
            return Err(Status::unauthenticated("revoked"));
        }
        match s.refresh_outcome {
            RefreshOutcome::Revoked => return Err(Status::unauthenticated("revoked")),
            RefreshOutcome::Network => return Err(Status::unavailable("relay down")),
            RefreshOutcome::Ok => {}
        }
        let now = now_ms();
        Ok(Response::new(RefreshTokenResponse {
            access_token: "a-".to_string() + &uuid_seed(now),
            access_exp_ms: now + s.access_ttl_ms,
            refresh_token: "r-".to_string() + &uuid_seed(now),
            refresh_exp_ms: now + s.refresh_ttl_ms,
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
use chathub_proto::v1::{SendRequest, SendResponse, ServerEvent, SubscribeRequest};
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
        _: Request<chathub_proto::v1::RecallRequest>,
    ) -> Result<Response<chathub_proto::v1::RecallResponse>, Status> {
        todo!("stub not implemented")
    }

    async fn ack_read(
        &self,
        _: Request<chathub_proto::v1::AckReadRequest>,
    ) -> Result<Response<chathub_proto::v1::AckReadResponse>, Status> {
        todo!("stub not implemented")
    }

    async fn fetch_history(
        &self,
        _: Request<chathub_proto::v1::FetchHistoryRequest>,
    ) -> Result<Response<chathub_proto::v1::FetchHistoryResponse>, Status> {
        todo!("stub not implemented")
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
    let auth_state = Arc::new(Mutex::new(StubState::new_default_ttls()));
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
