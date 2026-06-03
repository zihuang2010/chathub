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
use crate::change_notice::{ChangeNotice, ChangeScope, ChangeTopic};
use crate::error::AuthError;
use crate::friend_event::FriendEventApplier;
use crate::interceptor::AuthInterceptor;
use crate::message_event::MessageEventApplier;
use crate::recent_session_event::RecentSessionEventApplier;
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
    /// forward 通道侦测 HTTP 401(token 已失效)时,用它当场失效本地会话
    /// (清 token + 广播 TokenInvalid)。Option:单测/工具构造可不接;
    /// 生产在 setup 阶段经 [`HubClient::with_token_store`] 注入一次,所有 clone 共享。
    token_store: Option<Arc<TokenStore>>,
}

impl HubClient {
    pub fn new(channel: Channel, interceptor: AuthInterceptor) -> Self {
        let inner = RawHubClient::with_interceptor(channel, interceptor);
        Self {
            inner,
            token_store: None,
        }
    }

    /// 注入 TokenStore,使 forward 通道遇 HTTP 401 能失效本地会话。
    /// 生产 setup 应在 `new` 之后、clone 分发之前调用一次 —— 所有 clone 继承同一 store,
    /// 与 ConnectionManager 订阅的是同一个 `Arc<TokenStore>`,广播必达 run_loop。
    pub fn with_token_store(mut self, token_store: Arc<TokenStore>) -> Self {
        self.token_store = Some(token_store);
        self
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
        // 业务后台对过期/无效 token 统一回 HTTP 401(serviceCode 100000001「会话已过期」)。
        // 这是 forward 通道唯一的「token 已失效」权威信号:当场失效本地会话(清 token + 广播
        // TokenInvalid),驱动连接下线 + 前端回登录页;否则在线指示仍显示在线、用户对死 token
        // 反复发送却次次失败。其余 4xx(如 403 无权限)保持原样透传,由调用方按 http_status 自决。
        if resp.http_status == 401 {
            if let Some(ts) = &self.token_store {
                // 仅在仍登录时失效一次:state 清空后并发的 401 自然跳过,避免重复广播。
                if ts.is_logged_in() {
                    ts.mark_token_invalid().await;
                }
            }
            return Err(AuthError::Unauthenticated);
        }
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

    /// 拉取单个外部联系人的好友详情。POST body 透传 `{ wecomAccountId, externalUserId, isForceRefresh }`。
    /// 不入库,临时拉取(同 fetch_message_history 语义)。`is_force_refresh=true` 打破一天一次的自动刷新限制。
    pub async fn friend_detail(
        &self,
        req: FriendDetailRequest,
    ) -> Result<WecomFriendDetail, AuthError> {
        let body = serde_json::to_vec(&req).map_err(|e| AuthError::Internal {
            message: format!("friend_detail serialize: {e}"),
        })?;
        let resp = self.forward("friend_detail", body).await?;
        if resp.http_status != 200 {
            return Err(AuthError::Internal {
                message: format!("friend_detail returned http {}", resp.http_status),
            });
        }
        serde_json::from_slice::<WecomFriendDetail>(&resp.body_json).map_err(|e| {
            AuthError::Internal {
                message: format!("friend_detail JSON parse: {e}"),
            }
        })
    }

    /// 拉取"接待好友列表"(消息页的最近会话列表)。POST body 透传:
    ///   `{ size, cursor, externalName, externalMobile, wecomAccountId, onlyUnread }`
    /// 服务端按 `last_message_time` 倒序 + 游标分页;响应自带 `last_message_*` 快照
    /// 与 `unread_count`,前端可直接渲染列表。
    pub async fn list_recent_friends(
        &self,
        req: ListRecentFriendsRequest,
    ) -> Result<ListRecentFriendsResp, AuthError> {
        let body = serde_json::to_vec(&req).map_err(|e| AuthError::Internal {
            message: format!("list_recent_friends serialize: {e}"),
        })?;
        let resp = self.forward("list_recent_friends", body).await?;
        if resp.http_status != 200 {
            return Err(AuthError::Internal {
                message: format!("list_recent_friends returned http {}", resp.http_status),
            });
        }
        serde_json::from_slice::<ListRecentFriendsResp>(&resp.body_json).map_err(|e| {
            AuthError::Internal {
                message: format!("list_recent_friends JSON parse: {e}"),
            }
        })
    }

    /// 拉取一条会话的历史消息(扁平列表,cursor 分页)。
    ///
    /// POST body 透传:
    ///   `{ size, wecomAccountId, externalUserId, cursor }`
    /// 语义固定"earlier-only"(往更早翻);服务端 `records` 按 sortKey 升序(早→晚)扁平返回 +
    /// 游标分页;首页 `cursor=""`,后续传 `nextCursor`。
    pub async fn fetch_message_history(
        &self,
        req: FetchMessageHistoryRequest,
    ) -> Result<FetchMessageHistoryResp, AuthError> {
        let body = serde_json::to_vec(&req).map_err(|e| AuthError::Internal {
            message: format!("fetch_message_history serialize: {e}"),
        })?;
        let resp = self.forward("fetch_message_history", body).await?;
        if resp.http_status != 200 {
            return Err(AuthError::Internal {
                message: format!("fetch_message_history returned http {}", resp.http_status),
            });
        }
        serde_json::from_slice::<FetchMessageHistoryResp>(&resp.body_json).map_err(|e| {
            AuthError::Internal {
                message: format!("fetch_message_history JSON parse: {e}"),
            }
        })
    }

    /// 发送一条文本消息(`messageType=1`)。POST body 透传请求字段。
    ///
    /// `request_message_id` 是幂等键(由 MessageSync 复用前端 client_msg_id 固化),故对
    /// 瞬时网络错误 / 超时做有限重试是安全的:服务端按同键去重,不会产生重复消息。
    /// 只重试 `classify == Backoff`(Network / Internal)的瞬时错误;业务错(Business)、
    /// 协议不匹配(ProtocolMismatch)、4xx(经 http_status 返回)一律不重试。
    pub async fn send_message(
        &self,
        req: SendMessageRequest,
    ) -> Result<SendMessageResp, AuthError> {
        let body = serde_json::to_vec(&req).map_err(|e| AuthError::Internal {
            message: format!("send_message serialize: {e}"),
        })?;

        const MAX_ATTEMPTS: u32 = 3;
        const ATTEMPT_TIMEOUT: Duration = Duration::from_secs(8);
        const RETRY_BACKOFF: Duration = Duration::from_millis(300);

        let mut attempt = 0u32;
        let resp = loop {
            attempt += 1;
            match tokio::time::timeout(ATTEMPT_TIMEOUT, self.forward("send_message", body.clone()))
                .await
            {
                Ok(Ok(resp)) => break resp,
                Ok(Err(e)) if attempt < MAX_ATTEMPTS && matches!(classify(&e), Action::Backoff) => {
                    tracing::warn!(
                        target: "chathub::msg",
                        attempt,
                        error = %e,
                        "send_message 瞬时失败,重试(幂等键去重)"
                    );
                    tokio::time::sleep(RETRY_BACKOFF).await;
                }
                Ok(Err(e)) => return Err(e),
                Err(_) if attempt < MAX_ATTEMPTS => {
                    tracing::warn!(
                        target: "chathub::msg",
                        attempt,
                        "send_message 超时,重试(幂等键去重)"
                    );
                    tokio::time::sleep(RETRY_BACKOFF).await;
                }
                Err(_) => {
                    return Err(AuthError::Network {
                        message: format!("send_message 超时(已重试 {attempt} 次)"),
                    });
                }
            }
        };

        if resp.http_status != 200 {
            return Err(AuthError::Internal {
                message: format!("send_message returned http {}", resp.http_status),
            });
        }
        serde_json::from_slice::<SendMessageResp>(&resp.body_json).map_err(|e| {
            AuthError::Internal {
                message: format!("send_message JSON parse: {e}"),
            }
        })
    }

    /// 标记会话已读。POST body 透传 `{ conversationId, readSortKey? }`;`readSortKey` 省略时
    /// 服务端按摘要最后一条消息清零未读。`code != 1` 经 forward 映射为 `AuthError::Business`。
    pub async fn mark_read(&self, req: MarkReadRequest) -> Result<MarkReadResp, AuthError> {
        let body = serde_json::to_vec(&req).map_err(|e| AuthError::Internal {
            message: format!("mark_read serialize: {e}"),
        })?;
        let resp = self.forward("mark_read", body).await?;
        if resp.http_status != 200 {
            return Err(AuthError::Internal {
                message: format!("mark_read returned http {}", resp.http_status),
            });
        }
        serde_json::from_slice::<MarkReadResp>(&resp.body_json).map_err(|e| AuthError::Internal {
            message: format!("mark_read JSON parse: {e}"),
        })
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

/// 按多账号拉取好友(客户)列表入参。游标分页 + 服务端筛选。
///
/// 跨账号单 cursor:`wecom_account_ids` 全集合一次提交,业务后台做
/// `add_time DESC, id DESC` 的全局 keyset,返回单条游标 `next_cursor`。
///
/// 空字符串语义:
///   - `wecom_account_ids = []` → 全量拉取:序列化省略该字段,后台按登录账号 token 圈定;非空 → 按子集过滤
///   - `cursor = ""` → 首页;`cursor = nextCursor` → 续页
///   - `external_name = None` → 不筛选;非空 → 按名称模糊匹配
///   - `add_start_time / add_end_time = None` → 不限时间
///   - `total_mode` 固定 `"none"`:10万级数据量下不返 total/pages,UI 走纯滚动。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListFriendsRequest {
    /// 为空 = 全量拉取:序列化时整体省略该字段,业务后台按登录账号 token 圈定好友。
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub wecom_account_ids: Vec<String>,
    pub size: u32,
    pub cursor: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub add_start_time: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub add_end_time: Option<String>,
    /// totalMode:固定 `"none"`(不返 total/pages)。
    pub total_mode: String,
}

/// 好友单条记录(camelCase JSON ↔ Rust snake_case)。
///
/// 单 cursor 跨账号 keyset:每条记录自带 `wecom_account_id` 归属,前端多账号合并时
/// chip 数字、账号显示名都能精确对上(不再靠 Tauri 层按查询账号注入)。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WecomFriend {
    pub wecom_account_id: String,
    /// 归属账号(负责人)显示名;业务后台返回,缺省容忍空串。
    #[serde(default)]
    pub wecom_account_name: String,
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
    /// 视频号来源:业务后台可能下发 `null`(非视频号好友),故用 Option 容忍
    /// null/缺省(serde 对 `i32` 直接撞 `null` 会报 invalid type)。
    #[serde(default)]
    pub wechat_channels_source: Option<i32>,
    pub last_sync_time: String,
    pub sync_status: i32,
}

/// listFriends 游标响应(2xx envelope.data 的形态)。
///
/// totalMode `none`:不返 total/pages —— 10万级数据量下全表 count 没意义,UI 走纯滚动。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListFriendsResp {
    pub records: Vec<WecomFriend>,
    pub has_more: bool,
    pub next_cursor: String,
}

// ─── friend_detail typed contract ───────────────────────────────────────────

/// 好友详情入参。`is_force_refresh=true` 打破一天一次的自动刷新限制。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FriendDetailRequest {
    pub wecom_account_id: String,
    pub external_user_id: String,
    pub is_force_refresh: bool,
}

/// 客户标签快照(对应 `follow_user.tags`)。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FriendTag {
    #[serde(default)]
    pub group_name: String,
    #[serde(default)]
    pub tag_name: String,
}

/// 好友详情(2xx envelope.data 形态)。除 external_user_id / sync_status / gmt_modified_time
/// 三个必填外,其余字段服务端按需返回,故一律 `#[serde(default)]` 容忍缺省。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WecomFriendDetail {
    pub external_user_id: String,
    /// 归属账号(负责人)显示名;业务后台返回,缺省容忍空串。
    #[serde(default)]
    pub wecom_account_name: String,
    #[serde(default)]
    pub external_name: String,
    #[serde(default)]
    pub external_position: String,
    #[serde(default)]
    pub external_avatar: String,
    #[serde(default)]
    pub external_corp_name: String,
    #[serde(default)]
    pub external_corp_full_name: String,
    #[serde(default)]
    pub external_type: i32,
    #[serde(default)]
    pub external_gender: i32,
    /// 按权限脱敏
    #[serde(default)]
    pub external_mobile: String,
    #[serde(default)]
    pub follow_remark: String,
    #[serde(default)]
    pub follow_description: String,
    #[serde(default)]
    pub remark_corp_name: String,
    #[serde(default)]
    pub add_time: String,
    #[serde(default)]
    pub add_way: i32,
    #[serde(default)]
    pub follow_state: String,
    #[serde(default)]
    pub wechat_channels_nickname: String,
    /// 视频号来源:业务后台可能下发 `null`,用 Option 容忍(同列表 `WecomFriend`)。
    #[serde(default)]
    pub wechat_channels_source: Option<i32>,
    #[serde(default)]
    pub last_sync_time: String,
    /// 0 未同步,1 成功,2 失败
    pub sync_status: i32,
    #[serde(default)]
    pub remark_mobiles: Vec<String>,
    #[serde(default)]
    pub tags: Vec<FriendTag>,
    #[serde(default)]
    pub oper_userid: String,
    #[serde(default)]
    pub sync_fail_reason: Option<String>,
    /// 好友资料主表最近修改时间
    pub gmt_modified_time: String,
}

// ─── list_recent_friends typed contract ─────────────────────────────────────

/// session/recentFriends 入参。游标分页 + 服务端筛选。
///
/// 空字符串字段的语义:
///   - `cursor = ""` → 首页;`cursor = nextCursor` → 续页
///   - `wecom_account_id = ""` → 全部账号聚合;非空 → 仅该账号
///   - `external_name / external_mobile = ""` → 不筛选
///   - `external_user_id = ""` → 不按单好友定位;非空 → 只取该外部联系人的会话
///     (配合 `include_first_history`,响应顶层带回 `request_conversation_id` + 首屏历史)
///   - `include_first_history = false` → 不返回首屏历史(列表/搜索路径)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListRecentFriendsRequest {
    pub size: u32,
    pub cursor: String,
    pub external_name: String,
    pub external_mobile: String,
    pub wecom_account_id: String,
    pub only_unread: bool,
    /// 单好友定位:按 `external_user_id` 取该好友会话(打开会话流程用)。空串=不定位。
    #[serde(default)]
    pub external_user_id: String,
    /// 是否随响应带回该会话首屏历史(`first_conversation_history`)。
    #[serde(default)]
    pub include_first_history: bool,
}

/// session/recentFriends 单条记录(17 字段,camelCase JSON ↔ Rust snake_case)。
///
/// 业务后台已经做完了"会话最近"语义,客户端拿到即可渲染列表 —— 无需二次拉消息。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentFriendRecord {
    pub conversation_id: String,
    pub wecom_account_id: String,
    pub wecom_name: String,
    pub wecom_account: String,
    pub wecom_alias: String,
    pub external_user_id: String,
    pub external_name: String,
    pub external_avatar: String,
    pub external_mobile: String,
    pub last_local_message_id: String,
    /// 1=文本 / 2=图片 / 3=…(具体枚举翻译留给前端)
    pub last_message_type: i32,
    /// 1=入 / 2=出
    pub last_message_direction: i32,
    /// 3=已读 / 4=失败 …
    pub last_send_status: i32,
    pub last_message_summary: String,
    /// ISO 8601 with TZ,例如 "2026-05-18T10:28:36Z"
    pub last_message_time: String,
    pub unread_count: i64,
    pub has_unread: bool,
    /// 该会话单调排序键,首段为 epoch-ms(形如 `1715836200000:abc`)。LWW 主版本。
    /// 旧服务端缺省 → "" → 版本回退到 `last_message_time`。
    #[serde(default)]
    pub last_message_sort_key: String,
    /// 记录最后修改时间 `yyyy-MM-dd HH:mm:ss`。LWW 次版本(同 sortKey 时比较)。
    #[serde(default)]
    pub gmt_modified_time: String,
}

/// session/recentFriends 响应(2xx envelope.data 的形态)。
///
/// `request_conversation_id` 在请求带 `external_user_id` 单好友定位时由服务端返回(即使 `records`
/// 为空也给);`first_conversation_history` 仅在请求带 `include_first_history=true`(打开会话流程)
/// 时填充。列表/搜索路径两者缺省 → 默认值(空串 / None),反序列化兼容。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListRecentFriendsResp {
    pub size: u32,
    pub has_more: bool,
    pub next_cursor: String,
    pub records: Vec<RecentFriendRecord>,
    /// 服务端权威会话 ID:打开会话流程用此值(即使 `records` 为空也返回)。
    #[serde(default)]
    pub request_conversation_id: String,
    /// 该会话首屏历史。`null` / 缺省 → None。
    #[serde(default)]
    pub first_conversation_history: Option<FirstConversationHistory>,
}

/// `firstConversationHistory`:打开会话时随接待记录带回的首屏历史(语义对照 message/history:
/// 最新一页 + earlier-only 游标)。冷写入消息缓存建窗用 `records` + `has_more` + `next_cursor`;
/// 其余分页字段(size/total/current/pages)忽略。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FirstConversationHistory {
    #[serde(default)]
    pub records: Vec<HistoryMessage>,
    /// 是否还有更老消息(建窗 `has_more_older`)。
    #[serde(default)]
    pub has_more: bool,
    /// 更老分页游标;服务端返回 `null` → None(建窗 `older_cursor` 取空串)。
    #[serde(default)]
    pub next_cursor: Option<String>,
}

// ─── fetch_message_history typed contract ───────────────────────────────────

/// message/history 入参。游标分页(earlier-only)。
/// 语义固定"往更早翻":服务端取 `sortKey < cursor.sortKey` 的一页。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchMessageHistoryRequest {
    pub size: u32,
    pub wecom_account_id: String,
    pub external_user_id: String,
    /// 首页 ""(空串)/续页填上轮 `nextCursor`。
    pub cursor: String,
}

/// 单条历史消息记录(对照业务后台 message/history 单条形态)。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryMessage {
    pub local_message_id: String,
    /// 原始 spec（针对当前账号）：1=发送(out) / 2=接收(in) / 3=多端同步(out)。
    /// 落库时经 to_local_direction 转本地约定(1=in,2=out)。
    pub message_direction: i32,
    /// 1=文本 / 2=图片 / 3=...(具体枚举翻译留前端)。
    pub message_type: i32,
    pub content_text: String,
    /// 1=已发送 / 2=已送达 / 3=已读 / 4=失败 等。
    pub send_status: i32,
    /// `yyyy-MM-dd HH:mm:ss`,服务端本地时区。
    pub message_time: String,
    /// 服务端排序键(opaque,客户端不解析)。
    pub sort_key: String,
    pub attachments: Vec<HistoryAttachment>,
    /// 记录最后修改时间 `yyyy-MM-dd HH:mm:ss`(状态/内容变更时刷新;客户端暂不消费)。
    pub gmt_modified_time: String,
    /// 是否已撤回(MESSAGE_REVOKED 事件置真);前端据此渲染"已撤回"系统行。
    #[serde(default)]
    pub revoked: bool,
    /// 发送失败原因(SEND_FAILED 事件的 `failReason`);非失败为空串。
    #[serde(default)]
    pub fail_reason: String,
    /// 服务端去重用的客户端请求键(=`requestMessageId`/`client_msg_id`);乐观气泡确定性配对兜底。
    #[serde(default)]
    pub request_message_id: String,
}

/// 兼容数字与字符串两种 `fileSize`(上游历史/推送可能给字符串如 "176098");
/// null / 非法 / 缺失一律兜底 0(尺寸非渲染必需,不因它丢掉整条附件)。
fn de_i64_flexible<'de, D>(deserializer: D) -> Result<i64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::Deserialize as _;
    Ok(match serde_json::Value::deserialize(deserializer)? {
        serde_json::Value::Number(n) => n.as_i64().unwrap_or(0),
        serde_json::Value::String(s) => s.trim().parse::<i64>().unwrap_or(0),
        _ => 0,
    })
}

/// 规范附件形态(序列化恒输出 camelCase `mediaId`/`fileType`,前端按此消费)。
/// 反序列化额外兼容上游业务后台的实时推送/历史返回字段(`ossFilePath`/`fileSuffix`/
/// 字符串 `fileSize`),各字段都给 default,缺字段也不丢整条附件。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryAttachment {
    /// 存 OSS objectName。规范键 `mediaId`;上游键 `ossFilePath`。
    #[serde(default, alias = "ossFilePath")]
    pub media_id: String,
    #[serde(default)]
    pub file_name: String,
    #[serde(default, deserialize_with = "de_i64_flexible")]
    pub file_size: i64,
    /// 不含点的后缀(如 png)。规范键 `fileType`;上游键 `fileSuffix`。
    #[serde(default, alias = "fileSuffix")]
    pub file_type: String,
    /// 图片原始宽度（px），由后台预取注入；服务端不下发时为 None。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<i64>,
    /// 图片原始高度（px），由后台预取注入；服务端不下发时为 None。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<i64>,
    /// 本地缩略图绝对路径，由后台预取落盘后注入；前端走 asset 协议读取。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_path: Option<String>,
    /// 附件转存状态:0=无需转存,1=待转存(可能尚无 ossFilePath),2=转存成功,3=转存失败。
    /// 上游键 `transferStatus`(与规范键同名);缺失默认 0(视为就绪,向后兼容旧缓存)。
    #[serde(default)]
    pub transfer_status: i32,
    /// 媒体时长(秒);语音/视频由上游下发,其余为 None。上游键 `durationSeconds`(可能为 null)。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<i32>,
}

/// 响应(2xx envelope.data 的形态)。
/// `records` 为扁平消息列表,按 sortKey 升序(早→晚)。
/// `total/current/pages` 服务端不维护时返 -1,客户端忽略。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchMessageHistoryResp {
    pub records: Vec<HistoryMessage>,
    // 分页元数据(size/total/current/pages):客户端**不消费**(reconcile 只用 records/
    // next_cursor/has_more),仅为契约完整性保留。上游"不维护"时把 total/current/pages
    // 返回为**字符串** "-1"(而非数字 -1),故统一走 de_i64_flexible 容忍字符串数字 + default。
    // 否则单个元数据字段类型飘移会让整条响应(含所有 records)解析失败 → 历史一条都加载不出。
    #[serde(default, deserialize_with = "de_i64_flexible")]
    pub size: i64,
    #[serde(default)]
    pub has_more: bool,
    #[serde(default)]
    pub next_cursor: String,
    #[serde(default, deserialize_with = "de_i64_flexible")]
    pub total: i64,
    #[serde(default, deserialize_with = "de_i64_flexible")]
    pub current: i64,
    #[serde(default, deserialize_with = "de_i64_flexible")]
    pub pages: i64,
}

// ─── send_message typed contract(messageType 1=文本/2=图片/3=文件/4=语音)──────

/// message/send 入参。
/// 文本(`message_type=1`)带 `content_text`,不带 filePath;图片/文件/语音
/// (2/3/4)带 `file_path/file_name/file_size`,不带 contentText。混合消息由客户端
/// 拆成多条单消息分别发送(本契约不接收混合体)。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessageRequest {
    /// 客户端幂等键(去重用)。
    pub request_message_id: String,
    pub wecom_account_id: String,
    pub external_user_id: String,
    /// 1=文本 / 2=图片 / 3=文件 / 4=语音。
    pub message_type: i32,
    /// 文本内容;非文本消息为空串,空串不序列化(契约不带 contentText)。
    #[serde(skip_serializing_if = "String::is_empty")]
    pub content_text: String,
    /// OSS objectName(图片/文件/语音);文本消息为 None,不序列化。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_size: Option<i64>,
    /// 语音时长(秒,整数);仅语音(message_type=4)带,其余消息为 None,不序列化。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<i32>,
}

/// 响应(2xx envelope.data 的形态)。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessageResp {
    pub local_message_id: String,
    /// 1=已发送 / 2=已送达 / 3=已读 / 4=失败 等。
    pub send_status: i32,
    /// `yyyy-MM-dd HH:mm:ss`,服务端本地时区。
    pub message_time: String,
}

// ─── mark_read typed contract ────────────────────────────────────────────────

/// session/markRead 入参。`read_sort_key` 省略 = 按摘要最后一条消息清零。
/// 客户端目前不持有完整复合 sortKey,故 `read_sort_key` 恒为 `None`(清零到最新)。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkReadRequest {
    pub conversation_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_sort_key: Option<String>,
}

/// 响应(2xx envelope.data 的形态)。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkReadResp {
    pub success: bool,
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

/// 服务端"请求全量重拉"信号 —— 两条触发路径汇聚到这里:
///
///   1. Subscribe 首帧 `SubscribeAck.resync_required=true`:客户端 since_notify_seq
///      超出 relay 事件保留窗口,或服务端积压超 1000 截断,需要走兜底 API 对齐。
///   2. 实时流 `SystemSignal::ResyncRequired`:服务端检测到反压/日志窗口问题,
///      主动通知客户端走兜底。同步断重连(现有逻辑)。
///
/// 客户端上层(useRecentFriends)收到此信号 → 调一次 `list_recent_friends_remote_page`
/// 首页对齐。watermark 不重置,后续实时流照常从 `replayed_to_seq + 1` 推进。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResyncSignal {
    /// 人类可读理由,仅用于日志/UI 展示,**不要 parse**。
    pub reason: String,
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
    /// SubscribeAck.resync_required / SystemSignal::ResyncRequired 触发,上层桥接 → app.emit
    resync_tx: broadcast::Sender<ResyncSignal>,
    /// 统一变更通知通道 — applier / 用户命令 / resync 都往这里发,上层桥接 → app.emit("hub:change")。
    /// 由 setup 阶段创建并同时注入到 ConnectionManager 与各 applier(共享 broadcast channel)。
    change_notice_tx: broadcast::Sender<ChangeNotice>,
    /// 2026-05-17:Subscribe 流里 ACCOUNT_* 事件 → 本地账号缓存 + 广播给 Tauri 层。
    /// Optional 是为了让 chathub-net 单测可以构造 ConnectionManager 而不必带 AccountCacheStore。
    account_event_applier: Option<Arc<AccountEventApplier>>,
    /// 阶段 2:Subscribe 流里 FRIEND_* 事件 → 本地好友行存 + 广播给 Tauri 层。
    /// 与 account_event_applier 并列;PushBatchOut 来时两个 applier 都调一次,各自按 eventType 筛分支。
    friend_event_applier: Option<Arc<FriendEventApplier>>,
    /// 阶段 3:Subscribe 流里 MESSAGE_UPSERT / SESSION_SUMMARY_UPSERT 事件 → 本地最近会话行存 + 广播。
    /// 与上两个 applier 并列;PushBatchOut 来时三者都调一次,各自按 eventType 筛分支。
    recent_session_event_applier: Option<Arc<RecentSessionEventApplier>>,
    /// 阶段 4:Subscribe 流里 MESSAGE_UPSERT → 本地消息气泡行存 + broadcast。
    /// 与前三个 applier 并列;PushBatchOut 来时四者都调一次,各自按 eventType 筛分支。
    message_event_applier: Option<Arc<MessageEventApplier>>,
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
        recent_session_event_applier: Option<Arc<RecentSessionEventApplier>>,
        message_event_applier: Option<Arc<MessageEventApplier>>,
        // 共享 ChangeNotice 通道 —— setup 阶段统一创建,applier 与 ConnectionManager 持同一 sender。
        change_notice_tx: broadcast::Sender<ChangeNotice>,
    ) -> Self {
        let (state_tx, _) = watch::channel(ConnectionState::Disconnected { last_error: None });
        let (event_tx, _) = broadcast::channel(256);
        let (resync_tx, _) = broadcast::channel(16);
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
                resync_tx,
                change_notice_tx,
                account_event_applier,
                friend_event_applier,
                recent_session_event_applier,
                message_event_applier,
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

    /// 订阅"请全量重拉"信号。两条触发路径(SubscribeAck.resync_required /
    /// SystemSignal::ResyncRequired)都汇聚到这里。上层调一次 list_recent_friends_remote_page
    /// 首页对齐即可。
    pub fn resync_subscribe(&self) -> broadcast::Receiver<ResyncSignal> {
        self.inner.resync_tx.subscribe()
    }

    /// 订阅统一变更通知。setup 阶段桥接到 app.emit("hub:change")。
    pub fn change_notice_subscribe(&self) -> broadcast::Receiver<ChangeNotice> {
        self.inner.change_notice_tx.subscribe()
    }

    // C6 拆双发后:applier 不再各自暴露 subscribe;所有变更通过 change_notice_subscribe()
    // 统一接收。Inner.{account/friend/recent_session/message}_event_applier 字段仍保留,
    // 是因为 run_loop 内仍需调 apply_push_batch 处理 PushBatchOut 事件。

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
    /// Resync 路径触发 — 给所有已知 topic 各发一条 BulkInvalidate ChangeNotice。
    /// employee_id 取 token_store 当前会话的 user_id;若未登录(异常路径),不发。
    fn broadcast_resync_to_all_topics(&self) {
        let employee_id = match self.token_store.current_user_id() {
            Some(uid) if !uid.is_empty() => uid,
            _ => return,
        };
        let scope = ChangeScope::employee(employee_id);
        for topic in [
            ChangeTopic::Accounts,
            ChangeTopic::Friends,
            ChangeTopic::RecentSessions,
        ] {
            let _ = self
                .change_notice_tx
                .send(ChangeNotice::resync(topic, scope.clone()));
        }
    }
}

impl Inner {
    async fn run_loop(
        self: Arc<Inner>,
        mut logged_out_rx: broadcast::Receiver<crate::token::LoggedOutReason>,
    ) {
        let mut backoff = ExponentialBackoff::new(&self.backoff);
        // 已回传给 relay 的最高水位。跨重连保留:重连后 relay 从 since 重放,
        // 再 ack 同值幂等,不必清零。仅当持久化水位 > 此值时才发一次 ack。
        let mut last_acked: u64 = 0;

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

            // 本次订阅的回放上界:收到 SubscribeAck 后从 ack.replayed_to_seq 取;
            // 在此之前以 since 兜底(<=since 的都已处理过)。回放帧不进 event_tx 广播,
            // 避免大回放灌爆 broadcast(256) 触发 Lagged→stop/start 抖动。
            let mut replay_high: u64 = since;

            // ack 合并:每 1s 最多回传一次"最高已落库水位"(apply-then-advance 后持久化的值),
            // 避免每条消息一次 RPC,又让 relay 重放缓冲有界。空闲时水位不前进 → 不发。
            // interval 首 tick 立即就绪,消费掉以让第一次 ack 落在一个完整窗口之后。
            let mut ack_interval = tokio::time::interval(Duration::from_secs(1));
            ack_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            ack_interval.tick().await;

            loop {
                tokio::select! {
                    biased;
                    _ = logged_out_rx.recv() => {
                        self.state_tx.send_replace(ConnectionState::Disconnected { last_error: None });
                        return;
                    }
                    _ = ack_interval.tick() => {
                        // 读持久化水位(= 已 apply-then-advance 的最高 seq);advanced 才 ack。
                        let durable = self.notify_seq_store.read().await.unwrap_or(0);
                        if durable > last_acked {
                            match self.hub.ack(durable).await {
                                Ok(()) => last_acked = durable,
                                // 失败不前进 last_acked,下个窗口重试(seq 单调,重发幂等)。
                                Err(e) => tracing::warn!(?e, durable, "hub.ack failed; retry next window"),
                            }
                        }
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

                            // 捕获本次订阅回放上界(所有 ack,不止 resync)。
                            if let Some(Body::SubscribeAck(ack)) = &event.body {
                                replay_high = ack.replayed_to_seq;
                            }

                            // resync 信号汇聚:两条路径都触发上层全量重拉
                            //   1) Subscribe 首帧 ack.resync_required=true(超 retention 或积压截断)
                            //   2) 实时流 SystemSignal::ResyncRequired(服务端主动 + should_terminate 断重连)
                            // 注意 SystemSignal 触发后会断重连,下次首帧 ack 可能再次广播 ResyncSignal,
                            // 这是预期的(两次都该让上层 refreshFirstPage 一次,幂等)。
                            match &event.body {
                                Some(Body::SubscribeAck(ack)) if ack.resync_required => {
                                    tracing::info!(
                                        target: "chathub_net::hub",
                                        reason = %ack.resync_reason,
                                        resumed_from_seq = ack.resumed_from_seq,
                                        replayed_to_seq = ack.replayed_to_seq,
                                        "SubscribeAck.resync_required=true; broadcasting ResyncSignal"
                                    );
                                    let _ = self.resync_tx.send(ResyncSignal {
                                        reason: ack.resync_reason.clone(),
                                    });
                                    self.broadcast_resync_to_all_topics();
                                }
                                Some(Body::System(s)) if s.kind == Kind::ResyncRequired as i32 => {
                                    tracing::info!(
                                        target: "chathub_net::hub",
                                        detail = %s.detail,
                                        "SystemSignal::ResyncRequired received; broadcasting ResyncSignal"
                                    );
                                    let _ = self.resync_tx.send(ResyncSignal {
                                        reason: s.detail.clone(),
                                    });
                                    self.broadcast_resync_to_all_topics();
                                }
                                _ => {}
                            }

                            // PushBatchOut → 账号事件应用 → **应用后**推进水位(apply-then-advance)。
                            // 水位必须在 appliers 提交 SQLite 之后才前进:否则崩溃重启会用
                            // 一个超前的 since 重订阅,跳过尚未落库的批次(数据丢失到下次 resync)。
                            if let Some(Body::PushBatch(pb)) = &event.body {
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
                                // 阶段 3:消息会话事件(MESSAGE_UPSERT / SESSION_SUMMARY_UPSERT)
                                // → 本地最近会话行存 + broadcast。内部按 eventType 过滤,非命中直接返回。
                                if let Some(applier) = &self.recent_session_event_applier {
                                    applier.apply_push_batch(pb).await;
                                }
                                // 阶段 4:消息气泡(MESSAGE_UPSERT)→ 本地 hub_conversation_messages。
                                // 内部按 eventType 过滤,非命中直接返回。
                                if let Some(applier) = &self.message_event_applier {
                                    applier.apply_push_batch(pb).await;
                                }
                                // 四个 applier 都已 best-effort 应用(失败内部 log + 安排 fallback),
                                // 现在才推进全局水位。下次(重)订阅以此为 since。
                                if let Err(e) = self.notify_seq_store
                                    .upsert_if_greater(pb.notify_seq).await {
                                    tracing::warn!(?e, "notify_seq_store upsert failed, ignored");
                                }
                            }

                            // 回放帧(notify_seq <= 本次回放上界)只落库 + 推进水位,不进 event_tx
                            // 广播;live 帧(> 上界)正常广播。逐帧判断,抗 live/replay 交错。
                            let is_replay_frame = matches!(
                                &event.body,
                                Some(Body::PushBatch(pb)) if pb.notify_seq <= replay_high
                            );
                            if !is_replay_frame {
                                let _ = self.event_tx.send(event);
                            }

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

    // 回归:上游分页元数据(total/current/pages)"不维护"时返回**字符串** "-1"(而非数字)。
    // 早先 i64/i32 严格类型遇字符串即报 `invalid type: string "-1", expected i64`,使整条
    // 响应(含全部 records)解析失败 → reconcile 报错 → 历史一条都加载不出。de_i64_flexible
    // 容忍字符串数字后,records 必须正常解析(图片附件 ossFilePath 也要落到 media_id)。
    #[test]
    fn fetch_history_resp_tolerates_string_minus_one_metadata() {
        let raw = r#"{"records":[{"localMessageId":"2060699569984897024","messageDirection":1,"messageType":2,"contentText":"","sendStatus":3,"messageTime":"2026-05-30 20:27:16","sortKey":"1780144036000_00000000000011974113_2060699569984897024","attachments":[{"attachmentType":1,"fileName":"image.png","fileSuffix":"png","fileSize":"434309","ossFilePath":"t/dev/wechat-business-app/2026/05/30/202716_ec80d3fb.png"}],"gmtModifiedTime":"2026-05-30 20:27:16"}],"size":20,"hasMore":true,"nextCursor":"cur1","total":"-1","current":"-1","pages":"-1"}"#;
        let resp: FetchMessageHistoryResp =
            serde_json::from_str(raw).expect("字符串 -1 元数据不应导致整条响应解析失败");
        assert_eq!(resp.records.len(), 1, "records 必须正常解析出来");
        assert_eq!(resp.total, -1);
        assert_eq!(
            resp.records[0].attachments[0].media_id,
            "t/dev/wechat-business-app/2026/05/30/202716_ec80d3fb.png"
        );
        assert!(resp.has_more);
        assert_eq!(resp.next_cursor, "cur1");
    }

    #[test]
    fn connection_state_disconnected_no_error_omits_field() {
        let s = ConnectionState::Disconnected { last_error: None };
        let json = serde_json::to_string(&s).unwrap();
        assert_eq!(json, r#"{"state":"disconnected"}"#);
    }

    #[test]
    fn list_friends_request_empty_accounts_omits_wecom_account_ids() {
        // 全量拉取:账号集为空时请求体整体省略 wecomAccountIds(由后台按登录账号 token 圈定)。
        let req = ListFriendsRequest {
            wecom_account_ids: Vec::new(),
            size: 20,
            cursor: String::new(),
            external_name: None,
            add_start_time: None,
            add_end_time: None,
            total_mode: "none".into(),
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(!json.contains("wecomAccountIds"), "got {json}");
    }

    #[test]
    fn list_friends_request_non_empty_accounts_keeps_wecom_account_ids() {
        // 选定子集时仍下发 wecomAccountIds。
        let req = ListFriendsRequest {
            wecom_account_ids: vec!["acct-1".into()],
            size: 20,
            cursor: String::new(),
            external_name: None,
            add_start_time: None,
            add_end_time: None,
            total_mode: "none".into(),
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(
            json.contains(r#""wecomAccountIds":["acct-1"]"#),
            "got {json}"
        );
    }

    #[test]
    fn list_friends_resp_tolerates_null_wechat_channels_source() {
        // 回归:业务后台对非视频号好友下发 `wechatChannelsSource: null`,
        // 旧 i32 字段会报 "invalid type: null, expected i32",整页 records 丢弃。
        // 现改 Option<i32> 后 null → None,反序列化成功。
        let raw = r#"{
            "records": [{
                "wecomAccountId": "wjt",
                "externalUserId": "wmITqmBgAAdphngtNF824Zq9TCcmGTYA",
                "externalName": "Tom",
                "externalPosition": "",
                "externalAvatar": "",
                "externalCorpName": "",
                "externalCorpFullName": "",
                "externalType": 1,
                "externalGender": 1,
                "externalMobile": "",
                "followRemark": "Tom",
                "followDescription": "",
                "remarkCorpName": "",
                "addTime": "2026-04-29 14:03:45",
                "addWay": 1,
                "followState": "S1|JDLY202511141729028875",
                "wechatChannelsNickname": "",
                "wechatChannelsSource": null,
                "lastSyncTime": "2026-05-26 10:31:52",
                "syncStatus": 1
            }],
            "hasMore": false,
            "nextCursor": ""
        }"#;
        let resp: ListFriendsResp = serde_json::from_str(raw).expect("null source 应被容忍");
        assert_eq!(resp.records.len(), 1);
        assert_eq!(resp.records[0].wechat_channels_source, None);
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
