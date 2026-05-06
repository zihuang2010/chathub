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
    return () => {
      subscribers.delete(setPrefs);
    };
  }, []);

  return {
    prefs,
    setSilent: (next: boolean) => saveComposerPrefs({ ...prefs, silent: next }),
    setJumpToNext: (next: boolean) => saveComposerPrefs({ ...prefs, jumpToNext: next }),
  };
}
