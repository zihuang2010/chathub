//! 用户设置(设置页):DTO、默认值、KV 映射与 Tauri commands。
//!
//! 分层职责:
//! - `chathub_state::UserSettingsStore` 只做按账号分键的通用 KV 行存;
//! - 本模块负责语义:DTO 结构、默认值回填、partial patch 合并、取值钳制,
//!   以及 5 个 Tauri command(get/update/缓存占用/缓存清理/打开日志目录)。
//!
//! 设置跟随登录账号(employee_id = profile.user_id);未登录一律返回默认值。
//! `update_settings` 写库后刷新进程内快照并应用即时生效项(关闭行为/日志级别/
//! 静默超时/缓存预算),再广播 `settings:changed` 供多窗口同步。

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::RwLock;

// ============================== DTO 与默认值 ==============================

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NotifySettings {
    /// 新消息托盘红点/闪烁(前端 useNewMessageFlash 消费,关闭则不调 set_tray_unread)。
    pub tray_flash: bool,
    /// 任务栏闪烁(Windows;前端消费,macOS 隐藏)。
    pub taskbar_flash: bool,
    /// 新消息声音提醒(前端消费,仅窗口未聚焦时响)。
    pub sound: bool,
}

impl Default for NotifySettings {
    fn default() -> Self {
        Self {
            tray_flash: true,
            taskbar_flash: true,
            sound: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ComposerSettings {
    /// 静音发送(迁移自 useComposerPrefs)。
    pub silent: bool,
    /// 发送后跳到下一个会话(迁移自 useComposerPrefs)。
    pub jump_to_next: bool,
    /// 聊天区拖拽文件发送(设置页「消息行为」可关)。
    pub drag_drop: bool,
}

impl Default for ComposerSettings {
    fn default() -> Self {
        Self {
            silent: false,
            jump_to_next: false,
            drag_drop: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CloseAction {
    /// 点关闭按钮 → 最小化到托盘(现状默认)。
    Tray,
    /// 点关闭按钮 → 直接退出。
    Quit,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    pub close_action: CloseAction,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            close_action: CloseAction::Tray,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StorageSettings {
    /// 图片缩略图缓存预算(MB)。钳制范围见 `normalize`。
    pub image_cache_max_mb: u64,
}

impl Default for StorageSettings {
    fn default() -> Self {
        Self {
            image_cache_max_mb: 500,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AiSettings {
    /// AI 润色开关。实际可用 = enabled 且有效 Key 非空(设置 Key 优先,编译期 Key 兜底)。
    pub enabled: bool,
    /// 留空 → 回落编译期注入值。
    pub api_key: String,
    pub model: String,
    pub base_url: String,
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            api_key: String::new(),
            model: String::new(),
            base_url: String::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NetSettings {
    /// 连接静默看门狗超时(秒)。须 > 2× relay 心跳(15s),钳制 30..=120;下次重连生效。
    pub silence_timeout_secs: u64,
}

impl Default for NetSettings {
    fn default() -> Self {
        Self {
            silence_timeout_secs: 45,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    /// warn 起步(精简)。
    Quiet,
    /// 现状默认:info + chathub/chathub_net debug。
    Default,
    /// 排障:全局 debug + chathub/chathub_net trace。
    Verbose,
}

impl LogLevel {
    /// 对应的 EnvFilter 指令串。
    pub fn env_filter_directives(self) -> &'static str {
        match self {
            LogLevel::Quiet => "warn",
            LogLevel::Default => "info,chathub=debug,chathub_net=debug",
            LogLevel::Verbose => "debug,chathub=trace,chathub_net=trace",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LogSettings {
    pub level: LogLevel,
}

impl Default for LogSettings {
    fn default() -> Self {
        Self {
            level: LogLevel::Default,
        }
    }
}

/// 设置页完整 DTO。serde camelCase,直接喂给前端。
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UserSettings {
    pub notify: NotifySettings,
    pub composer: ComposerSettings,
    pub app: AppSettings,
    pub storage: StorageSettings,
    pub ai: AiSettings,
    pub net: NetSettings,
    pub log: LogSettings,
}

// ============================== KV 映射与合并 ==============================

/// DTO → 扁平 KV(`group.field` → JSON 字面量字符串),供 UserSettingsStore 持久化。
pub fn to_entries(settings: &UserSettings) -> Vec<(String, String)> {
    let value = serde_json::to_value(settings).unwrap_or_default();
    let mut out = Vec::new();
    if let serde_json::Value::Object(groups) = value {
        for (group, fields) in groups {
            if let serde_json::Value::Object(fields) = fields {
                for (field, v) in fields {
                    out.push((format!("{group}.{field}"), v.to_string()));
                }
            }
        }
    }
    out
}

/// 扁平 KV → DTO:从默认值出发逐项覆盖;未知 key / 坏 JSON / 坏类型一律忽略该项
/// (向后兼容废弃项与脏数据,绝不影响其它项)。
pub fn from_entries(entries: &[(String, String)]) -> UserSettings {
    let mut settings = UserSettings::default();
    for (key, raw) in entries {
        let Some((group, field)) = key.split_once('.') else {
            continue;
        };
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(raw) else {
            continue;
        };
        let mut candidate = serde_json::to_value(&settings).unwrap_or_default();
        // 只覆盖默认 DTO 中已存在的叶子(未知 key 直接跳过)
        let Some(slot) = candidate.get_mut(group).and_then(|g| g.get_mut(field)) else {
            continue;
        };
        *slot = parsed;
        // 类型不符 → 整体反序列化失败 → 丢弃该项,settings 保持上一步状态
        if let Ok(next) = serde_json::from_value::<UserSettings>(candidate) {
            settings = next;
        }
    }
    normalize(&mut settings);
    settings
}

/// 把前端传来的 partial patch(嵌套 JSON,如 `{"notify":{"sound":false}}`)深合并到
/// 当前设置上,再钳制取值。patch 结构不合法(字段类型错)→ Err。
pub fn merge_patch(
    current: &UserSettings,
    patch: &serde_json::Value,
) -> Result<UserSettings, String> {
    let mut value = serde_json::to_value(current).map_err(|e| e.to_string())?;
    deep_merge(&mut value, patch);
    let mut merged = serde_json::from_value::<UserSettings>(value)
        .map_err(|e| format!("设置格式不合法: {e}"))?;
    normalize(&mut merged);
    Ok(merged)
}

/// 两层对象深合并:patch 中的对象递归、标量覆盖。
fn deep_merge(base: &mut serde_json::Value, patch: &serde_json::Value) {
    match (base, patch) {
        (serde_json::Value::Object(base_map), serde_json::Value::Object(patch_map)) => {
            for (k, pv) in patch_map {
                match base_map.get_mut(k) {
                    Some(bv) if bv.is_object() && pv.is_object() => deep_merge(bv, pv),
                    Some(bv) => *bv = pv.clone(),
                    // 未知 key 忽略(serde 反序列化也会忽略,这里直接不并入)
                    None => {}
                }
            }
        }
        (base_slot, _) => *base_slot = patch.clone(),
    }
}

/// 取值钳制:silenceTimeoutSecs 30..=120;imageCacheMaxMb 100..=8192。
pub fn normalize(settings: &mut UserSettings) {
    settings.net.silence_timeout_secs = settings.net.silence_timeout_secs.clamp(30, 120);
    settings.storage.image_cache_max_mb = settings.storage.image_cache_max_mb.clamp(100, 8192);
}

// ============================== 进程内快照 ==============================

/// 关闭按钮行为快照:on_window_event 是普通闭包、不走 State,与 QUITTING 同样用 static。
/// true = 关闭到托盘(默认);false = 直接退出。
pub static CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(true);

/// 当前登录账号的设置快照(get_settings/update_settings 时刷新)。
/// ai_polish 等命令读它,避免每次查库。
#[derive(Default)]
pub struct SettingsSnapshot(pub RwLock<UserSettings>);

impl SettingsSnapshot {
    pub fn get(&self) -> UserSettings {
        self.0.read().map(|g| g.clone()).unwrap_or_default()
    }

    pub fn set(&self, next: UserSettings) {
        if let Ok(mut g) = self.0.write() {
            *g = next;
        }
    }
}

/// 快照变化时需要立即下推的内部副作用(独立纯函数,便于单测 CLOSE_TO_TRAY 翻转)。
pub fn apply_close_action(settings: &UserSettings) {
    CLOSE_TO_TRAY.store(
        settings.app.close_action == CloseAction::Tray,
        Ordering::SeqCst,
    );
}

// ============================== 副作用下推与 Tauri commands ==============================

/// 把快照里的即时生效项下推到各子系统:关闭行为(static)、日志级别(reload)、
/// 静默超时(下次重连生效)、图片缓存预算(下次淘汰生效)。
pub fn apply_side_effects(app: &tauri::AppHandle, settings: &UserSettings) {
    use tauri::Manager;
    apply_close_action(settings);
    if let Some(log) = app.try_state::<crate::logging::LogControl>() {
        log.set_directives(settings.log.level.env_filter_directives());
    }
    if let Some(cm) = app.try_state::<std::sync::Arc<chathub_net::ConnectionManager>>() {
        cm.set_silence_timeout(Some(std::time::Duration::from_secs(
            settings.net.silence_timeout_secs,
        )));
    }
    if let Some(cache) = app.try_state::<std::sync::Arc<crate::image_cache::ImageCache>>() {
        cache.set_max_bytes(
            settings
                .storage
                .image_cache_max_mb
                .saturating_mul(1024 * 1024),
        );
    }
}

/// 加载某账号设置 → 刷新快照 → 下推副作用。登录成功 / 启动恢复会话 / get_settings 共用。
/// 读库失败回落默认值(设置丢了影响有限,绝不阻塞登录链路)。
pub async fn load_and_apply(app: &tauri::AppHandle, employee_id: &str) -> UserSettings {
    use tauri::Manager;
    let settings = match app.try_state::<chathub_state::UserSettingsStore>() {
        Some(store) => match store.read_all(employee_id).await {
            Ok(rows) => from_entries(&rows),
            Err(e) => {
                tracing::warn!(target: "chathub::settings", error = %e, "读取用户设置失败,回落默认值");
                UserSettings::default()
            }
        },
        None => UserSettings::default(),
    };
    if let Some(snapshot) = app.try_state::<SettingsSnapshot>() {
        snapshot.set(settings.clone());
    }
    apply_side_effects(app, &settings);
    settings
}

/// API Key 脱敏(机械式,不带文案):空 → 空;≤8 字符 → 不暴露任何字符;常规 → 首3…尾4。
pub fn mask_api_key(key: &str) -> String {
    if key.is_empty() {
        return String::new();
    }
    let chars: Vec<char> = key.chars().collect();
    if chars.len() <= 8 {
        return "•••".into();
    }
    format!(
        "{}…{}",
        chars[..3].iter().collect::<String>(),
        chars[chars.len() - 4..].iter().collect::<String>()
    )
}

/// 出境脱敏:Key 明文永不出 Rust 层。get_settings / update_settings 的返回值与
/// `settings:changed` 广播都必须经过这里;后端快照(SettingsSnapshot)保留明文供 ai_polish 用。
pub fn redacted(mut settings: UserSettings) -> UserSettings {
    settings.ai.api_key = mask_api_key(&settings.ai.api_key);
    settings
}

/// 防御:patch 中的 ai.apiKey 若是脱敏占位串(含 `…` 或为 `•••`),当作"未改动"剥离。
/// 正常前端只在用户真实输入时才携带 apiKey,此守卫兜 UI 误回显的底。
pub fn strip_masked_api_key(patch: &mut serde_json::Value) {
    let Some(ai) = patch.get_mut("ai").and_then(|v| v.as_object_mut()) else {
        return;
    };
    let is_masked = ai
        .get("apiKey")
        .and_then(|k| k.as_str())
        .map(|k| k.contains('…') || k == "•••")
        .unwrap_or(false);
    if is_masked {
        ai.remove("apiKey");
    }
}

/// 编译期内置 AI 配置(供设置页预填展示)。内置 Key 只暴露"有没有",不泄露任何片段。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiDefaults {
    pub base_url: String,
    pub model: String,
    pub has_api_key: bool,
}

#[tauri::command]
pub fn get_ai_defaults() -> AiDefaults {
    AiDefaults {
        base_url: env!("CHATHUB_AI_BASE_URL_RESOLVED").to_string(),
        model: env!("CHATHUB_AI_MODEL_RESOLVED").to_string(),
        has_api_key: !env!("CHATHUB_AI_API_KEY_RESOLVED").is_empty(),
    }
}

fn settings_err(op: &'static str, e: impl std::fmt::Display) -> chathub_net::AuthError {
    tracing::error!(target: "chathub::settings", op, error = %e, "settings command failed");
    chathub_net::AuthError::Internal {
        message: format!("设置操作失败: {op}"),
    }
}

/// 读当前登录账号的全部设置(缺省项回填默认值),顺带刷新快照与副作用。
/// 未登录返回纯默认值(登录页阶段)。
#[tauri::command]
pub async fn get_settings(
    app: tauri::AppHandle,
    auth_api: tauri::State<'_, std::sync::Arc<chathub_net::AuthApi>>,
) -> Result<UserSettings, chathub_net::AuthError> {
    match auth_api.current_session().await? {
        Some(profile) => Ok(redacted(load_and_apply(&app, &profile.user_id).await)),
        None => Ok(UserSettings::default()),
    }
}

/// 部分更新:patch 为嵌套 JSON(如 `{"notify":{"sound":false}}`)。
/// 以**库内当前值**为基底合并(不信任快照,避免切账号竞态),写库 → 刷新快照 →
/// 下推副作用 → 广播 `settings:changed`(多窗口同步)→ 返回合并后的完整 DTO。
#[tauri::command]
pub async fn update_settings(
    app: tauri::AppHandle,
    auth_api: tauri::State<'_, std::sync::Arc<chathub_net::AuthApi>>,
    store: tauri::State<'_, chathub_state::UserSettingsStore>,
    snapshot: tauri::State<'_, SettingsSnapshot>,
    patch: serde_json::Value,
) -> Result<UserSettings, chathub_net::AuthError> {
    use tauri::Emitter;
    let profile = auth_api
        .current_session()
        .await?
        .ok_or(chathub_net::AuthError::Unauthenticated)?;
    let rows = store
        .read_all(&profile.user_id)
        .await
        .map_err(|e| settings_err("read", e))?;
    let current = from_entries(&rows);
    let mut patch = patch;
    strip_masked_api_key(&mut patch);
    let merged = merge_patch(&current, &patch)
        .map_err(|message| chathub_net::AuthError::Internal { message })?;
    store
        .upsert_many(&profile.user_id, &to_entries(&merged))
        .await
        .map_err(|e| settings_err("write", e))?;
    snapshot.set(merged.clone());
    apply_side_effects(&app, &merged);
    // 出境(返回 + 广播)一律脱敏;明文只在快照与库里。
    let safe = redacted(merged);
    let _ = app.emit("settings:changed", &safe);
    Ok(safe)
}

/// 图片缓存当前占用(字节)。walk 目录放 blocking 线程。
#[tauri::command]
pub async fn get_image_cache_usage(
    cache: tauri::State<'_, std::sync::Arc<crate::image_cache::ImageCache>>,
) -> Result<u64, String> {
    let cache = std::sync::Arc::clone(&cache);
    tauri::async_runtime::spawn_blocking(move || cache.usage_bytes())
        .await
        .map_err(|e| format!("join: {e}"))
}

/// 清空图片缓存,返回释放字节数。
#[tauri::command]
pub async fn clear_image_cache(
    cache: tauri::State<'_, std::sync::Arc<crate::image_cache::ImageCache>>,
) -> Result<u64, String> {
    let cache = std::sync::Arc::clone(&cache);
    tauri::async_runtime::spawn_blocking(move || cache.clear_all())
        .await
        .map_err(|e| format!("join: {e}"))
}

/// 在系统文件管理器中打开日志目录。
#[tauri::command]
pub fn open_log_dir(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    tauri_plugin_opener::open_path(dir.to_string_lossy().into_owned(), None::<String>)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_roundtrips_through_entries() {
        let def = UserSettings::default();
        let entries = to_entries(&def);
        // 14 个叶子字段,一项不少
        assert_eq!(entries.len(), 14, "entries: {entries:?}");
        assert_eq!(from_entries(&entries), def);
    }

    #[test]
    fn entries_use_dotted_camel_case_keys_and_json_values() {
        let mut s = UserSettings::default();
        s.notify.sound = false;
        s.app.close_action = CloseAction::Quit;
        s.net.silence_timeout_secs = 60;
        s.ai.api_key = "sk-test".into();
        let entries = to_entries(&s);
        let get = |k: &str| {
            entries
                .iter()
                .find(|(key, _)| key == k)
                .map(|(_, v)| v.clone())
                .unwrap_or_else(|| panic!("missing key {k}"))
        };
        assert_eq!(get("notify.sound"), "false");
        assert_eq!(get("app.closeAction"), "\"quit\"");
        assert_eq!(get("net.silenceTimeoutSecs"), "60");
        assert_eq!(get("ai.apiKey"), "\"sk-test\"");
    }

    #[test]
    fn from_entries_overlays_defaults_and_ignores_unknown_or_bad() {
        let entries = vec![
            ("notify.sound".to_string(), "false".to_string()),
            ("log.level".to_string(), "\"verbose\"".to_string()),
            // 未知 key(未来废弃项)与坏 JSON / 坏类型一律忽略,不 panic、不影响其它项
            ("ghost.key".to_string(), "1".to_string()),
            ("composer.silent".to_string(), "not-json".to_string()),
            ("net.silenceTimeoutSecs".to_string(), "\"abc\"".to_string()),
        ];
        let s = from_entries(&entries);
        assert!(!s.notify.sound);
        assert_eq!(s.log.level, LogLevel::Verbose);
        assert!(!s.composer.silent, "坏值回落默认");
        assert_eq!(s.net.silence_timeout_secs, 45, "坏类型回落默认");
        assert!(s.notify.tray_flash, "未提及项保持默认");
    }

    #[test]
    fn merge_patch_deep_merges_partial_and_keeps_rest() {
        let current = UserSettings::default();
        let patch = serde_json::json!({ "notify": { "sound": false } });
        let merged = merge_patch(&current, &patch).unwrap();
        assert!(!merged.notify.sound);
        assert!(merged.notify.tray_flash, "同组其它字段不被覆盖");
        assert_eq!(merged.app.close_action, CloseAction::Tray, "其它组不动");
    }

    #[test]
    fn merge_patch_rejects_wrong_types() {
        let current = UserSettings::default();
        let patch = serde_json::json!({ "notify": { "sound": "yes" } });
        assert!(merge_patch(&current, &patch).is_err());
    }

    #[test]
    fn merge_patch_clamps_out_of_range_values() {
        let current = UserSettings::default();
        let patch = serde_json::json!({
            "net": { "silenceTimeoutSecs": 5 },
            "storage": { "imageCacheMaxMb": 99999 }
        });
        let merged = merge_patch(&current, &patch).unwrap();
        assert_eq!(merged.net.silence_timeout_secs, 30, "下钳到 30");
        assert_eq!(merged.storage.image_cache_max_mb, 8192, "上钳到 8192");
    }

    #[test]
    fn apply_close_action_flips_static() {
        let mut s = UserSettings::default();
        apply_close_action(&s);
        assert!(CLOSE_TO_TRAY.load(Ordering::SeqCst));
        s.app.close_action = CloseAction::Quit;
        apply_close_action(&s);
        assert!(!CLOSE_TO_TRAY.load(Ordering::SeqCst));
        // 复原,避免影响其它测试(static 全局)
        s.app.close_action = CloseAction::Tray;
        apply_close_action(&s);
    }

    #[test]
    fn mask_api_key_never_reveals_full_key() {
        assert_eq!(mask_api_key(""), "");
        // 短 Key 不暴露任何字符
        assert_eq!(mask_api_key("short"), "•••");
        assert_eq!(mask_api_key("12345678"), "•••");
        // 常规 Key:首3…尾4
        assert_eq!(mask_api_key("sk-abcdefgh1234"), "sk-…1234");
    }

    /// Key 明文永不出 Rust 层:返回给前端/广播的 DTO 必须脱敏,其余字段原样。
    #[test]
    fn redacted_masks_api_key_only() {
        let mut s = UserSettings::default();
        s.ai.api_key = "sk-abcdefgh1234".into();
        s.ai.model = "qwen-max".into();
        s.notify.sound = false;
        let safe = redacted(s.clone());
        assert_eq!(safe.ai.api_key, "sk-…1234");
        assert_eq!(safe.ai.model, "qwen-max", "其余字段不动");
        assert!(!safe.notify.sound);
    }

    /// 防御:UI 若误把脱敏占位串(sk-…1234 / •••)回传,必须当作"未改动"剥离,不能存成 Key。
    #[test]
    fn strip_masked_api_key_drops_placeholder_keeps_real() {
        let mut masked = serde_json::json!({ "ai": { "apiKey": "sk-…1234", "model": "m" } });
        strip_masked_api_key(&mut masked);
        assert!(masked["ai"].get("apiKey").is_none());
        assert_eq!(masked["ai"]["model"], "m", "其余字段保留");

        let mut dots = serde_json::json!({ "ai": { "apiKey": "•••" } });
        strip_masked_api_key(&mut dots);
        assert!(dots["ai"].get("apiKey").is_none());

        let mut real = serde_json::json!({ "ai": { "apiKey": "sk-new-key-123456" } });
        strip_masked_api_key(&mut real);
        assert_eq!(
            real["ai"]["apiKey"], "sk-new-key-123456",
            "真实 Key 不受影响"
        );
    }

    #[test]
    fn log_level_maps_to_env_filter() {
        assert_eq!(LogLevel::Quiet.env_filter_directives(), "warn");
        assert_eq!(
            LogLevel::Default.env_filter_directives(),
            "info,chathub=debug,chathub_net=debug"
        );
        assert_eq!(
            LogLevel::Verbose.env_filter_directives(),
            "debug,chathub=trace,chathub_net=trace"
        );
    }

    #[test]
    fn drag_drop_default_true_and_kv_roundtrip() {
        // 默认开
        let s = UserSettings::default();
        assert!(s.composer.drag_drop);
        // KV 往返不丢
        let entries = to_entries(&s);
        let restored = from_entries(&entries);
        assert!(restored.composer.drag_drop);
        // 老账号(存量 KV 没有 composer.dragDrop 键) → 默认 true
        let legacy = from_entries(&[("composer.silent".to_string(), "true".to_string())]);
        assert!(legacy.composer.drag_drop);
        assert!(legacy.composer.silent);
        // patch 可以关掉
        let patched =
            merge_patch(&s, &serde_json::json!({"composer": {"dragDrop": false}})).unwrap();
        assert!(!patched.composer.drag_drop);
    }
}
