//! AuthSvc — server-side impl Auth(login / refresh_token / logout)。
//! AuthSvc 本身 **不挂 JWT 拦截器**(spec §10);仅 HubSvc 挂(T11)。

use crate::downstream::{DownstreamClient, VerifyUserReq};
use crate::error::RelayError;
use crate::jwt::Signer;
use crate::storage::sessions::{hash_refresh_token, SessionStore};
use chathub_proto::v1::auth_server::Auth;
use chathub_proto::v1::{
    LoginRequest, LoginResponse, LogoutRequest, LogoutResponse, RefreshTokenRequest,
    RefreshTokenResponse, UserProfile, WecomAccount,
};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tonic::{Request, Response, Status};

pub struct AuthSvc {
    pub downstream: Arc<DownstreamClient>,
    pub sessions: SessionStore,
    pub signer: Signer,
    pub pepper: String,
    pub access_ttl: Duration,
    pub refresh_ttl: Duration,
}

#[tonic::async_trait]
impl Auth for AuthSvc {
    async fn login(&self, req: Request<LoginRequest>) -> Result<Response<LoginResponse>, Status> {
        let r = req.into_inner();
        let resp = self
            .downstream
            .verify_user(VerifyUserReq {
                username: &r.username,
                password: &r.password,
                device_id: &r.device_id,
                device_name: &r.device_name,
            })
            .await
            .map_err(Status::from)?;

        let now_ms = now_ms();
        let refresh_token = mint_opaque();
        let refresh_hash = hash_refresh_token(&self.pepper, &refresh_token);
        let refresh_exp_ms = now_ms + self.refresh_ttl.as_millis() as i64;

        let accounts: Vec<String> = resp
            .wecom_accounts
            .iter()
            .map(|a| a.wecom_account_id.clone())
            .collect();

        self.sessions
            .upsert(
                &resp.user_id,
                &r.device_id,
                &refresh_hash,
                refresh_exp_ms,
                &accounts,
                now_ms,
            )
            .await
            .map_err(|e| Status::from(RelayError::from(e)))?;

        let claims = self.signer.make_claims(
            &resp.user_id,
            accounts.clone(),
            &r.device_id,
            self.access_ttl.as_secs() as i64,
        );
        let access_token = self
            .signer
            .sign(&claims)
            .map_err(|e| Status::from(RelayError::from(e)))?;
        let access_exp_ms = now_ms + self.access_ttl.as_millis() as i64;

        Ok(Response::new(LoginResponse {
            access_token,
            access_exp_ms,
            refresh_token,
            refresh_exp_ms,
            user: Some(UserProfile {
                user_id: resp.user_id,
                display_name: resp.display_name,
                avatar_url: resp.avatar_url,
                role: resp.role,
                tenant_id: resp.tenant_id,
            }),
            wecom_accounts: resp
                .wecom_accounts
                .into_iter()
                .map(|a| WecomAccount {
                    wecom_account_id: a.wecom_account_id,
                    corp_id: a.corp_id,
                    agent_id: a.agent_id as u32,
                    display_name: a.display_name,
                    enabled: a.enabled,
                })
                .collect(),
        }))
    }

    async fn refresh_token(
        &self,
        req: Request<RefreshTokenRequest>,
    ) -> Result<Response<RefreshTokenResponse>, Status> {
        let r = req.into_inner();
        let hash = hash_refresh_token(&self.pepper, &r.refresh_token);
        let session = self
            .sessions
            .find_by_refresh_hash(&hash)
            .await
            .map_err(|e| Status::from(RelayError::from(e)))?
            .ok_or_else(|| Status::unauthenticated("invalid credentials"))?;

        if session.kicked_at_ms.is_some() {
            return Err(Status::unauthenticated("invalid credentials"));
        }
        let now_ms = now_ms();
        if session.refresh_exp_ms <= now_ms {
            return Err(Status::unauthenticated("invalid credentials"));
        }

        // 旋转 refresh — 沿用 session 中持久化的 accounts 快照(login 时写入)
        let new_refresh = mint_opaque();
        let new_hash = hash_refresh_token(&self.pepper, &new_refresh);
        let new_exp = now_ms + self.refresh_ttl.as_millis() as i64;
        self.sessions
            .delete(&hash)
            .await
            .map_err(|e| Status::from(RelayError::from(e)))?;
        self.sessions
            .upsert(
                &session.user_id,
                &session.device_id,
                &new_hash,
                new_exp,
                &session.accounts,
                now_ms,
            )
            .await
            .map_err(|e| Status::from(RelayError::from(e)))?;

        // accounts 取自 session.accounts(login 时存的 JSON 快照),
        // Plan 6+ 加 AccountStatus event 后可在 push 时同步更新或 refresh 时重拉。
        let claims = self.signer.make_claims(
            &session.user_id,
            session.accounts.clone(),
            &session.device_id,
            self.access_ttl.as_secs() as i64,
        );
        let access = self
            .signer
            .sign(&claims)
            .map_err(|e| Status::from(RelayError::from(e)))?;
        let access_exp_ms = now_ms + self.access_ttl.as_millis() as i64;

        Ok(Response::new(RefreshTokenResponse {
            access_token: access,
            access_exp_ms,
            refresh_token: new_refresh,
            refresh_exp_ms: new_exp,
        }))
    }

    async fn logout(
        &self,
        req: Request<LogoutRequest>,
    ) -> Result<Response<LogoutResponse>, Status> {
        let r = req.into_inner();
        let hash = hash_refresh_token(&self.pepper, &r.refresh_token);
        // best-effort:不存在也返 Ok
        let _ = self.sessions.delete(&hash).await;
        Ok(Response::new(LogoutResponse {}))
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn mint_opaque() -> String {
    // 32 bytes 高熵;UUIDv4 (16B) ×2 拼接,encode hex
    let a = uuid::Uuid::new_v4();
    let b = uuid::Uuid::new_v4();
    format!("{}{}", a.simple(), b.simple())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Storage;
    use chathub_proto::v1::auth_client::AuthClient;
    use chathub_proto::v1::auth_server::AuthServer;
    use std::net::SocketAddr;
    use tokio::net::TcpListener;
    use tokio_stream::wrappers::TcpListenerStream;
    use tonic::transport::{Endpoint, Server};
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    async fn spawn_auth(
        downstream_uri: &str,
        pepper: &str,
    ) -> (SocketAddr, tokio::task::JoinHandle<()>, Storage, Signer) {
        let tmp = tempfile::tempdir().unwrap();
        std::mem::forget(tmp.path().to_path_buf()); // 路径已 leak by tempdir 持续到测试退出
        let db = tmp.path().join("t.db");
        let storage = Storage::open(&db).await.unwrap();
        std::mem::forget(tmp);

        let signer = Signer::bootstrap(&storage, None, None, "chathub-relay")
            .await
            .unwrap();
        let sessions = SessionStore::new(storage.clone());
        let downstream = Arc::new(DownstreamClient::new(downstream_uri, "dn-secret").unwrap());

        let svc = AuthSvc {
            downstream,
            sessions,
            signer: signer.clone(),
            pepper: pepper.to_string(),
            access_ttl: Duration::from_secs(1800),
            refresh_ttl: Duration::from_secs(86400 * 30),
        };

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let stream = TcpListenerStream::new(listener);
        let handle = tokio::spawn(async move {
            let _ = Server::builder()
                .add_service(AuthServer::new(svc))
                .serve_with_incoming(stream)
                .await;
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        (addr, handle, storage, signer)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn login_happy_returns_token_and_user() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/verify_user"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "user_id":"u-7","display_name":"Alice","role":"op","tenant_id":"t-1",
                "wecom_accounts":[
                    {"wecom_account_id":"wa-1","corp_id":"c","agent_id":1,"display_name":"w","enabled":true}
                ]
            })))
            .mount(&mock)
            .await;
        let (addr, _h, _st, signer) = spawn_auth(&mock.uri(), "pep").await;
        let endpoint = Endpoint::from_shared(format!("http://{addr}")).unwrap();
        let mut client = AuthClient::connect(endpoint).await.unwrap();
        let resp = client
            .login(LoginRequest {
                username: "u".into(),
                password: "p".into(),
                device_id: "dev-A".into(),
                device_name: "Mac".into(),
                client_ver: "".into(),
            })
            .await
            .unwrap()
            .into_inner();

        assert!(!resp.access_token.is_empty());
        assert!(resp.access_exp_ms > 0);
        assert_eq!(resp.user.as_ref().unwrap().user_id, "u-7");
        // JWT 内部含 user_id + device_id + accounts
        let claims = signer.verifier().verify(&resp.access_token).unwrap();
        assert_eq!(claims.sub, "u-7");
        assert_eq!(claims.device_id, "dev-A");
        assert_eq!(claims.accounts, vec!["wa-1".to_string()]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn login_bad_creds_maps_unauthenticated() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/verify_user"))
            .respond_with(
                ResponseTemplate::new(401)
                    .set_body_json(serde_json::json!({"code":"INVALID_CREDS"})),
            )
            .mount(&mock)
            .await;
        let (addr, _h, _st, _s) = spawn_auth(&mock.uri(), "pep").await;
        let endpoint = Endpoint::from_shared(format!("http://{addr}")).unwrap();
        let mut client = AuthClient::connect(endpoint).await.unwrap();
        let st = client
            .login(LoginRequest {
                username: "u".into(),
                password: "wrong".into(),
                device_id: "dev-A".into(),
                device_name: "Mac".into(),
                client_ver: "".into(),
            })
            .await
            .unwrap_err();
        assert_eq!(st.code(), tonic::Code::Unauthenticated);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn refresh_happy_rotates_pair() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/verify_user"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "user_id":"u-7","display_name":"A","role":"op","tenant_id":"t",
                "wecom_accounts":[{"wecom_account_id":"wa-1","corp_id":"c","agent_id":1,"display_name":"w","enabled":true}]
            })))
            .mount(&mock).await;
        let (addr, _h, _st, signer) = spawn_auth(&mock.uri(), "pep").await;
        let ep = Endpoint::from_shared(format!("http://{addr}")).unwrap();
        let mut client = AuthClient::connect(ep).await.unwrap();
        let login = client
            .login(LoginRequest {
                username: "u".into(),
                password: "p".into(),
                device_id: "dev".into(),
                device_name: "M".into(),
                client_ver: "".into(),
            })
            .await
            .unwrap()
            .into_inner();
        let rt1 = login.refresh_token.clone();
        let r = client
            .refresh_token(RefreshTokenRequest {
                refresh_token: rt1.clone(),
                device_id: "dev".into(),
            })
            .await
            .unwrap()
            .into_inner();
        assert_ne!(r.refresh_token, rt1);
        assert!(!r.access_token.is_empty());
        // 新 access JWT 应含 login 时同样的 accounts(session 快照)
        let claims = signer.verifier().verify(&r.access_token).unwrap();
        assert_eq!(claims.accounts, vec!["wa-1".to_string()]);
        assert_eq!(claims.device_id, "dev");
        // 旧 refresh 应当不再 work
        let st = client
            .refresh_token(RefreshTokenRequest {
                refresh_token: rt1,
                device_id: "dev".into(),
            })
            .await
            .unwrap_err();
        assert_eq!(st.code(), tonic::Code::Unauthenticated);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn logout_then_refresh_unauthenticated() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/verify_user"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "user_id":"u-7","display_name":"A","role":"op","tenant_id":"t",
                "wecom_accounts":[]
            })))
            .mount(&mock)
            .await;
        let (addr, _h, _st, _s) = spawn_auth(&mock.uri(), "pep").await;
        let ep = Endpoint::from_shared(format!("http://{addr}")).unwrap();
        let mut client = AuthClient::connect(ep).await.unwrap();
        let login = client
            .login(LoginRequest {
                username: "u".into(),
                password: "p".into(),
                device_id: "d".into(),
                device_name: "M".into(),
                client_ver: "".into(),
            })
            .await
            .unwrap()
            .into_inner();
        let _ = client
            .logout(LogoutRequest {
                refresh_token: login.refresh_token.clone(),
            })
            .await
            .unwrap();
        let st = client
            .refresh_token(RefreshTokenRequest {
                refresh_token: login.refresh_token,
                device_id: "d".into(),
            })
            .await
            .unwrap_err();
        assert_eq!(st.code(), tonic::Code::Unauthenticated);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn kicked_then_refresh_unauthenticated() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/verify_user"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "user_id":"u-7","display_name":"A","role":"op","tenant_id":"t",
                "wecom_accounts":[]
            })))
            .mount(&mock)
            .await;
        let (addr, _h, storage, _s) = spawn_auth(&mock.uri(), "pep").await;
        let ep = Endpoint::from_shared(format!("http://{addr}")).unwrap();
        let mut client = AuthClient::connect(ep).await.unwrap();
        let login = client
            .login(LoginRequest {
                username: "u".into(),
                password: "p".into(),
                device_id: "d-X".into(),
                device_name: "M".into(),
                client_ver: "".into(),
            })
            .await
            .unwrap()
            .into_inner();
        // 后台直接 mark_kicked
        SessionStore::new(storage)
            .mark_kicked("u-7", "d-X", 99_999)
            .await
            .unwrap();
        let st = client
            .refresh_token(RefreshTokenRequest {
                refresh_token: login.refresh_token,
                device_id: "d-X".into(),
            })
            .await
            .unwrap_err();
        assert_eq!(st.code(), tonic::Code::Unauthenticated);
    }
}
