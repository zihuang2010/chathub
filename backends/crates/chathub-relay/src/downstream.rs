//! DownstreamClient — reqwest 封装下游 HTTP 合约。
//!
//! 鉴权模型(2026-05-16 OAuth2 重构):
//!   - login:OAuth2 password grant + Basic client auth(唯一例外,客户端此时无 token)
//!   - verify_token / logout / forward(业务 RPC):一律用客户端原 Bearer token 透传
//!   - relay 不再持有出站 shared secret(`RELAY_DOWNSTREAM_SECRET` 已下线)
//!
//! 安全约束:`client_token` 仅作 `&str` 在函数参数 / `bearer_auth()` 之间流转,
//!   不进任何 struct / cache / 日志字段(日志只允许出现 token 前 8 char + ***)。

use crate::config::{DownstreamRoutes, HttpMethod};
use crate::error::RelayError;
use reqwest::Client;
use serde::Deserialize;
use std::time::{Duration, Instant};

#[derive(Clone)]
pub struct DownstreamClient {
    base_url: String,
    http: Client,
    paths: AuthPaths,
    oauth: OAuthCreds,
}

#[derive(Clone, Debug)]
pub struct AuthPaths {
    pub login: String,
    pub verify_token: String,
    pub logout: String,
}

#[derive(Clone, Debug)]
pub struct OAuthCreds {
    pub client_id: String,
    pub client_secret: String,
}

/// OAuth2 password grant 入参(relay → 业务后台)。
#[derive(Debug)]
pub struct LoginReq<'a> {
    pub username: &'a str,
    pub password: &'a str,
    pub device_id: &'a str,
}

/// 业务后台登录响应(JddTokenVO → 摘取 relay 关心字段)。
/// `wecom_accounts` 永远为空 —— 由前端发起独立 `Hub.Forward("list_accounts", …)` 拉取。
#[derive(Debug, Clone)]
pub struct LoginResp {
    pub access_token: String,
    pub user_id: String,
    pub display_name: String,
    pub avatar_url: String,
    pub role: String,
    pub tenant_id: String,
    pub wecom_accounts: Vec<WecomAccount>,
}

/// JddTokenVO 反序列化结构(仅摘 relay 需要的字段;
/// channel/username/mobile/tokenType/issuedAt/expiresAt 被 serde 忽略)。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JddTokenVO {
    access_token: JddAccessToken,
    user_id: i64,
    #[serde(default)]
    nick_name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JddAccessToken {
    token_value: String,
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
    /// token 过期时间(epoch ms);用于 relay 侧缓存 TTL。缺省时缓存用固定上限(5 min)。
    #[serde(default)]
    pub exp_ms: Option<i64>,
    /// 员工数值 ID。老 mock / 业务后台未升级时为 0,Subscribe/Ack/Forward 拒。
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

/// 关键路径(verify_token)的超时,要短 — 它在 Subscribe 建连前,慢一秒用户感知一秒。
const VERIFY_TOKEN_TIMEOUT: Duration = Duration::from_secs(3);
/// 业务路径(forward)默认超时。比 verify 长,业务可能慢点。
const BUSINESS_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

impl DownstreamClient {
    pub fn new(base_url: &str, paths: AuthPaths, oauth: OAuthCreds) -> Result<Self, RelayError> {
        // F4:reqwest 全面 h2 调优 — 关键是 HTTP/2 多路复用,把 5000 conn × N forward
        // 收敛到 1-2 个 TCP carries 数千 streams。pool size 在 h2 下基本无意义,
        // 但 h1.1 fallback 时仍需要充足空间。
        let h2_prior = std::env::var("RELAY_HTTP2_PRIOR_KNOWLEDGE")
            .map(|v| v == "true" || v == "1")
            .unwrap_or(false);
        let mut builder = Client::builder()
            .timeout(BUSINESS_REQUEST_TIMEOUT)
            .connect_timeout(Duration::from_secs(1))      // F4:TCP 握手 hang 不吃 verify 3s 预算
            .pool_max_idle_per_host(256)                  // F4:h1.1 fallback 容量
            .pool_idle_timeout(Duration::from_secs(90))   // F4:与 h2 keepalive 配套
            .tcp_keepalive(Duration::from_secs(60))
            .tcp_nodelay(true)                            // F4:禁 Nagle,小请求(verify 空 body)不攒 40ms
            .http2_keep_alive_interval(Duration::from_secs(30))
            .http2_keep_alive_timeout(Duration::from_secs(10))
            .http2_keep_alive_while_idle(true);
        if h2_prior {
            // h2c(h2 without TLS):部署确认后台支持 h2 cleartext 时 opt-in。
            // https 场景靠 ALPN 自动协商,不需要 prior_knowledge。
            builder = builder.http2_prior_knowledge();
        }
        let http = builder
            .build()
            .map_err(|e| RelayError::Http(e.to_string()))?;
        Ok(Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            http,
            paths,
            oauth,
        })
    }

    /// 测试便捷构造:默认 AuthPaths + 默认 OAuth(rh_wxchat / rh_wxchat)。
    pub fn new_with_defaults(base_url: &str) -> Result<Self, RelayError> {
        Self::new(
            base_url,
            AuthPaths {
                login: "/account-app/oauth2/token".into(),
                verify_token: "/v1/verify_token".into(),
                logout: "/auth/logout".into(),
            },
            OAuthCreds {
                client_id: "rh_wxchat".into(),
                client_secret: "rh_wxchat".into(),
            },
        )
    }

    /// OAuth2 password grant + Basic client auth → 业务后台。
    /// 形态:`POST {login_path}?scope=server&terminalId=<dev>&grant_type=password`
    ///       `Authorization: Basic Base64("<client_id>:<client_secret>")`
    ///       `Content-Type: application/x-www-form-urlencoded`
    ///       body: `username=…&password=…`
    pub async fn login(&self, req: LoginReq<'_>) -> Result<LoginResp, RelayError> {
        let url = format!("{}{}", self.base_url, self.paths.login);
        let started = Instant::now();

        tracing::debug!(
            target: "chathub_relay::downstream",
            url = %url,
            "oauth2 login request",
        );

        let resp = self
            .http
            .post(&url)
            .query(&[
                ("scope", "server"),
                ("terminalId", req.device_id),
                ("grant_type", "password"),
            ])
            .basic_auth(&self.oauth.client_id, Some(&self.oauth.client_secret))
            .form(&[("username", req.username), ("password", req.password)])
            .send()
            .await
            .map_err(|e| {
                let elapsed_ms = started.elapsed().as_millis() as u64;
                tracing::warn!(
                    target: "chathub_relay::downstream",
                    error = %e,
                    elapsed_ms,
                    "oauth2 login send failed",
                );
                if e.is_timeout() || e.is_connect() {
                    RelayError::Transient
                } else {
                    RelayError::Http(e.to_string())
                }
            })?;

        let status = resp.status();
        let elapsed_ms = started.elapsed().as_millis() as u64;
        if !status.is_success() {
            let code = status.as_u16();
            tracing::warn!(
                target: "chathub_relay::downstream",
                status = code,
                elapsed_ms,
                "oauth2 login non-2xx",
            );
            return Err(match code {
                401 | 403 => RelayError::InvalidCreds,
                400 => RelayError::InvalidArg,
                c if c >= 500 => RelayError::Transient,
                _ => RelayError::Internal,
            });
        }

        let jdd: JddTokenVO = resp.json().await.map_err(|e| {
            tracing::warn!(
                target: "chathub_relay::downstream",
                error = %e,
                elapsed_ms,
                "oauth2 login JSON parse failed (upstream protocol violation)",
            );
            RelayError::Internal
        })?;

        tracing::info!(
            target: "chathub_relay::downstream",
            user_id = jdd.user_id,
            elapsed_ms,
            "oauth2 login ok",
        );

        Ok(LoginResp {
            access_token: jdd.access_token.token_value,
            user_id: jdd.user_id.to_string(),
            display_name: jdd.nick_name.unwrap_or_default(),
            avatar_url: String::new(),
            role: String::new(),
            tenant_id: String::new(),
            wecom_accounts: Vec::new(),
        })
    }

    /// 透传客户端登出到业务后台。best-effort:网络错也不阻断。
    pub async fn logout(&self, client_token: &str) -> Result<(), RelayError> {
        let url = format!("{}{}", self.base_url, self.paths.logout);
        let _ = self.http.post(&url).bearer_auth(client_token).send().await;
        Ok(())
    }

    /// OAuth2 introspection 风格 verify:Bearer = 要校验的 token,空 body。
    pub async fn verify_token(&self, client_token: &str) -> Result<VerifyTokenResp, RelayError> {
        let url = format!("{}{}", self.base_url, self.paths.verify_token);
        let started = Instant::now();

        let resp = self
            .http
            .post(&url)
            .bearer_auth(client_token)
            .timeout(VERIFY_TOKEN_TIMEOUT)
            .send()
            .await
            .map_err(|e| {
                let elapsed_ms = started.elapsed().as_millis() as u64;
                tracing::warn!(
                    target: "chathub_relay::downstream",
                    url = %url,
                    error = %e,
                    elapsed_ms,
                    "verify_token send failed",
                );
                if e.is_timeout() || e.is_connect() {
                    RelayError::Transient
                } else {
                    RelayError::Http(e.to_string())
                }
            })?;

        let status = resp.status();
        let elapsed_ms = started.elapsed().as_millis() as u64;
        if !status.is_success() {
            let code = status.as_u16();
            tracing::warn!(
                target: "chathub_relay::downstream",
                status = code,
                elapsed_ms,
                "verify_token non-2xx",
            );
            return Err(match code {
                401 | 403 => RelayError::InvalidCreds,
                c if c >= 500 => RelayError::Transient,
                _ => RelayError::Internal,
            });
        }

        let body: VerifyTokenResp = resp
            .json()
            .await
            .map_err(|e| RelayError::Http(e.to_string()))?;

        tracing::info!(
            target: "chathub_relay::downstream",
            elapsed_ms,
            user_id = %body.user_id,
            employee_id = body.employee_id,
            "verify_token ok",
        );

        Ok(body)
    }

    // ─── Hub.Forward 透传 ────────────────────────────────────────────
    //
    // relay 不解析 body_json,按 routes 查到 method 对应的 (HTTP verb, 路径) 后整段透传。
    // Authorization 用客户端原 Bearer token(关键:让业务后台解析真实身份)。
    // `X-Relay-Employee-Id` 头是 relay 已验证过的 employee 标识,审计 / 兜底用。

    pub async fn forward(
        &self,
        routes: &DownstreamRoutes,
        method: &str,
        employee_id: i64,
        body_bytes: &[u8],
        client_token: &str,
    ) -> Result<ForwardOutcome, RelayError> {
        let spec = routes.get(method).ok_or(RelayError::InvalidArg)?;
        let url = format!("{}{}", self.base_url, spec.path);
        let started = Instant::now();

        tracing::debug!(
            target: "chathub_relay::downstream",
            method,
            verb = ?spec.method,
            url = %url,
            employee_id,
            body_len = body_bytes.len(),
            "forward request",
        );

        let builder = match spec.method {
            HttpMethod::Get => {
                if !body_bytes.is_empty() {
                    tracing::debug!(
                        target: "chathub_relay::downstream",
                        method,
                        body_len = body_bytes.len(),
                        "GET method given non-empty body — ignored",
                    );
                }
                self.http.get(&url)
            }
            HttpMethod::Post => self
                .http
                .post(&url)
                .header("Content-Type", "application/json")
                .body(body_bytes.to_vec()),
        };

        let resp = builder
            .bearer_auth(client_token)
            .header("X-Relay-Employee-Id", employee_id.to_string())
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

        // REST 隧道语义:2xx 和 4xx 都返回 ForwardOutcome,客户端按 http_status 自决。
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

        if status.is_success() {
            tracing::info!(
                target: "chathub_relay::downstream",
                method,
                status = status.as_u16(),
                body_len = body.len(),
                elapsed_ms,
                "forward ok",
            );
        } else {
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_string_contains, header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn jdd_response() -> serde_json::Value {
        serde_json::json!({
            "accessToken": {
                "tokenValue": "biz-tok-abc",
                "tokenType": { "value": "Bearer" },
                "issuedAt": "2026-05-16 10:00:00",
                "expiresAt": "2026-05-16 22:00:00"
            },
            "userId": 1234,
            "username": "alice",
            "nickName": "Alice",
            "mobile": "1380000000",
            "channel": 3
        })
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn login_oauth2_form_basic_query() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/account-app/oauth2/token"))
            .and(query_param("scope", "server"))
            .and(query_param("terminalId", "dev-A"))
            .and(query_param("grant_type", "password"))
            // basic_auth("rh_wxchat", Some("rh_wxchat")) → Base64("rh_wxchat:rh_wxchat")
            .and(header(
                "authorization",
                "Basic cmhfd3hjaGF0OnJoX3d4Y2hhdA==",
            ))
            .and(header(
                "content-type",
                "application/x-www-form-urlencoded",
            ))
            .and(body_string_contains("username=alice"))
            .and(body_string_contains("password=secret"))
            .respond_with(ResponseTemplate::new(200).set_body_json(jdd_response()))
            .mount(&mock)
            .await;

        let client = DownstreamClient::new_with_defaults(&mock.uri()).unwrap();
        let resp = client
            .login(LoginReq {
                username: "alice",
                password: "secret",
                device_id: "dev-A",
            })
            .await
            .unwrap();
        assert_eq!(resp.access_token, "biz-tok-abc");
        assert_eq!(resp.user_id, "1234");
        assert_eq!(resp.display_name, "Alice");
        assert!(resp.wecom_accounts.is_empty()); // 永远空
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn login_oauth2_401_maps_invalid_creds() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/account-app/oauth2/token"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&mock)
            .await;
        let client = DownstreamClient::new_with_defaults(&mock.uri()).unwrap();
        let err = client
            .login(LoginReq {
                username: "u",
                password: "bad",
                device_id: "d",
            })
            .await
            .unwrap_err();
        assert!(matches!(err, RelayError::InvalidCreds));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn login_oauth2_503_maps_transient() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/account-app/oauth2/token"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&mock)
            .await;
        let client = DownstreamClient::new_with_defaults(&mock.uri()).unwrap();
        let err = client
            .login(LoginReq {
                username: "u",
                password: "p",
                device_id: "d",
            })
            .await
            .unwrap_err();
        assert!(matches!(err, RelayError::Transient));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn login_oauth2_malformed_jdd_maps_internal() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/account-app/oauth2/token"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"garbage": true})),
            )
            .mount(&mock)
            .await;
        let client = DownstreamClient::new_with_defaults(&mock.uri()).unwrap();
        let err = client
            .login(LoginReq {
                username: "u",
                password: "p",
                device_id: "d",
            })
            .await
            .unwrap_err();
        assert!(matches!(err, RelayError::Internal));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn verify_token_uses_client_token_as_bearer_and_empty_body() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/verify_token"))
            .and(header("authorization", "Bearer client-xyz"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "active": true,
                "user_id": "u-9",
                "device_id": "dev-X",
                "accounts": ["wa-1"],
                "exp_ms": 1_900_000_000_000i64,
                "employee_id": 42
            })))
            .mount(&mock)
            .await;
        let client = DownstreamClient::new_with_defaults(&mock.uri()).unwrap();
        let resp = client.verify_token("client-xyz").await.unwrap();
        assert!(resp.active);
        assert_eq!(resp.employee_id, 42);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn verify_token_401_maps_invalid_creds() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/verify_token"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&mock)
            .await;
        let client = DownstreamClient::new_with_defaults(&mock.uri()).unwrap();
        let err = client.verify_token("bad").await.unwrap_err();
        assert!(matches!(err, RelayError::InvalidCreds));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn logout_is_best_effort_ok_even_on_404() {
        let mock = MockServer::start().await;
        // 不挂任何路由 → 默认 404
        let client = DownstreamClient::new_with_defaults(&mock.uri()).unwrap();
        assert!(client.logout("t").await.is_ok());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn forward_post_uses_client_token_not_relay_secret() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/send"))
            .and(header("authorization", "Bearer client-xyz"))
            .and(header("x-relay-employee-id", "42"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"ok": true})))
            .mount(&mock)
            .await;
        let client = DownstreamClient::new_with_defaults(&mock.uri()).unwrap();
        let routes = DownstreamRoutes::default_for_test();
        let outcome = client
            .forward(&routes, "send", 42, br#"{"x":1}"#, "client-xyz")
            .await
            .unwrap();
        assert_eq!(outcome.http_status, 200);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn forward_get_omits_body_and_dispatches_get() {
        let mock = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path(
                "/wechat-business-app/wecom-cs/v1/wecomAggregate/account/listMine",
            ))
            .and(header("authorization", "Bearer client-xyz"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!([{"id": "wa-1"}])),
            )
            .mount(&mock)
            .await;
        let client = DownstreamClient::new_with_defaults(&mock.uri()).unwrap();
        let routes = DownstreamRoutes::default_for_test();
        // 即使传非空 body,GET 也忽略
        let outcome = client
            .forward(&routes, "list_accounts", 42, b"ignored-body", "client-xyz")
            .await
            .unwrap();
        assert_eq!(outcome.http_status, 200);
        let arr: serde_json::Value = serde_json::from_slice(&outcome.body).unwrap();
        assert_eq!(arr[0]["id"], "wa-1");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn forward_unknown_method_returns_invalid_arg() {
        let mock = MockServer::start().await;
        let client = DownstreamClient::new_with_defaults(&mock.uri()).unwrap();
        let routes = DownstreamRoutes::default_for_test();
        let err = client
            .forward(&routes, "unknown_method", 1, b"", "tok")
            .await
            .unwrap_err();
        assert!(matches!(err, RelayError::InvalidArg));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn forward_business_4xx_returns_outcome_not_error() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/send"))
            .respond_with(
                ResponseTemplate::new(403)
                    .set_body_json(serde_json::json!({"code": "NO_PERMISSION"})),
            )
            .mount(&mock)
            .await;
        let client = DownstreamClient::new_with_defaults(&mock.uri()).unwrap();
        let routes = DownstreamRoutes::default_for_test();
        let outcome = client
            .forward(&routes, "send", 1, b"{}", "tok")
            .await
            .unwrap();
        assert_eq!(outcome.http_status, 403);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn forward_business_5xx_maps_internal() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/send"))
            .respond_with(ResponseTemplate::new(502))
            .mount(&mock)
            .await;
        let client = DownstreamClient::new_with_defaults(&mock.uri()).unwrap();
        let routes = DownstreamRoutes::default_for_test();
        let err = client
            .forward(&routes, "send", 1, b"{}", "tok")
            .await
            .unwrap_err();
        assert!(matches!(err, RelayError::Internal));
    }
}
