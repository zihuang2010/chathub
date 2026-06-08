mod ai_polish;
mod image_cache;
mod image_prefetch;
mod logging;
mod media;

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, LogicalSize, Manager, State, WindowEvent};
use tracing::{info, warn};

use chathub_net::{
    record_to_remote, row_to_history, to_local_direction, AccountEventApplier, AuthApi, AuthError,
    AuthInterceptor, BackoffConfig, ChangeCoalescer, ChangeNotice, ChangeScope, ChangeSource,
    ChangeTopic, ConnectionManager, ConnectionState, FetchMessageHistoryRequest,
    FetchMessageHistoryResp, FriendDetailRequest, FriendEventApplier, HistoryMessage, HubClient,
    ListAccountsFilter, ListAccountsItem, ListFriendsRequest, ListFriendsResp,
    ListRecentFriendsRequest, ListRecentFriendsResp, LoggedOutReason, MarkReadRequest,
    MessageEventApplier, MessageSync, OssUploader, RecentFriendRecord, RecentSessionEventApplier,
    SendMessageResp, TokenStore, UploadedAttachment, WecomFriendDetail,
};
use chathub_proto::v1::UserProfile;
use chathub_state::{
    AccountCacheStore, FriendDetailCacheStore, ImageMetaStore, LocalTokenStore, MessagesStore,
    NotifySeqStore, QuarantinedEventsStore, QuickRepliesStore, QuickReplyRow, RecentSessionRow,
    RecentSessionsStore, SessionStore, SqlitePool, WecomAccountRow,
    MESSAGE_HOT_CONVERSATIONS_LIMIT, RECENT_SESSIONS_GLOBAL_LIMIT,
    RECENT_SESSIONS_PER_ACCOUNT_LIMIT,
};
use std::time::Duration;
use tokio::sync::broadcast as tokio_broadcast;
use tokio::sync::broadcast::channel as broadcast_channel;

/// 「关闭到托盘」开关:点关闭按钮只隐藏主窗口,只有托盘菜单「退出」置位后才放行真正关闭。
static QUITTING: AtomicBool = AtomicBool::new(false);

/// 托盘图标闪烁开关:有未读且窗口未获焦时为 true,闪烁线程据此在 normal↔dim 间交替。
/// 由 set_tray_unread 命令启停,前端在收消息/失焦/获焦时驱动。
static BLINKING: AtomicBool = AtomicBool::new(false);

/// 托盘图标闪烁周期(毫秒)。
const TRAY_BLINK_INTERVAL_MS: u64 = 500;

/// 托盘图标的两态:正常 + 暗淡(闪烁用)。暗淡版 = 正常图整体 alpha 降到 ~25% 的「呼吸」帧,
/// 闪烁线程在两态间交替。不用全透明帧——Windows 托盘对「整帧 alpha 全 0」会忽略 alpha、渲染成黑块。
struct TrayIcons {
    normal: tauri::image::Image<'static>,
    dim: tauri::image::Image<'static>,
}

/// 解码打包的 128x128 托盘图标,合成「正常」与「暗淡」两态(供闪烁线程交替)。
/// 用 128 而非 32:Mac 菜单栏 Retina 按 ~44px(@2x) 渲染、Win 高 DPI 托盘亦 >32px,
/// 喂 32px 会被放大发糊;128 留足余量由系统下采样,清晰且体积可忽略。
/// 暗淡版 = 正常图保持 alpha 轮廓不变、仅整体 alpha 缩到 ~25%,呈「淡入淡出」式呼吸闪烁;
/// 既不用全透明(Windows 托盘对全 0 alpha 帧渲染成黑块),也不压暗 RGB(同样发黑)。
/// 注意:tauri 的 Image::from_bytes 受 image-png feature 门控(本项目未开),故直接用 image crate 解码,
/// 再走 Image::new_owned(RGBA) 构造,绕开该 feature 依赖。
fn build_tray_icons() -> TrayIcons {
    const RAW: &[u8] = include_bytes!("../icons/128x128.png");
    let base = image::load_from_memory(RAW)
        .expect("decode tray icon 128x128.png")
        .to_rgba8();
    let (w, h) = base.dimensions();
    let normal = tauri::image::Image::new_owned(base.clone().into_raw(), w, h);
    // 暗淡帧:仅把每个像素的 alpha 缩到 25%(RGB 不动 → 不会发黑;透明区仍透明)。
    // 与 normal 交替即「呼吸」式闪烁;0.25 可按观感微调。
    let mut dimmed = base;
    for px in dimmed.pixels_mut() {
        px[3] = (px[3] as f32 * 0.25) as u8;
    }
    let dim = tauri::image::Image::new_owned(dimmed.into_raw(), w, h);
    TrayIcons { normal, dim }
}

/// 从托盘恢复主窗口:先 unminimize(Windows 上最小化窗口 is_visible 仍为 true,只 show 不够),
/// 再 show + set_focus。托盘左键与「打开主窗口」菜单共用。
fn restore_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// 前端按未读总数启停托盘图标闪烁 + 同步 tooltip。count>0 启动闪烁,count<=0 停闪复原。
/// 关到托盘后无任务栏按钮可闪,托盘图标闪烁是唯一可见提醒,故由前端在收消息/失焦/获焦时调用。
/// 图标视觉由闪烁线程负责(见 setup),本命令只翻转 BLINKING 开关并设 tooltip。
#[tauri::command]
fn set_tray_unread(tray: State<'_, tauri::tray::TrayIcon>, count: i64) -> Result<(), String> {
    let tip = if count > 0 {
        BLINKING.store(true, Ordering::SeqCst);
        format!("ChatHub · {count} 条新消息")
    } else {
        BLINKING.store(false, Ordering::SeqCst);
        "ChatHub".to_string()
    };
    tray.set_tooltip(Some(tip)).map_err(|e| e.to_string())?;
    Ok(())
}

// ============================== 现有命令保留 ==============================

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

/// 读取 tauri-plugin-screenshots 抓屏后落盘的 PNG,返回 base64 供前端框选裁剪。
/// 抓屏全程在原生插件(xcap)完成;这里只把整屏图喂回 webview——避免 asset 协议
/// scope/canvas 跨域污染等运行时坑,直接走 data URL 最稳。
/// 防越权:仅允许读插件产出目录下的 png(路径须含 "tauri-plugin-screenshots" 且以 ".png" 结尾)。
#[tauri::command]
async fn read_screenshot_file(path: String) -> Result<String, String> {
    use base64::engine::general_purpose::STANDARD as BASE64;
    use base64::Engine;

    let lower = path.to_lowercase();
    if !path.contains("tauri-plugin-screenshots") || !lower.ends_with(".png") {
        return Err("非法的截图路径".to_string());
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("读取截图失败: {e}"))?;
    if bytes.is_empty() {
        return Err("截图结果为空".to_string());
    }
    Ok(BASE64.encode(bytes))
}

// ============================== Plan 2:Auth 命令 ==============================

#[tauri::command]
async fn login(
    state: State<'_, Arc<AuthApi>>,
    cm: State<'_, Arc<ConnectionManager>>,
    username: String,
    password: String,
) -> Result<UserProfile, AuthError> {
    // 不打印 username(PII):成功/失败路径均不记录账号,仅记录错误原因以便排查认证问题。
    info!(target: "chathub::cmd", "login command invoked");
    let profile = match state.login(&username, &password).await {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(target: "chathub::cmd", error = %e, "login command failed");
            return Err(e);
        }
    };
    // S1:强制干净重连。直接 start() 有幂等陷阱——run_loop 仍存活时 start() 静默 return,
    // 重/二次登录变空操作且日志误导。先 stop()(abort 旧 task + 置 Disconnected)再 start()。
    // stop/start 共用 task mutex 串行,不会产生双 run_loop;abort 可能切断正在 apply 的批,
    // 靠四个 applier 同 seq 重投幂等兜底(见 spec §4.3 / P1 applier 核验)。
    cm.stop().await;
    cm.start().await;
    info!(target: "chathub::cmd", user_id = %profile.user_id, "login command ok, ConnectionManager reconnected");
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
///   - `account_ids` 为空 → 全量拉取:请求体省略 `wecomAccountIds`,业务后台按登录账号 token 圈定;
///     非空 → 按该账号子集过滤
///   - `cursor` 缺省 / "" → 首页;续页传上次的 `nextCursor`
///   - `size` 缺省 20,clamp 到 [1, 100]
///   - `external_name` → 按名称模糊匹配;空 → 不筛选
///   - `add_start_time` / `add_end_time` → 添加时间范围;空 → 不限
///
/// 切换筛选条件 / 账号集时,前端丢弃旧 cursor 从首页(`cursor=""`)重拉。
#[tauri::command]
async fn list_friends(
    hub: State<'_, HubClient>,
    account_ids: Vec<String>,
    cursor: Option<String>,
    size: Option<u32>,
    external_name: Option<String>,
    add_start_time: Option<String>,
    add_end_time: Option<String>,
) -> Result<ListFriendsResp, AuthError> {
    // account_ids 为空 = 全量拉取:请求体省略 wecomAccountIds,业务后台按登录账号 token 圈定。
    // 非空则按该子集过滤。两种情况都透传 forward,不在此短路。
    let req = ListFriendsRequest {
        wecom_account_ids: account_ids,
        size: size.unwrap_or(20).clamp(1, 100),
        cursor: cursor.unwrap_or_default(),
        external_name: external_name.filter(|s| !s.is_empty()),
        add_start_time: add_start_time.filter(|s| !s.is_empty()),
        add_end_time: add_end_time.filter(|s| !s.is_empty()),
        total_mode: "none".into(),
    };
    hub.list_friends(req).await
}

// ============================== friend/detail 好友详情 ==============================

/// 拉取单个外部联系人的好友详情。
///
/// 当天(本地日历日)缓存落 `hub_friend_detail_cache`:
///   - 非强制且命中当天缓存 → 直接返回本地,零远程往返;
///   - 强制刷新 / 未命中 / 跨天 → 透传业务后台 `/wecomAggregate/friend/detail` 重拉并覆盖缓存。
/// `is_force_refresh=true` 同时打破业务后台一天一次的自动刷新限制。
/// 缓存读写均为 best-effort:失败(含 JSON 损坏)只降级走远程 / 记日志,不影响本次取数。
#[tauri::command]
async fn friend_detail(
    hub: State<'_, HubClient>,
    cache: State<'_, FriendDetailCacheStore>,
    wecom_account_id: String,
    external_user_id: String,
    is_force_refresh: Option<bool>,
) -> Result<WecomFriendDetail, AuthError> {
    let force = is_force_refresh.unwrap_or(false);

    // 非强制:命中当天缓存即返回本地。缓存读取失败 / JSON 损坏均降级走远程。
    if !force {
        if let Ok(Some(json)) = cache
            .get_fresh_today(&wecom_account_id, &external_user_id)
            .await
        {
            if let Ok(detail) = serde_json::from_str::<WecomFriendDetail>(&json) {
                return Ok(detail);
            }
        }
    }

    // 远程拉取(强制 / 未命中 / 跨天 / 缓存损坏)。
    let req = FriendDetailRequest {
        wecom_account_id: wecom_account_id.clone(),
        external_user_id: external_user_id.clone(),
        is_force_refresh: force,
    };
    let detail = hub.friend_detail(req).await?;

    // best-effort 写缓存:失败仅记日志,不影响本次返回。
    match serde_json::to_string(&detail) {
        Ok(json) => {
            if let Err(e) = cache
                .upsert(&wecom_account_id, &external_user_id, &json)
                .await
            {
                tracing::warn!(target: "chathub::cmd", error = %e, "friend_detail 写缓存失败");
            }
        }
        Err(e) => {
            tracing::warn!(target: "chathub::cmd", error = %e, "friend_detail 序列化缓存失败");
        }
    }

    Ok(detail)
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

/// 缓存优先的消息读取响应:升序 records(早→晚,前端直接渲染)+ 是否还有更老/更新。
/// `has_more_newer` 仅窗口化读(`load_cached_window`)会置真;整窗读(`load_conversation_messages`)
/// 与往旧翻(`load_older_messages`)恒为 false(整窗已含到缓存最新,无更新可翻),前端可选字段向后兼容。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CachedMessagesResp {
    records: Vec<HistoryMessage>,
    has_more_older: bool,
    has_more_newer: bool,
}

/// 缓存优先读一条会话首屏 + 会话水位门(决定是否后台重对齐)。
///
/// 流程:
/// 会话历史是否需要 reconcile(安全网 #3,spec §6.4-3)。
/// `force=true`(resync 对当前打开会话)无视水位门 fresh 恒返 true(强制同步绕门对齐);
/// 否则维持原水位门语义(fresh → 不 reconcile,否则需 reconcile,冷/温由调用方另行分流)。
fn should_reconcile_conv_messages(force: bool, fresh: bool, _is_cold: bool) -> bool {
    force || !fresh
}

///   1. 解 employee_id(未登录返空,仿 `list_recent_friends`)。
///   2. `touch_accessed` 标热 + `trim_conversations` 整会话 LRU(warn 忽略错)。
///   3. `list_conversation_asc` 取整窗(升序);`get_window` 读水位。整窗返回保证显示尾恒等于
///      window.oldest,`load_older` 翻页永远接得上(不跳段留洞)。`limit` 仅作 reconcile 页大小。
///   4. **会话水位门**:`cache_newest_ms`(window.newest_message_time_ms)对比 recents 行
///      `latest_sort_key_ms`。两者都有且 `cache >= recents > 0` → fresh(零网络);
///      否则后台 spawn `reconcile_newest`(reconcile 完成经 ChangeNotice 通知前端重读)。
///      `force=true`(resync 路径)绕过 fresh 门,强制一次同步 reconcile。
///   5. 立即返回缓存升序 records + `has_more_older`(无 window → false)。
// 入参均为 Tauri State 注入 + IPC 透传字段;拆参会破坏 #[tauri::command] 命令签名与前端
// 调用约定,故按 clippy 推荐豁免(该函数早因图片预取参数由 8→9 参越阈,属既有问题)。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn load_conversation_messages(
    messages_store: State<'_, MessagesStore>,
    recents_store: State<'_, RecentSessionsStore>,
    message_sync: State<'_, MessageSync>,
    auth_api: State<'_, Arc<AuthApi>>,
    image_prefetcher: State<'_, image_prefetch::ImagePrefetcher>,
    conversation_id: String,
    wecom_account_id: String,
    external_user_id: String,
    limit: Option<u32>,
    force: Option<bool>,
) -> Result<CachedMessagesResp, AuthError> {
    let employee_id = match auth_api.current_session().await? {
        Some(p) => p.user_id,
        None => {
            return Ok(CachedMessagesResp {
                records: Vec::new(),
                has_more_older: false,
                has_more_newer: false,
            })
        }
    };
    let limit = limit.unwrap_or(20).clamp(1, 200);
    let force = force.unwrap_or(false);

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
    let gate_decision = if force {
        "force:resync 绕水位门→同步reconcile"
    } else if fresh {
        "fresh:零网络命中"
    } else if is_cold {
        "not-fresh:冷会话→同步reconcile"
    } else {
        "not-fresh:温缓存→后台reconcile"
    };
    // 会话水位门判定全过程日志:c=缓存窗最新(cache_newest_ms),r=recents 行最新(recents_latest_ms);
    // fresh ⇔ 两者都有值 且 r>0 且 c>=r。fresh 走零网络,否则按冷/温分流到同步/后台 reconcile。
    // force=true(resync 路径)绕过 fresh 门,强制一次同步 reconcile(安全网 #3)。
    tracing::debug!(
        target: "chathub::messages",
        conversation_id = %conversation_id,
        cache_newest_ms = ?cache_newest_ms,
        recents_latest_ms = ?recents_latest_ms,
        has_window = window.is_some(),
        cached_rows = records.len(),
        fresh,
        is_cold,
        force,
        decision = gate_decision,
        "会话水位门判定(fresh ⇔ r>0 且 c>=r)",
    );
    let need_reconcile = should_reconcile_conv_messages(force, fresh, is_cold);
    // force(resync)或冷会话:同步等一次 reconcile 再返回(force 强制绕水位门一次性对齐打开会话)。
    // 温缓存(非 force 且非冷且 not-fresh):后台 spawn(stale-while-revalidate)。
    if need_reconcile && (force || is_cold) {
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
                tracing::warn!(target: "chathub::messages", error = %e, "reconcile_newest failed (sync await)");
            }
            Err(_) => {
                tracing::warn!(target: "chathub::messages", "reconcile_newest timed out (sync await)");
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
        tracing::debug!(
            target: "chathub::messages",
            conversation_id = %conversation_id,
            rows_after = records.len(),
            has_more_older,
            force,
            "同步 reconcile 完成(force 或冷会话),已重读本地缓存返回首屏",
        );
    } else if need_reconcile {
        tracing::debug!(
            target: "chathub::messages",
            conversation_id = %conversation_id,
            "温缓存水位落后,后台 spawn reconcile_newest(stale-while-revalidate)",
        );
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

    // 注入图片元数据（本地宽高 + 缩略图路径）；缺失的后台预取（best-effort）。
    image_prefetcher
        .enrich_and_prefetch(&mut records, &conversation_id, &employee_id)
        .await;

    Ok(CachedMessagesResp {
        records,
        has_more_older,
        // 整窗读已含到缓存最新,无「更新可翻」;窗口化往更新翻是 load_cached_window 的职责。
        has_more_newer: false,
    })
}

/// 往更老翻一页:走网络拉、落库、推进下界 + 游标,返回升序新页(前端 prepend)。
/// 未登录 / 无 window / 无更老 → 空结果。
#[tauri::command]
async fn load_older_messages(
    message_sync: State<'_, MessageSync>,
    auth_api: State<'_, Arc<AuthApi>>,
    image_prefetcher: State<'_, image_prefetch::ImagePrefetcher>,
    conversation_id: String,
    page_size: Option<u32>,
) -> Result<CachedMessagesResp, AuthError> {
    let employee_id = match auth_api.current_session().await? {
        Some(p) => p.user_id,
        None => {
            return Ok(CachedMessagesResp {
                records: Vec::new(),
                has_more_older: false,
                has_more_newer: false,
            })
        }
    };
    let page_size = page_size.unwrap_or(20).clamp(1, 200);
    let result = message_sync
        .load_older(&conversation_id, &employee_id, page_size)
        .await?;
    let mut records = result.records;
    // 注入图片元数据（本地宽高 + 缩略图路径）；缺失的后台预取（best-effort）。
    image_prefetcher
        .enrich_and_prefetch(&mut records, &conversation_id, &employee_id)
        .await;
    Ok(CachedMessagesResp {
        records,
        has_more_older: result.has_more_older,
        // 往旧翻不涉及「更新方向」,恒 false。
        has_more_newer: false,
    })
}

/// 窗口化读:围绕锚点 `anchor_sort_key` 取一段连续本地缓存(纯本地,**不触发 reconcile、不走网络**)。
///
/// 参数语义(对称、单命令带方向):
///   - `after>0`:取锚点更新方向 `after` 条(`list_newer`,升序);
///   - `before>0`:取锚点更旧方向 `before` 条(`list_older_than`,反转升序);
///   - `anchor_sort_key=""`:无锚点 = 取最新尾窗,复用 `list_conversation_asc` 取尾 N
///     (N=after>0 ? after : before),贴底首屏窗。
///
/// 边界标志(供前端判定是否还能继续翻):
///   - `has_more_older`:本窗最旧 sort_key 之前缓存里仍有更旧行,**或** window.has_more_older
///     (后者表示缓存底之下服务端还有可网络扩缓存的更旧页)。
///   - `has_more_newer`:本窗最新 sort_key 之后缓存里仍有更新行(纯本地,不涉服务端)。
/// 未登录返回空结果。
#[tauri::command]
async fn load_cached_window(
    messages_store: State<'_, MessagesStore>,
    auth_api: State<'_, Arc<AuthApi>>,
    image_prefetcher: State<'_, image_prefetch::ImagePrefetcher>,
    conversation_id: String,
    anchor_sort_key: String,
    before: Option<u32>,
    after: Option<u32>,
) -> Result<CachedMessagesResp, AuthError> {
    let employee_id = match auth_api.current_session().await? {
        Some(p) => p.user_id,
        None => {
            return Ok(CachedMessagesResp {
                records: Vec::new(),
                has_more_older: false,
                has_more_newer: false,
            })
        }
    };
    let before = before.unwrap_or(0).clamp(0, 200) as usize;
    let after = after.unwrap_or(0).clamp(0, 200) as usize;

    // 取一段升序行:无锚点 → 尾窗(取尾 N);after>0 → 更新方向;否则 before>0 → 更旧方向。
    let rows = if anchor_sort_key.is_empty() {
        // 尾窗:N=after>0 ? after : before(两者任一即可,默认兜底 1)。
        let n = if after > 0 { after } else { before }.max(1);
        let mut all = messages_store
            .list_conversation_asc(&employee_id, &conversation_id)
            .await
            .map_err(messages_err)?;
        // list_conversation_asc 已升序;取尾 N(不足则全取)。
        if all.len() > n {
            all.split_off(all.len() - n)
        } else {
            all
        }
    } else if after > 0 {
        messages_store
            .list_newer(&employee_id, &conversation_id, &anchor_sort_key, after)
            .await
            .map_err(messages_err)?
    } else {
        messages_store
            .list_older_than(&employee_id, &conversation_id, &anchor_sort_key, before)
            .await
            .map_err(messages_err)?
    };

    // 边界探测:本窗为空时无从判断更旧/更新,均回退 false(让前端按需另行触底拉)。
    let (mut has_more_older, mut has_more_newer) = (false, false);
    if let (Some(first), Some(last)) = (rows.first(), rows.last()) {
        // 本窗最旧之前缓存里是否仍有更旧行(取 1 条探存在性)。
        has_more_older = !messages_store
            .list_older_than(&employee_id, &conversation_id, &first.sort_key, 1)
            .await
            .map_err(messages_err)?
            .is_empty();
        // 本窗最新之后缓存里是否仍有更新行。
        has_more_newer = !messages_store
            .list_newer(&employee_id, &conversation_id, &last.sort_key, 1)
            .await
            .map_err(messages_err)?
            .is_empty();
    }
    // 缓存底之下服务端是否还有更旧页(window.has_more_older)→ 也算「能继续往旧翻」。
    if !has_more_older {
        has_more_older = messages_store
            .get_window(&employee_id, &conversation_id)
            .await
            .map_err(messages_err)?
            .map(|w| w.has_more_older)
            .unwrap_or(false);
    }

    let mut records: Vec<HistoryMessage> = rows.iter().map(row_to_history).collect();
    // 注入图片元数据（本地宽高 + 缩略图路径）；缺失的后台预取（best-effort）。
    image_prefetcher
        .enrich_and_prefetch(&mut records, &conversation_id, &employee_id)
        .await;

    Ok(CachedMessagesResp {
        records,
        has_more_older,
        has_more_newer,
    })
}

/// 清除当前登录员工的全部本地聊天记录:删消息行 + 折叠水位窗(保留 newest 水位防旧史被水位门
/// 回拉、清空翻页能力堵上滑回拉,详见 `MessagesStore::clear_for_employee`)。未登录则 no-op。
/// 仅清本地缓存,不动服务端。employee_id 由当前会话注入,SQL 强制按 employee 过滤,跨员工不可见。
/// 清完广播一条 ConversationMessages ChangeNotice,让打开着的会话立即重读 → 水位门判 fresh 零网络
/// 返回空 → 落空态(而非停在加载骨架)。
#[tauri::command]
async fn clear_chat_messages(
    messages_store: State<'_, MessagesStore>,
    auth_api: State<'_, Arc<AuthApi>>,
    change_tx: State<'_, tokio_broadcast::Sender<ChangeNotice>>,
) -> Result<(), AuthError> {
    let employee_id = match auth_api.current_session().await? {
        Some(p) => p.user_id,
        None => return Ok(()),
    };
    messages_store
        .clear_for_employee(&employee_id)
        .await
        .map_err(messages_err)?;
    // scope 不带 conversation_id → 广义命中所有打开会话的 conversation-messages 订阅,使其重读落空态。
    let _ = change_tx.send(ChangeNotice::command_upsert(
        ChangeTopic::ConversationMessages,
        ChangeScope {
            employee_id,
            ..Default::default()
        },
    ));
    Ok(())
}

/// 发送一条文本消息(`messageType=1`):网络发送 → 落库(出站气泡)→ 发 ConversationMessages
/// ChangeNotice。打开着的会话经订阅重读缓存,新气泡随权威列表稳定追加(不再依赖乐观气泡)。
///
/// 发送成功后还对接待列表(recents)做一次**乐观本地写**(`mark_local_sent`):立即把预览文案/
/// 置顶信号写入本地列(不动版本键与发送状态),并广播 `RecentSessions` ChangeNotice 让接待列表
/// 即时刷新(不等 ~400ms 的 SESSION_SUMMARY push);随后的权威摘要 push 经版本门对齐。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn send_message(
    message_sync: State<'_, MessageSync>,
    recents_store: State<'_, RecentSessionsStore>,
    change_tx: State<'_, tokio_broadcast::Sender<ChangeNotice>>,
    auth_api: State<'_, Arc<AuthApi>>,
    conversation_id: String,
    wecom_account_id: String,
    external_user_id: String,
    message_type: i32,
    content_text: String,
    file_path: Option<String>,
    file_name: Option<String>,
    file_size: Option<i64>,
    duration_seconds: Option<i32>,
    client_msg_id: String,
) -> Result<SendMessageResp, AuthError> {
    let employee_id = auth_api
        .current_session()
        .await?
        .ok_or(AuthError::Unauthenticated)?
        .user_id;
    let resp = message_sync
        .send_message(
            &conversation_id,
            &wecom_account_id,
            &external_user_id,
            &employee_id,
            message_type,
            &content_text,
            file_path.as_deref(),
            file_name.as_deref(),
            file_size,
            duration_seconds,
            &client_msg_id,
        )
        .await?;
    // 接待列表乐观本地写:预览先行 + 置顶信号。方向取 push 原始出站值=1(不经 to_local_direction
    // 转换,与 recent_session_event 读 lastMessageDirection 原始值一致),避免方向前缀闪变。
    // 失败仅 warn 不阻塞返回(送达不因本地列写失败而判失败);会话不在 recents 时 no-op(回退到事件补全)。
    let summary = summary_preview(message_type, &content_text, file_name.as_deref());
    if let Err(e) = recents_store
        .mark_local_sent(
            &employee_id,
            &conversation_id,
            &summary,
            message_type,
            1,
            now_unix_ms(),
        )
        .await
    {
        tracing::warn!(error = %e, "mark_local_sent 失败(不阻塞发送返回)");
    }
    let _ = change_tx.send(ChangeNotice::command_upsert(
        ChangeTopic::RecentSessions,
        ChangeScope {
            employee_id: employee_id.clone(),
            conversation_id: Some(conversation_id.clone()),
            ..Default::default()
        },
    ));
    Ok(resp)
}

/// 派生接待列表预览文案(`lastMessageSummary`):非文本类按内容类型回退占位标签。
/// 标签须与前端 utils.ts 的占位约定及 push `lastMessageSummary` 对齐
/// (图片`[图片]`/文件`[文件]`/语音`[语音]`/视频`[视频]`),避免乐观预览与权威标签不一致。
fn summary_preview(message_type: i32, content_text: &str, file_name: Option<&str>) -> String {
    match message_type {
        2 => "[图片]".to_string(),
        3 => file_name
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| "[文件]".to_string()),
        4 => "[语音]".to_string(),
        6 => "[视频]".to_string(),
        _ => content_text.to_string(), // 1=文本及其它
    }
}

/// 上传一个聊天附件到 OSS:取 STS 凭证 → 取 objectName → 直传。返回 objectName 等元数据,
/// 前端再把 objectName 作 filePath 调 send_message。
#[tauri::command]
async fn upload_attachment(
    oss_uploader: State<'_, OssUploader>,
    bytes: Vec<u8>,
    file_name: String,
    file_suf: String,
    content_type: Option<String>,
) -> Result<UploadedAttachment, AuthError> {
    oss_uploader
        .upload(bytes, file_name, file_suf, content_type)
        .await
}

/// 前端任一 markFailed 落地一条出站失败气泡到本地库(send_status=4),并乐观写接待列表失败态
/// (mark_local_failed:写展示列 + last_send_status=4,不抬水位键)。随后广播 ConversationMessages +
/// RecentSessions ChangeNotice 触发重读。employee_id 走 session 防串台。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn persist_outbox_failure(
    messages_store: State<'_, MessagesStore>,
    recents_store: State<'_, RecentSessionsStore>,
    change_tx: State<'_, tokio_broadcast::Sender<ChangeNotice>>,
    auth_api: State<'_, Arc<AuthApi>>,
    conversation_id: String,
    wecom_account_id: String,
    external_user_id: String,
    client_msg_id: String,
    sent_at_ms: i64,
    message_type: i32,
    content_text: String,
    fail_reason: String,
    attachments_json: String,
) -> Result<(), AuthError> {
    let employee_id = auth_api
        .current_session()
        .await?
        .ok_or(AuthError::Unauthenticated)?
        .user_id;
    messages_store
        .insert_failed_outbox(
            &employee_id,
            &conversation_id,
            &wecom_account_id,
            &external_user_id,
            &client_msg_id,
            sent_at_ms,
            message_type,
            &content_text,
            &fail_reason,
            &attachments_json,
        )
        .await
        .map_err(AuthError::from)?;
    // 接待列表失败态乐观写(方向取出站原始值 1,与 send_message 成功路径一致);新会话 no-op。
    let summary = summary_preview(message_type, &content_text, None);
    if let Err(e) = recents_store
        .mark_local_failed(
            &employee_id,
            &conversation_id,
            &summary,
            message_type,
            1,
            now_unix_ms(),
        )
        .await
    {
        tracing::warn!(error = %e, "persist_outbox_failure: mark_local_failed 失败(不阻塞)");
    }
    let _ = change_tx.send(ChangeNotice::command_upsert(
        ChangeTopic::ConversationMessages,
        ChangeScope {
            employee_id: employee_id.clone(),
            conversation_id: Some(conversation_id.clone()),
            ..Default::default()
        },
    ));
    let _ = change_tx.send(ChangeNotice::command_upsert(
        ChangeTopic::RecentSessions,
        ChangeScope {
            employee_id,
            conversation_id: Some(conversation_id),
            ..Default::default()
        },
    ));
    Ok(())
}

/// 重发前删本地失败行(让气泡回纯乐观 sending);发完 ChangeNotice 让打开着的会话重读。
#[tauri::command]
async fn clear_outbox_row(
    messages_store: State<'_, MessagesStore>,
    change_tx: State<'_, tokio_broadcast::Sender<ChangeNotice>>,
    auth_api: State<'_, Arc<AuthApi>>,
    conversation_id: String,
    client_msg_id: String,
) -> Result<(), AuthError> {
    let employee_id = auth_api
        .current_session()
        .await?
        .ok_or(AuthError::Unauthenticated)?
        .user_id;
    messages_store
        .clear_outbox_row(&employee_id, &client_msg_id)
        .await
        .map_err(AuthError::from)?;
    let _ = change_tx.send(ChangeNotice::command_upsert(
        ChangeTopic::ConversationMessages,
        ChangeScope {
            employee_id,
            conversation_id: Some(conversation_id),
            ..Default::default()
        },
    ));
    Ok(())
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

/// 默认列表渲染深度的回退值 —— 前端未显式传 `limit` 时用它。实际深度由前端随游标
/// 翻页逐步生长(见 `list_recent_friends` 的 limit 入参),上限封顶到
/// `RECENT_SESSIONS_GLOBAL_LIMIT`。
const RECENT_FRIENDS_LIST_LIMIT: usize = 200;

/// 远端单页拉取的 size 硬顶 —— 纵深防御:前端默认列表发 50、搜索发 20,但渲染进程
/// 若被篡改/出 bug 传入超大 size 会放大服务端与网络负载,这里在过线前钳到上限。
const RECENT_FRIENDS_REMOTE_MAX_SIZE: u32 = 100;

/// 水位预填目标:本地(当前 scope)补到 ≥ 它(或远端耗尽)即止。对齐 RECENT_FRIENDS_LIST_LIMIT,
/// 保证默认列表渲染深度内的数据本地齐备,翻页可纯本地深读。前端的"触发线"取更低值(100)
/// 形成滞回,避免在目标边界频繁触发(见 frontends/lib/api/useRecentFriends.ts)。
const RECENT_FRIENDS_WATERMARK_TARGET: usize = 200;

/// 预填单页上限:一次远端请求最多拉这么多。常态(目标 200)一页即可拉满目标,独立于搜索
/// 路径的 RECENT_FRIENDS_REMOTE_MAX_SIZE(不影响后者);目标若 > 它则循环分批。
const RECENT_FRIENDS_PREFILL_PAGE_MAX: usize = 200;

/// 预填循环安全上限:最多续拉这么多页,防远端异常导致失控拉取。
const RECENT_FRIENDS_PREFILL_MAX_ITERS: u32 = 10;

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
/// recents 读出边界方向收口:库存 `last_message_direction` 是上游原始语义
/// (1=发送方 / 2=客户 / 3=多端同步),与消息库本地语义(1=in / 2=out)不同。读出命令吐给前端前
/// 统一过 `to_local_direction`,使前端拿到的 recents 方向与消息库一致。两个读出出口
/// (`list_recent_friends` / `list_recent_friends_remote_page`)必须一致调用,否则缓存行与远端页双轨。
/// 不写回库 —— 库恒存上游值,每次读出单次转换,幂等。
fn normalize_recents_rows_direction_for_read(rows: &mut [RecentSessionRow]) {
    for r in rows {
        r.last_message_direction = to_local_direction(r.last_message_direction as i64);
    }
}

fn normalize_recents_records_direction_for_read(recs: &mut [RecentFriendRecord]) {
    for r in recs {
        r.last_message_direction = to_local_direction(r.last_message_direction as i64);
    }
}

/// 防御性已经由 list_top 内部 WHERE employee_id 兜底,即使本地表里有别人的残留行也读不到。
#[tauri::command]
async fn list_recent_friends(
    store: State<'_, RecentSessionsStore>,
    auth_api: State<'_, Arc<AuthApi>>,
    account_filter: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<RecentSessionRow>, AuthError> {
    let employee_id = match auth_api.current_session().await? {
        Some(p) => p.user_id,
        None => return Ok(Vec::new()),
    };
    let filter = account_filter.filter(|s| !s.is_empty());
    // 渲染深度由前端 `limit` 决定(随游标翻页生长);未传时回退头部窗口。
    // 钳到全局 trim 上限:默认列表最深就到本地热缓存的总量,再深一律走搜索。
    let limit = limit
        .unwrap_or(RECENT_FRIENDS_LIST_LIMIT)
        .clamp(1, RECENT_SESSIONS_GLOBAL_LIMIT);
    let mut rows = store
        .list_top(&employee_id, filter, limit)
        .await
        .map_err(|e| recents_internal_error("list_top", e))?;
    normalize_recents_rows_direction_for_read(&mut rows);
    Ok(rows)
}

/// 远端拉一页"接待好友列表"。
///   - `persist=true`(通常仅首页 cursor="")→ records 同步 UPSERT 到本地表(仅远端列),
///     成功后 trim 到 `RECENT_SESSIONS_GLOBAL_LIMIT` 并 emit `recent_friends_changed`。
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
    let mut resp = hub.list_recent_friends(req).await?;
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
    // 读出边界方向收口:写库分支(上方 record_to_remote)须保持存上游值,故转换放在 if persist 块
    // 之外、返回之前,只作用于即将吐给前端的 resp.records。见 normalize_recents_* 文档。
    normalize_recents_records_direction_for_read(&mut resp.records);
    Ok(resp)
}

/// 水位预填结果(供前端日志/调试,前端可忽略具体字段)。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PrefillResult {
    /// 是否实际发起了远端拉取(false = 本地已达目标水位,直接跳过)。
    filled: bool,
    /// 结束时本地(当前 scope)行数。
    local_count: usize,
    /// 实际远端续拉的页数。
    iters: u32,
    /// 远端是否已耗尽(has_more=false / 返回空)—— true 表示本地已 = 远端全部。
    exhausted: bool,
}

/// 水位预填:把本地接待列表补到目标水位,供"纯本地深读"翻页有足够数据可翻。
///
/// 默认列表渲染只读本地 `list_top(limit)`、翻页纯本地加深 limit(不联网);为保证本地
/// 有足够深度,冷启动/低水位时由本命令一次性补到水位线:
///   - 本地(当前 scope)行数 ≥ TARGET → 直接返回,不打远端。
///   - 否则从 cursor="" **自适应单页**续拉(每页 size = 需补足量,钳到 PREFILL_PAGE_MAX),
///     UPSERT 写库,直到本地 ≥ TARGET / 远端耗尽 / 安全上限。
///   - 写库走 `upsert_remote_many`(版本门保本地列),循环结束 `trim` 一次 + emit ChangeNotice。
///
/// `account_filter` 跟随当前视图:单账号补该账号,None(全部)补合并列表。"是否触发"由前端
/// 按触发线判定;命令被调到即尝试补到 TARGET。
#[tauri::command]
async fn prefill_recent_friends(
    hub: State<'_, HubClient>,
    store: State<'_, RecentSessionsStore>,
    auth_api: State<'_, Arc<AuthApi>>,
    change_tx: State<'_, tokio_broadcast::Sender<ChangeNotice>>,
    account_filter: Option<String>,
    force: Option<bool>,
) -> Result<PrefillResult, AuthError> {
    let employee_id = match auth_api.current_session().await? {
        Some(p) => p.user_id,
        None => {
            return Ok(PrefillResult {
                filled: false,
                local_count: 0,
                iters: 0,
                exhausted: false,
            })
        }
    };
    let filter = account_filter.filter(|s| !s.is_empty());
    prefill_to_watermark(
        &hub,
        &store,
        &change_tx,
        &employee_id,
        filter,
        force.unwrap_or(false),
    )
    .await
}

/// 水位预填短路判定(安全网 #1,spec §6.4-1):非 force 且本地已达目标水位 → 跳过远端拉取。
/// `force=true`(resync / 手动刷新)时恒不短路,强制一次首页 LWW 重拉。
fn prefill_short_circuit(force: bool, local_count: usize, target: usize) -> bool {
    !force && local_count >= target
}

/// `prefill_recent_friends` 的循环主体(抽出便于保持命令简短、聚焦)。
async fn prefill_to_watermark(
    hub: &HubClient,
    store: &RecentSessionsStore,
    change_tx: &tokio_broadcast::Sender<ChangeNotice>,
    employee_id: &str,
    filter: Option<String>,
    force: bool,
) -> Result<PrefillResult, AuthError> {
    let mut local_count = store
        .count(employee_id, filter.clone())
        .await
        .map_err(|e| recents_internal_error("count", e))?;
    if prefill_short_circuit(force, local_count, RECENT_FRIENDS_WATERMARK_TARGET) {
        return Ok(PrefillResult {
            filled: false,
            local_count,
            iters: 0,
            exhausted: false,
        });
    }

    let mut cursor = String::new();
    let mut iters: u32 = 0;
    let mut exhausted = false;
    loop {
        if iters >= RECENT_FRIENDS_PREFILL_MAX_ITERS {
            break;
        }
        // force 路径(resync 首页重拉):本地已≥TARGET 时 need=0 会让 size=0 空转,
        // 固定用 RECENT_FRIENDS_REMOTE_MAX_SIZE 做首页大小,拉满首页即退出(只对齐首页,
        // 不续深;更早整窗缺口靠用户翻页/惰性补,与 spec §6.4-5 有界风险一致)。
        // 非 force 路径维持原自适应单页逻辑。
        let need = RECENT_FRIENDS_WATERMARK_TARGET.saturating_sub(local_count);
        let effective_size = if force && need == 0 {
            RECENT_FRIENDS_REMOTE_MAX_SIZE as usize
        } else {
            need
        };
        let size = effective_size.min(RECENT_FRIENDS_PREFILL_PAGE_MAX) as u32;
        let resp = hub
            .list_recent_friends(ListRecentFriendsRequest {
                size,
                cursor: cursor.clone(),
                external_name: String::new(),
                external_mobile: String::new(),
                wecom_account_id: filter.clone().unwrap_or_default(),
                only_unread: false,
                external_user_id: String::new(),
                include_first_history: false,
            })
            .await?;
        if resp.records.is_empty() {
            exhausted = true;
            break;
        }
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
        iters += 1;
        local_count = store
            .count(employee_id, filter.clone())
            .await
            .map_err(|e| recents_internal_error("count", e))?;
        if !resp.has_more || resp.next_cursor.is_empty() {
            exhausted = true;
            break;
        }
        // force 路径拉满首页即退出(只对齐首页,不续深)。
        if force && need == 0 {
            break;
        }
        if local_count >= RECENT_FRIENDS_WATERMARK_TARGET {
            break;
        }
        cursor = resp.next_cursor;
    }

    if iters > 0 {
        if let Err(e) = store
            .trim(
                employee_id,
                RECENT_SESSIONS_PER_ACCOUNT_LIMIT,
                RECENT_SESSIONS_GLOBAL_LIMIT,
            )
            .await
        {
            tracing::warn!(target: "chathub::recents", ?e, "prefill trim failed; ignoring");
        }
        let _ = change_tx.send(ChangeNotice::command_upsert(
            ChangeTopic::RecentSessions,
            ChangeScope::employee(employee_id),
        ));
        // trim 可能裁掉尾部行,重算最终 count 反映落库后真实深度。
        local_count = store
            .count(employee_id, filter.clone())
            .await
            .map_err(|e| recents_internal_error("count", e))?;
    }

    Ok(PrefillResult {
        filled: iters > 0,
        local_count,
        iters,
        exhausted,
    })
}

/// `open_friend_conversation` 返回:本次定位/创建的会话 ID(前端据此选中)。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenFriendConversationResp {
    conversation_id: String,
}

/// 从搜索点开某客户 → 定位/创建其会话并提到非置顶区顶部。
///
/// 一次 `recentFriends`(`externalUserId` + `includeFirstHistory=true`)拿齐:
///   - `requestConversationId` = 服务端权威会话 ID(records 为空也返回);
///   - `records`:0/1 条该好友的接待记录;
///   - `firstConversationHistory.records`:首屏历史。
///
/// 编排:
///   1. records 命中 → `record_to_remote` 入接待列表;为空 → 用前端兜底资料合成空白行
///      (消息字段空、sortKey 空 → 版本 0,真实记录到达即覆盖,不会产生重复)。
///   2. 首屏历史冷写入消息缓存(仅会话冷时,best-effort)。
///   3. `set_opened` 把行提到非置顶区顶部(置顶仍在其上)。
///   4. emit RecentSessions ChangeNotice(消息侧由 seed_first_history 内部 emit)。
// Tauri 命令:5 个 State 注入 + 标识 + 空白回退资料,参数数天然超 clippy 默认阈值(同
// load_conversation_messages)。State 不可合并,故按惯例 allow。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn open_friend_conversation(
    hub: State<'_, HubClient>,
    recents_store: State<'_, RecentSessionsStore>,
    message_sync: State<'_, MessageSync>,
    auth_api: State<'_, Arc<AuthApi>>,
    change_tx: State<'_, tokio_broadcast::Sender<ChangeNotice>>,
    wecom_account_id: String,
    external_user_id: String,
    // 以下仅当远端无该好友接待记录(走空白行)时用于展示;有记录时一律以记录为准。
    external_name: String,
    external_avatar: String,
    external_mobile: String,
    wecom_name: String,
    wecom_alias: String,
) -> Result<OpenFriendConversationResp, AuthError> {
    let employee_id = auth_api
        .current_session()
        .await?
        .ok_or(AuthError::Unauthenticated)?
        .user_id;

    // 单好友定位:externalUserId 过滤(size=1)+ 带回首屏历史。
    let resp = hub
        .list_recent_friends(ListRecentFriendsRequest {
            size: 1,
            cursor: String::new(),
            external_name: String::new(),
            external_mobile: String::new(),
            wecom_account_id: wecom_account_id.clone(),
            only_unread: false,
            external_user_id: external_user_id.clone(),
            include_first_history: true,
        })
        .await?;

    let record = resp.records.into_iter().next();

    // conversationId 以服务端 requestConversationId 为准;缺省回退记录自带 id;再无则报错。
    let conversation_id = if !resp.request_conversation_id.is_empty() {
        resp.request_conversation_id.clone()
    } else if let Some(r) = &record {
        r.conversation_id.clone()
    } else {
        return Err(AuthError::Internal {
            message: "打开会话失败: 服务端未返回会话 ID".into(),
        });
    };

    // 接待行:有记录用真实记录;无记录合成空白行(sortKey 空 → 版本 0,不覆盖未来真实记录)。
    let remote = match record {
        Some(mut r) => {
            r.conversation_id = conversation_id.clone();
            record_to_remote(r, &employee_id)
        }
        None => {
            let blank = RecentFriendRecord {
                conversation_id: conversation_id.clone(),
                wecom_account_id: wecom_account_id.clone(),
                wecom_name,
                wecom_account: String::new(),
                wecom_alias,
                external_user_id: external_user_id.clone(),
                external_name,
                external_avatar,
                external_mobile,
                last_local_message_id: String::new(),
                last_message_type: 0,
                last_message_direction: 0,
                last_send_status: 0,
                last_message_summary: String::new(),
                last_message_time: String::new(),
                unread_count: 0,
                has_unread: false,
                last_message_sort_key: String::new(),
                gmt_modified_time: String::new(),
            };
            record_to_remote(blank, &employee_id)
        }
    };
    recents_store
        .upsert_remote_one(remote)
        .await
        .map_err(|e| recents_internal_error("open_upsert", e))?;

    // 首屏历史冷写入(仅会话冷时);失败 best-effort —— 选中后 load_conversation_messages 会兜底重对齐。
    if let Some(h) = &resp.first_conversation_history {
        if let Err(e) = message_sync
            .seed_first_history(
                &conversation_id,
                &wecom_account_id,
                &external_user_id,
                &employee_id,
                h,
            )
            .await
        {
            tracing::warn!(target: "chathub::recents", error = %e, "seed_first_history failed; ignoring");
        }
    }

    // 打开 = 显式查看意图:若该会话此前被本地软删除(removed=1),空白行 sort_key=0 会被
    // upsert_remote_in_tx 版本门整体跳过而无法清 removed,表现为"打开成功但列表里不可见"
    // (list_top 过滤 removed=0)。这里独立清除 removed,与 set_opened 一样不受远端列版本门影响。
    recents_store
        .set_removed(&employee_id, &conversation_id, false)
        .await
        .map_err(|e| recents_internal_error("open_unremove", e))?;

    // 提到非置顶区顶部。
    recents_store
        .set_opened(&employee_id, &conversation_id, now_unix_ms())
        .await
        .map_err(|e| recents_internal_error("set_opened", e))?;

    // 单条插入也按既有上限收口,与远端拉取路径一致。
    if let Err(e) = recents_store
        .trim(
            &employee_id,
            RECENT_SESSIONS_PER_ACCOUNT_LIMIT,
            RECENT_SESSIONS_GLOBAL_LIMIT,
        )
        .await
    {
        tracing::warn!(target: "chathub::recents", ?e, "open trim failed; ignoring");
    }

    let _ = change_tx.send(ChangeNotice::command_upsert(
        ChangeTopic::RecentSessions,
        ChangeScope::employee(&employee_id),
    ));

    Ok(OpenFriendConversationResp { conversation_id })
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

// ============================== 快捷回复(纯客户端本地表) ==============================

fn quick_replies_err(op: &'static str, e: impl std::fmt::Display) -> AuthError {
    tracing::error!(target: "chathub::quick_replies", op, error = %e, "quick_replies command failed");
    AuthError::Internal {
        message: format!("快捷回复操作失败: {op}"),
    }
}

/// 列出当前登录员工的全部快捷回复(本地表,按 sort_order 升序)。
#[tauri::command]
async fn list_quick_replies(
    store: State<'_, QuickRepliesStore>,
    auth_api: State<'_, Arc<AuthApi>>,
) -> Result<Vec<QuickReplyRow>, AuthError> {
    let profile = auth_api
        .current_session()
        .await?
        .ok_or(AuthError::Unauthenticated)?;
    store
        .list_for_employee(&profile.user_id)
        .await
        .map_err(|e| quick_replies_err("list", e))
}

/// 新建一条快捷回复。`id` 由前端生成(crypto.randomUUID)。
#[tauri::command]
async fn create_quick_reply(
    store: State<'_, QuickRepliesStore>,
    auth_api: State<'_, Arc<AuthApi>>,
    id: String,
    title: String,
    content: String,
) -> Result<(), AuthError> {
    let profile = auth_api
        .current_session()
        .await?
        .ok_or(AuthError::Unauthenticated)?;
    store
        .create(&profile.user_id, &id, &title, &content)
        .await
        .map_err(|e| quick_replies_err("create", e))
}

/// 修改一条快捷回复的标题 / 正文。
#[tauri::command]
async fn update_quick_reply(
    store: State<'_, QuickRepliesStore>,
    auth_api: State<'_, Arc<AuthApi>>,
    id: String,
    title: String,
    content: String,
) -> Result<(), AuthError> {
    let profile = auth_api
        .current_session()
        .await?
        .ok_or(AuthError::Unauthenticated)?;
    store
        .update(&profile.user_id, &id, &title, &content)
        .await
        .map_err(|e| quick_replies_err("update", e))
}

/// 删除一条快捷回复。
#[tauri::command]
async fn delete_quick_reply(
    store: State<'_, QuickRepliesStore>,
    auth_api: State<'_, Arc<AuthApi>>,
    id: String,
) -> Result<(), AuthError> {
    let profile = auth_api
        .current_session()
        .await?
        .ok_or(AuthError::Unauthenticated)?;
    store
        .delete(&profile.user_id, &id)
        .await
        .map_err(|e| quick_replies_err("delete", e))
}

// ============================== run() ==============================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_screenshots::init())
        // 媒体附件 HTTP 客户端(下载附件 / 取语音字节)。无需 app handle,builder 直接托管。
        .manage(media::MediaHttp::new())
        // AI 润色全局单条在途流的取消句柄。无需 app handle,builder 直接托管。
        .manage(ai_polish::PolishState::default())
        // 远程图片(头像/消息图)缓存协议:前端 <img src="cachedimg://localhost/?w=&u=">
        // → 命中读盘 / 未命中下载并缩略图落盘。CPU 与网络都在 handler 内的 async/blocking 完成。
        .register_asynchronous_uri_scheme_protocol("cachedimg", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                responder.respond(image_cache::serve(&app, request).await);
            });
        })
        // 关闭到托盘:拦截主窗口关闭请求,只隐藏不退出;真正退出由托盘菜单置 QUITTING 后放行。
        .on_window_event(|window, event| {
            // 仅拦主窗口;图片/视频预览窗(image-preview/video-preview)的关闭照常放行。
            if window.label() != "main" {
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                if !QUITTING.load(Ordering::SeqCst) {
                    api.prevent_close();
                    if let Err(e) = window.hide() {
                        warn!(error = %e, "隐藏主窗口到托盘失败");
                    }
                }
            }
        })
        .setup(|app| {
            let log_dir = app.path().app_log_dir()?;
            let guard = logging::init(&log_dir)
                .map_err(|e| Box::<dyn std::error::Error>::from(e.to_string()))?;
            app.manage(guard);
            info!(?log_dir, "tracing initialised");

            // 按显示器分辨率自适应窗口:取屏幕逻辑尺寸 70%,clamp 到 [min, 上限],居中后再显示。
            // config 里窗口设为 visible:false,在此调好尺寸再 show(),避免先弹出默认尺寸再缩放的闪烁。
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(Some(monitor)) = window.current_monitor() {
                    let scale = monitor.scale_factor();
                    let screen = monitor.size(); // 物理像素
                    let sw = screen.width as f64 / scale; // → 逻辑像素
                    let sh = screen.height as f64 / scale;
                    let w = (sw * 0.8).clamp(860.0, 1380.0);
                    let h = (sh * 0.9).clamp(600.0, 900.0);
                    let _ = window.set_size(LogicalSize::new(w, h));
                    let _ = window.center();
                }
                let _ = window.show();
            }

            // ---- 关闭到托盘:系统托盘图标 + 菜单(打开/退出) ----
            // 左键单击切换主窗口显隐;右键弹菜单。退出走 app.exit(0)(经 ExitRequested,不被关闭拦截影响)。
            let open_item = MenuItem::with_id(app, "open", "打开主窗口", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&open_item, &quit_item])?;
            let tray_icons = build_tray_icons();
            let tray = TrayIconBuilder::with_id("main-tray")
                .icon(tray_icons.normal.clone())
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .tooltip("ChatHub")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        restore_main_window(app);
                    }
                    "quit" => {
                        QUITTING.store(true, Ordering::SeqCst);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // 左键单击(松开)切换主窗口显隐。
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let visible = w.is_visible().unwrap_or(false);
                            let minimized = w.is_minimized().unwrap_or(false);
                            // 仅「真正可见且未最小化」才隐藏;最小化(Windows 上 is_visible 仍为 true)
                            // 或已隐藏一律走恢复,避免点托盘把窗口弄没。
                            if visible && !minimized {
                                let _ = w.hide();
                            } else {
                                restore_main_window(app);
                            }
                        }
                    }
                })
                .build(app)?;

            // 托盘图标闪烁线程:每 TRAY_BLINK_INTERVAL_MS 一拍,BLINKING 为真时在 normal↔dim
            // 间交替(呼吸式);转假且停在 dim 帧时补一次 normal 复原。独立 std 线程、不依赖 webview,
            // 故关到托盘也能闪。set_icon 在 Tauri v2 可跨线程调用(与命令同源)。
            let blink_tray = tray.clone();
            let TrayIcons { normal, dim } = tray_icons;
            std::thread::spawn(move || {
                let mut showing_dim = false;
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(TRAY_BLINK_INTERVAL_MS));
                    if BLINKING.load(Ordering::SeqCst) {
                        showing_dim = !showing_dim;
                        let img = if showing_dim { dim.clone() } else { normal.clone() };
                        let _ = blink_tray.set_icon(Some(img));
                    } else if showing_dim {
                        showing_dim = false;
                        let _ = blink_tray.set_icon(Some(normal.clone()));
                    }
                }
            });

            app.manage(tray);

            // ---- Plan 2:接入 chathub-net auth 链路 ----
            let app_data = app.path().app_data_dir()?;
            let app_handle = app.handle().clone();

            // 远程图片磁盘缩略图缓存(cachedimg:// 协议消费它)。独立于 SQLite 领域库,纯磁盘文件。
            let img_cache_dir = app.path().app_cache_dir()?.join("img-cache");
            let img_cache = Arc::new(image_cache::ImageCache::new(img_cache_dir.clone()));
            app.manage(img_cache.clone());
            // asset 协议授权图片缓存目录（程序化，避免配置里写死平台相关路径变量）。
            app.asset_protocol_scope().allow_directory(&img_cache_dir, true)
                .map_err(|e| format!("asset scope: {e}"))?;

            // tauri::async_runtime::block_on 在 setup 同步完成 SQLite 与 endpoint 初始化。
            // setup 闭包本身不在 async 上下文,block_on 安全可用。
            let (auth_api, hub_client, conn_manager, account_cache, recents_store, messages_store, quick_replies_store, friend_detail_cache, message_sync, oss_uploader, change_notice_tx, image_meta_store) = tauri::async_runtime::block_on(async {
                std::fs::create_dir_all(&app_data).ok();
                let pool = SqlitePool::open(app_data.join("state.sqlite"))
                    .await.map_err(|e| e.to_string())?;
                let session_store = SessionStore::new(pool.clone());
                let notify_seq_store = NotifySeqStore::new(pool.clone());
                let account_cache = AccountCacheStore::new(pool.clone());
                let recents_store = RecentSessionsStore::new(pool.clone());
                let messages_store = MessagesStore::new(pool.clone());
                let quick_replies_store = QuickRepliesStore::new(pool.clone());
                // 异常库:语义矛盾脏事件落库前被拦截改入此库(见 MessageEventApplier 网关)。
                let quarantined_store = QuarantinedEventsStore::new(pool.clone());
                let friend_detail_cache = FriendDetailCacheStore::new(pool.clone());
                // 图片派生元数据存储（按 URL 为键，存宽高 + 本地缩略图路径）
                let image_meta_store = ImageMetaStore::new(pool.clone());
                let local_store = LocalTokenStore::new(pool);
                // device_id 从本地 SQLite 取(首次启动生成),不再用 macOS 钥匙串。
                let device_id = local_store.ensure_device_id()
                    .await.map_err(|e| format!("device_id: {e}"))?;
                let endpoint = chathub_net::build_endpoint(chathub_net::RELAY_URL)
                    .map_err(|e| format!("endpoint: {e}"))?;
                let channel = endpoint.connect_lazy();
                let token_store = Arc::new(TokenStore::new(endpoint, local_store, device_id.clone()));
                let interceptor = AuthInterceptor::new(token_store.clone());
                // with_token_store:让 forward 通道遇 HTTP 401(会话已过期)能当场失效本地会话
                // (清 token + 广播 TokenInvalid → 连接下线 + 前端回登录页)。须在下方各 clone
                // 分发前注入,使所有 clone 与 ConnectionManager 共享同一 Arc<TokenStore>。
                let hub_client = HubClient::new(channel, interceptor).with_token_store(token_store.clone());
                // C1+C2 统一变更通知通道 —— 由 setup 阶段创建,在所有 applier 与 ConnectionManager
                // 之间共享。256 buffer 同 hub.event_tx,够事件风暴使用。
                let (change_notice_tx, _) = broadcast_channel::<ChangeNotice>(256);
                // 消息页"缓存优先 + 后台重对齐"编排器(读 messages_store / 拉 hub / 发 ChangeNotice)。
                let message_sync = MessageSync::new(
                    messages_store.clone(),
                    hub_client.clone(),
                    change_notice_tx.clone(),
                );
                // OSS 附件上传器:复用 hub_client 的 forward 通道取 STS 凭证 / objectName。
                let oss_uploader = OssUploader::new(hub_client.clone());
                // 2026-05-17:Subscribe 流里 ACCOUNT_* 事件 → AccountCacheStore + broadcast。
                let account_applier = Arc::new(AccountEventApplier::new(
                    account_cache.clone(),
                    hub_client.clone(),
                    change_notice_tx.clone(),
                ));
                // 阶段 2:Subscribe 流里 FRIEND_* 事件 → broadcast(无本地行存、无 per-resource 水位)。
                let friend_applier = Arc::new(FriendEventApplier::new(change_notice_tx.clone()));
                // 阶段 3:Subscribe 流里 MESSAGE_UPSERT / SESSION_SUMMARY_UPSERT → RecentSessionsStore + broadcast。
                let recent_applier = Arc::new(RecentSessionEventApplier::new(
                    recents_store.clone(),
                    account_cache.clone(),
                    change_notice_tx.clone(),
                ));
                // 阶段 4:Subscribe 流里 MESSAGE_UPSERT → MessagesStore 气泡 + broadcast。
                let message_applier = Arc::new(MessageEventApplier::new(
                    messages_store.clone(),
                    message_sync.clone(),
                    quarantined_store.clone(),
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
                Ok::<_, String>((auth_api, hub_client, conn_manager, account_cache, recents_store, messages_store, quick_replies_store, friend_detail_cache, message_sync, oss_uploader, change_notice_tx, image_meta_store))
            }).map_err(Box::<dyn std::error::Error>::from)?;
            let auth_api = Arc::new(auth_api);
            app.manage(Arc::clone(&auth_api));
            app.manage(hub_client);
            app.manage(Arc::clone(&conn_manager));
            app.manage(account_cache);
            app.manage(recents_store);
            app.manage(messages_store);
            app.manage(quick_replies_store);
            app.manage(friend_detail_cache);
            app.manage(message_sync);
            app.manage(oss_uploader);
            // change_notice_tx 也 manage 一份,Tauri 命令(pin/draft 等)用它直接发 LocalCommand 通知
            app.manage(change_notice_tx.clone());
            // 图片元数据存储 + 后台预取服务（读消息时注入宽高/本地路径，消除图片闪烁）
            app.manage(image_meta_store.clone());
            app.manage(image_prefetch::ImagePrefetcher::new(
                img_cache,
                image_meta_store,
            ));

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

            // (hub:event 桥已退役 2026-06-03:前端零监听该通道,实时帧应用全部在后端 4 个 applier 内
            // 完成;连带移除原 Lagged→stop/start 的抖动重连。被踢下线走 auth:logged_out,连接态由下方
            // hub:connection 桥上报。)

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
                use tokio::time::{sleep_until, Instant as TokioInstant};
                // 尾沿防抖 + maxWait 上限:把一阵高频 ChangeNotice 按 (topic,scope) 合并成稀疏 emit。
                // WINDOW:最后一条事件后等这么久再 flush(治列表闪烁 + 拉开 emit 间隔避免前端 in-flight
                // 丢尾部更新)。MAX_WAIT:持续事件流时强制 flush,避免大批 backfill 期间列表长时间不更新。
                const WINDOW: Duration = Duration::from_millis(150);
                const MAX_WAIT: Duration = Duration::from_millis(500);
                let mut coalescer = ChangeCoalescer::new();
                let mut flush_at: Option<TokioInstant> = None; // 尾沿截止
                let mut hard_at: Option<TokioInstant> = None; // maxWait 截止(首条 pending 起算)
                loop {
                    tokio::select! {
                        recv = change_rx.recv() => match recv {
                            Ok(notice) => {
                                if notice.source == ChangeSource::Resync {
                                    // 全量对齐:先按序放行已 pending,再立即 emit resync,绕过防抖。
                                    for n in coalescer.drain_ordered() {
                                        let _ = app_for_change.emit("hub:change", &n);
                                    }
                                    let _ = app_for_change.emit("hub:change", &notice);
                                    flush_at = None;
                                    hard_at = None;
                                } else {
                                    let now = TokioInstant::now();
                                    if coalescer.is_empty() {
                                        hard_at = Some(now + MAX_WAIT);
                                    }
                                    coalescer.merge(notice);
                                    let trailing = now + WINDOW;
                                    flush_at = Some(match hard_at {
                                        Some(h) => trailing.min(h),
                                        None => trailing,
                                    });
                                }
                            }
                            Err(tokio_broadcast::error::RecvError::Lagged(n)) => {
                                tracing::warn!(target: "chathub::change", skipped = n, "hub:change lagged");
                            }
                            Err(tokio_broadcast::error::RecvError::Closed) => break,
                        },
                        _ = async { sleep_until(flush_at.unwrap()).await }, if flush_at.is_some() => {
                            for n in coalescer.drain_ordered() {
                                let _ = app_for_change.emit("hub:change", &n);
                            }
                            flush_at = None;
                            hard_at = None;
                        }
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
            take_screenshot, read_screenshot_file,
            set_tray_unread,
            login, logout, current_session,
            hub_forward, hub_ack, hub_state, list_accounts, list_friends, friend_detail,
            list_recent_friends, list_recent_friends_remote_page, prefill_recent_friends,
            open_friend_conversation,
            set_conversation_pinned, set_conversation_draft, set_conversation_removed,
            set_conversation_muted, mark_conversation_read,
            fetch_message_history,
            load_conversation_messages, load_older_messages, load_cached_window, clear_chat_messages,
            send_message, upload_attachment, persist_outbox_failure, clear_outbox_row,
            list_quick_replies, create_quick_reply, update_quick_reply, delete_quick_reply,
            media::download_attachment, media::fetch_media_bytes, media::read_local_file,
            ai_polish::ai_polish, ai_polish::cancel_ai_polish,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, _event| {
            // macOS:点 Dock 图标(应用无可见窗口时)唤回隐藏的主窗口。
            // RunEvent::Reopen 仅 macOS 存在,需 cfg 门控,否则 Windows/Linux 编译失败。
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } = &_event
            {
                if !*has_visible_windows {
                    if let Some(w) = _app_handle.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }
            }
        });
}

// 编译期烟雾测试在 Plan 2 起被实际通信代码替代,删除占位。

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conv_messages_force_bypasses_fresh_gate() {
        // 安全网 #3(spec §6.4-3):force=true 无视 fresh,恒需(同步)reconcile。
        assert!(should_reconcile_conv_messages(
            true, /*fresh=*/ true, /*is_cold=*/ false
        ));
        // 非 force + fresh → 零网络命中,不 reconcile。
        assert!(!should_reconcile_conv_messages(false, true, false));
        // 非 force + 非 fresh → 需 reconcile(冷/温分流另判,本函数只答"要不要")。
        assert!(should_reconcile_conv_messages(false, false, true));
        assert!(should_reconcile_conv_messages(false, false, false));
    }

    #[test]
    fn prefill_watermark_skips_short_circuit_when_forced() {
        // 非 force + 本地达水位 → 短路(零远端)。
        assert!(prefill_short_circuit(
            false,
            200,
            RECENT_FRIENDS_WATERMARK_TARGET
        ));
        // force=true + 本地达水位 → 不短路(resync 首页 LWW 重拉)。
        assert!(!prefill_short_circuit(
            true,
            200,
            RECENT_FRIENDS_WATERMARK_TARGET
        ));
        // 非 force + 本地未达水位 → 不短路(常态冷启动续拉)。
        assert!(!prefill_short_circuit(
            false,
            50,
            RECENT_FRIENDS_WATERMARK_TARGET
        ));
        // force=true + 本地未达水位 → 也不短路。
        assert!(!prefill_short_circuit(
            true,
            50,
            RECENT_FRIENDS_WATERMARK_TARGET
        ));
        // 非 force + 本地恰好在水位边界 → 短路。
        assert!(prefill_short_circuit(false, 200, 200));
        // 非 force + 本地超过水位 → 短路。
        assert!(prefill_short_circuit(
            false,
            250,
            RECENT_FRIENDS_WATERMARK_TARGET
        ));
    }

    fn recents_row(dir: i32) -> RecentSessionRow {
        RecentSessionRow {
            conversation_id: "c1".into(),
            wecom_account_id: "wa1".into(),
            employee_id: "e1".into(),
            wecom_name: String::new(),
            wecom_account: String::new(),
            wecom_alias: String::new(),
            external_user_id: String::new(),
            external_name: String::new(),
            external_avatar: String::new(),
            external_mobile: String::new(),
            last_local_message_id: String::new(),
            last_message_type: 1,
            last_message_direction: dir,
            last_send_status: 0,
            last_message_summary: String::new(),
            last_message_time_ms: 0,
            unread_count: 0,
            has_unread: false,
            last_message_sort_key_ms: 0,
            gmt_modified_time: String::new(),
            updated_at_ms: 0,
            pinned: false,
            pinned_at_ms: 0,
            local_draft_at_ms: 0,
            local_draft_text: String::new(),
            removed: false,
            removed_at_ms: 0,
            muted: false,
            muted_at_ms: 0,
            opened_at_ms: 0,
            local_last_sent_at_ms: 0,
        }
    }

    fn recents_record(dir: i32) -> RecentFriendRecord {
        RecentFriendRecord {
            conversation_id: "c1".into(),
            wecom_account_id: "wa1".into(),
            wecom_name: String::new(),
            wecom_account: String::new(),
            wecom_alias: String::new(),
            external_user_id: String::new(),
            external_name: String::new(),
            external_avatar: String::new(),
            external_mobile: String::new(),
            last_local_message_id: String::new(),
            last_message_type: 1,
            last_message_direction: dir,
            last_send_status: 0,
            last_message_summary: String::new(),
            last_message_time: String::new(),
            unread_count: 0,
            has_unread: false,
            last_message_sort_key: String::new(),
            gmt_modified_time: String::new(),
        }
    }

    /// 读出边界收口:两个出口的包装都把 recents 上游方向转本地语义。
    /// 上游 1=发送方 / 3=多端同步 → 本地 2(out);上游 2=客户 → 本地 1(in)。
    /// 映射本身由 message_event.rs 覆盖;本测试只验证读出包装确实施加了转换、且不动其它字段。
    #[test]
    fn normalize_recents_direction_for_read_translates_upstream_to_local() {
        let mut rows = vec![recents_row(1), recents_row(2), recents_row(3)];
        normalize_recents_rows_direction_for_read(&mut rows);
        assert_eq!(rows[0].last_message_direction, 2, "上游1发送方→本地out");
        assert_eq!(rows[1].last_message_direction, 1, "上游2客户→本地in");
        assert_eq!(rows[2].last_message_direction, 2, "上游3多端同步→本地out");
        assert_eq!(rows[0].conversation_id, "c1", "仅动方向,其它字段不变");

        let mut recs = vec![recents_record(1), recents_record(2), recents_record(3)];
        normalize_recents_records_direction_for_read(&mut recs);
        assert_eq!(recs[0].last_message_direction, 2, "上游1发送方→本地out");
        assert_eq!(recs[1].last_message_direction, 1, "上游2客户→本地in");
        assert_eq!(recs[2].last_message_direction, 2, "上游3多端同步→本地out");
        assert_eq!(recs[0].conversation_id, "c1", "仅动方向,其它字段不变");
    }
}
