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
use std::sync::Arc;
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

/// 下游 base_url 的来源。
///   - `Static`:固定 url(未启用 Nacos 的现状,或 Nacos 兜底)。
///   - `Nacos`:每请求向 Nacos 解析一个健康实例的地址;拿不到时回退 `fallback`。
///     每请求决策 → Nacos 恢复后自动切回发现结果,无需重启。
#[derive(Clone)]
pub enum BaseUrlSource {
    /// 固定 base_url(已 trim 尾部 '/')。
    Static(Arc<str>),
    /// Nacos 服务发现 + 静态兜底(`fallback` 已 trim 尾部 '/')。
    Nacos {
        client: Arc<crate::nacos::NacosClient>,
        fallback: Arc<str>,
    },
}

impl BaseUrlSource {
    /// 构造静态来源,自动 trim 尾部 '/'。
    pub fn new_static(url: &str) -> Self {
        Self::Static(Arc::from(url.trim_end_matches('/')))
    }

    /// 构造 Nacos 来源,`fallback` 自动 trim 尾部 '/'。
    pub fn new_nacos(client: Arc<crate::nacos::NacosClient>, fallback: &str) -> Self {
        Self::Nacos {
            client,
            fallback: Arc::from(fallback.trim_end_matches('/')),
        }
    }

    /// 当前应使用的 base_url。Nacos 失败回退 `fallback`,故总能返回可用值,不会失败。
    pub async fn base_url(&self) -> String {
        match self {
            Self::Static(u) => u.to_string(),
            Self::Nacos { client, fallback } => match client.discover_base_url().await {
                Some(u) => u,
                None => fallback.to_string(),
            },
        }
    }

    /// 给 reqwest `no_proxy` 启发式(loopback 检测)用的代表性 url。
    /// Nacos 模式用静态 `fallback` 代表(典型 dev 用 loopback mock)。
    fn representative_url(&self) -> &str {
        match self {
            Self::Static(u) => u,
            Self::Nacos { fallback, .. } => fallback,
        }
    }
}

#[derive(Clone)]
pub struct DownstreamClient {
    source: BaseUrlSource,
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

/// 业务后台 OAuth2 的 `terminalId` 派生:从「设备安装 id + 登录账号」确定性算出一个 UUIDv5。
///
/// 为什么不直接用 device_id:device_id 每台设备只有一个(LocalTokenStore 持久化的 UUIDv4),
/// 同一台设备上不同账号登录会发出**相同** terminalId,业务后台据此把不同账号当成同一终端,
/// 导致踢线 / 水位串扰。这里按账号区分:
///   - 同设备同账号 → 恒定不变(后台识别为同一终端,不产生终端膨胀);
///   - 不同账号 / 不同设备 → 必不相同;
///   - 结果仍是标准 36 位 UUID 字符串(后台历来只收到 UUID,保持兼容)、不可反推账号。
///
/// 在 relay 侧派生而非客户端:proto 的 `device_id` 字段语义是"设备安装唯一 id"(per-device),
/// 不应被改写成 per-account;且服务端派生让所有已部署客户端无需更新即可生效。
pub fn terminal_id_for(device_id: &str, username: &str) -> String {
    let name = format!("chathub:terminal:{device_id}:{username}");
    uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_URL, name.as_bytes()).to_string()
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
    /// 登录用户名(JddTokenVO.username),供个人信息卡片展示。
    pub username: String,
    /// 手机号(JddTokenVO.mobile),供个人信息卡片展示。
    pub mobile: String,
    /// 本次登录派生的 terminalId(= terminal_id_for(device_id, username) 的 UUIDv5,
    /// 与传给业务后台 OAuth 的 terminalId 一致)。回传客户端持久化 + subscribe 上行,
    /// 供 force_close 终端粒度路由。
    pub terminal_id: String,
    pub wecom_accounts: Vec<WecomAccount>,
}

/// JddTokenVO 反序列化结构(仅摘 relay 需要的字段;
/// channel/tokenType/issuedAt/expiresAt 被 serde 忽略)。
///
/// `user_id` 容忍 string / number 两种形态:生产业务后台(jdd51)序列化为字符串
/// (雪花算法 ID 超 JS 安全整数,后台统一发 string 防客户端精度丢失);早期 mock /
/// 单测仍发 number。relay 不该卡在这种契约毛刺上。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JddTokenVO {
    access_token: JddAccessToken,
    #[serde(deserialize_with = "deserialize_id_string_or_number")]
    user_id: String,
    #[serde(default)]
    nick_name: Option<String>,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    mobile: Option<String>,
}

/// 兼容 `"123"` / `123` 两种 JSON 形态的整型 ID。
/// 失败场景:浮点 / 非整型 string / 其它 JSON 类型 → serde error。
fn deserialize_id_string_or_number<'de, D>(de: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::{Error, Unexpected, Visitor};
    use std::fmt;

    struct IdVisitor;
    impl<'de> Visitor<'de> for IdVisitor {
        type Value = String;

        fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("an integer ID as string or number")
        }

        fn visit_str<E: Error>(self, v: &str) -> Result<Self::Value, E> {
            // 仍要求是整数 string,避免后台误发 "abc" 也被静默接受
            if v.is_empty() || !v.bytes().all(|b| b.is_ascii_digit() || b == b'-') {
                return Err(Error::invalid_value(Unexpected::Str(v), &self));
            }
            Ok(v.to_owned())
        }
        fn visit_string<E: Error>(self, v: String) -> Result<Self::Value, E> {
            self.visit_str(&v)
        }
        fn visit_i64<E: Error>(self, v: i64) -> Result<Self::Value, E> {
            Ok(v.to_string())
        }
        fn visit_u64<E: Error>(self, v: u64) -> Result<Self::Value, E> {
            Ok(v.to_string())
        }
    }

    de.deserialize_any(IdVisitor)
}

/// verifyToken 的 `employeeId` 兼容 `"123"` / `123` / `""` 三种形态,返回 i64。
/// 雪花 ID 超 JS 安全整数,业务后台发字符串;空串出现在 allowed==false 等无身份场景 → 0。
fn deserialize_employee_id<'de, D>(de: D) -> Result<i64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::{Error, Unexpected, Visitor};
    use std::fmt;

    struct EmpIdVisitor;
    impl<'de> Visitor<'de> for EmpIdVisitor {
        type Value = i64;

        fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("an employee id as string, number, or empty string")
        }

        fn visit_str<E: Error>(self, v: &str) -> Result<Self::Value, E> {
            if v.is_empty() {
                return Ok(0);
            }
            v.parse::<i64>()
                .map_err(|_| Error::invalid_value(Unexpected::Str(v), &self))
        }
        fn visit_string<E: Error>(self, v: String) -> Result<Self::Value, E> {
            self.visit_str(&v)
        }
        fn visit_i64<E: Error>(self, v: i64) -> Result<Self::Value, E> {
            Ok(v)
        }
        fn visit_u64<E: Error>(self, v: u64) -> Result<Self::Value, E> {
            Ok(v as i64)
        }
    }

    de.deserialize_any(EmpIdVisitor)
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

/// verifyToken 响应:relay 据此拿到连接身份与放行决策。
///
/// 业务合约(camelCase,2026-05-30 对齐 wecom-cs 网关权威响应):
///   { "allowed": true, "rejectCode": "", "rejectMessage": "",
///     "employeeId": "2046043266615037952", "configId": "5", "manageableAccountCount": "4" }
///
/// - `allowed == false` → relay 当场以 `BusinessError` 拒绝(透传 rejectMessage/rejectCode
///   给客户端展示)。字段缺失(老后台 / mock)→ `None`,不在此层拒,保持既有延迟拒绝行为。
/// - `employeeId` 雪花算法 ID 超 JS 安全整数,后台序列化为字符串;兼容字符串/数字/空串,
///   `0` 或缺失视为未激活(鉴权延迟到 Subscribe/Ack/Forward 层友好提示)。
/// - `configId` / `manageableAccountCount` 当前 relay 不消费,由 serde 忽略。
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VerifyTokenResp {
    /// 放行决策。`Some(false)` → 当场拒绝;`None`(字段缺失)→ 不拒。
    #[serde(default)]
    pub allowed: Option<bool>,
    /// `allowed == false` 时的拒绝码 / 文案,原样透传客户端展示。
    #[serde(default)]
    pub reject_code: String,
    #[serde(default)]
    pub reject_message: String,
    /// 员工数值 ID。0 或缺失 → 鉴权失败。兼容字符串 / 数字 / 空串。
    #[serde(default, deserialize_with = "deserialize_employee_id")]
    pub employee_id: i64,
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

    /// 静态 base_url 构造(未启用 Nacos / 测试)。内部包成 `BaseUrlSource::Static`。
    pub fn new(base_url: &str, paths: AuthPaths, oauth: OAuthCreds) -> Result<Self, RelayError> {
        Self::new_with_source(BaseUrlSource::new_static(base_url), paths, oauth)
    }

    /// 通用构造:base_url 来源可为静态或 Nacos 发现。reqwest client 只建一次,
    /// 故 `no_proxy` 启发式按来源的代表性 url(loopback 检测)一次性决定。
    pub fn new_with_source(
        source: BaseUrlSource,
        paths: AuthPaths,
        oauth: OAuthCreds,
    ) -> Result<Self, RelayError> {
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
        if Self::is_loopback_base(source.representative_url()) {
            builder = builder.no_proxy();
        }
        let http = builder
            .build()
            .map_err(|e| RelayError::Http(e.to_string()))?;
        Ok(Self {
            source,
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
                verify_token:
                    "/wechat-business-app/wecom-cs/v1/wecomAggregate/connection/verifyToken".into(),
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
    ///
    /// 诊断日志:出站请求 / 响应 status+headers 在 info 级别打印;响应 body 在 4xx/5xx
    /// 或 envelope 解析失败时打全(限 2KB),帮助定位"对接不通"。敏感字段(client_secret /
    /// password / Authorization header)统一走 [`crate::secret::Redacted`] 脱敏。
    pub async fn login(&self, req: LoginReq<'_>) -> Result<LoginResp, RelayError> {
        use crate::secret::Redacted;

        // terminalId 按账号派生(见 [`terminal_id_for`]):同设备多账号不再共用同一终端标识。
        let terminal_id = terminal_id_for(req.device_id, req.username);
        let base = self.source.base_url().await;
        let url = format!("{}{}", base, self.paths.login);
        let started = Instant::now();

        // 出站请求快照(脱敏):URL/query/Basic 客户端凭证/form 都打出来便于对账 curl。
        // debug 级(默认 info 不输出),避免每次 login 固定打长 info 噪声 + 默认落 username。
        tracing::debug!(
            target: "chathub_relay::downstream",
            method = "POST",
            url = %url,
            query.scope = "server",
            query.terminalId = %terminal_id,
            query.device_id = %req.device_id,
            query.grant_type = "password",
            content_type = "application/x-www-form-urlencoded",
            authorization = %format!("Basic <Base64({}:{})>", self.oauth.client_id, Redacted(&self.oauth.client_secret)),
            oauth_client_id = %self.oauth.client_id,
            oauth_client_secret = %Redacted(&self.oauth.client_secret),
            form.username = %req.username,
            form.password = %Redacted(req.password),
            "oauth2 login: outbound request",
        );

        // 显式 build() 取出 reqwest::Request,把最终 headers / body 字节长度一起打出来,
        // 排除 reqwest builder 中途吞参的可能性。
        let pending = self
            .http
            .post(&url)
            .query(&[
                ("scope", "server"),
                ("terminalId", terminal_id.as_str()),
                ("grant_type", "password"),
            ])
            .basic_auth(&self.oauth.client_id, Some(&self.oauth.client_secret))
            .form(&[("username", req.username), ("password", req.password)])
            .build()
            .map_err(|e| {
                tracing::warn!(
                    target: "chathub_relay::downstream",
                    error = %e,
                    "oauth2 login request build failed",
                );
                RelayError::Http(e.to_string())
            })?;

        // 打 reqwest 最终拼好的 url 与脱敏 headers,确认 query / Basic / Content-Type 都齐。
        let final_url = pending.url().to_string();
        let header_dump: Vec<(String, String)> = pending
            .headers()
            .iter()
            .map(|(k, v)| {
                let val = v.to_str().unwrap_or("<bin>").to_string();
                // Authorization 整段脱敏,其余原样
                if k.as_str().eq_ignore_ascii_case("authorization") {
                    (k.to_string(), Redacted(&val).to_string())
                } else {
                    (k.to_string(), val)
                }
            })
            .collect();
        let body_len = pending
            .body()
            .and_then(|b| b.as_bytes())
            .map(|b| b.len())
            .unwrap_or(0);
        tracing::debug!(
            target: "chathub_relay::downstream",
            final_url = %final_url,
            headers = ?header_dump,
            body_len,
            "oauth2 login: final request snapshot (post-builder)",
        );

        let resp = self.http.execute(pending).await.map_err(|e| {
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

        // 响应 headers 在 info 级别打印,便于核对 Content-Type / Set-Cookie / X-* 等。
        let resp_headers: Vec<(String, String)> = resp
            .headers()
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("<bin>").to_string()))
            .collect();
        tracing::info!(
            target: "chathub_relay::downstream",
            status = status.as_u16(),
            headers = ?resp_headers,
            elapsed_ms,
            "oauth2 login: response received",
        );

        if !status.is_success() {
            let code = status.as_u16();
            // 限 2KB body 摘要;大响应不淹没日志,但对调试 4xx/5xx 够用
            let body_snippet = match resp.bytes().await {
                Ok(b) => {
                    let take = b.len().min(2048);
                    String::from_utf8_lossy(&b[..take]).into_owned()
                }
                Err(e) => format!("<body read failed: {e}>"),
            };
            tracing::warn!(
                target: "chathub_relay::downstream",
                status = code,
                elapsed_ms,
                body = %body_snippet,
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
        // 2xx 成功 body 不打全文 —— 内含 accessToken.tokenValue(本次要返还给客户端的 Bearer)。
        // 失败路径(非 2xx / envelope 解析失败)已各自在 warn 打 body 供诊断,成功路径只记录长度。
        let body_preview = {
            let take = body_bytes.len().min(2048);
            String::from_utf8_lossy(&body_bytes[..take]).into_owned()
        };
        tracing::debug!(
            target: "chathub_relay::downstream",
            body_len = body_bytes.len(),
            "oauth2 login: response body received",
        );
        let jdd: JddTokenVO = unwrap_envelope::<JddTokenVO>(&body_bytes, "login")
            .map_err(|e| {
                tracing::warn!(
                    target: "chathub_relay::downstream",
                    error = %e,
                    body = %body_preview,
                    elapsed_ms,
                    "oauth2 login envelope parse failed (body printed for diagnosis)",
                );
                e
            })?
            .ok_or_else(|| {
                tracing::warn!(
                    target: "chathub_relay::downstream",
                    body = %body_preview,
                    elapsed_ms,
                    "oauth2 login envelope ok but data missing",
                );
                RelayError::Internal
            })?;

        // userId 已是 string(雪花 ID 防精度丢失)。AuthSvc 仍需要 i64 给 cache prepopulate,
        // 因此这里解析一次;解析失败属于契约错(后台发了非整型 ID),映射 Internal。
        let employee_id: i64 = jdd.user_id.parse().map_err(|e| {
            tracing::warn!(
                target: "chathub_relay::downstream",
                user_id = %jdd.user_id,
                error = %e,
                elapsed_ms,
                "oauth2 login userId not parseable to i64",
            );
            RelayError::Internal
        })?;

        tracing::info!(
            target: "chathub_relay::downstream",
            user_id = %jdd.user_id,
            elapsed_ms,
            "oauth2 login ok",
        );

        Ok(LoginResp {
            access_token: jdd.access_token.token_value,
            user_id: jdd.user_id,
            employee_id, // 数值 ID,关键给 cache prepopulate 用
            display_name: jdd.nick_name.unwrap_or_default(),
            avatar_url: String::new(),
            role: String::new(),
            tenant_id: String::new(),
            username: jdd.username.unwrap_or_default(),
            mobile: jdd.mobile.unwrap_or_default(),
            terminal_id, // 上方 terminal_id_for(device_id, username) 派生,move 进响应回传客户端
            wecom_accounts: Vec::new(),
        })
    }

    /// 透传客户端登出到业务后台。best-effort:网络错也不阻断。
    /// 业务后台返 `{code:1, msg:"成功", data:null}` 形态;envelope 解析失败/code!=1 时
    /// 也只 warn-log 不阻断(logout 关键路径不应被业务报错卡住)。
    pub async fn logout(&self, client_token: &str) -> Result<(), RelayError> {
        let base = self.source.base_url().await;
        let url = format!("{}{}", base, self.paths.logout);
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
    /// 路径走 `wecom-cs/v1`(面向客户端 Bearer 的聚合网关命名空间);早期误用内部
    /// `rpc/v1` 会被网关拒为 403「接口未授权」。响应解析后,`allowed==false` 当场拒绝。
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
        let base = self.source.base_url().await;
        let url = format!("{}{}", base, self.paths.verify_token);
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
            // 读 body 摘要(限长 512B,nginx html 等大响应不会淹没日志)用于排查
            // 网关/业务后台拒绝的真实原因。读失败时不淹没原 status 错误,降级为空。
            let body_snippet = match resp.bytes().await {
                Ok(b) => {
                    let take = b.len().min(512);
                    String::from_utf8_lossy(&b[..take]).into_owned()
                }
                Err(e) => {
                    tracing::warn!(
                        target: "chathub_relay::downstream",
                        status = code,
                        elapsed_ms,
                        error = %e,
                        "verify_token body read failed",
                    );
                    String::new()
                }
            };
            tracing::warn!(
                target: "chathub_relay::downstream",
                status = code,
                elapsed_ms,
                body = %body_snippet,
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

        // allowed==false:业务后台显式拒绝本次连接(token 有效但无权)。透传
        // rejectMessage/rejectCode 给客户端展示。字段缺失(老后台 / mock)→ None,不拒。
        if body.allowed == Some(false) {
            tracing::warn!(
                target: "chathub_relay::downstream",
                elapsed_ms,
                reject_code = %body.reject_code,
                reject_message = %body.reject_message,
                "verify_token rejected by business backend (allowed=false)",
            );
            return Err(RelayError::BusinessError {
                service_code: body.reject_code,
                msg: body.reject_message,
            });
        }

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
        let base = self.source.base_url().await;
        let url = format!("{}{}", base, self.paths.notify_pull);
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
        let base = self.source.base_url().await;
        let url = format!("{}{}", base, spec.path);
        let started = Instant::now();

        // 排查辅助(debug 级):出站请求元信息(method/url/query),核对发给业务后台的参数
        // (如 list_friends 的 wecomAccountIds)。请求体全文降到 trace,见下。
        tracing::debug!(
            target: "chathub_relay::downstream",
            method,
            verb = ?spec.method,
            url = %url,
            employee_id,
            body_len = body.len(),
            query_len = query.len(),
            query = ?query,
            "forward request",
        );
        // 请求体全文含消息明文 + 手机号等 PII;降到 trace,需显式 chathub_relay=trace 才落盘,
        // 避免开 debug 排障即把全量业务 payload 写进日志文件。
        tracing::trace!(
            target: "chathub_relay::downstream",
            method,
            req_body = %String::from_utf8_lossy(&body),
            "forward request body",
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

        // 响应体全文(截断 4000 字符)含好友手机号/消息列表等 PII;降到 trace,
        // 需显式 chathub_relay=trace 才落盘,避免默认 debug 排障即把业务响应写盘。
        tracing::trace!(
            target: "chathub_relay::downstream",
            method,
            status = status.as_u16(),
            resp_body = %String::from_utf8_lossy(&body).chars().take(4000).collect::<String>(),
            "forward response body",
        );
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

    /// terminalId 必须按账号区分,且对「同设备同账号」确定性稳定。
    /// 回归历史 bug:terminalId 取自每设备唯一的 device_id,同设备多账号全部相同,
    /// 业务后台把不同账号当成同一终端 → 串扰。
    #[test]
    fn terminal_id_is_per_account_and_stable() {
        // 同设备同账号:确定性派生,恒定一致
        assert_eq!(
            terminal_id_for("dev-A", "alice"),
            terminal_id_for("dev-A", "alice"),
        );
        // 同设备不同账号:必不相同(修复"全部都一样")
        assert_ne!(
            terminal_id_for("dev-A", "alice"),
            terminal_id_for("dev-A", "bob"),
        );
        // 不同设备同账号:必不相同
        assert_ne!(
            terminal_id_for("dev-A", "alice"),
            terminal_id_for("dev-B", "alice"),
        );
        // 仍是合法 UUID 字符串(业务后台历来只收到 UUID)
        assert!(uuid::Uuid::parse_str(&terminal_id_for("dev-A", "alice")).is_ok());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn base_url_source_static_trims_trailing_slash() {
        let src = BaseUrlSource::new_static("https://dn.local/");
        assert_eq!(src.base_url().await, "https://dn.local");
        // representative_url 同样去尾斜杠
        assert_eq!(src.representative_url(), "https://dn.local");
    }

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

    /// 默认 fixture 用 string userId,与生产业务后台契约一致(雪花 ID 防 JS 精度丢失)。
    fn jdd_response() -> serde_json::Value {
        envelope_ok_json(serde_json::json!({
            "accessToken": {
                "tokenValue": "biz-tok-abc",
                "tokenType": { "value": "Bearer" },
                "issuedAt": "2026-05-16 10:00:00",
                "expiresAt": "2026-05-16 22:00:00"
            },
            "userId": "1234",
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
            // terminalId 现按账号派生:device_id="dev-A" + username="alice"
            .and(query_param("terminalId", terminal_id_for("dev-A", "alice")))
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
        assert_eq!(resp.employee_id, 1234);
        assert_eq!(resp.display_name, "Alice");
        assert!(resp.wecom_accounts.is_empty()); // 永远空
    }

    /// 生产业务后台(jdd51)实际形态:userId 是 19 位雪花算法 ID 的字符串,
    /// 远超 JS Number 安全整数范围 → 后台用 string 序列化。
    /// 回归历史 bug:i64 直反序列化时此响应直接 envelope ok / data 解析失败。
    #[tokio::test(flavor = "multi_thread")]
    async fn login_oauth2_accepts_snowflake_string_user_id() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/account-app/oauth2/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(envelope_ok_json(
                serde_json::json!({
                    "accessToken": {
                        "tokenValue": "rh_wxchat:zhangle:e1388374-f614-459a-b3b8-f655e6500381",
                        "tokenType": { "value": "Bearer" },
                        "issuedAt": 1779959859.507000000_f64,
                        "expiresAt": 1780564659.507000000_f64,
                        "scopes": ["server"]
                    },
                    "channel": 3,
                    "userId": "1674614956223361024",
                    "mobile": "13043979430",
                    "nickName": "张乐乐",
                    "username": "zhangle"
                }),
            )))
            .mount(&mock)
            .await;
        let client = DownstreamClient::new_with_defaults(&mock.uri()).unwrap();
        let resp = client
            .login(LoginReq {
                username: "zhangle",
                password: "YehdBPev",
                device_id: "eca831ca-bab9-4bff-a78d-6d9b13cd6d7c",
            })
            .await
            .unwrap();
        assert_eq!(
            resp.access_token,
            "rh_wxchat:zhangle:e1388374-f614-459a-b3b8-f655e6500381"
        );
        assert_eq!(resp.user_id, "1674614956223361024");
        assert_eq!(resp.employee_id, 1674614956223361024_i64);
        assert_eq!(resp.display_name, "张乐乐");
    }

    /// 向后兼容:早期 mock / 单测仍发数字 userId,relay 必须能解析。
    #[tokio::test(flavor = "multi_thread")]
    async fn login_oauth2_accepts_numeric_user_id() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/account-app/oauth2/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(envelope_ok_json(
                serde_json::json!({
                    "accessToken": {
                        "tokenValue": "tok-99",
                        "tokenType": { "value": "Bearer" }
                    },
                    "userId": 99,
                    "nickName": "N"
                }),
            )))
            .mount(&mock)
            .await;
        let client = DownstreamClient::new_with_defaults(&mock.uri()).unwrap();
        let resp = client
            .login(LoginReq {
                username: "u",
                password: "p",
                device_id: "d",
            })
            .await
            .unwrap();
        assert_eq!(resp.user_id, "99");
        assert_eq!(resp.employee_id, 99);
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

    const VERIFY_PATH: &str =
        "/wechat-business-app/wecom-cs/v1/wecomAggregate/connection/verifyToken";

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

    /// 4xx 带 body 时,verify_token 应能读取 body 后正常映射错误(不淹没原 status 错误)。
    /// 回归点:body 读取逻辑加入后,行为语义保持不变。
    #[tokio::test(flavor = "multi_thread")]
    async fn verify_token_403_with_body_still_maps_invalid_creds() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(VERIFY_PATH))
            .respond_with(
                ResponseTemplate::new(403)
                    .set_body_string(r#"{"code":-1,"msg":"forbidden by gateway"}"#),
            )
            .mount(&mock)
            .await;
        let client = DownstreamClient::new_with_defaults(&mock.uri()).unwrap();
        let err = client.verify_token("bad").await.unwrap_err();
        assert!(matches!(err, RelayError::InvalidCreds));
    }

    /// 权威合约:`employeeId` 为字符串雪花 ID(超 JS 安全整数),verify_token 应正常解析为 i64。
    #[tokio::test(flavor = "multi_thread")]
    async fn verify_token_employee_id_as_string_parses() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(VERIFY_PATH))
            .respond_with(ResponseTemplate::new(200).set_body_json(envelope_ok_json(
                serde_json::json!({
                    "allowed": true,
                    "rejectCode": "",
                    "rejectMessage": "",
                    "employeeId": "2046043266615037952",
                    "configId": "5",
                    "manageableAccountCount": "4"
                }),
            )))
            .mount(&mock)
            .await;
        let client = DownstreamClient::new_with_defaults(&mock.uri()).unwrap();
        let resp = client.verify_token("client-xyz").await.unwrap();
        assert_eq!(resp.employee_id, 2046043266615037952);
        assert_eq!(resp.allowed, Some(true));
    }

    /// `allowed == false` → 当场以 BusinessError 拒绝,透传 rejectCode / rejectMessage。
    #[tokio::test(flavor = "multi_thread")]
    async fn verify_token_allowed_false_maps_business_error() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(VERIFY_PATH))
            .respond_with(ResponseTemplate::new(200).set_body_json(envelope_ok_json(
                serde_json::json!({
                    "allowed": false,
                    "rejectCode": "NO_PERMISSION",
                    "rejectMessage": "无可管理账号",
                    "employeeId": ""
                }),
            )))
            .mount(&mock)
            .await;
        let client = DownstreamClient::new_with_defaults(&mock.uri()).unwrap();
        let err = client.verify_token("client-xyz").await.unwrap_err();
        match err {
            RelayError::BusinessError { service_code, msg } => {
                assert_eq!(service_code, "NO_PERMISSION");
                assert_eq!(msg, "无可管理账号");
            }
            other => panic!("expected BusinessError, got {other:?}"),
        }
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
