//! DownstreamClient — reqwest 封装下游 HTTP 合约。
//!
//! 鉴权模型(2026-05-16 OAuth2 重构):
//!   - login:OAuth2 password grant + Basic client auth(唯一例外,客户端此时无 token)
//!   - verify_token / logout / forward(业务 RPC):一律用客户端原 Bearer token 透传
//!   - relay 不再持有出站 shared secret(`RELAY_DOWNSTREAM_SECRET` 已下线)
//!
//! 安全约束:`client_token` 仅作 `&str` 在函数参数 / `bearer_auth()` 之间流转,
//!   不进任何 struct / cache / 日志字段(日志只允许出现 token 前 8 char + ***)。
//!   日志输出需走 [`crate::secret::redact_token`] 强制脱敏,不要直接拼明文 token。

use crate::config::{DownstreamRoutes, HttpMethod};
use crate::error::{map_downstream_4xx_5xx, RelayError};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

/// 业务后台统一响应包络(2026-05-17 起):
///   { "code": 1, "serviceCode": "...", "msg": "成功", "data": {...} }
/// 成功 = `code == 1`,其余视为业务错(`msg` 直接展示给用户)。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Envelope<T> {
    code: i32,
    #[serde(default)]
    service_code: String,
    #[serde(default)]
    msg: String,
    #[serde(default = "Option::default")]
    data: Option<T>,
}

/// 解 envelope 后取 `data`:
///   - 解析失败 → `RelayError::Internal`(契约错,relay 跟后台对不上 envelope 形态)
///   - `code != 1` → `RelayError::BusinessError`(把 service_code + msg 透传给客户端)
///   - `code == 1` 但 data 缺失 → 调用方自行决定(返 `None`,典型如 logout 不关心)
fn unwrap_envelope<T>(bytes: &[u8], op: &str) -> Result<Option<T>, RelayError>
where
    T: serde::de::DeserializeOwned,
{
    let env: Envelope<T> = serde_json::from_slice(bytes).map_err(|e| {
        tracing::warn!(
            target: "chathub_relay::downstream",
            op,
            error = %e,
            "envelope parse failed (upstream protocol violation)",
        );
        RelayError::Internal
    })?;
    if env.code != 1 {
        tracing::warn!(
            target: "chathub_relay::downstream",
            op,
            code = env.code,
            service_code = %env.service_code,
            msg = %env.msg,
            "business error (envelope code != 1)",
        );
        return Err(RelayError::BusinessError {
            service_code: env.service_code,
            msg: env.msg,
        });
    }
    Ok(env.data)
}

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
    /// notify/pull 通知补偿拉取(relay→业务端内部 RPC)。
    pub notify_pull: String,
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
    /// 数值员工 ID(来自 JddTokenVO.userId)。AuthSvc 用它预填 TokenAuthenticator cache,
    /// 让登录后的 Subscribe 直接命中,跳过 verify_token 一跳。
    pub employee_id: i64,
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
///
/// 业务合约(camelCase):
///   { "employeeId": 1234, "username": "", "nickName": "", "mobile": "", "channel": "" }
///
/// `employeeId == 0`(或缺失)视为未激活,鉴权失败。其它字段当前 relay 不消费,
/// 仅 `username` / `nickName` 留作未来可能的日志增强,不进 UserCtx。
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VerifyTokenResp {
    /// 员工数值 ID。0 或缺失 → 鉴权失败。
    #[serde(default)]
    pub employee_id: i64,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub nick_name: String,
}

/// notify/pull 请求体(relay→业务端,§6.4)。list 模式与 range 模式二选一:
/// 传 `notify_seq_list` 时不要同时传 `start/end`。
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NotifyPullReq<'a> {
    pub client_id: &'a str,
    pub employee_id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notify_seq_list: Option<&'a [u64]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_notify_seq: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_notify_seq: Option<u64>,
    pub limit: u32,
    pub request_id: &'a str,
    /// 拉取原因:`RELAY_LOG_MISSING` / `PUSH_LOST` / `CLIENT_GAP_REPLAY` / `OPS_COMPENSATE`。
    pub reason: &'a str,
    pub trace_id: &'a str,
}

/// notify/pull 响应 data(§6.4)。
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NotifyPullResp {
    #[serde(default)]
    pub accepted: bool,
    #[serde(default)]
    pub employee_id: i64,
    #[serde(default)]
    pub batches: Vec<NotifyPullBatch>,
    #[serde(default)]
    pub missing_notify_seq_list: Vec<u64>,
    #[serde(default)]
    pub has_more: bool,
    #[serde(default)]
    pub next_start_notify_seq: Option<u64>,
    #[serde(default)]
    pub reject_code: Option<String>,
    #[serde(default)]
    pub reject_message: Option<String>,
}

/// notify/pull 命中的单个 batch。`payload` 与 §6.3 push body 同结构 →
/// 由调用方 `serde_json::from_value::<PushBatchIn>` 复用解析。
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NotifyPullBatch {
    pub notify_seq: u64,
    #[serde(default)]
    pub batch_id: Option<String>,
    #[serde(default)]
    pub batch_time: Option<String>,
    #[serde(default)]
    pub send_status: Option<i32>,
    pub payload: serde_json::Value,
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
/// notify/pull 超时。介于 verify(3s)与业务(15s)之间 — 补偿拉取罕见但要兜住分页往返。
const NOTIFY_PULL_TIMEOUT: Duration = Duration::from_secs(5);

impl DownstreamClient {
    /// base_url 的 host 是否为 loopback(localhost / 127.0.0.0/8 / ::1)。
    fn is_loopback_base(base_url: &str) -> bool {
        reqwest::Url::parse(base_url)
            .ok()
            .and_then(|u| u.host_str().map(str::to_owned))
            .map(|host| match host.as_str() {
                "localhost" => true,
                h => h
                    .trim_start_matches('[')
                    .trim_end_matches(']')
                    .parse::<std::net::IpAddr>()
                    .map(|ip| ip.is_loopback())
                    .unwrap_or(false),
            })
            .unwrap_or(false)
    }

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
        // loopback downstream(mock/dev)绕过系统代理:reqwest 默认读 ALL_PROXY,会把 127.0.0.1 请求误导向 SOCKS 代理,代理不在时触发 transient downstream。
        if Self::is_loopback_base(base_url) {
            builder = builder.no_proxy();
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
                verify_token: "/wechat-business-app/rpc/v1/wecomAggregate/connection/verifyToken"
                    .into(),
                logout: "/auth/logout".into(),
                notify_pull: "/wechat-business-app/rpc/v1/wecomAggregate/notify/pull".into(),
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
            return Err(map_downstream_4xx_5xx(
                code,
                "oauth2 login returned non-2xx",
            ));
        }

        let body_bytes = resp.bytes().await.map_err(|e| {
            tracing::warn!(
                target: "chathub_relay::downstream",
                error = %e,
                elapsed_ms,
                "oauth2 login body read failed",
            );
            RelayError::Http(e.to_string())
        })?;
        let jdd: JddTokenVO =
            unwrap_envelope::<JddTokenVO>(&body_bytes, "login")?.ok_or_else(|| {
                tracing::warn!(
                    target: "chathub_relay::downstream",
                    elapsed_ms,
                    "oauth2 login envelope ok but data missing",
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
            employee_id: jdd.user_id, // 数值 ID,关键给 cache prepopulate 用
            display_name: jdd.nick_name.unwrap_or_default(),
            avatar_url: String::new(),
            role: String::new(),
            tenant_id: String::new(),
            wecom_accounts: Vec::new(),
        })
    }

    /// 透传客户端登出到业务后台。best-effort:网络错也不阻断。
    /// 业务后台返 `{code:1, msg:"成功", data:null}` 形态;envelope 解析失败/code!=1 时
    /// 也只 warn-log 不阻断(logout 关键路径不应被业务报错卡住)。
    pub async fn logout(&self, client_token: &str) -> Result<(), RelayError> {
        let url = format!("{}{}", self.base_url, self.paths.logout);
        let resp = match self.http.post(&url).bearer_auth(client_token).send().await {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(
                    target: "chathub_relay::downstream",
                    error = %e,
                    "logout network error — ignored (best-effort)",
                );
                return Ok(());
            }
        };
        let status = resp.status();
        if !status.is_success() {
            tracing::warn!(
                target: "chathub_relay::downstream",
                status = status.as_u16(),
                "logout non-2xx — ignored (best-effort)",
            );
            return Ok(());
        }
        let bytes = match resp.bytes().await {
            Ok(b) => b,
            Err(_) => return Ok(()),
        };
        // envelope 不强求 — 后台可能 200 + 空 body / 错误 envelope,都不阻断 logout 流程
        if let Err(e) = unwrap_envelope::<serde::de::IgnoredAny>(&bytes, "logout") {
            tracing::warn!(
                target: "chathub_relay::downstream",
                error = %e,
                "logout envelope reported error — ignored (best-effort)",
            );
        }
        Ok(())
    }

    /// OAuth2 introspection 风格 verify:Bearer = 要校验的 token,空 JSON body `{}`。
    ///
    /// 协议形态(2026-05-16 修复 415 后):
    ///   POST {verify_token_path}
    ///   Authorization: Bearer <client_token>
    ///   Content-Type: application/json
    ///   Body: {}
    ///
    /// 为什么发 `{}` 而不是真正空 body:多数后台(Spring Boot 默认 @PostMapping)
    /// 在请求**无 Content-Type 或无 body** 时直接返 415 Unsupported Media Type,
    /// 不进 handler。`{}` + JSON header 是最不可能被挑刺的形态。
    pub async fn verify_token(&self, client_token: &str) -> Result<VerifyTokenResp, RelayError> {
        let url = format!("{}{}", self.base_url, self.paths.verify_token);
        let started = Instant::now();

        let resp = self
            .http
            .post(&url)
            .bearer_auth(client_token)
            .header("Content-Type", "application/json")
            .body("{}")
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
            return Err(map_downstream_4xx_5xx(
                code,
                "verify_token returned non-2xx",
            ));
        }

        let body_bytes = resp
            .bytes()
            .await
            .map_err(|e| RelayError::Http(e.to_string()))?;
        let body: VerifyTokenResp =
            unwrap_envelope::<VerifyTokenResp>(&body_bytes, "verify_token")?.ok_or_else(|| {
                tracing::warn!(
                    target: "chathub_relay::downstream",
                    elapsed_ms,
                    "verify_token envelope ok but data missing",
                );
                RelayError::Internal
            })?;

        tracing::info!(
            target: "chathub_relay::downstream",
            elapsed_ms,
            employee_id = body.employee_id,
            "verify_token ok",
        );

        Ok(body)
    }

    /// notify/pull 通知补偿拉取(relay→业务端内部 RPC,§6.4)。
    /// 形态同 verify_token:Bearer 透传客户端 token + `X-Relay-Employee-Id` 头,JSON body。
    /// 2xx → 解 envelope 取 data;非 2xx → `map_downstream_4xx_5xx`;超时/连接错 → `Transient`。
    pub async fn notify_pull(
        &self,
        client_token: &str,
        req: NotifyPullReq<'_>,
    ) -> Result<NotifyPullResp, RelayError> {
        let url = format!("{}{}", self.base_url, self.paths.notify_pull);
        let started = Instant::now();
        let body = serde_json::to_vec(&req).map_err(|_| RelayError::Internal)?;

        let resp = self
            .http
            .post(&url)
            .bearer_auth(client_token)
            .header("Content-Type", "application/json")
            .header("X-Relay-Employee-Id", req.employee_id.to_string())
            .body(body)
            .timeout(NOTIFY_PULL_TIMEOUT)
            .send()
            .await
            .map_err(|e| {
                let elapsed_ms = started.elapsed().as_millis() as u64;
                tracing::warn!(
                    target: "chathub_relay::downstream",
                    url = %url,
                    error = %e,
                    elapsed_ms,
                    "notify_pull send failed",
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
                "notify_pull non-2xx",
            );
            return Err(map_downstream_4xx_5xx(code, "notify_pull returned non-2xx"));
        }

        let body_bytes = resp
            .bytes()
            .await
            .map_err(|e| RelayError::Http(e.to_string()))?;
        let data: NotifyPullResp = unwrap_envelope::<NotifyPullResp>(&body_bytes, "notify_pull")?
            .ok_or_else(|| {
            tracing::warn!(
                target: "chathub_relay::downstream",
                elapsed_ms,
                "notify_pull envelope ok but data missing",
            );
            RelayError::Internal
        })?;

        tracing::info!(
            target: "chathub_relay::downstream",
            elapsed_ms,
            employee_id = req.employee_id,
            batches = data.batches.len(),
            missing = data.missing_notify_seq_list.len(),
            has_more = data.has_more,
            "notify_pull ok",
        );
        Ok(data)
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
        body: bytes::Bytes,
        query: &std::collections::HashMap<String, String>,
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
            body_len = body.len(),
            query_len = query.len(),
            "forward request",
        );

        let builder = match spec.method {
            HttpMethod::Get => {
                if !body.is_empty() {
                    tracing::debug!(
                        target: "chathub_relay::downstream",
                        method,
                        body_len = body.len(),
                        "GET method given non-empty body — ignored",
                    );
                }
                // GET 路径:query map 拼到 URL 上(reqwest 自动 URL-encode)
                self.http.get(&url).query(query)
            }
            HttpMethod::Post => {
                if !query.is_empty() {
                    tracing::debug!(
                        target: "chathub_relay::downstream",
                        method,
                        query_len = query.len(),
                        "POST method given query params — ignored (POST 用 body 传参)",
                    );
                }
                // body 直接交给 reqwest(Bytes → Body 零拷贝),不再 to_vec() 多拷一次
                self.http
                    .post(&url)
                    .header("Content-Type", "application/json")
                    .body(body)
            }
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

    /// 2026-05-17 包络化后,业务后台响应统一是 `{code:1, serviceCode, msg, data}`。
    /// 测试 fixture 用这个 helper 把原 payload 包成成功包络。
    fn envelope_ok_json(data: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "code": 1,
            "serviceCode": "",
            "msg": "成功",
            "data": data
        })
    }

    fn jdd_response() -> serde_json::Value {
        envelope_ok_json(serde_json::json!({
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
        }))
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

    const VERIFY_PATH: &str = "/wechat-business-app/rpc/v1/wecomAggregate/connection/verifyToken";

    #[tokio::test(flavor = "multi_thread")]
    async fn verify_token_uses_client_token_as_bearer_and_empty_body() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(VERIFY_PATH))
            .and(header("authorization", "Bearer client-xyz"))
            // 415 修复:必须发 Content-Type + body `{}`,否则 Spring 后台 415
            .and(header("content-type", "application/json"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(envelope_ok_json(serde_json::json!({
                    "employeeId": 1231231233112313_i64,
                    "username": "",
                    "nickName": "",
                    "mobile": "",
                    "channel": ""
                }))),
            )
            .mount(&mock)
            .await;
        let client = DownstreamClient::new_with_defaults(&mock.uri()).unwrap();
        let resp = client.verify_token("client-xyz").await.unwrap();
        assert_eq!(resp.employee_id, 1231231233112313);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn verify_token_415_maps_protocol_mismatch() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(VERIFY_PATH))
            .respond_with(ResponseTemplate::new(415))
            .mount(&mock)
            .await;
        let client = DownstreamClient::new_with_defaults(&mock.uri()).unwrap();
        let err = client.verify_token("client-xyz").await.unwrap_err();
        match err {
            RelayError::ProtocolMismatch { code, .. } => assert_eq!(code, 415),
            other => panic!("expected ProtocolMismatch, got {other:?}"),
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn verify_token_404_maps_protocol_mismatch() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(VERIFY_PATH))
            .respond_with(ResponseTemplate::new(404))
            .mount(&mock)
            .await;
        let client = DownstreamClient::new_with_defaults(&mock.uri()).unwrap();
        let err = client.verify_token("client-xyz").await.unwrap_err();
        assert!(matches!(
            err,
            RelayError::ProtocolMismatch { code: 404, .. }
        ));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn verify_token_401_maps_invalid_creds() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(VERIFY_PATH))
            .respond_with(ResponseTemplate::new(401))
            .mount(&mock)
            .await;
        let client = DownstreamClient::new_with_defaults(&mock.uri()).unwrap();
        let err = client.verify_token("bad").await.unwrap_err();
        assert!(matches!(err, RelayError::InvalidCreds));
    }

    const NOTIFY_PULL_PATH: &str = "/wechat-business-app/rpc/v1/wecomAggregate/notify/pull";

    fn pull_req<'a>(start: u64, limit: u32) -> NotifyPullReq<'a> {
        NotifyPullReq {
            client_id: "rh_wxchat",
            employee_id: 42,
            notify_seq_list: None,
            start_notify_seq: Some(start),
            end_notify_seq: None,
            limit,
            request_id: "PULL_TEST_1",
            reason: "RELAY_LOG_MISSING",
            trace_id: "TRACE_TEST_1",
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn notify_pull_parses_batches_and_pagination() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(NOTIFY_PULL_PATH))
            .and(header("authorization", "Bearer client-xyz"))
            .and(header("content-type", "application/json"))
            .and(header("x-relay-employee-id", "42"))
            .respond_with(ResponseTemplate::new(200).set_body_json(envelope_ok_json(
                serde_json::json!({
                    "accepted": true,
                    "clientId": "rh_wxchat",
                    "employeeId": 42,
                    "batches": [{
                        "notifySeq": 1025,
                        "batchId": "rh_wxchat:42:1025",
                        "batchTime": "2026-05-17 11:28:00",
                        "sendStatus": 1,
                        "payload": {
                            "notifySeq": 1025,
                            "clientId": "rh_wxchat",
                            "employeeId": 42,
                            "batchId": "rh_wxchat:42:1025",
                            "batchTime": "2026-05-17 11:28:00",
                            "events": [{ "eventType": "MESSAGE_UPSERT", "conversationId": "c1" }]
                        }
                    }],
                    "missingNotifySeqList": [1026],
                    "hasMore": true,
                    "nextStartNotifySeq": 1027
                }),
            )))
            .mount(&mock)
            .await;
        let client = DownstreamClient::new_with_defaults(&mock.uri()).unwrap();
        let resp = client
            .notify_pull("client-xyz", pull_req(1025, 100))
            .await
            .unwrap();
        assert!(resp.accepted);
        assert_eq!(resp.batches.len(), 1);
        assert_eq!(resp.batches[0].notify_seq, 1025);
        assert_eq!(resp.missing_notify_seq_list, vec![1026]);
        assert!(resp.has_more);
        assert_eq!(resp.next_start_notify_seq, Some(1027));
        // payload 与 §6.3 push body 同构,可直接解析
        assert_eq!(
            resp.batches[0].payload["events"][0]["eventType"],
            "MESSAGE_UPSERT"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn notify_pull_404_maps_protocol_mismatch() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(NOTIFY_PULL_PATH))
            .respond_with(ResponseTemplate::new(404))
            .mount(&mock)
            .await;
        let client = DownstreamClient::new_with_defaults(&mock.uri()).unwrap();
        let err = client.notify_pull("t", pull_req(1, 100)).await.unwrap_err();
        assert!(matches!(
            err,
            RelayError::ProtocolMismatch { code: 404, .. }
        ));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn notify_pull_503_maps_transient() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(NOTIFY_PULL_PATH))
            .respond_with(ResponseTemplate::new(503))
            .mount(&mock)
            .await;
        let client = DownstreamClient::new_with_defaults(&mock.uri()).unwrap();
        let err = client.notify_pull("t", pull_req(1, 100)).await.unwrap_err();
        assert!(matches!(err, RelayError::Transient));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn notify_pull_malformed_maps_internal() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(NOTIFY_PULL_PATH))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"garbage": true})),
            )
            .mount(&mock)
            .await;
        let client = DownstreamClient::new_with_defaults(&mock.uri()).unwrap();
        let err = client.notify_pull("t", pull_req(1, 100)).await.unwrap_err();
        assert!(matches!(err, RelayError::Internal));
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
            .forward(
                &routes,
                "send",
                42,
                bytes::Bytes::from_static(br#"{"x":1}"#),
                &std::collections::HashMap::new(),
                "client-xyz",
            )
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
            .forward(
                &routes,
                "list_accounts",
                42,
                bytes::Bytes::from_static(b"ignored-body"),
                &std::collections::HashMap::new(),
                "client-xyz",
            )
            .await
            .unwrap();
        assert_eq!(outcome.http_status, 200);
        let arr: serde_json::Value = serde_json::from_slice(&outcome.body).unwrap();
        assert_eq!(arr[0]["id"], "wa-1");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn forward_get_passes_query_params_into_url() {
        use wiremock::matchers::query_param;
        let mock = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path(
                "/wechat-business-app/wecom-cs/v1/wecomAggregate/account/listMine",
            ))
            .and(query_param("enabled", "true"))
            .and(header("authorization", "Bearer client-xyz"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
            .mount(&mock)
            .await;
        let client = DownstreamClient::new_with_defaults(&mock.uri()).unwrap();
        let routes = DownstreamRoutes::default_for_test();
        let mut q = std::collections::HashMap::new();
        q.insert("enabled".to_string(), "true".to_string());
        let outcome = client
            .forward(
                &routes,
                "list_accounts",
                42,
                bytes::Bytes::new(),
                &q,
                "client-xyz",
            )
            .await
            .unwrap();
        assert_eq!(outcome.http_status, 200);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn forward_unknown_method_returns_invalid_arg() {
        let mock = MockServer::start().await;
        let client = DownstreamClient::new_with_defaults(&mock.uri()).unwrap();
        let routes = DownstreamRoutes::default_for_test();
        let err = client
            .forward(
                &routes,
                "unknown_method",
                1,
                bytes::Bytes::new(),
                &std::collections::HashMap::new(),
                "tok",
            )
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
            .forward(
                &routes,
                "send",
                1,
                bytes::Bytes::from_static(b"{}"),
                &std::collections::HashMap::new(),
                "tok",
            )
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
            .forward(
                &routes,
                "send",
                1,
                bytes::Bytes::from_static(b"{}"),
                &std::collections::HashMap::new(),
                "tok",
            )
            .await
            .unwrap_err();
        assert!(matches!(err, RelayError::Internal));
    }
}
