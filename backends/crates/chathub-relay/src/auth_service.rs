//! AuthSvc — 纯透传:把客户端 login / logout 转发到业务后台 HTTP,不签发、不存储。
//! AuthSvc 不挂认证拦截器(login 时客户端还没 token)。

use crate::downstream::{DownstreamClient, LoginReq, LogoutReq};
use chathub_proto::v1::auth_server::Auth;
use chathub_proto::v1::{
    LoginRequest, LoginResponse, LogoutRequest, LogoutResponse, UserProfile, WecomAccount,
};
use std::sync::Arc;
use tonic::{Request, Response, Status};

pub struct AuthSvc {
    pub downstream: Arc<DownstreamClient>,
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
                device_name: &r.device_name,
            })
            .await
            .map_err(|e| {
                tracing::warn!(error = %e, elapsed_ms = started.elapsed().as_millis() as u64, "login rejected");
                Status::from(e)
            })?;
        tracing::info!(
            user_id = %resp.user_id,
            wecom_accounts = resp.wecom_accounts.len(),
            elapsed_ms = started.elapsed().as_millis() as u64,
            "login ok"
        );

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
        // best-effort:下游网络/状态错误不阻断客户端登出。
        if let Err(e) = self.downstream.logout(LogoutReq { token: &r.token }).await {
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
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    async fn spawn_auth(downstream_uri: &str) -> (SocketAddr, tokio::task::JoinHandle<()>) {
        let downstream = Arc::new(DownstreamClient::new(downstream_uri, "dn-secret").unwrap());
        let svc = AuthSvc { downstream };

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

    #[tokio::test(flavor = "multi_thread")]
    async fn login_passes_through_token_and_user() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/auth/login"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token":"biz-tok-7",
                "user_id":"u-7","display_name":"Alice","role":"op","tenant_id":"t-1",
                "wecom_accounts":[
                    {"wecom_account_id":"wa-1","corp_id":"c","agent_id":1,"display_name":"w","enabled":true}
                ]
            })))
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

        // relay 原样透传业务 token,不做任何签发/解析
        assert_eq!(resp.access_token, "biz-tok-7");
        assert_eq!(resp.user.as_ref().unwrap().user_id, "u-7");
        assert_eq!(resp.wecom_accounts.len(), 1);
        assert_eq!(resp.wecom_accounts[0].wecom_account_id, "wa-1");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn login_bad_creds_maps_unauthenticated() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/auth/login"))
            .respond_with(
                ResponseTemplate::new(401)
                    .set_body_json(serde_json::json!({"code":"INVALID_CREDS"})),
            )
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
}
