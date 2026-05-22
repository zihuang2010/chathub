// useHubSyncStatus — 应用级 hub 同步状态(不绑定具体资源 topic)。
//
// 跟 useResource 的同步状态区别:
//   - useResource 内的 connectionState / lastEventAt / resyncing 都是 per-instance,
//     需要 topic + scope + queryFn 才能用,只能给"列表页"用
//   - useHubSyncStatus 是 app-level singleton-like(每个实例独立 listen,但语义一致),
//     给 Sidebar / TitleBar 等"跨页全局组件"用,只读元状态
//
// 监听:
//   - hub:connection → connectionState
//   - hub:change(任何 topic / source) → lastEventAt
//   - hub:resync 或 hub:change source=resync → resyncing(2s 后自动复位)

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { ChangeNotice } from "./types";
import type { HubConnectionState } from "./useResource";

export interface UseHubSyncStatusResult {
  connectionState: HubConnectionState | null;
  lastEventAt: number | null;
  lastRefreshAt: number | null;
  resyncing: boolean;
  /** 点击红点的兜底动作 — 仅本地标记"刚刚活跃",不发起任何业务请求。
   *  具体页的"刷新"由该页自己的按钮负责;Sidebar 不跨页触发 refetch。 */
  refresh: () => Promise<void>;
}

const RESYNC_INDICATOR_MS = 2000;

export function useHubSyncStatus(): UseHubSyncStatusResult {
  const [connectionState, setConnectionState] = useState<HubConnectionState | null>(null);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  // 初始 Date.now() 让冷启动假设"刚刚活跃",避免开屏色点突然变红。
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(() => Date.now());
  const [resyncing, setResyncing] = useState(false);

  // hub:connection
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const init = await invoke<HubConnectionState>("hub_state");
        if (!cancelled) setConnectionState(init);
      } catch {
        // hub_state 命令未就绪时静默
      }
      unlisten = await listen<HubConnectionState>("hub:connection", (event) => {
        if (!cancelled) setConnectionState(event.payload);
      });
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // hub:change(任何 ChangeNotice 都算"应用级活跃")
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    let resyncTimer: number | undefined;
    void (async () => {
      unlisten = await listen<ChangeNotice>("hub:change", (event) => {
        if (cancelled) return;
        setLastEventAt(Date.now());
        if (event.payload.source === "resync") {
          setResyncing(true);
          if (resyncTimer !== undefined) window.clearTimeout(resyncTimer);
          resyncTimer = window.setTimeout(() => {
            if (!cancelled) setResyncing(false);
          }, RESYNC_INDICATOR_MS);
        }
      });
    })();
    return () => {
      cancelled = true;
      if (resyncTimer !== undefined) window.clearTimeout(resyncTimer);
      unlisten?.();
    };
  }, []);

  // hub:resync(独立 ResyncSignal 通道,与 hub:change source=resync 双触发)
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    let timer: number | undefined;
    void (async () => {
      unlisten = await listen("hub:resync", () => {
        if (cancelled) return;
        setResyncing(true);
        if (timer !== undefined) window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          if (!cancelled) setResyncing(false);
        }, RESYNC_INDICATOR_MS);
      });
    })();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      unlisten?.();
    };
  }, []);

  const refresh = useCallback(async () => {
    setLastRefreshAt(Date.now());
  }, []);

  return {
    connectionState,
    lastEventAt,
    lastRefreshAt,
    resyncing,
    refresh,
  };
}
