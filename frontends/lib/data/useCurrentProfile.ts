// useCurrentProfile — 提供当前登录员工的完整 UserProfile,供左侧栏顶部员工区展示。
//
// 设计与 useCurrentEmployeeId 一致:
//   - mount 时调一次 current_session 拿初态
//   - listen auth:logged_out 时清空(返 null = 未登录)
//   - 不缓存(current_session 走 SQLite 极快;每个实例独立读)

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { UserProfile } from "@/App";

export function useCurrentProfile(): UserProfile | null {
  const [profile, setProfile] = useState<UserProfile | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    void (async () => {
      try {
        const p = await invoke<UserProfile | null>("current_session");
        if (!cancelled) setProfile(p);
      } catch {
        if (!cancelled) setProfile(null);
      }
      // 登出 / 被踢时清空
      unlisten = await listen<{ reason?: string }>("auth:logged_out", () => {
        setProfile(null);
      });
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return profile;
}
