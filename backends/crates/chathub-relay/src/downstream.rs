//! DownstreamClient — reqwest 封装下游 HTTP 合约(spec §9.2)。
//! 共用错误转化:HTTP code → RelayError。

use crate::config::DownstreamRoutes;
use crate::error::RelayError;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

#[derive(Clone)]
pub struct DownstreamClient {
    base_url: String,
    secret: String,
    http: Client,
}

/// 客户端登录 —— relay 透传到业务后台 `/auth/login`。
#[derive(Serialize)]
pub struct LoginReq<'a> {
    pub username: &'a str,
    pub password: &'a str,
    pub device_id: &'a str,
    pub device_name: &'a str,
}

/// 业务后台登录响应:token 透传给客户端,relay 不解析。
#[derive(Deserialize, Debug, Clone)]
pub struct LoginResp {
    pub access_token: String,
    pub user_id: String,
    pub display_name: String,
    #[serde(default)]
    pub avatar_url: String,
    pub role: String,
    pub tenant_id: String,
    pub wecom_accounts: Vec<WecomAccount>,
}

/// 客户端登出 —— relay 透传到业务后台 `/auth/logout`(best-effort)。
#[derive(Serialize)]
pub struct LogoutReq<'a> {
    pub token: &'a str,
}

/// token 校验 —— relay 在 HubSvc 建连入口调业务后台 verifyToken。
#[derive(Serialize)]
pub struct VerifyTokenReq<'a> {
    pub token: &'a str,
}

/// Hub.Forward 的下游响应:relay 把 HTTP 状态码 + body 一起带回客户端。
/// 客户端按 `http_status` 区分业务成功/失败,不依赖 gRPC error code。
#[derive(Debug, Clone)]
pub struct ForwardOutcome {
    pub http_status: u16,
    pub body: Vec<u8>,
}

/// verifyToken 响应:relay 据此拿到连接身份。
#[derive(Deserialize, Debug, Clone)]
pub struct VerifyTokenResp {
    #[serde(default)]
    pub active: bool,
    #[serde(default)]
    pub user_id: String,
    #[serde(default)]
    pub device_id: String,
    #[serde(default)]
    pub accounts: Vec<String>,
    /// token 过期时间(ms);用于 relay 侧缓存 TTL。缺省时缓存用固定上限。
    #[serde(default)]
    pub exp_ms: Option<i64>,
    /// Plan 6:员工数值 ID(spec §3 employeeId)。relay 用这个做 router 索引、
    /// Hub.Ack 水位、Hub.Forward 的 X-Relay-Employee-Id header。
    /// 老 mock / 业务后台未返回时默认 0,Plan 6 的 Subscribe v2 / Ack / Forward 会
    /// 拒绝 employee_id=0 的调用(legacy 路径不受影响)。
    #[serde(default)]
    pub employee_id: i64,
}

#[derive(Deserialize, Debug, Clone)]
pub struct WecomAccount {
    pub wecom_account_id: String,
    pub corp_id: String,
    pub agent_id: i64,
    pub display_name: String,
    pub enabled: bool,
}

#[derive(Deserialize, Debug)]
struct ErrPayload {
    code: String,
    #[serde(default)]
    min_version: String,
    #[serde(default)]
    download_url: String,
}

/// 关键路径(verify_token)的超时,要短 — 它在 Subscribe 建连前,慢一秒用户感知一秒。
const VERIFY_TOKEN_TIMEOUT: Duration = Duration::from_secs(3);
/// 业务路径(forward/send/recall/fetch_history)默认超时。比 verify 长,业务可能慢点。
const BUSINESS_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

impl DownstreamClient {
    pub fn new(base_url: &str, secret: &str) -> Result<Self, RelayError> {
        // P1-5:reqwest 连接池上限 + TCP keepalive,防 burst 时 socket 泄漏
        // P1-6:默认 timeout 给业务路径(15s),verify_token 在调用点用 .timeout(3s) 覆盖
        let http = Client::builder()
            .timeout(BUSINESS_REQUEST_TIMEOUT)
            .pool_max_idle_per_host(32)
            .tcp_keepalive(Duration::from_secs(60))
            .build()
            .map_err(|e| RelayError::Http(e.to_string()))?;
        Ok(Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            secret: secret.to_string(),
            http,
        })
    }

    /// 透传客户端登录到业务后台。
    pub async fn login(&self, req: LoginReq<'_>) -> Result<LoginResp, RelayError> {
        self.post_json("/auth/login", &req).await
    }

    /// 透传客户端登出到业务后台。best-effort:网络错也不阻断,HTTP 非 2xx 忽略。
    pub async fn logout(&self, req: LogoutReq<'_>) -> Result<(), RelayError> {
        let url = format!("{}/auth/logout", self.base_url);
        match self
            .http
            .post(&url)
            .bearer_auth(&self.secret)
            .json(&req)
            .send()
            .await
        {
            Ok(_) => Ok(()),
            Err(e) if e.is_timeout() || e.is_connect() => Err(RelayError::Transient),
            Err(e) => Err(RelayError::Http(e.to_string())),
        }
    }

    /// 在 HubSvc 建连入口调:校验客户端 token,拿连接身份。
    pub async fn verify_token(
        &self,
        req: VerifyTokenReq<'_>,
    ) -> Result<VerifyTokenResp, RelayError> {
        // P1-6:verify_token 在 Subscribe 关键路径上,用更短超时,慢响应不拖垮缓存 miss 风暴
        self.post_json_with_timeout("/v1/verify_token", &req, VERIFY_TOKEN_TIMEOUT)
            .await
    }

    // Plan 7 — send/recall/ack_read/fetch_history 的 typed wrappers 已删,
    // 所有业务 RPC 统一走 `forward(routes, method, employee_id, body_bytes)`。

    // ─── Hub.Forward 透传 ────────────────────────────────────────────
    //
    // Relay 不解析 body_json,按 routes 查到 method 对应的 HTTP 路径后整段透传到
    // 业务后台。relay 自己的 Bearer secret + 经 relay 认证的 employee_id(放在
    // `X-Relay-Employee-Id` header)告诉业务后台:这次请求是某 employee 发起的、
    // 已经通过 relay 的 verify_token 鉴权。

    pub async fn forward(
        &self,
        routes: &DownstreamRoutes,
        method: &str,
        employee_id: i64,
        body_bytes: &[u8],
    ) -> Result<ForwardOutcome, RelayError> {
        let path = routes.path_for(method).ok_or(RelayError::InvalidArg)?;
        let url = format!("{}{}", self.base_url, path);
        let started = Instant::now();

        tracing::debug!(
            target: "chathub_relay::downstream",
            method,
            url = %url,
            employee_id,
            body_len = body_bytes.len(),
            "forward request",
        );

        let body_owned = body_bytes.to_vec();
        let resp = self
            .http
            .post(&url)
            .bearer_auth(&self.secret)
            .header("X-Relay-Employee-Id", employee_id.to_string())
            .header("Content-Type", "application/json")
            .body(body_owned)
            .send()
            .await
            .map_err(|e| {
                tracing::warn!(
                    target: "chathub_relay::downstream",
                    method,
                    error = %e,
                    elapsed_ms = started.elapsed().as_millis() as u64,
                    "forward network error",
                );
                if e.is_timeout() || e.is_connect() {
                    RelayError::Transient
                } else {
                    RelayError::Http(e.to_string())
                }
            })?;

        let status = resp.status();
        let elapsed_ms = started.elapsed().as_millis() as u64;
        let body = resp.bytes().await.map_err(|e| {
            tracing::warn!(
                target: "chathub_relay::downstream",
                method,
                status = status.as_u16(),
                error = %e,
                elapsed_ms,
                "forward body read failed",
            );
            RelayError::Http(e.to_string())
        })?;

        // P0-5:语义改为 REST 隧道。2xx 和 4xx 都返回 ForwardOutcome,客户端按 http_status
        // 判断业务结果(401/403 可能是业务规则而非鉴权失败,relay 无法准确区分)。
        // 只有 5xx 和实际 transport 故障才映射成 gRPC error。
        if status.is_server_error() {
            tracing::warn!(
                target: "chathub_relay::downstream",
                method,
                status = status.as_u16(),
                elapsed_ms,
                "forward 5xx — mapped to RelayError::Internal",
            );
            return Err(RelayError::Internal);
        }

        let level = if status.is_success() { "info" } else { "warn" };
        if level == "info" {
            tracing::info!(
                target: "chathub_relay::downstream",
                method,
                status = status.as_u16(),
                body_len = body.len(),
                elapsed_ms,
                "forward ok",
            );
        } else {
            // 4xx — 业务规则错,不是 relay 鉴权错。客户端读 http_status + body 自决。
            tracing::warn!(
                target: "chathub_relay::downstream",
                method,
                status = status.as_u16(),
                body_len = body.len(),
                elapsed_ms,
                "forward 4xx — surfaced to client via http_status (not gRPC error)",
            );
        }
        Ok(ForwardOutcome {
            http_status: status.as_u16(),
            body: body.to_vec(),
        })
    }

    /// 统一的 POST + JSON helper:负责发请求、记日志、翻译响应。
    async fn post_json<Req, Resp>(
        &self,
        endpoint: &'static str,
        req: &Req,
    ) -> Result<Resp, RelayError>
    where
        Req: Serialize + ?Sized,
        Resp: for<'de> Deserialize<'de>,
    {
        // 走 Client 默认超时(BUSINESS_REQUEST_TIMEOUT=15s)
        self.post_json_inner(endpoint, req, None).await
    }

    /// 带显式超时的版本(P1-6:verify_token 用更短超时)
    async fn post_json_with_timeout<Req, Resp>(
        &self,
        endpoint: &'static str,
        req: &Req,
        timeout: Duration,
    ) -> Result<Resp, RelayError>
    where
        Req: Serialize + ?Sized,
        Resp: for<'de> Deserialize<'de>,
    {
        self.post_json_inner(endpoint, req, Some(timeout)).await
    }

    async fn post_json_inner<Req, Resp>(
        &self,
        endpoint: &'static str,
        req: &Req,
        timeout: Option<Duration>,
    ) -> Result<Resp, RelayError>
    where
        Req: Serialize + ?Sized,
        Resp: for<'de> Deserialize<'de>,
    {
        let url = format!("{}{}", self.base_url, endpoint);
        let started = Instant::now();
        tracing::debug!(target: "chathub_relay::downstream", endpoint, url = %url, "downstream request");

        let mut builder = self.http.post(&url).bearer_auth(&self.secret).json(req);
        if let Some(t) = timeout {
            builder = builder.timeout(t);
        }

        let resp = builder.send().await.map_err(|e| {
            let elapsed_ms = started.elapsed().as_millis() as u64;
            let kind = if e.is_timeout() {
                "timeout"
            } else if e.is_connect() {
                "connect"
            } else {
                "other"
            };
            tracing::warn!(
                target: "chathub_relay::downstream",
                endpoint, url = %url, kind, elapsed_ms,
                error = %e,
                "downstream send failed",
            );
            if e.is_timeout() || e.is_connect() {
                RelayError::Transient
            } else {
                RelayError::Http(e.to_string())
            }
        })?;

        let status = resp.status();
        let elapsed_ms = started.elapsed().as_millis() as u64;
        if status.is_success() {
            tracing::info!(
                target: "chathub_relay::downstream",
                endpoint, url = %url, status = status.as_u16(), elapsed_ms,
                "downstream ok",
            );
        } else {
            tracing::warn!(
                target: "chathub_relay::downstream",
                endpoint, url = %url, status = status.as_u16(), elapsed_ms,
                "downstream non-2xx",
            );
        }
        translate(resp).await
    }
}

// Plan 7 — 老的 SendReq/Resp / RecallReq/Resp / AckReadReq/Resp / FetchHistoryReq/Resp
// typed structs 全删,业务 RPC 走 Hub.Forward 的 opaque body_json。

/// 通用响应翻译:200 → 反序列化 T;4xx/5xx → 映射错误。
pub(crate) async fn translate<T: for<'de> Deserialize<'de>>(
    resp: reqwest::Response,
) -> Result<T, RelayError> {
    let status = resp.status();
    if status.is_success() {
        let body = resp
            .json::<T>()
            .await
            .map_err(|e| RelayError::Http(e.to_string()))?;
        return Ok(body);
    }
    // 试着解析 {code, ...}
    let code = status.as_u16();
    let err: Option<ErrPayload> = resp.json().await.ok();
    match (code, err.as_ref().map(|e| e.code.as_str())) {
        (401, _) => Err(RelayError::InvalidCreds),
        (403, _) => Err(RelayError::AccountDisabled),
        (412, _) => {
            let (m, d) = err
                .map(|e| (e.min_version, e.download_url))
                .unwrap_or_default();
            Err(RelayError::UpgradeRequired {
                min_version: m,
                download_url: d,
            })
        }
        (400, _) => Err(RelayError::InvalidArg),
        (c, _) if c >= 500 => Err(RelayError::Transient),
        _ => Err(RelayError::Internal),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test(flavor = "multi_thread")]
    async fn login_happy_passes_through_token_and_user() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/auth/login"))
            .and(header("authorization", "Bearer dn-secret"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token":"biz-tok-abc",
                "user_id":"u-1","display_name":"D","role":"op","tenant_id":"t",
                "wecom_accounts":[{"wecom_account_id":"wa-1","corp_id":"c","agent_id":1,"display_name":"w","enabled":true}]
            })))
            .mount(&mock)
            .await;

        let client = DownstreamClient::new(&mock.uri(), "dn-secret").unwrap();
        let resp = client
            .login(LoginReq {
                username: "u",
                password: "p",
                device_id: "d1",
                device_name: "Mac",
            })
            .await
            .unwrap();
        assert_eq!(resp.access_token, "biz-tok-abc");
        assert_eq!(resp.user_id, "u-1");
        assert_eq!(resp.wecom_accounts.len(), 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn login_401_maps_invalid_creds() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/auth/login"))
            .respond_with(
                ResponseTemplate::new(401)
                    .set_body_json(serde_json::json!({"code":"INVALID_CREDS"})),
            )
            .mount(&mock)
            .await;

        let client = DownstreamClient::new(&mock.uri(), "dn-secret").unwrap();
        let err = client
            .login(LoginReq {
                username: "u",
                password: "bad",
                device_id: "d1",
                device_name: "Mac",
            })
            .await
            .unwrap_err();
        assert!(matches!(err, RelayError::InvalidCreds));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn login_503_maps_transient() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/auth/login"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&mock)
            .await;
        let client = DownstreamClient::new(&mock.uri(), "dn-secret").unwrap();
        let err = client
            .login(LoginReq {
                username: "u",
                password: "p",
                device_id: "d",
                device_name: "M",
            })
            .await
            .unwrap_err();
        assert!(matches!(err, RelayError::Transient));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn login_412_maps_upgrade_required() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/auth/login"))
            .respond_with(ResponseTemplate::new(412).set_body_json(serde_json::json!({
                "code":"UPGRADE_REQUIRED","min_version":"1.5.0","download_url":"https://x/y"
            })))
            .mount(&mock)
            .await;
        let client = DownstreamClient::new(&mock.uri(), "dn-secret").unwrap();
        let err = client
            .login(LoginReq {
                username: "u",
                password: "p",
                device_id: "d",
                device_name: "M",
            })
            .await
            .unwrap_err();
        match err {
            RelayError::UpgradeRequired { min_version, .. } => assert_eq!(min_version, "1.5.0"),
            other => panic!("wrong: {other:?}"),
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn verify_token_happy_returns_identity() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/verify_token"))
            .and(header("authorization", "Bearer dn-secret"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "active": true,
                "user_id": "u-9",
                "device_id": "dev-X",
                "accounts": ["wa-1", "wa-2"],
                "exp_ms": 1_900_000_000_000i64
            })))
            .mount(&mock)
            .await;
        let client = DownstreamClient::new(&mock.uri(), "dn-secret").unwrap();
        let resp = client
            .verify_token(VerifyTokenReq { token: "biz-tok" })
            .await
            .unwrap();
        assert!(resp.active);
        assert_eq!(resp.user_id, "u-9");
        assert_eq!(resp.device_id, "dev-X");
        assert_eq!(resp.accounts, vec!["wa-1", "wa-2"]);
        assert_eq!(resp.exp_ms, Some(1_900_000_000_000));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn verify_token_inactive_body_is_ok_with_active_false() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/verify_token"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"active": false})),
            )
            .mount(&mock)
            .await;
        let client = DownstreamClient::new(&mock.uri(), "dn-secret").unwrap();
        let resp = client
            .verify_token(VerifyTokenReq { token: "stale" })
            .await
            .unwrap();
        assert!(!resp.active);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn verify_token_401_maps_invalid_creds() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/verify_token"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&mock)
            .await;
        let client = DownstreamClient::new(&mock.uri(), "dn-secret").unwrap();
        let err = client
            .verify_token(VerifyTokenReq { token: "bad" })
            .await
            .unwrap_err();
        assert!(matches!(err, RelayError::InvalidCreds));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn logout_is_best_effort_ok() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/auth/logout"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&mock)
            .await;
        let client = DownstreamClient::new(&mock.uri(), "dn-secret").unwrap();
        assert!(client.logout(LogoutReq { token: "t" }).await.is_ok());
    }
}
