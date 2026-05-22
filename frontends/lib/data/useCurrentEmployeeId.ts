// useCurrentEmployeeId — 提供当前登录员工 ID,供 useResource scope 用。
//
// 设计:
//   - mount 时调一次 current_session 拿初态
//   - listen auth:logged_out 时清空(返 null = 未登录)
//   - 不缓存(每个 hook 实例独立读;current_session 走 SQLite 极快)
//
// 业务 hook 通常这样用:
//   const employeeId = useCurrentEmployeeId();
//   const r = useResource({
//     topic: "accounts",
//     scope: { employeeId: employeeId ?? "" },
//     queryFn: ...,
//     enabled: !!employeeId,
//   });

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { UserProfile } from "@/App";

export function useCurrentEmployeeId(): string | null {
  const [employeeId, setEmployeeId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    void (async () => {
      try {
        const profile = await invoke<UserProfile | null>("current_session");
        if (!cancelled) setEmployeeId(profile?.user_id ?? null);
      } catch {
        if (!cancelled) setEmployeeId(null);
      }
      // 登出 / 被踢时清空
      unlisten = await listen<{ reason?: string }>("auth:logged_out", () => {
        setEmployeeId(null);
      });
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return employeeId;
}
