mod logging;

use serde::Serialize;
use std::sync::Arc;
use tauri::{Emitter, LogicalSize, Manager, State};
use tracing::info;

use chathub_net::{
    record_to_remote, row_to_history, AccountEventApplier, AuthApi, AuthError, AuthInterceptor,
    BackoffConfig, ChangeNotice, ChangeScope, ChangeTopic, ConnectionManager, ConnectionState,
    FetchMessageHistoryRequest, FetchMessageHistoryResp, FriendEventApplier, HistoryMessage,
    HubClient, ListAccountsFilter, ListAccountsItem, ListFriendsRequest, ListFriendsResp,
    ListRecentFriendsRequest, ListRecentFriendsResp, LoggedOutReason, MarkReadRequest,
    MessageEventApplier, MessageSync, RecentSessionEventApplier, SendMessageResp, TokenStore,
};
use chathub_proto::v1::UserProfile;
use chathub_state::{
    AccountCacheStore, FriendsStore, LocalTokenStore, MessagesStore, NotifySeqStore,
    RecentSessionRow, RecentSessionsStore, SessionStore, SqlitePool, WecomAccountRow,
    MESSAGE_HOT_CONVERSATIONS_LIMIT, RECENT_SESSIONS_GLOBAL_LIMIT,
    RECENT_SESSIONS_PER_ACCOUNT_LIMIT,
};
use std::time::{Duration, Instant};
use tokio::sync::broadcast as tokio_broadcast;
use tokio::sync::broadcast::channel as broadcast_channel;

// ============================== 现有命令保留 ==============================

#[tauri::command]
fn greet(name: &str) -> String {
    info!(target: "chathub::cmd", %name, "greet command invoked");
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScreenshotResult {
    cancelled: bool,
    base64: Option<String>,
}

#[tauri::command]
async fn take_screenshot() -> Result<ScreenshotResult, String> {
    take_screenshot_impl()
}

#[cfg(target_os = "macos")]
fn take_screenshot_impl() -> Result<ScreenshotResult, String> {
    use base64::engine::general_purpose::STANDARD as BASE64;
    use base64::Engine;
    use std::fs;
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("生成截图文件名失败: {e}"))?
        .as_millis();
    let path = std::env::temp_dir().join(format!("chathub-screenshot-{stamp}.png"));

    let output = Command::new("screencapture")
        .args(["-i", "-x", "-t", "png"])
        .arg(&path)
        .output()
        .map_err(|e| format!("无法启动系统截图工具: {e}"))?;

    let bytes = match fs::read(&path) {
        Ok(bytes) if !bytes.is_empty() => bytes,
        _ => {
            let _ = fs::remove_file(&path);
            if output.status.success() {
                tracing::warn!(target: "chathub::cmd", "screenshot picker returned without an image");
            }
            return Ok(ScreenshotResult {
                cancelled: true,
                base64: None,
            });
        }
    };
    let _ = fs::remove_file(&path);

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        tracing::warn!(target: "chathub::cmd", status = ?output.status, stderr, "screenshot command failed");
        return Err(if stderr.is_empty() {
            "截图失败".to_string()
        } else {
            format!("截图失败: {stderr}")
        });
    }

    info!(target: "chathub::cmd", bytes = bytes.len(), "screenshot region captured");
    Ok(ScreenshotResult {
        cancelled: false,
        base64: Some(BASE64.encode(bytes)),
    })
}

#[cfg(not(target_os = "macos"))]
fn take_screenshot_impl() -> Result<ScreenshotResult, String> {
    Err("当前平台暂不支持区域截图，请使用系统截图后粘贴".to_string())
}

// ============================== Plan 2:Auth 命令 ==============================

#[tauri::command]
async fn login(
    state: State<'_, Arc<AuthApi>>,
    cm: State<'_, Arc<ConnectionManager>>,
    username: String,
    password: String,
) -> Result<UserProfile, AuthError> {
    // 不在常规日志打印 username(PII);失败路径保留账号以便排查认证问题。
    info!(target: "chathub::cmd", "login command invoked");
    let profile = match state.login(&username, &password).await {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(target: "chathub::cmd", %username, error = %e, "login command failed");
            return Err(e);
        }
    };
    cm.start().await;
    info!(target: "chathub::cmd", user_id = %profile.user_id, "login command ok, ConnectionManager started");
    Ok(profile)
}

#[tauri::command]
async fn logout(
    state: State<'_, Arc<AuthApi>>,
    cm: State<'_, Arc<ConnectionManager>>,
) -> Result<(), AuthError> {
    cm.stop().await;
    state.logout().await
}

#[tauri::command]
async fn current_session(state: State<'_, Arc<AuthApi>>) -> Result<Option<UserProfile>, AuthError> {
    state.current_session().await
}

/// Plan 7 — 业务 RPC 统一走 Hub.Forward。
/// 前端传 method + body_json,relay 转 POST 到业务后台,返回 (http_status, body_json)。
/// 前端按 http_status 判断业务结果(2xx 成功 / 4xx 业务错 / relay 不替它解读)。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ForwardResult {
    http_status: u32,
    body_json: String,
}

#[tauri::command]
async fn hub_forward(
    hub: State<'_, HubClient>,
    method: String,
    body_json: String,
) -> Result<ForwardResult, AuthError> {
    let resp = hub.forward(&method, body_json.into_bytes()).await?;
    Ok(ForwardResult {
        http_status: resp.http_status,
        // F6: Bytes → String,只在 Tauri command 出口转一次。
        // 非 UTF-8 说明响应编码损坏,降级为空串但必须告警,不静默吞错。
        body_json: String::from_utf8(resp.body_json.to_vec()).unwrap_or_else(|e| {
            tracing::warn!(
                target: "chathub::cmd",
                method = %method,
                error = %e,
                "hub_forward 响应非 UTF-8,已降级为空串"
            );
            String::new()
        }),
    })
}

#[tauri::command]
async fn hub_ack(hub: State<'_, HubClient>, notify_seq: u64) -> Result<(), AuthError> {
    hub.ack(notify_seq).await
}

#[tauri::command]
async fn hub_state(cm: State<'_, Arc<ConnectionManager>>) -> Result<ConnectionState, ()> {
    Ok(cm.state_subscribe().borrow().clone())
}

/// 拉取当前员工可管理的企微账号列表。**Cache-first**:
///   - 默认读 `AccountCacheStore` 本地缓存,零远程往返;
///   - 本地缓存为空 / `force=true` 时透传业务后台 listMine,**全量(不带 enabled 过滤)** 拉一份
///     回填 cache,再按 `enabled` 在本地过滤后返回。
///   - Subscribe 流推 ACCOUNT_* 事件后,cache 通过 `AccountEventApplier` 自动增量更新,
///     前端走 `accounts_changed` 事件再读一次本地 cache 即可。
#[tauri::command]
async fn list_accounts(
    hub: State<'_, HubClient>,
    auth_api: State<'_, Arc<AuthApi>>,
    cache: State<'_, AccountCacheStore>,
    enabled: Option<bool>,
    force: Option<bool>,
) -> Result<Vec<ListAccountsItem>, AuthError> {
    let force = force.unwrap_or(false);
    let profile = auth_api
        .current_session()
        .await?
        .ok_or(AuthError::Unauthenticated)?;
    // user_id ↔ employee_id 边界翻译:同一个 String,只换变量名
    let employee_id = profile.user_id.as_str();

    if !force {
        let rows = cache
            .read_for_employee(employee_id)
            .await
            .map_err(|e| AuthError::Internal {
                message: format!("cache read: {e}"),
            })?;
        if !rows.is_empty() {
            return Ok(filter_rows(rows, enabled));
        }
    }

    // cache miss 或 force:全量拉(无 enabled 过滤),回填 cache,再本地过滤
    let all = hub
        .list_accounts(ListAccountsFilter { enabled: None })
        .await?;
    let rows: Vec<WecomAccountRow> = all
        .iter()
        .cloned()
        .map(|it| item_to_row(it, employee_id))
        .collect();
    cache
        .replace_all_for_employee(employee_id, &rows)
        .await
        .map_err(|e| AuthError::Internal {
            message: format!("cache write: {e}"),
        })?;
    Ok(filter_rows(rows, enabled))
}

fn item_to_row(it: ListAccountsItem, employee_id: &str) -> WecomAccountRow {
    WecomAccountRow {
        wecom_account_id: it.wecom_account_id,
        employee_id: employee_id.to_string(),
        wecom_name: it.wecom_name,
        wecom_account: it.wecom_account,
        wecom_alias: it.wecom_alias,
        wecom_avatar: it.wecom_avatar,
        wecom_status: it.wecom_status,
        gender: it.gender,
        position: it.position,
    }
}

fn row_to_item(r: WecomAccountRow) -> ListAccountsItem {
    ListAccountsItem {
        wecom_account_id: r.wecom_account_id,
        wecom_name: r.wecom_name,
        wecom_account: r.wecom_account,
        wecom_alias: r.wecom_alias,
        wecom_avatar: r.wecom_avatar,
        wecom_status: r.wecom_status,
        gender: r.gender,
        position: r.position,
    }
}

fn filter_rows(rows: Vec<WecomAccountRow>, enabled: Option<bool>) -> Vec<ListAccountsItem> {
    rows.into_iter()
        .filter(|r| enabled.map_or(true, |want| (r.wecom_status == 1) == want))
        .map(row_to_item)
        .collect()
}

/// 按多账号拉取好友(客户)列表 —— 纯 cursor 滚动透传业务后台 keyset 分页。
///
/// 退役全量镜像:不写本地行存,直接 forward。单 cursor 跨账号(`account_ids` 全集合一次提交),
/// 业务后台做 `add_time DESC, id DESC` 全局 keyset,返回 `{records, hasMore, nextCursor}`。
/// 每条 record 自带 `wecomAccountId` 归属(前端多账号合并 chip 数字/显示名直接用)。
///
/// 入参:
///   - `cursor` 缺省 / "" → 首页;续页传上次的 `nextCursor`
///   - `size` 缺省 20,clamp 到 [1, 100]
///   - `external_id` → 名称/手机号统一模糊匹配;空 → 不筛选
///   - `add_start_time` / `add_end_time` → 添加时间范围;空 → 不限
///
/// 切换筛选条件 / 账号集时,前端丢弃旧 cursor 从首页(`cursor=""`)重拉。
#[tauri::command]
async fn list_friends(
    hub: State<'_, HubClient>,
    account_ids: Vec<String>,
    cursor: Option<String>,
    size: Option<u32>,
    external_id: Option<String>,
    add_start_time: Option<String>,
    add_end_time: Option<String>,
) -> Result<ListFriendsResp, AuthError> {
    if account_ids.is_empty() {
        return Ok(ListFriendsResp {
            records: Vec::new(),
            has_more: false,
            next_cursor: String::new(),
        });
    }
    let req = ListFriendsRequest {
        wecom_account_ids: account_ids,
        size: size.unwrap_or(20).clamp(1, 100),
        cursor: cursor.unwrap_or_default(),
        external_id: external_id.filter(|s| !s.is_empty()),
        add_start_time: add_start_time.filter(|s| !s.is_empty()),
        add_end_time: add_end_time.filter(|s| !s.is_empty()),
    };
    hub.list_friends(req).await
}

// ============================== message/history 历史消息 ==============================

/// 拉取一条会话的历史消息(按天分组,cursor 分页)。
///
/// 透传到业务后台 `/wechat-business-app/wecom-cs/v1/wecomAggregate/message/history`。
/// 不入库,不订阅事件 —— 消息历史是临时拉取,数据量大,客户端只缓存当前打开会话的几页。
/// `req.cursor=""` 表示首页;后续传上一次的 `nextCursor`。语义固定 earlier-only,服务端升序返回。
#[tauri::command]
async fn fetch_message_history(
    hub: State<'_, HubClient>,
    req: FetchMessageHistoryRequest,
) -> Result<FetchMessageHistoryResp, AuthError> {
    hub.fetch_message_history(req).await
}

// ============================== message 本地缓存(秒开 + 会话水位门)==============================

/// 缓存优先的消息读取响应:升序 records(早→晚,前端直接渲染)+ 是否还有更老。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CachedMessagesResp {
    records: Vec<HistoryMessage>,
    has_more_older: bool,
}

/// 缓存优先读一条会话首屏 + 会话水位门(决定是否后台重对齐)。
///
/// 流程:
///   1. 解 employee_id(未登录返空,仿 `list_recent_friends`)。
///   2. `touch_accessed` 标热 + `trim_conversations` 整会话 LRU(warn 忽略错)。
///   3. `list_conversation_asc` 取整窗(升序);`get_window` 读水位。整窗返回保证显示尾恒等于
///      window.oldest,`load_older` 翻页永远接得上(不跳段留洞)。`limit` 仅作 reconcile 页大小。
///   4. **会话水位门**:`cache_newest_ms`(window.newest_message_time_ms)对比 recents 行
///      `latest_sort_key_ms`。两者都有且 `cache >= recents > 0` → fresh(零网络);
///      否则后台 spawn `reconcile_newest`(reconcile 完成经 ChangeNotice 通知前端重读)。
///   5. 立即返回缓存升序 records + `has_more_older`(无 window → false)。
#[tauri::command]
async fn load_conversation_messages(
    messages_store: State<'_, MessagesStore>,
    recents_store: State<'_, RecentSessionsStore>,
    message_sync: State<'_, MessageSync>,
    auth_api: State<'_, Arc<AuthApi>>,
    conversation_id: String,
    wecom_account_id: String,
    external_user_id: String,
    limit: Option<u32>,
) -> Result<CachedMessagesResp, AuthError> {
    let employee_id = match auth_api.current_session().await? {
        Some(p) => p.user_id,
        None => {
            return Ok(CachedMessagesResp {
                records: Vec::new(),
                has_more_older: false,
            })
        }
    };
    let limit = limit.unwrap_or(20).clamp(1, 200);

    // 标热 + 整会话 LRU。冷开(无 window)时 touch 是 no-op,reconcile 会建窗。
    if let Err(e) = messages_store
        .touch_accessed(&employee_id, &conversation_id, now_unix_ms())
        .await
    {
        tracing::warn!(target: "chathub::messages", ?e, "touch_accessed failed; ignoring");
    }
    if let Err(e) = messages_store
        .trim_conversations(&employee_id, MESSAGE_HOT_CONVERSATIONS_LIMIT)
        .await
    {
        tracing::warn!(target: "chathub::messages", ?e, "trim_conversations failed; ignoring");
    }

    let rows = messages_store
        .list_conversation_asc(&employee_id, &conversation_id)
        .await
        .map_err(messages_err)?;
    let mut records: Vec<HistoryMessage> = rows.iter().map(row_to_history).collect();

    let window = messages_store
        .get_window(&employee_id, &conversation_id)
        .await
        .map_err(messages_err)?;
    let cache_newest_ms = window.as_ref().map(|w| w.newest_message_time_ms);
    let mut has_more_older = window.as_ref().map(|w| w.has_more_older).unwrap_or(false);

    let recents_latest_ms = recents_store
        .latest_sort_key_ms(&employee_id, &conversation_id)
        .await
        .map_err(messages_err)?;

    // 水位门:缓存覆盖到 recents 权威最新位置 → 零网络;否则对齐。
    let fresh = matches!(
        (cache_newest_ms, recents_latest_ms),
        (Some(c), Some(r)) if r > 0 && c >= r
    );
    // 真冷(无任何缓存行 / 无窗口):同步等一次 reconcile 再返回,使首屏直接带回历史 ——
    // 不依赖"后台 reconcile 完成后发 ChangeNotice → 前端重读"那条路径(该重读受 employeeId
    // 异步解析竞态影响可能丢通知,表现为切会话空、需切走再切回/发送才出历史)。
    // 温缓存(已有行)保持秒开 + 后台对齐(stale-while-revalidate),零延迟回归。
    let is_cold = records.is_empty() || window.is_none();
    if !fresh && is_cold {
        // gRPC forward 隧道无 per-call deadline,必须超时包裹,避免远端慢/挂时卡死命令。
        let outcome = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            message_sync.reconcile_newest(
                &conversation_id,
                &wecom_account_id,
                &external_user_id,
                &employee_id,
                limit,
            ),
        )
        .await;
        match outcome {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                tracing::warn!(target: "chathub::messages", error = %e, "reconcile_newest failed (cold await)");
            }
            Err(_) => {
                tracing::warn!(target: "chathub::messages", "reconcile_newest timed out (cold await)");
            }
        }
        // 无论成功/失败/超时,都重读本地缓存:成功 → 带回历史;失败 → 退回原(可能仍空)缓存,
        // 真空会话合法地显示空态。
        let rows = messages_store
            .list_conversation_asc(&employee_id, &conversation_id)
            .await
            .map_err(messages_err)?;
        records = rows.iter().map(row_to_history).collect();
        has_more_older = messages_store
            .get_window(&employee_id, &conversation_id)
            .await
            .map_err(messages_err)?
            .map(|w| w.has_more_older)
            .unwrap_or(false);
    } else if !fresh {
        let sync = message_sync.inner().clone();
        let conv = conversation_id.clone();
        let wa = wecom_account_id.clone();
        let ext = external_user_id.clone();
        let emp = employee_id.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = sync.reconcile_newest(&conv, &wa, &ext, &emp, limit).await {
                tracing::warn!(target: "chathub::messages", error = %e, "reconcile_newest failed");
            }
        });
    }

    Ok(CachedMessagesResp {
        records,
        has_more_older,
    })
}

/// 往更老翻一页:走网络拉、落库、推进下界 + 游标,返回升序新页(前端 prepend)。
/// 未登录 / 无 window / 无更老 → 空结果。
#[tauri::command]
async fn load_older_messages(
    message_sync: State<'_, MessageSync>,
    auth_api: State<'_, Arc<AuthApi>>,
    conversation_id: String,
    page_size: Option<u32>,
) -> Result<CachedMessagesResp, AuthError> {
    let employee_id = match auth_api.current_session().await? {
        Some(p) => p.user_id,
        None => {
            return Ok(CachedMessagesResp {
                records: Vec::new(),
                has_more_older: false,
            })
        }
    };
    let page_size = page_size.unwrap_or(20).clamp(1, 200);
    let result = message_sync
        .load_older(&conversation_id, &employee_id, page_size)
        .await?;
    Ok(CachedMessagesResp {
        records: result.records,
        has_more_older: result.has_more_older,
    })
}

/// 发送一条文本消息(`messageType=1`):网络发送 → 落库(出站气泡)→ 发 ConversationMessages
/// ChangeNotice。打开着的会话经订阅重读缓存,新气泡随权威列表稳定追加(不再依赖乐观气泡)。
#[tauri::command]
async fn send_message(
    message_sync: State<'_, MessageSync>,
    auth_api: State<'_, Arc<AuthApi>>,
    conversation_id: String,
    wecom_account_id: String,
    external_user_id: String,
    content_text: String,
) -> Result<SendMessageResp, AuthError> {
    let employee_id = auth_api
        .current_session()
        .await?
        .ok_or(AuthError::Unauthenticated)?
        .user_id;
    message_sync
        .send_message(
            &conversation_id,
            &wecom_account_id,
            &external_user_id,
            &employee_id,
            &content_text,
        )
        .await
}

fn messages_err(e: chathub_state::StateError) -> AuthError {
    AuthError::Internal {
        message: format!("messages store: {e}"),
    }
}

fn now_unix_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ============================== session/recentFriends 接待好友列表 ==============================

/// 头部缓存读取上限 —— UI 默认列表最多展示 200 条;尾部走远端 cursor 分页(不写库)。
const RECENT_FRIENDS_LIST_LIMIT: usize = 200;

/// 远端单页拉取的 size 硬顶 —— 纵深防御:前端固定发 20,但渲染进程若被篡改/出 bug
/// 传入超大 size 会放大服务端与网络负载,这里在过线前钳到上限。
const RECENT_FRIENDS_REMOTE_MAX_SIZE: u32 = 100;

/// recents 命令内部错误收敛:底层细节(StateError / SQL)只写本地日志,返回渲染层的
/// message 仅含我们掌控的静态操作名,避免内部实现细节经 IPC 泄露到前端。
fn recents_internal_error(op: &'static str, e: impl std::fmt::Display) -> AuthError {
    tracing::error!(target: "chathub::recents", op, error = %e, "recents command failed");
    AuthError::Internal {
        message: format!("接待列表操作失败: {op}"),
    }
}

/// 仅从本地行存读"接待好友列表"。打开消息页时**优先**调它,秒开。
///
/// 多键 ORDER BY:`pinned DESC, pinned_at_ms DESC, MAX(last_msg_ms, draft_ms) DESC, last_msg_ms DESC`,
/// `account_filter=None` 表示该员工全部账号合并。
/// `employee_id` 来自当前会话,SQL 强制过滤,跨员工不可见。
///
/// **未登录返空,不报错**:本命令是本地缓存读取,未登录(冷启动 try_resume_session 未完成 /
/// 用户登出后)就应该是 0 行,而不是抛 Unauthenticated 让 UI 误报"同步失败"。
/// 防御性已经由 list_top 内部 WHERE employee_id 兜底,即使本地表里有别人的残留行也读不到。
#[tauri::command]
async fn list_recent_friends(
    store: State<'_, RecentSessionsStore>,
    auth_api: State<'_, Arc<AuthApi>>,
    account_filter: Option<String>,
) -> Result<Vec<RecentSessionRow>, AuthError> {
    let employee_id = match auth_api.current_session().await? {
        Some(p) => p.user_id,
        None => return Ok(Vec::new()),
    };
    let filter = account_filter.filter(|s| !s.is_empty());
    store
        .list_top(&employee_id, filter, RECENT_FRIENDS_LIST_LIMIT)
        .await
        .map_err(|e| recents_internal_error("list_top", e))
}

/// 远端拉一页"接待好友列表"。
///   - `persist=true`(通常仅首页 cursor="")→ records 同步 UPSERT 到本地表(仅远端列),
///     成功后 trim 到 `RECENT_SESSIONS_MAX_ROWS` 并 emit `recent_friends_changed`。
///   - `persist=false`(滚动加载更多 / 带筛选的搜索)→ 仅透传响应,不写库不发事件。
///
/// `persist=true` 时,所有 UPSERT 行打上当前 employee_id 标记,trim 也按 employee 维度执行。
#[tauri::command]
async fn list_recent_friends_remote_page(
    app: tauri::AppHandle,
    hub: State<'_, HubClient>,
    store: State<'_, RecentSessionsStore>,
    auth_api: State<'_, Arc<AuthApi>>,
    change_tx: State<'_, tokio_broadcast::Sender<ChangeNotice>>,
    mut req: ListRecentFriendsRequest,
    persist: bool,
) -> Result<ListRecentFriendsResp, AuthError> {
    // 纵深防御:钳制分页 size,挡住超大请求放大服务端/网络负载(前端固定 20)。
    req.size = req.size.clamp(1, RECENT_FRIENDS_REMOTE_MAX_SIZE);
    let resp = hub.list_recent_friends(req).await?;
    if persist && !resp.records.is_empty() {
        let profile = auth_api
            .current_session()
            .await?
            .ok_or(AuthError::Unauthenticated)?;
        let employee_id = profile.user_id.as_str();
        let rows: Vec<_> = resp
            .records
            .iter()
            .cloned()
            .map(|r| record_to_remote(r, employee_id))
            .collect();
        store
            .upsert_remote_many(&rows)
            .await
            .map_err(|e| recents_internal_error("upsert_remote_many", e))?;
        if let Err(e) = store
            .trim(
                employee_id,
                RECENT_SESSIONS_PER_ACCOUNT_LIMIT,
                RECENT_SESSIONS_GLOBAL_LIMIT,
            )
            .await
        {
            tracing::warn!(target: "chathub::recents", ?e, "trim failed; ignoring");
        }
        // C6 单发:仅 ChangeNotice(LocalCommand)。前端 ChangeBus 接收后通知 useResource refetch。
        let _ = change_tx.send(ChangeNotice::command_upsert(
            ChangeTopic::RecentSessions,
            ChangeScope::employee(employee_id),
        ));
        // app 参数仍需保留(命令签名依赖),但 app.emit("recent_friends_changed") 已废弃。
        let _ = app;
    }
    Ok(resp)
}

/// 置顶 / 取消置顶。只动本地列(pinned/pinned_at_ms),严防远端列被覆盖。
/// SQL 同时校验 employee_id,跨员工不可触发(防御 conversation_id 被恶意 / 错误传入)。
/// 成功后 emit `recent_friends_changed`,让前端 refetch 默认列表拿到新顺序。
#[tauri::command]
async fn set_conversation_pinned(
    app: tauri::AppHandle,
    store: State<'_, RecentSessionsStore>,
    auth_api: State<'_, Arc<AuthApi>>,
    change_tx: State<'_, tokio_broadcast::Sender<ChangeNotice>>,
    conversation_id: String,
    pinned: bool,
) -> Result<(), AuthError> {
    let profile = auth_api
        .current_session()
        .await?
        .ok_or(AuthError::Unauthenticated)?;
    let employee_id = profile.user_id.as_str();
    store
        .set_pinned(employee_id, &conversation_id, pinned)
        .await
        .map_err(|e| recents_internal_error("set_pinned", e))?;
    // C6 单发:ChangeNotice(LocalCommand);scope 带 conversation_id 让 ChangeBus 精准 match。
    let _ = change_tx.send(ChangeNotice::command_upsert(
        ChangeTopic::RecentSessions,
        ChangeScope {
            employee_id: employee_id.to_string(),
            conversation_id: Some(conversation_id),
            ..Default::default()
        },
    ));
    let _ = app;
    Ok(())
}

/// 软移除 / 取消移除接待会话(V11)。只动本地列 removed/removed_at_ms。
/// employee_id 由当前会话注入,跨员工 no-op。
/// 成功后 emit `ChangeNotice`,让前端 refetch 默认列表过滤掉/恢复该行。
#[tauri::command]
async fn set_conversation_removed(
    app: tauri::AppHandle,
    store: State<'_, RecentSessionsStore>,
    auth_api: State<'_, Arc<AuthApi>>,
    change_tx: State<'_, tokio_broadcast::Sender<ChangeNotice>>,
    conversation_id: String,
    removed: bool,
) -> Result<(), AuthError> {
    let profile = auth_api
        .current_session()
        .await?
        .ok_or(AuthError::Unauthenticated)?;
    let employee_id = profile.user_id.as_str();
    store
        .set_removed(employee_id, &conversation_id, removed)
        .await
        .map_err(|e| recents_internal_error("set_removed", e))?;
    let _ = change_tx.send(ChangeNotice::command_upsert(
        ChangeTopic::RecentSessions,
        ChangeScope {
            employee_id: employee_id.to_string(),
            conversation_id: Some(conversation_id),
            ..Default::default()
        },
    ));
    let _ = app;
    Ok(())
}

/// 消息免打扰 / 取消免打扰(V12)。只动本地列 muted/muted_at_ms。
/// employee_id 由当前会话注入,跨员工 no-op。muted 不改排序/过滤,仅影响渲染。
/// 成功后 emit `ChangeNotice`,让前端 refetch 默认列表拿到新 muted 态。
#[tauri::command]
async fn set_conversation_muted(
    app: tauri::AppHandle,
    store: State<'_, RecentSessionsStore>,
    auth_api: State<'_, Arc<AuthApi>>,
    change_tx: State<'_, tokio_broadcast::Sender<ChangeNotice>>,
    conversation_id: String,
    muted: bool,
) -> Result<(), AuthError> {
    let profile = auth_api
        .current_session()
        .await?
        .ok_or(AuthError::Unauthenticated)?;
    let employee_id = profile.user_id.as_str();
    store
        .set_muted(employee_id, &conversation_id, muted)
        .await
        .map_err(|e| recents_internal_error("set_muted", e))?;
    let _ = change_tx.send(ChangeNotice::command_upsert(
        ChangeTopic::RecentSessions,
        ChangeScope {
            employee_id: employee_id.to_string(),
            conversation_id: Some(conversation_id),
            ..Default::default()
        },
    ));
    let _ = app;
    Ok(())
}

/// 标记会话已读。用户主动点开有未读的会话时调用。
/// 远端优先:先打业务后台 markRead(失败直接 propagate,前端 toast,红标不动可重试);
/// 成功后本地乐观清零 unread + emit ChangeNotice,让 useResource refetch 后红标消失。
/// `read_sort_key` 恒为 None(= 清零到摘要最后一条),客户端不持有完整复合 sortKey。
#[tauri::command]
async fn mark_conversation_read(
    hub: State<'_, HubClient>,
    store: State<'_, RecentSessionsStore>,
    auth_api: State<'_, Arc<AuthApi>>,
    change_tx: State<'_, tokio_broadcast::Sender<ChangeNotice>>,
    conversation_id: String,
) -> Result<(), AuthError> {
    let profile = auth_api
        .current_session()
        .await?
        .ok_or(AuthError::Unauthenticated)?;
    let employee_id = profile.user_id.as_str();
    hub.mark_read(MarkReadRequest {
        conversation_id: conversation_id.clone(),
        read_sort_key: None,
    })
    .await?;
    store
        .clear_unread(employee_id, &conversation_id)
        .await
        .map_err(|e| recents_internal_error("clear_unread", e))?;
    let _ = change_tx.send(ChangeNotice::command_upsert(
        ChangeTopic::RecentSessions,
        ChangeScope {
            employee_id: employee_id.to_string(),
            conversation_id: Some(conversation_id),
            ..Default::default()
        },
    ));
    Ok(())
}

/// 草稿写入(V10):text="" 清空,非空保存为草稿。ChatArea 输入框 debounce 后调一次。
/// 只动本地列 + employee_id 校验。
#[tauri::command]
async fn set_conversation_draft(
    app: tauri::AppHandle,
    store: State<'_, RecentSessionsStore>,
    auth_api: State<'_, Arc<AuthApi>>,
    change_tx: State<'_, tokio_broadcast::Sender<ChangeNotice>>,
    conversation_id: String,
    text: String,
) -> Result<(), AuthError> {
    let profile = auth_api
        .current_session()
        .await?
        .ok_or(AuthError::Unauthenticated)?;
    let employee_id = profile.user_id.as_str();
    store
        .set_draft(employee_id, &conversation_id, &text)
        .await
        .map_err(|e| recents_internal_error("set_draft", e))?;
    // C6 单发:ChangeNotice(LocalCommand)。
    let _ = change_tx.send(ChangeNotice::command_upsert(
        ChangeTopic::RecentSessions,
        ChangeScope {
            employee_id: employee_id.to_string(),
            conversation_id: Some(conversation_id),
            ..Default::default()
        },
    ));
    let _ = app;
    Ok(())
}

// ============================== run() ==============================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let log_dir = app.path().app_log_dir()?;
            let guard = logging::init(&log_dir)
                .map_err(|e| Box::<dyn std::error::Error>::from(e.to_string()))?;
            app.manage(guard);
            info!(?log_dir, "tracing initialised");

            // 按显示器分辨率自适应窗口:取屏幕逻辑尺寸 80%,clamp 到 [min, 上限],居中后再显示。
            // config 里窗口设为 visible:false,在此调好尺寸再 show(),避免先弹出默认尺寸再缩放的闪烁。
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(Some(monitor)) = window.current_monitor() {
                    let scale = monitor.scale_factor();
                    let screen = monitor.size(); // 物理像素
                    let sw = screen.width as f64 / scale; // → 逻辑像素
                    let sh = screen.height as f64 / scale;
                    let w = (sw * 0.8).clamp(860.0, 1600.0);
                    let h = (sh * 0.8).clamp(600.0, 1100.0);
                    let _ = window.set_size(LogicalSize::new(w, h));
                    let _ = window.center();
                }
                let _ = window.show();
            }

            // ---- Plan 2:接入 chathub-net auth 链路 ----
            let app_data = app.path().app_data_dir()?;
            let app_handle = app.handle().clone();

            // tauri::async_runtime::block_on 在 setup 同步完成 SQLite 与 endpoint 初始化。
            // setup 闭包本身不在 async 上下文,block_on 安全可用。
            let (auth_api, hub_client, conn_manager, account_cache, recents_store, messages_store, message_sync, change_notice_tx) = tauri::async_runtime::block_on(async {
                std::fs::create_dir_all(&app_data).ok();
                let pool = SqlitePool::open(app_data.join("state.sqlite"))
                    .await.map_err(|e| e.to_string())?;
                let session_store = SessionStore::new(pool.clone());
                let notify_seq_store = NotifySeqStore::new(pool.clone());
                let account_cache = AccountCacheStore::new(pool.clone());
                let friends_store = FriendsStore::new(pool.clone());
                let recents_store = RecentSessionsStore::new(pool.clone());
                let messages_store = MessagesStore::new(pool.clone());
                let local_store = LocalTokenStore::new(pool);
                // device_id 从本地 SQLite 取(首次启动生成),不再用 macOS 钥匙串。
                let device_id = local_store.ensure_device_id()
                    .await.map_err(|e| format!("device_id: {e}"))?;
                let endpoint = chathub_net::build_endpoint(chathub_net::RELAY_URL)
                    .map_err(|e| format!("endpoint: {e}"))?;
                let channel = endpoint.connect_lazy();
                let token_store = Arc::new(TokenStore::new(endpoint, local_store, device_id.clone()));
                let interceptor = AuthInterceptor::new(token_store.clone());
                let hub_client = HubClient::new(channel, interceptor);
                // C1+C2 统一变更通知通道 —— 由 setup 阶段创建,在所有 applier 与 ConnectionManager
                // 之间共享。256 buffer 同 hub.event_tx,够事件风暴使用。
                let (change_notice_tx, _) = broadcast_channel::<ChangeNotice>(256);
                // 消息页"缓存优先 + 后台重对齐"编排器(读 messages_store / 拉 hub / 发 ChangeNotice)。
                let message_sync = MessageSync::new(
                    messages_store.clone(),
                    hub_client.clone(),
                    change_notice_tx.clone(),
                );
                // 2026-05-17:Subscribe 流里 ACCOUNT_* 事件 → AccountCacheStore + broadcast。
                let account_applier = Arc::new(AccountEventApplier::new(
                    account_cache.clone(),
                    hub_client.clone(),
                    change_notice_tx.clone(),
                ));
                // 阶段 2:Subscribe 流里 FRIEND_* 事件 → 推进 watermark + broadcast(无本地行存)。
                let friend_applier = Arc::new(FriendEventApplier::new(
                    friends_store,
                    change_notice_tx.clone(),
                ));
                // 阶段 3:Subscribe 流里 MESSAGE_UPSERT / SESSION_SUMMARY_UPSERT → RecentSessionsStore + broadcast。
                let recent_applier = Arc::new(RecentSessionEventApplier::new(
                    recents_store.clone(),
                    hub_client.clone(),
                    change_notice_tx.clone(),
                ));
                // 阶段 4:Subscribe 流里 MESSAGE_UPSERT → MessagesStore 气泡 + broadcast。
                let message_applier = Arc::new(MessageEventApplier::new(
                    messages_store.clone(),
                    message_sync.clone(),
                    change_notice_tx.clone(),
                ));
                let conn_manager = Arc::new(ConnectionManager::new(
                    hub_client.clone(),
                    token_store.clone(),
                    notify_seq_store,
                    device_id,
                    env!("CARGO_PKG_VERSION").to_string(),
                    BackoffConfig::default(),
                    Some(account_applier),
                    Some(friend_applier),
                    Some(recent_applier),
                    Some(message_applier),
                    change_notice_tx.clone(),
                ));
                let auth_api = AuthApi::new(token_store, session_store);
                Ok::<_, String>((auth_api, hub_client, conn_manager, account_cache, recents_store, messages_store, message_sync, change_notice_tx))
            }).map_err(Box::<dyn std::error::Error>::from)?;
            let auth_api = Arc::new(auth_api);
            app.manage(Arc::clone(&auth_api));
            app.manage(hub_client);
            app.manage(Arc::clone(&conn_manager));
            app.manage(account_cache);
            app.manage(recents_store);
            app.manage(messages_store);
            app.manage(message_sync);
            // change_notice_tx 也 manage 一份,Tauri 命令(pin/draft 等)用它直接发 LocalCommand 通知
            app.manage(change_notice_tx);

            // 启动时 try_resume(后台 task,不阻塞 setup);成功后启动 ConnectionManager
            let api_for_resume = Arc::clone(&auth_api);
            let cm_for_resume = Arc::clone(&conn_manager);
            tauri::async_runtime::spawn(async move {
                match api_for_resume.try_resume_session().await {
                    Ok(Some(p)) => {
                        info!(target: "chathub::auth", user_id = %p.user_id, "resumed session");
                        cm_for_resume.start().await;
                    }
                    Ok(None)    => info!(target: "chathub::auth", "no session to resume"),
                    Err(e)      => tracing::warn!(target: "chathub::auth", error = %e, "try_resume_session failed"),
                }
            });

            // LoggedOut 事件桥接
            let mut rx = auth_api.logged_out_subscribe();
            let app_for_event = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                while let Ok(reason) = rx.recv().await {
                    let kind = match reason {
                        LoggedOutReason::Manual       => "manual",
                        LoggedOutReason::TokenInvalid => "token-invalid",
                        LoggedOutReason::Kicked       => "kicked",
                    };
                    let _ = app_for_event.emit("auth:logged_out", serde_json::json!({ "reason": kind }));
                }
            });

            // ---- Plan 3:hub:event 桥接(broadcast<ServerEvent> → app.emit) ----
            let cm_for_event = Arc::clone(&conn_manager);
            let auth_for_kicked = Arc::clone(&auth_api);
            let app_for_hub_event = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                let mut rx = cm_for_event.event_subscribe();
                let mut last_lag_reconnect: Option<Instant> = None;
                loop {
                    match rx.recv().await {
                        Ok(event) => {
                            // Plan 7 — KICKED 已删,业务后台用 CONNECTION_FORCE_CLOSE event 通知。
                            // SubscribeAck / PushBatchOut / SystemSignal 都直接 emit 给前端,
                            // 前端按 body 解构(force_close 事件在 PushBatchOut.events_json 里)。
                            let _ = app_for_hub_event.emit("hub:event", &event);
                            // 也保留对 logout 的钩子(LoggedOutReason via TokenStore broadcast)
                            let _ = &auth_for_kicked; // silence unused
                        }
                        Err(tokio_broadcast::error::RecvError::Lagged(n)) => {
                            let now = Instant::now();
                            if last_lag_reconnect.map_or(true, |t| now.duration_since(t) > Duration::from_secs(5)) {
                                tracing::warn!(target: "chathub::hub", skipped = n, "hub event lag, requesting reconnect");
                                cm_for_event.stop().await;
                                cm_for_event.start().await;
                                last_lag_reconnect = Some(now);
                            } else {
                                tracing::warn!(target: "chathub::hub", skipped = n, "hub event lag throttled");
                            }
                        }
                        Err(tokio_broadcast::error::RecvError::Closed) => break,
                    }
                }
            });

            // ---- Plan 3:hub:connection 桥接(watch<ConnectionState> → app.emit) ----
            let cm_for_state = Arc::clone(&conn_manager);
            let app_for_state = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                let mut rx = cm_for_state.state_subscribe();
                // 主动 emit 一次初始态(watch::Receiver::changed 不会 fire 第一次值)
                let _ = app_for_state.emit("hub:connection", &*rx.borrow());
                while rx.changed().await.is_ok() {
                    let s = rx.borrow().clone();
                    let _ = app_for_state.emit("hub:connection", &s);
                }
            });

            // ---- C6 拆双发后:accounts_changed / friends_changed / recent_friends_changed
            // 这 3 条旧通道全部下线,统一走 hub:change(下面那段)。前端 hook 也都已迁移
            // 到 useResource + ChangeBus,不再 listen 旧名。

            // ---- C3:hub:change 桥接(统一变更通知通道) ----
            // 所有 applier / 用户命令 / resync 都通过 change_notice_tx 发 ChangeNotice;
            // 前端 ChangeBus 全局 listen("hub:change") 后按 topic+scope 分发给 useResource。
            // 注意:本通道在 C2-C5 期间与旧的 accounts_changed / friends_changed /
            // recent_friends_changed 双发存在,C6 拆除旧通道。
            let mut change_rx = conn_manager.change_notice_subscribe();
            let app_for_change = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    match change_rx.recv().await {
                        Ok(notice) => {
                            let _ = app_for_change.emit("hub:change", &notice);
                        }
                        Err(tokio_broadcast::error::RecvError::Lagged(n)) => {
                            tracing::warn!(target: "chathub::change", skipped = n, "hub:change lagged");
                        }
                        Err(tokio_broadcast::error::RecvError::Closed) => break,
                    }
                }
            });

            // ---- R1:hub:resync 桥接 ----
            // ConnectionManager 在 SubscribeAck.resync_required=true 或
            // SystemSignal::ResyncRequired 时 broadcast ResyncSignal,这里 emit 给前端。
            // 前端 useRecentFriends 收事件后调一次 refreshFirstPage 全量对齐。
            let mut resync_rx = conn_manager.resync_subscribe();
            let app_for_resync = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    match resync_rx.recv().await {
                        Ok(signal) => {
                            let _ = app_for_resync.emit("hub:resync", &signal);
                        }
                        Err(tokio_broadcast::error::RecvError::Lagged(n)) => {
                            tracing::warn!(target: "chathub::resync", skipped = n, "hub:resync lagged");
                        }
                        Err(tokio_broadcast::error::RecvError::Closed) => break,
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet, take_screenshot,
            login, logout, current_session,
            hub_forward, hub_ack, hub_state, list_accounts, list_friends,
            list_recent_friends, list_recent_friends_remote_page,
            set_conversation_pinned, set_conversation_draft, set_conversation_removed,
            set_conversation_muted, mark_conversation_read,
            fetch_message_history,
            load_conversation_messages, load_older_messages, send_message,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// 编译期烟雾测试在 Plan 2 起被实际通信代码替代,删除占位。
