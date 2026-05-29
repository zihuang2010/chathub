//! AuthSvc — 纯透传:把客户端 login / logout 转发到业务后台 HTTP,不签发、不存储。
//! AuthSvc 不挂认证拦截器(login 时客户端还没 token)。
//!
//! 2026-05-16 OAuth2 重构:login 走 OAuth2 password grant + Basic client auth,
//! logout 走 Bearer 客户端原 token。

use crate::downstream::{DownstreamClient, LoginReq};
use crate::hub_service::{TokenAuthenticator, UserCtx};
use chathub_proto::v1::auth_server::Auth;
use chathub_proto::v1::{
    LoginRequest, LoginResponse, LogoutRequest, LogoutResponse, UserProfile, WecomAccount,
};
use std::sync::Arc;
use tonic::{Request, Response, Status};

pub struct AuthSvc {
    pub downstream: Arc<DownstreamClient>,
    /// 与 HubSvc 共享同一个 TokenAuthenticator —— login 成功后预填 cache,
    /// 让 Subscribe 直接命中,跳过 verify_token 一跳。
    pub auth: Arc<TokenAuthenticator>,
}

#[tonic::async_trait]
impl Auth for AuthSvc {
    #[tracing::instrument(
        skip_all,
        fields(username = %req.get_ref().username, device_id = %req.get_ref().device_id)
    )]
    async fn login(&self, req: Request<LoginRequest>) -> Result<Response<LoginResponse>, Status> {
        let r = req.into_inner();
        let started = std::time::Instant::now();
        let resp = self
            .downstream
            .login(LoginReq {
                username: &r.username,
                password: &r.password,
                device_id: &r.device_id,
            })
            .await
            .map_err(|e| {
                tracing::warn!(error = %e, elapsed_ms = started.elapsed().as_millis() as u64, "login rejected");
                Status::from(e)
            })?;
        tracing::info!(
            user_id = %resp.user_id,
            employee_id = resp.employee_id,
            wecom_accounts = resp.wecom_accounts.len(),
            elapsed_ms = started.elapsed().as_millis() as u64,
            "login ok"
        );

        // 预填 TokenAuthenticator cache:接下来的 Subscribe / Ack / Forward 直接命中,
        // 不再调 verify_token。device_id 取自客户端 LoginRequest;accounts 留空
        // (前端走 list_accounts 单独拉,relay 不需要也不该在这里假装知道)。
        self.auth
            .prepopulate(
                &resp.access_token,
                UserCtx {
                    user_id: resp.user_id.clone(),
                    accounts: Vec::new(),
                    device_id: r.device_id.clone(),
                    employee_id: resp.employee_id,
                },
            )
            .await;

        Ok(Response::new(LoginResponse {
            access_token: resp.access_token,
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

    #[tracing::instrument(skip_all)]
    async fn logout(
        &self,
        req: Request<LogoutRequest>,
    ) -> Result<Response<LogoutResponse>, Status> {
        let r = req.into_inner();
        // 先失效本地鉴权缓存:否则旧 token 在 5min TTL 内仍能命中 Subscribe/Ack,登出形同虚设。
        self.auth.invalidate(&r.token).await;
        // best-effort:下游网络/状态错误不阻断客户端登出。Bearer 用客户端原 token。
        if let Err(e) = self.downstream.logout(&r.token).await {
            tracing::debug!(error = %e, "logout downstream failed (ignored, best-effort)");
        }
        tracing::info!("logout ok");
        Ok(Response::new(LogoutResponse {}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chathub_proto::v1::auth_client::AuthClient;
    use chathub_proto::v1::auth_server::AuthServer;
    use std::net::SocketAddr;
    use std::time::Duration;
    use tokio::net::TcpListener;
    use tokio_stream::wrappers::TcpListenerStream;
    use tonic::transport::{Endpoint, Server};
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    async fn spawn_auth(downstream_uri: &str) -> (SocketAddr, tokio::task::JoinHandle<()>) {
        let downstream = Arc::new(DownstreamClient::new_with_defaults(downstream_uri).unwrap());
        let auth = Arc::new(TokenAuthenticator::new(downstream.clone()));
        let svc = AuthSvc { downstream, auth };

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
        (addr, handle)
    }

    fn jdd_response() -> serde_json::Value {
        // 业务后台 2026-05-17 起统一包络:`{code:1, msg:"成功", data:JddTokenVO}`
        serde_json::json!({
            "code": 1,
            "serviceCode": "",
            "msg": "成功",
            "data": {
                "accessToken": {
                    "tokenValue": "biz-tok-7",
                    "tokenType": { "value": "Bearer" },
                    "issuedAt": "2026-05-16 10:00:00",
                    "expiresAt": "2026-05-16 22:00:00"
                },
                "userId": "7",
                "nickName": "Alice",
                "channel": 3
            }
        })
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn login_oauth2_passes_through_token_and_user() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/account-app/oauth2/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(jdd_response()))
            .mount(&mock)
            .await;
        let (addr, _h) = spawn_auth(&mock.uri()).await;
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

        // relay 原样透传业务 token,不签发不解析
        assert_eq!(resp.access_token, "biz-tok-7");
        assert_eq!(resp.user.as_ref().unwrap().user_id, "7");
        assert_eq!(resp.user.as_ref().unwrap().display_name, "Alice");
        // wecom_accounts 永远空,前端走 list_accounts
        assert!(resp.wecom_accounts.is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn login_oauth2_bad_creds_maps_unauthenticated() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/account-app/oauth2/token"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&mock)
            .await;
        let (addr, _h) = spawn_auth(&mock.uri()).await;
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
    async fn logout_is_ok_even_when_downstream_unreachable() {
        // 不挂 /auth/logout 路由 → 下游 404;logout 仍 best-effort 返回 Ok
        let mock = MockServer::start().await;
        let (addr, _h) = spawn_auth(&mock.uri()).await;
        let endpoint = Endpoint::from_shared(format!("http://{addr}")).unwrap();
        let mut client = AuthClient::connect(endpoint).await.unwrap();
        let resp = client.logout(LogoutRequest { token: "t".into() }).await;
        assert!(resp.is_ok());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn logout_evicts_token_from_shared_auth_cache() {
        let mock = MockServer::start().await;
        // verify_token 必须被调 2 次:logout 清缓存后再 authenticate 必须回源
        Mock::given(method("POST"))
            .and(path(
                "/wechat-business-app/rpc/v1/wecomAggregate/connection/verifyToken",
            ))
            .and(header("authorization", "Bearer tok-L"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "code": 1, "serviceCode": "", "msg": "成功",
                "data": { "employeeId": 5, "username": "", "nickName": "", "mobile": "", "channel": "" }
            })))
            .expect(2)
            .mount(&mock)
            .await;
        let downstream = Arc::new(DownstreamClient::new_with_defaults(&mock.uri()).unwrap());
        let auth = Arc::new(TokenAuthenticator::new(downstream.clone()));
        let svc = AuthSvc {
            downstream,
            auth: auth.clone(),
        };
        // 1) 预热缓存
        assert_eq!(auth.authenticate("tok-L").await.unwrap().employee_id, 5);
        // 2) logout 清缓存(下游 logout 路由未挂 → 404,best-effort 不影响)
        svc.logout(Request::new(LogoutRequest {
            token: "tok-L".into(),
        }))
        .await
        .unwrap();
        // 3) 缓存已清 → 再 authenticate 回源(verify 第 2 次)
        assert_eq!(auth.authenticate("tok-L").await.unwrap().employee_id, 5);
    }
}
