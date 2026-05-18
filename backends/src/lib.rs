mod logging;

use serde::Serialize;
use std::sync::Arc;
use tauri::{Emitter, Manager, State};
use tracing::info;

use chathub_net::{
    friend_to_row, AccountEventApplier, AuthApi, AuthError, AuthInterceptor, BackoffConfig,
    ConnectionManager, ConnectionState, FriendEventApplier, HubClient, ListAccountsFilter,
    ListAccountsItem, LoggedOutReason, TokenStore,
};
use chathub_proto::v1::UserProfile;
use chathub_state::{
    AccountCacheStore, FriendsStore, LocalTokenStore, NotifySeqStore, SessionStore, SqlitePool,
    WecomAccountRow, WecomFriendRow,
};
use std::time::{Duration, Instant};
use tokio::sync::broadcast as tokio_broadcast;

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
    info!(target: "chathub::cmd", %username, "login command invoked");
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
        // F6: Bytes → String,只在 Tauri command 出口转一次
        body_json: String::from_utf8(resp.body_json.to_vec()).unwrap_or_default(),
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
        .filter(|r| enabled.is_none_or(|want| (r.wecom_status == 1) == want))
        .map(row_to_item)
        .collect()
}

/// 全量同步 TTL:10 分钟。事件 keep data fresh,TTL 只是兜底防"长时间无事件时数据陈旧"。
const FRIENDS_FULL_SYNC_TTL_MS: i64 = 10 * 60 * 1000;

/// 按多账号拉取好友(客户)列表 —— 返回**全量**(单账号 / 多账号合并)行,带 `wecomAccountId` 归属。
///
/// 流程:
///   1) 对每个账号判 `FriendsStore::is_fresh(FRIENDS_FULL_SYNC_TTL_MS)`,失效 / `force=true` 时
///      调 `HubClient::list_all_friends_for_account` 循环拉所有页 → 转 row → `replace_all_for_account`
///      → `mark_synced`。
///   2) 从 SQLite 行存读所有选中账号的全量行(带 wecom_account_id 归属)。
///
/// 入参不再有 `current / external_name / external_mobile / add_start_time / add_end_time / size` ——
/// 这些都成为前端本地操作(`useCustomersFilters` 在内存里分页/筛选)。
#[tauri::command]
async fn list_friends(
    hub: State<'_, HubClient>,
    store: State<'_, FriendsStore>,
    auth_api: State<'_, Arc<AuthApi>>,
    account_ids: Vec<String>,
    force: Option<bool>,
) -> Result<Vec<WecomFriendRow>, AuthError> {
    let force = force.unwrap_or(false);
    let profile = auth_api
        .current_session()
        .await?
        .ok_or(AuthError::Unauthenticated)?;
    let employee_id = profile.user_id.as_str();

    // 1) 按账号判 fresh,失效的远程拉全量并入库
    for acct in &account_ids {
        let fresh = store
            .is_fresh(acct, FRIENDS_FULL_SYNC_TTL_MS)
            .await
            .map_err(|e| AuthError::Internal {
                message: format!("friends is_fresh: {e}"),
            })?;
        if force || !fresh {
            let friends = hub.list_all_friends_for_account(acct).await?;
            let rows: Vec<WecomFriendRow> = friends
                .into_iter()
                .map(|f| friend_to_row(f, acct))
                .collect();
            let total = rows.len() as u64;
            store
                .replace_all_for_account(acct, &rows)
                .await
                .map_err(|e| AuthError::Internal {
                    message: format!("friends replace_all: {e}"),
                })?;
            store
                .mark_synced(acct, employee_id, total)
                .await
                .map_err(|e| AuthError::Internal {
                    message: format!("friends mark_synced: {e}"),
                })?;
        }
    }

    // 2) 从 SQLite 读所有选中账号的全量行
    store
        .read_for_account_ids(&account_ids)
        .await
        .map_err(|e| AuthError::Internal {
            message: format!("friends read: {e}"),
        })
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

            // ---- Plan 2:接入 chathub-net auth 链路 ----
            let app_data = app.path().app_data_dir()?;
            let app_handle = app.handle().clone();

            // tauri::async_runtime::block_on 在 setup 同步完成 SQLite 与 endpoint 初始化。
            // setup 闭包本身不在 async 上下文,block_on 安全可用。
            let (auth_api, hub_client, conn_manager, account_cache, friends_store) = tauri::async_runtime::block_on(async {
                std::fs::create_dir_all(&app_data).ok();
                let pool = SqlitePool::open(app_data.join("state.sqlite"))
                    .await.map_err(|e| e.to_string())?;
                let session_store = SessionStore::new(pool.clone());
                let notify_seq_store = NotifySeqStore::new(pool.clone());
                let account_cache = AccountCacheStore::new(pool.clone());
                let friends_store = FriendsStore::new(pool.clone());
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
                // 2026-05-17:Subscribe 流里 ACCOUNT_* 事件 → AccountCacheStore + broadcast。
                let account_applier = Arc::new(AccountEventApplier::new(
                    account_cache.clone(),
                    hub_client.clone(),
                ));
                // 阶段 2:Subscribe 流里 FRIEND_* 事件 → FriendsStore 行存 + broadcast。
                let friend_applier = Arc::new(FriendEventApplier::new(
                    friends_store.clone(),
                    hub_client.clone(),
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
                ));
                let auth_api = AuthApi::new(token_store, session_store);
                Ok::<_, String>((auth_api, hub_client, conn_manager, account_cache, friends_store))
            }).map_err(Box::<dyn std::error::Error>::from)?;
            let auth_api = Arc::new(auth_api);
            app.manage(Arc::clone(&auth_api));
            app.manage(hub_client);
            app.manage(Arc::clone(&conn_manager));
            app.manage(account_cache);
            app.manage(friends_store);

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

            // ---- 2026-05-17:accounts_changed 桥接(broadcast<AccountChanged> → app.emit) ----
            // Subscribe 流里 ACCOUNT_BINDING_CHANGE 事件被 AccountEventApplier 写完 cache 后
            // broadcast 出来,这里 emit 给前端;前端 useAccounts 收到事件后 refetch(读 cache)。
            if let Some(mut rx) = conn_manager.account_event_subscribe() {
                let app_for_account = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        match rx.recv().await {
                            Ok(change) => {
                                let _ = app_for_account.emit("accounts_changed", &change);
                            }
                            Err(tokio_broadcast::error::RecvError::Lagged(n)) => {
                                tracing::warn!(target: "chathub::accounts", skipped = n, "accounts_changed lagged");
                            }
                            Err(tokio_broadcast::error::RecvError::Closed) => break,
                        }
                    }
                });
            }

            // ---- 阶段 2:friends_changed 桥接(broadcast<FriendChanged> → app.emit) ----
            // Subscribe 流里 FRIEND_BINDING_CHANGE 事件被 FriendEventApplier 写完行存后
            // broadcast 出来,这里 emit 给前端;前端 useFriends 收到事件后 refetch(读行存)。
            if let Some(mut rx) = conn_manager.friend_event_subscribe() {
                let app_for_friends = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        match rx.recv().await {
                            Ok(change) => {
                                let _ = app_for_friends.emit("friends_changed", &change);
                            }
                            Err(tokio_broadcast::error::RecvError::Lagged(n)) => {
                                tracing::warn!(target: "chathub::friends", skipped = n, "friends_changed lagged");
                            }
                            Err(tokio_broadcast::error::RecvError::Closed) => break,
                        }
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet, take_screenshot,
            login, logout, current_session,
            hub_forward, hub_ack, hub_state, list_accounts, list_friends,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// 编译期烟雾测试在 Plan 2 起被实际通信代码替代,删除占位。
