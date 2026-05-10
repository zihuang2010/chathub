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

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum LoginOutcome {
    Ok,
    Unauthenticated,
    Network,
    UpgradeRequired,
}

impl Default for LoginOutcome {
    fn default() -> Self {
        LoginOutcome::Ok
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum RefreshOutcome {
    Ok,
    Revoked,
    Network,
}

impl Default for RefreshOutcome {
    fn default() -> Self {
        RefreshOutcome::Ok
    }
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

pub async fn start_stub() -> (SocketAddr, Arc<Mutex<StubState>>, JoinHandle<()>) {
    let state = Arc::new(Mutex::new(StubState::new_default_ttls()));
    let auth = StubAuth {
        state: state.clone(),
    };
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("local_addr");
    let stream = TcpListenerStream::new(listener);
    let handle = tokio::spawn(async move {
        let _ = Server::builder()
            .add_service(AuthServer::new(auth))
            .serve_with_incoming(stream)
            .await;
    });
    // 给 server 一点点启动时间(本地通常 < 1ms,加 sleep 保险)
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    (addr, state, handle)
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
