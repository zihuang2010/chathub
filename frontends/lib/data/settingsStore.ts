// settingsStore — 设置页的前端镜像 store(单一事实源在后端 SQLite hub_user_settings)。
//
// 数据流:
//   登录/恢复会话 → load():invoke get_settings 整体回填(后端顺带把副作用下推);
//   设置页/输入框开关改动 → update(patch):乐观更新 + invoke update_settings,失败回滚;
//   多窗口同步 → startSettingsSync() 监听后端 update_settings 广播的 settings:changed;
//   登出/切账号 → reset() 回默认值,新账号登录后再 load()。
//
// 旧 useComposerPrefs 的 localStorage 偏好(不分账号)在首次 load() 时一次性迁移进
// 后端存储并删除旧键 —— 旧偏好本来就是设备级的,迁给首个登录账号符合直觉。

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";

export type CloseAction = "tray" | "quit";
export type LogLevel = "quiet" | "default" | "verbose";

/** 与后端 settings::UserSettings 对齐(serde camelCase)。 */
export interface UserSettings {
  notify: { trayFlash: boolean; taskbarFlash: boolean; sound: boolean };
  composer: { silent: boolean; jumpToNext: boolean; dragDrop: boolean };
  app: { closeAction: CloseAction };
  storage: { imageCacheMaxMb: number };
  ai: { enabled: boolean; apiKey: string; model: string; baseUrl: string };
  net: { silenceTimeoutSecs: number };
  log: { level: LogLevel };
}

/** 部分更新:每组每字段都可选。 */
export type SettingsPatch = {
  [G in keyof UserSettings]?: Partial<UserSettings[G]>;
};

export const DEFAULT_SETTINGS: UserSettings = {
  notify: { trayFlash: true, taskbarFlash: true, sound: true },
  composer: { silent: false, jumpToNext: false, dragDrop: true },
  app: { closeAction: "tray" },
  storage: { imageCacheMaxMb: 500 },
  ai: { enabled: true, apiKey: "", model: "", baseUrl: "" },
  net: { silenceTimeoutSecs: 45 },
  log: { level: "default" },
};

/** 旧 composer 偏好的 localStorage 键(迁移后删除)。 */
export const LEGACY_COMPOSER_PREFS_KEY = "workbench.composer.prefs.v1";

/** 两层深合并(纯函数):patch 给到的叶子覆盖,其余保持。 */
export function mergeSettings(base: UserSettings, patch: SettingsPatch): UserSettings {
  const next = structuredClone(base);
  for (const group of Object.keys(patch) as (keyof UserSettings)[]) {
    const fields = patch[group];
    if (!fields) continue;
    Object.assign(next[group], fields);
  }
  return next;
}

interface SettingsStore {
  settings: UserSettings;
  /** 已从后端回填过(区分"默认值兜底"与"真实账号设置")。 */
  loaded: boolean;
  /** 登录/恢复会话后调用:get_settings 整体回填 + 旧 composer 偏好一次性迁移。 */
  load: () => Promise<void>;
  /** 乐观更新 + 持久化;失败回滚并返回 false。 */
  update: (patch: SettingsPatch) => Promise<boolean>;
  /** 登出/切账号:回默认值。 */
  reset: () => void;
  /** settings:changed 多窗口同步:直接采用后端广播的完整 DTO。 */
  applyExternal: (settings: UserSettings) => void;
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,

  load: async () => {
    let fetched: UserSettings;
    try {
      fetched = await invoke<UserSettings>("get_settings");
    } catch {
      // 非 Tauri 运行时(纯 Vite 预览/单测)或后端读库失败:保持默认值,不置 loaded。
      return;
    }
    set({ settings: fetched, loaded: true });
    migrateLegacyComposerPrefs(get().update);
  },

  update: async (patch) => {
    const prev = get().settings;
    set({ settings: mergeSettings(prev, patch) });
    try {
      const merged = await invoke<UserSettings>("update_settings", { patch });
      set({ settings: merged, loaded: true });
      return true;
    } catch {
      set({ settings: prev });
      return false;
    }
  },

  reset: () => set({ settings: DEFAULT_SETTINGS, loaded: false }),

  applyExternal: (settings) => set({ settings, loaded: true }),
}));

/** 旧 useComposerPrefs 的 localStorage 偏好一次性迁移(读到即写后端并删键;失败下次再试)。 */
function migrateLegacyComposerPrefs(update: SettingsStore["update"]) {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(LEGACY_COMPOSER_PREFS_KEY);
  } catch {
    return;
  }
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as Partial<{ silent: boolean; jumpToNext: boolean }>;
    window.localStorage.removeItem(LEGACY_COMPOSER_PREFS_KEY);
    void update({
      composer: { silent: Boolean(parsed.silent), jumpToNext: Boolean(parsed.jumpToNext) },
    });
  } catch {
    // 坏 JSON:直接删键,放弃迁移。
    try {
      window.localStorage.removeItem(LEGACY_COMPOSER_PREFS_KEY);
    } catch {
      /* ignore */
    }
  }
}

let syncStarted = false;

/** 监听后端 settings:changed(update_settings 广播),多窗口/多入口保持一致。App 启动时调用一次。 */
export function startSettingsSync(): void {
  if (syncStarted) return;
  syncStarted = true;
  void listen<UserSettings>("settings:changed", (event) => {
    if (event.payload) useSettingsStore.getState().applyExternal(event.payload);
  }).catch(() => {
    syncStarted = false; // 非 Tauri 运行时:允许之后重试,实际不影响功能
  });
}
