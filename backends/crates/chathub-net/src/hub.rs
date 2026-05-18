//! Hub client + ConnectionManager(Plan 7 — 只剩 v2 三件套)。
//!
//! 公共 API:
//!   - `HubClient`:封装 tonic-generated client,只暴露 v2 三件套
//!     - `forward(method, body_json)` — 业务 RPC 单一透传入口
//!     - `ack(notify_seq)` — 上报水位
//!     - `subscribe(since_notify_seq, device_id)` — 内部用,ConnectionManager 调
//!   - `ConnectionManager`:状态机 + 后台 task + 事件总线
//!   - `ConnectionState`:Connecting / Subscribed / Disconnected{last_error}

use crate::account_event::AccountEventApplier;
use crate::error::AuthError;
use crate::friend_event::FriendEventApplier;
use crate::interceptor::AuthInterceptor;
use crate::token::TokenStore;
use chathub_proto::v1::hub_client::HubClient as RawHubClient;
use chathub_proto::v1::{
    AckRequest, ForwardRequest, ForwardResponse, ServerEvent, SubscribeRequest,
};
use chathub_state::NotifySeqStore;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{broadcast, watch};
use tokio::task::JoinHandle;
use tonic::codegen::InterceptedService;
use tonic::transport::Channel;

#[derive(Clone, Debug)]
pub struct BackoffConfig {
    pub base: Duration,
    pub factor: f64,
    pub cap: Duration,
}

impl Default for BackoffConfig {
    fn default() -> Self {
        Self {
            base: Duration::from_secs(1),
            factor: 2.0,
            cap: Duration::from_secs(15),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum ConnectionState {
    Connecting,
    Subscribed,
    Disconnected {
        #[serde(skip_serializing_if = "Option::is_none")]
        last_error: Option<AuthError>,
    },
}

#[derive(Debug, PartialEq)]
pub(crate) enum Action {
    Logout,
    Terminate,
    Backoff,
}

pub(crate) fn classify(err: &AuthError) -> Action {
    match err {
        AuthError::Unauthenticated => Action::Logout,
        AuthError::UpgradeRequired { .. } => Action::Terminate,
        AuthError::Network { .. } => Action::Backoff,
        AuthError::Storage { .. } => Action::Terminate,
        AuthError::Internal { .. } => Action::Backoff,
        AuthError::AccountDisabled { .. } => Action::Terminate,
        // 协议契约不匹配 → 永久错,客户端不重试不退出登录(token 没问题,接口对不上)
        AuthError::ProtocolMismatch { .. } => Action::Terminate,
        // 业务错(envelope code != 1)从连接路径冒出来通常意味着 token 被业务侧拒绝
        // (过期 / 账号变更),保守地走 Logout 让用户重新登录;forward 通道的 Business
        // 不经过 classify,直接 propagate 到 UI 弹 msg。
        AuthError::Business { .. } => Action::Logout,
    }
}

#[derive(Clone)]
pub struct HubClient {
    inner: RawHubClient<InterceptedService<Channel, AuthInterceptor>>,
}

impl HubClient {
    pub fn new(channel: Channel, interceptor: AuthInterceptor) -> Self {
        let inner = RawHubClient::with_interceptor(channel, interceptor);
        Self { inner }
    }

    /// 业务 RPC 透传(REST 隧道)。客户端只需要构造 body_json 并指定 method。
    /// 4xx 通过 `ForwardResponse.http_status` 返回(不会变成 AuthError);
    /// 只有 5xx / 网络/超时 才映射 AuthError。
    pub async fn forward(
        &self,
        method: &str,
        body_json: Vec<u8>,
    ) -> Result<ForwardResponse, AuthError> {
        self.forward_with_query(method, body_json, std::collections::HashMap::new())
            .await
    }

    /// `forward` 的全参版本:GET 路径专用 query 参数(POST 路径会被 relay 忽略)。
    ///
    /// 2026-05-17 起业务后台统一包络 `{code,serviceCode,msg,data}`。relay 仍透明
    /// 转发 bytes,SDK 在这一层集中处理:`code != 1` → [`AuthError::Business`];
    /// 成功时把 `body_json` 替换为 envelope 内层 `data` 的原始 JSON 切片,调用方按旧
    /// 形态 `serde_json::from_slice` 取值即可,UI 调用点无需感知 envelope。
    pub async fn forward_with_query(
        &self,
        method: &str,
        body_json: Vec<u8>,
        query: std::collections::HashMap<String, String>,
    ) -> Result<ForwardResponse, AuthError> {
        let mut client = self.inner.clone();
        let resp = client
            .forward(tonic::Request::new(ForwardRequest {
                method: method.into(),
                body_json: body_json.into(), // F6: Vec<u8> → Bytes
                query,
            }))
            .await?;
        let mut resp = resp.into_inner();
        if resp.http_status == 200 && !resp.body_json.is_empty() {
            resp.body_json = unwrap_envelope_bytes(&resp.body_json)?.into();
        }
        Ok(resp)
    }

    /// 拉取当前员工可管理的企微账号列表(走 forward 通道,后端 GET listMine)。
    /// 字段形态先按 mock 占位约定 — 等业务后台 finalize schema 再 adapt 这里。
    ///
    /// 用法:登录成功后立刻调一次填充账号选择 UI;非 2xx 映射 `AuthError::Internal`,
    /// UI 提示"加载账号失败,点击重试",不影响 token 有效性。
    pub async fn list_accounts(
        &self,
        filter: ListAccountsFilter,
    ) -> Result<Vec<ListAccountsItem>, AuthError> {
        let query = filter.to_query();
        let resp = self
            .forward_with_query("list_accounts", Vec::new(), query)
            .await?;
        if resp.http_status != 200 {
            return Err(AuthError::Internal {
                message: format!("list_accounts returned http {}", resp.http_status),
            });
        }
        serde_json::from_slice::<Vec<ListAccountsItem>>(&resp.body_json).map_err(|e| {
            AuthError::Internal {
                message: format!("list_accounts JSON parse: {e}"),
            }
        })
    }

    /// 按多账号拉取好友(客户)列表。POST body 透传 wecomAccountIds + 分页 + 服务端筛选。
    /// 4xx 映射 `AuthError::Internal`,UI 提示"加载失败,点击重试";5xx/网络错走 forward 默认映射。
    pub async fn list_friends(
        &self,
        req: ListFriendsRequest,
    ) -> Result<ListFriendsResp, AuthError> {
        let body = serde_json::to_vec(&req).map_err(|e| AuthError::Internal {
            message: format!("list_friends serialize: {e}"),
        })?;
        let resp = self.forward("list_friends", body).await?;
        if resp.http_status != 200 {
            return Err(AuthError::Internal {
                message: format!("list_friends returned http {}", resp.http_status),
            });
        }
        serde_json::from_slice::<ListFriendsResp>(&resp.body_json).map_err(|e| {
            AuthError::Internal {
                message: format!("list_friends JSON parse: {e}"),
            }
        })
    }

    /// 拉取单账号好友的**全量**(内部循环 list_friends 分页直到拉完)。
    ///
    /// 用法:Tauri 层在 cache miss / TTL 失效 / 推送 fallback 时调,把整账号的好友灌入
    /// 本地 `wecom_friends` 行存。size 固定 100,无服务端筛选。
    ///
    /// 上限保护:`max_pages = 100`(即最多 10000 条),防止后台分页响应异常导致死循环。
    /// 实际客户量级远低于此,触顶时返 `AuthError::Internal`。
    pub async fn list_all_friends_for_account(
        &self,
        wecom_account_id: &str,
    ) -> Result<Vec<WecomFriend>, AuthError> {
        const MAX_PAGES: u32 = 100;
        const PAGE_SIZE: u32 = 100;
        let mut all: Vec<WecomFriend> = Vec::new();
        let mut current: u32 = 1;
        loop {
            let resp = self
                .list_friends(ListFriendsRequest {
                    wecom_account_ids: vec![wecom_account_id.to_string()],
                    current,
                    size: PAGE_SIZE,
                    external_name: None,
                    external_mobile: None,
                    add_start_time: None,
                    add_end_time: None,
                })
                .await?;
            let got = resp.records.len() as u32;
            all.extend(resp.records);
            if got < PAGE_SIZE || current >= resp.pages.max(1) {
                break;
            }
            current += 1;
            if current > MAX_PAGES {
                return Err(AuthError::Internal {
                    message: format!(
                        "list_all_friends_for_account exceeded {MAX_PAGES} pages \
                         for wecom_account_id={wecom_account_id}"
                    ),
                });
            }
        }
        Ok(all)
    }

    /// 上报 notify_seq 水位(per-employee)。
    pub async fn ack(&self, notify_seq: u64) -> Result<(), AuthError> {
        let mut client = self.inner.clone();
        let _ = client
            .ack(tonic::Request::new(AckRequest { notify_seq }))
            .await?;
        Ok(())
    }

    /// Subscribe v2(employee-scope)。`since_notify_seq=0` 表示首连只接实时。
    pub(crate) async fn subscribe(
        &self,
        since_notify_seq: u64,
        device_id: String,
        client_version: String,
    ) -> Result<tonic::Streaming<ServerEvent>, AuthError> {
        let mut client = self.inner.clone();
        let req = SubscribeRequest {
            since_notify_seq,
            device_id,
            client_version,
        };
        let resp = client.subscribe(tonic::Request::new(req)).await?;
        Ok(resp.into_inner())
    }
}

/// 业务后台统一响应包络解码:
///   `{ code, serviceCode, msg, data }` —— `code == 1` 视为成功,其余报错。
///
/// 成功路径:把 `data` 字段的原始 JSON 切片拷出来当新 `body_json`,UI 调用点
/// 用旧的 `serde_json::from_slice::<T>(body)` 取值即可,完全无视 envelope。
/// 失败路径:`AuthError::Business { service_code, msg }`。
/// envelope 自身解析失败:`AuthError::Internal`(契约错)。
fn unwrap_envelope_bytes(body: &[u8]) -> Result<Vec<u8>, AuthError> {
    use serde_json::value::RawValue;
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Env<'a> {
        code: i32,
        #[serde(default)]
        service_code: String,
        #[serde(default)]
        msg: String,
        #[serde(default, borrow)]
        data: Option<&'a RawValue>,
    }
    let env: Env = serde_json::from_slice(body).map_err(|e| AuthError::Internal {
        message: format!("envelope parse failed: {e}"),
    })?;
    if env.code != 1 {
        return Err(AuthError::Business {
            service_code: env.service_code,
            msg: env.msg,
        });
    }
    Ok(env
        .data
        .map(|r| r.get().as_bytes().to_vec())
        .unwrap_or_else(|| b"null".to_vec()))
}

// ─── list_accounts typed contract(provisional;待业务后台 finalize)──────────

/// 当前员工可管理企微账号列表过滤(均可选;空 = 全量)。
/// 字段意图:
///   - `enabled = Some(true)`  仅启用账号
///   - `enabled = Some(false)` 仅停用账号
///   - `enabled = None`        全量
#[derive(Debug, Clone, Default)]
pub struct ListAccountsFilter {
    pub enabled: Option<bool>,
}

impl ListAccountsFilter {
    fn to_query(&self) -> std::collections::HashMap<String, String> {
        let mut q = std::collections::HashMap::new();
        if let Some(en) = self.enabled {
            q.insert("enabled".into(), if en { "true" } else { "false" }.into());
        }
        q
    }
}

/// listMine 单条记录(新契约,camelCase JSON ↔ Rust snake_case)。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListAccountsItem {
    pub wecom_account_id: String,
    pub wecom_name: String,
    pub wecom_account: String,
    pub wecom_alias: String,
    pub wecom_avatar: String,
    pub wecom_status: i32,
    pub gender: i32,
    pub position: String,
}

// ─── list_friends typed contract ────────────────────────────────────────────

/// 按多账号拉取好友(客户)列表入参。POST body,size 调用方固定 100。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListFriendsRequest {
    pub wecom_account_ids: Vec<String>,
    pub current: u32,
    pub size: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_mobile: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub add_start_time: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub add_end_time: Option<String>,
}

/// 好友单条记录(20 字段,camelCase JSON ↔ Rust snake_case)。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WecomFriend {
    pub external_user_id: String,
    pub external_name: String,
    pub external_position: String,
    pub external_avatar: String,
    pub external_corp_name: String,
    pub external_corp_full_name: String,
    /// 1=微信用户,2=企微用户
    pub external_type: i32,
    /// 0=未知 1=男 2=女
    pub external_gender: i32,
    /// 已脱敏(`138****1234`)
    pub external_mobile: String,
    pub follow_remark: String,
    pub follow_description: String,
    pub remark_corp_name: String,
    /// `yyyy-MM-dd HH:mm:ss`,服务端本地时区
    pub add_time: String,
    pub add_way: i32,
    pub follow_state: String,
    pub wechat_channels_nickname: String,
    pub wechat_channels_source: i32,
    pub last_sync_time: String,
    pub sync_status: i32,
}

/// listFriends 分页响应(2xx envelope.data 的形态)。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListFriendsResp {
    pub records: Vec<WecomFriend>,
    pub total: u64,
    pub current: u32,
    pub size: u32,
    pub pages: u32,
}

/// Full jitter 指数退避。
pub(crate) struct ExponentialBackoff {
    base: Duration,
    factor: f64,
    cap: Duration,
    attempt: u32,
}

impl ExponentialBackoff {
    pub fn new(cfg: &BackoffConfig) -> Self {
        Self {
            base: cfg.base,
            factor: cfg.factor,
            cap: cfg.cap,
            attempt: 0,
        }
    }

    pub fn next(&mut self) -> Duration {
        let exp = self.factor.powi(self.attempt as i32);
        let raw_ms = (self.base.as_millis() as f64) * exp;
        let cap_ms = self.cap.as_millis() as f64;
        let bound_ms = raw_ms.min(cap_ms);
        let jittered_ms = rand::random::<f64>() * bound_ms;
        self.attempt = self.attempt.saturating_add(1);
        Duration::from_millis(jittered_ms as u64)
    }

    pub fn reset(&mut self) {
        self.attempt = 0;
    }
}

struct Inner {
    hub: HubClient,
    token_store: Arc<TokenStore>,
    notify_seq_store: NotifySeqStore,
    device_id: String,
    client_version: String,
    backoff: BackoffConfig,
    state_tx: watch::Sender<ConnectionState>,
    event_tx: broadcast::Sender<ServerEvent>,
    /// 2026-05-17:Subscribe 流里 ACCOUNT_* 事件 → 本地账号缓存 + 广播给 Tauri 层。
    /// Optional 是为了让 chathub-net 单测可以构造 ConnectionManager 而不必带 AccountCacheStore。
    account_event_applier: Option<Arc<AccountEventApplier>>,
    /// 阶段 2:Subscribe 流里 FRIEND_* 事件 → 本地好友行存 + 广播给 Tauri 层。
    /// 与 account_event_applier 并列;PushBatchOut 来时两个 applier 都调一次,各自按 eventType 筛分支。
    friend_event_applier: Option<Arc<FriendEventApplier>>,
    task: tokio::sync::Mutex<Option<JoinHandle<()>>>,
}

#[derive(Clone)]
pub struct ConnectionManager {
    inner: Arc<Inner>,
}

impl ConnectionManager {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        hub: HubClient,
        token_store: Arc<TokenStore>,
        notify_seq_store: NotifySeqStore,
        device_id: String,
        client_version: String,
        backoff: BackoffConfig,
        account_event_applier: Option<Arc<AccountEventApplier>>,
        friend_event_applier: Option<Arc<FriendEventApplier>>,
    ) -> Self {
        let (state_tx, _) = watch::channel(ConnectionState::Disconnected { last_error: None });
        let (event_tx, _) = broadcast::channel(256);
        Self {
            inner: Arc::new(Inner {
                hub,
                token_store,
                notify_seq_store,
                device_id,
                client_version,
                backoff,
                state_tx,
                event_tx,
                account_event_applier,
                friend_event_applier,
                task: tokio::sync::Mutex::new(None),
            }),
        }
    }

    pub fn state_subscribe(&self) -> watch::Receiver<ConnectionState> {
        self.inner.state_tx.subscribe()
    }

    pub fn event_subscribe(&self) -> broadcast::Receiver<ServerEvent> {
        self.inner.event_tx.subscribe()
    }

    /// 订阅"账号缓存变了"广播。若未注入 [`AccountEventApplier`] 返 `None`。
    /// 上层(backends/src/lib.rs)收到后 `app.emit("accounts_changed", { employee_id })`。
    pub fn account_event_subscribe(
        &self,
    ) -> Option<broadcast::Receiver<crate::account_event::AccountChanged>> {
        self.inner
            .account_event_applier
            .as_ref()
            .map(|a| a.subscribe())
    }

    /// 订阅"好友缓存变了"广播。若未注入 [`FriendEventApplier`] 返 `None`。
    /// 上层(backends/src/lib.rs)收到后 `app.emit("friends_changed", { employeeId, wecomAccountId? })`。
    pub fn friend_event_subscribe(
        &self,
    ) -> Option<broadcast::Receiver<crate::friend_event::FriendChanged>> {
        self.inner
            .friend_event_applier
            .as_ref()
            .map(|a| a.subscribe())
    }

    pub async fn start(&self) {
        let mut guard = self.inner.task.lock().await;
        if guard.as_ref().is_some_and(|h| !h.is_finished()) {
            return;
        }
        let logged_out_rx = self.inner.token_store.logged_out_subscribe();
        let inner = Arc::clone(&self.inner);
        *guard = Some(tokio::spawn(async move {
            Inner::run_loop(inner, logged_out_rx).await;
        }));
    }

    pub async fn stop(&self) {
        let mut guard = self.inner.task.lock().await;
        if let Some(h) = guard.take() {
            h.abort();
            let _ = h.await;
        }
        self.inner
            .state_tx
            .send_replace(ConnectionState::Disconnected { last_error: None });
    }
}

impl Inner {
    async fn run_loop(
        self: Arc<Inner>,
        mut logged_out_rx: broadcast::Receiver<crate::token::LoggedOutReason>,
    ) {
        let mut backoff = ExponentialBackoff::new(&self.backoff);

        'reconnect: loop {
            self.state_tx.send_replace(ConnectionState::Connecting);

            let since = self.notify_seq_store.read().await.unwrap_or(0);

            let mut stream = match self
                .hub
                .subscribe(since, self.device_id.clone(), self.client_version.clone())
                .await
            {
                Ok(s) => s,
                Err(err) => match classify(&err) {
                    Action::Logout => {
                        self.token_store.mark_token_invalid().await;
                        self.state_tx
                            .send_replace(ConnectionState::Disconnected { last_error: None });
                        return;
                    }
                    Action::Terminate => {
                        self.state_tx.send_replace(ConnectionState::Disconnected {
                            last_error: Some(err),
                        });
                        return;
                    }
                    Action::Backoff => {
                        self.state_tx.send_replace(ConnectionState::Disconnected {
                            last_error: Some(err),
                        });
                        tokio::time::sleep(backoff.next()).await;
                        continue 'reconnect;
                    }
                },
            };

            self.state_tx.send_replace(ConnectionState::Subscribed);
            backoff.reset();

            loop {
                tokio::select! {
                    biased;
                    _ = logged_out_rx.recv() => {
                        self.state_tx.send_replace(ConnectionState::Disconnected { last_error: None });
                        return;
                    }
                    msg = stream.message() => match msg {
                        Ok(Some(event)) => {
                            // 处理 v2 三件套
                            use chathub_proto::v1::server_event::Body;
                            use chathub_proto::v1::system_signal::Kind;
                            let should_terminate = matches!(
                                &event.body,
                                Some(Body::System(s))
                                    if s.kind == Kind::ServerDrain as i32
                                       || s.kind == Kind::ResyncRequired as i32
                            );

                            // PushBatchOut → 更新水位 + 账号事件应用
                            if let Some(Body::PushBatch(pb)) = &event.body {
                                if let Err(e) = self.notify_seq_store
                                    .upsert_if_greater(pb.notify_seq).await {
                                    tracing::warn!(?e, "notify_seq_store upsert failed, ignored");
                                }
                                // 2026-05-17:账号事件 → 本地 cache + broadcast。
                                // 内部按 eventType 过滤,非 ACCOUNT_* 直接返回。
                                if let Some(applier) = &self.account_event_applier {
                                    applier.apply_push_batch(pb).await;
                                }
                                // 阶段 2:好友事件 → 本地行存 + broadcast。
                                // 内部按 eventType 过滤,非 FRIEND_* 直接返回。两个 applier 并存。
                                if let Some(applier) = &self.friend_event_applier {
                                    applier.apply_push_batch(pb).await;
                                }
                            }

                            let _ = self.event_tx.send(event);

                            if should_terminate {
                                // SERVER_DRAIN / RESYNC_REQUIRED → 主动断 + 退避重连
                                self.state_tx.send_replace(
                                    ConnectionState::Disconnected { last_error: None },
                                );
                                tokio::time::sleep(backoff.next()).await;
                                continue 'reconnect;
                            }
                        }
                        Ok(None) => {
                            self.state_tx.send_replace(ConnectionState::Disconnected { last_error: None });
                            tokio::time::sleep(backoff.next()).await;
                            continue 'reconnect;
                        }
                        Err(status) => {
                            let err: AuthError = status.into();
                            match classify(&err) {
                                Action::Logout => {
                                    self.token_store.mark_token_invalid().await;
                                    self.state_tx.send_replace(
                                        ConnectionState::Disconnected { last_error: None },
                                    );
                                    return;
                                }
                                Action::Terminate => {
                                    self.state_tx.send_replace(ConnectionState::Disconnected {
                                        last_error: Some(err),
                                    });
                                    return;
                                }
                                Action::Backoff => {
                                    self.state_tx.send_replace(ConnectionState::Disconnected {
                                        last_error: Some(err),
                                    });
                                    tokio::time::sleep(backoff.next()).await;
                                    continue 'reconnect;
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fast_cfg() -> BackoffConfig {
        BackoffConfig {
            base: Duration::from_millis(10),
            factor: 2.0,
            cap: Duration::from_millis(150),
        }
    }

    #[test]
    fn exponential_backoff_first_call_within_1x_base() {
        let mut b = ExponentialBackoff::new(&fast_cfg());
        let d = b.next();
        assert!(d <= Duration::from_millis(10), "got {d:?}");
    }

    #[test]
    fn exponential_backoff_caps_at_cap() {
        let mut b = ExponentialBackoff::new(&fast_cfg());
        for _ in 0..20 {
            let d = b.next();
            assert!(d <= Duration::from_millis(150), "got {d:?}");
        }
    }

    #[test]
    fn exponential_backoff_reset_zeroes_attempt() {
        let mut b = ExponentialBackoff::new(&fast_cfg());
        for _ in 0..5 {
            let _ = b.next();
        }
        b.reset();
        let d = b.next();
        assert!(d <= Duration::from_millis(10), "got {d:?}");
    }

    #[test]
    fn connection_state_disconnected_no_error_omits_field() {
        let s = ConnectionState::Disconnected { last_error: None };
        let json = serde_json::to_string(&s).unwrap();
        assert_eq!(json, r#"{"state":"disconnected"}"#);
    }

    #[test]
    fn classify_unauthenticated_returns_logout() {
        assert_eq!(classify(&AuthError::Unauthenticated), Action::Logout);
    }

    #[test]
    fn classify_business_returns_logout() {
        // 业务错从 Subscribe 路径冒出来通常是 token 被业务侧拒,保守走 Logout
        let err = AuthError::Business {
            service_code: "wecom.token.expired".into(),
            msg: "登录已过期".into(),
        };
        assert_eq!(classify(&err), Action::Logout);
    }

    #[test]
    fn unwrap_envelope_bytes_success_returns_inner_data() {
        let body = r#"{"code":1,"serviceCode":"","msg":"成功","data":{"x":42}}"#.as_bytes();
        let data = unwrap_envelope_bytes(body).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&data).unwrap();
        assert_eq!(v["x"], 42);
    }

    #[test]
    fn unwrap_envelope_bytes_code_not_one_returns_business_error() {
        let body =
            r#"{"code":2001,"serviceCode":"wecom.x","msg":"余额不足","data":null}"#.as_bytes();
        let err = unwrap_envelope_bytes(body).unwrap_err();
        match err {
            AuthError::Business { service_code, msg } => {
                assert_eq!(service_code, "wecom.x");
                assert_eq!(msg, "余额不足");
            }
            other => panic!("expected Business, got {other:?}"),
        }
    }

    #[test]
    fn unwrap_envelope_bytes_garbage_returns_internal() {
        let body = b"not a json envelope";
        let err = unwrap_envelope_bytes(body).unwrap_err();
        assert!(matches!(err, AuthError::Internal { .. }));
    }

    #[test]
    fn unwrap_envelope_bytes_missing_data_returns_null_bytes() {
        let body = r#"{"code":1,"serviceCode":"","msg":"成功"}"#.as_bytes();
        let data = unwrap_envelope_bytes(body).unwrap();
        assert_eq!(&data[..], b"null");
    }

    #[test]
    fn classify_network_returns_backoff() {
        assert_eq!(
            classify(&AuthError::Network {
                message: "down".into()
            }),
            Action::Backoff
        );
    }

    #[test]
    fn classify_protocol_mismatch_returns_terminate() {
        // 关键:防止 verify_token 415/404 死循环
        assert_eq!(
            classify(&AuthError::ProtocolMismatch {
                detail: "downstream_protocol_mismatch:415:verify_token".into()
            }),
            Action::Terminate
        );
    }
}
