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
      // 登出 / 被踢时清空。listen 排在 await invoke 之后,若组件在 current_session 在途
      // 期间卸载,cleanup 已先跑过(此刻 unlisten 仍 undefined、空跑),故 await 后补 cancelled
      // 守卫:已卸载则立即取消、不再赋给 unlisten,避免监听器永久悬挂(与本仓其余 await listen
      // 点一致,如 App.tsx)。
      const un = await listen<{ reason?: string }>("auth:logged_out", () => {
        setProfile(null);
      });
      if (cancelled) {
        un();
        return;
      }
      unlisten = un;
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return profile;
}
