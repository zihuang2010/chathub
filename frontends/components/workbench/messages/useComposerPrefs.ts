import { useEffect, useState } from "react";

export interface ComposerPrefs {
  silent: boolean;
  jumpToNext: boolean;
}

export const COMPOSER_PREFS_KEY = "workbench.composer.prefs.v1";
export const DEFAULT_PREFS: ComposerPrefs = { silent: false, jumpToNext: false };

const subscribers = new Set<(prefs: ComposerPrefs) => void>();

export function loadComposerPrefs(): ComposerPrefs {
  if (typeof window === "undefined") return DEFAULT_PREFS;
  try {
    const raw = window.localStorage.getItem(COMPOSER_PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<ComposerPrefs>;
    return {
      silent: Boolean(parsed.silent),
      jumpToNext: Boolean(parsed.jumpToNext),
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function saveComposerPrefs(prefs: ComposerPrefs) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(COMPOSER_PREFS_KEY, JSON.stringify(prefs));
  subscribers.forEach((fn) => fn(prefs));
}

export function useComposerPrefs() {
  const [prefs, setPrefs] = useState<ComposerPrefs>(loadComposerPrefs);

  useEffect(() => {
    subscribers.add(setPrefs);
    // 跨窗口同步:storage 事件只在「其它」窗口触发(改动方自身不触发),用进程内
    // subscribers 覆盖同窗口、storage 事件覆盖多 Tauri 窗口,两者互补。
    const onStorage = (e: StorageEvent) => {
      if (e.key === COMPOSER_PREFS_KEY) setPrefs(loadComposerPrefs());
    };
    window.addEventListener("storage", onStorage);
    return () => {
      subscribers.delete(setPrefs);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return {
    prefs,
    setSilent: (next: boolean) => saveComposerPrefs({ ...loadComposerPrefs(), silent: next }),
    setJumpToNext: (next: boolean) =>
      saveComposerPrefs({ ...loadComposerPrefs(), jumpToNext: next }),
  };
}
