// useComposerPrefs — 设置存储(settingsStore)的 composer 组适配层。
//
// 历史:曾是独立的 localStorage 偏好(不分账号,跨窗口靠 storage 事件)。设置页上线后
// 收编进统一设置存储(后端 SQLite,按登录账号分键),本 hook 保留原 API 形状,
// MessageComposer/SendButtonGroup 零改动;旧 localStorage 键由 settingsStore.load()
// 首次登录时一次性迁移。

import { useSettingsStore } from "@/lib/data/settingsStore";

export interface ComposerPrefs {
  silent: boolean;
  jumpToNext: boolean;
}

export function useComposerPrefs() {
  const prefs = useSettingsStore((s) => s.settings.composer);
  const update = useSettingsStore((s) => s.update);

  return {
    prefs,
    setSilent: (next: boolean) => void update({ composer: { silent: next } }),
    setJumpToNext: (next: boolean) => void update({ composer: { jumpToNext: next } }),
  };
}
