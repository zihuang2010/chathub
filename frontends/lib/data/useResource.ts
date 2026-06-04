// useResource — 通用的"订阅 + 拉取"hook。
//
// 把以前散在每个 hook 里的横切关注点集中:
//   - mount 时 queryFn 一次
//   - 订阅 ChangeBus,匹配 topic + scope 时自动 refetch
//   - 90s 静默探活
//   - 前台聚焦刷新(Tauri window focus)
//   - hub:resync 信号(全量重拉) → setResyncing + refetch
//   - hub:connection 状态(给 SyncStatusBadge 用)
//
// 设计纪律:
//   - 不做缓存共享(每个实例独立 state) —— 多实例共享数据靠 ChangeBus 通知一致刷新
//   - 不做 optimistic update(写命令由调用方直接 invoke,后端 emit ChangeNotice 后自动 refetch)
//   - queryFn 应该幂等

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { changeBus } from "./changeBus";
import type { ChangeNotice, ChangeScope, ChangeTopic } from "./types";

/** Subscribe 流连接态(对齐 Rust ConnectionState,serde tagged)。 */
export type HubConnectionState =
  | { state: "connecting" }
  | { state: "subscribed" }
  | { state: "disconnected"; lastError?: unknown }
  // 鉴权被拒终态(verifyToken allowed=false / 会话失效):后端不再重试,code/message 透传后台 reject 文案。
  | { state: "rejected"; code: string; message: string };

export interface UseResourceOptions<T> {
  topic: ChangeTopic;
  /** 订阅范围 —— 既是 ChangeBus 过滤条件,也是 queryFn 的入参。 */
  scope: ChangeScope;
  /** 数据拉取函数。scope 由 hook 透传(便于子查询拼参数)。 */
  queryFn: (scope: ChangeScope) => Promise<T>;
  /** 默认 true。false 时不拉数据也不订阅。 */
  enabled?: boolean;
  /** 90s 无任何活跃(事件 / refresh)→ 主动 refresh。0 关闭。 */
  silentProbeMs?: number;
  /** Tauri window focus 距上次 refresh >30s → 自动 refresh。 */
  refetchOnFocus?: boolean;
}

export interface UseResourceResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  // 同步状态可观察性(给 SyncStatusBadge 用)
  lastEventAt: number | null;
  lastRefreshAt: number | null;
  resyncing: boolean;
  connectionState: HubConnectionState | null;
  /**
   * 首次 queryFn 是否已经返回(无论 data 是空数组还是非空)。
   *
   * 用于消费方"首屏数据门":未 true 时认为本地 cache 还没读出来,UI 应该展示骨架,
   * 避免假数据先渲染再被真数据覆盖造成的闪烁。true 后**只前进**,后续 refetch
   * (切 scope / 静默探活 / focus 刷新 / resync)不会回退它。
   *
   * 与 `data !== null` 的区别:cache 命中且空列表时 `setData([])` 同样非 null,
   * 但 `null vs []` 在消费方读起来 fragile;`initialFetched` 是显式单调布尔。
   */
  initialFetched: boolean;
  /**
   * 当前 `data` 取自的 scope 与当前 scope 不一致 —— 即 scope 刚变(如切账号筛选)、
   * 新 scope 的数据尚未返回的窗口期。期间 `data` 仍是上一个 scope 的旧数据
   * (stale-while-revalidate),消费方可据此渲染骨架,避免"旧 scope 数据残留一瞬再突变"的闪烁。
   *
   * 与 `initialFetched` 互补:后者管首屏(data 还没有过任何值),前者管 scope 切换
   * (data 有值但属于上一个 scope)。data 为 null(尚无任何数据)时恒 false。
   */
  isStale: boolean;
}

const DEFAULT_SILENT_PROBE_MS = 90_000;
const SILENT_PROBE_CHECK_INTERVAL_MS = 30_000;
const FOCUS_REFETCH_THRESHOLD_MS = 30_000;

function errorMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}

/**
 * 序列化 scope 作为 useEffect 依赖项。
 * scope 是 object,直接放 deps 会每次 render 都触发(引用不等)。
 * JSON.stringify 简单稳定 —— scope 字段都是基本类型 string。
 */
function scopeKey(scope: ChangeScope): string {
  return JSON.stringify(scope);
}

export function useResource<T>(opts: UseResourceOptions<T>): UseResourceResult<T> {
  const {
    topic,
    scope,
    queryFn,
    enabled = true,
    silentProbeMs = DEFAULT_SILENT_PROBE_MS,
    refetchOnFocus = true,
  } = opts;

  const [data, setData] = useState<T | null>(null);
  // 当前 data 取自的 scope 序列化键;与当前 scopeStr 比较得出 isStale(见 return)。
  const [dataScopeStr, setDataScopeStr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  // 初始 Date.now():冷启动假设新鲜,5min 没动静才显 stale(对齐 SyncStatusBadge 派生规则)
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(() => Date.now());
  const [resyncing, setResyncing] = useState(false);
  const [connectionState, setConnectionState] = useState<HubConnectionState | null>(null);
  // 单调向前的"首次拉取已完成"门;首次 queryFn settle 后 setTrue,后续不再 setState
  // (在 setter 内部判断,避免每次 fetch 都 schedule 新 render)。
  const [initialFetched, setInitialFetched] = useState(false);

  // refs 用于 effect 内拿最新值,避免 stale closure。
  // 初始 0,下面 effect 会立即把 lastRefreshAt(useState initializer 已置 Date.now)同步进来。
  const lastRefreshAtRef = useRef<number>(0);
  const lastEventAtRef = useRef<number | null>(null);
  const queryFnRef = useRef(queryFn);
  const scopeRef = useRef(scope);
  useEffect(() => {
    queryFnRef.current = queryFn;
  }, [queryFn]);
  useEffect(() => {
    scopeRef.current = scope;
  }, [scope]);
  useEffect(() => {
    if (lastRefreshAt !== null) lastRefreshAtRef.current = lastRefreshAt;
  }, [lastRefreshAt]);
  useEffect(() => {
    lastEventAtRef.current = lastEventAt;
  }, [lastEventAt]);

  // D5: inflight 去重 —— 并发调用复用同一个 promise。多个事件几乎同时到(常见于
  // ChangeBus 一次 dispatch 触发同一 hook 多 listener 同时 refetch),不去重就是 N
  // 路并发 IPC + setState 竞争。inflightRef 仅在 promise resolve/reject 后置回 null。
  const inflightRef = useRef<Promise<void> | null>(null);
  const doFetch = useCallback(async () => {
    if (inflightRef.current) return inflightRef.current;
    const promise = (async () => {
      setLoading(true);
      // 捕获本次拉取所用 scope:queryFn 同步读 scopeRef.current(无 await 间隔,不会被
      // 后续 scope 变更串改),据此把结果归属到正确 scope,供 isStale 判定。
      const fetchScopeStr = scopeKey(scopeRef.current);
      try {
        const result = await queryFnRef.current(scopeRef.current);
        setData(result);
        setDataScopeStr(fetchScopeStr);
        setLastRefreshAt(Date.now());
        setError(null);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setLoading(false);
        // 即使 queryFn 抛错也置 initialFetched(消费方"知道结果"的语义包含失败结果);
        // 用 functional updater + 等值判断,避免 true→true 触发额外 render。
        setInitialFetched((prev) => (prev ? prev : true));
      }
    })();
    inflightRef.current = promise.finally(() => {
      inflightRef.current = null;
    });
    return inflightRef.current;
  }, []);

  // 显式 refresh 接口 —— 给 UI 按钮 / SyncStatusBadge 红点点击用
  const refresh = useCallback(async () => {
    await doFetch();
  }, [doFetch]);

  // mount + scope 变化时拉一次 + 订阅 ChangeBus
  const scopeStr = scopeKey(scope);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    void (async () => {
      // 启动全局 listener(幂等)
      await changeBus.start();
      // 初次拉
      if (!cancelled) await doFetch();
    })();

    const unsubscribe = changeBus.subscribe(topic, scope, (notice: ChangeNotice) => {
      if (cancelled) return;
      setLastEventAt(Date.now());
      if (notice.source === "resync") {
        setResyncing(true);
        void doFetch().finally(() => setResyncing(false));
      } else {
        void doFetch();
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
    // scope 变化用 scopeStr 字符串 key 触发重订阅
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic, scopeStr, enabled, doFetch]);

  // 静默探活
  // 用 ref 读 lastEventAt 而非 deps:每收一条事件就重建 interval 会让"30s 检查"窗口反复
  // 重置(永远轮不到 fire)。改 ref 后 interval 只在 enabled / silentProbeMs / doFetch
  // 变化时重建,平时一直跑,内部读最新值判断是否触发。
  useEffect(() => {
    if (!enabled || silentProbeMs <= 0) return;
    const id = setInterval(() => {
      const lastActive = Math.max(lastEventAtRef.current ?? 0, lastRefreshAtRef.current);
      if (Date.now() - lastActive > silentProbeMs) {
        void doFetch();
      }
    }, SILENT_PROBE_CHECK_INTERVAL_MS);
    return () => clearInterval(id);
  }, [enabled, silentProbeMs, doFetch]);

  // 前台聚焦刷新
  useEffect(() => {
    if (!enabled || !refetchOnFocus) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      const win = getCurrentWindow();
      const un = await win.onFocusChanged(({ payload: focused }) => {
        if (!focused) return;
        if (Date.now() - lastRefreshAtRef.current > FOCUS_REFETCH_THRESHOLD_MS) {
          void doFetch();
        }
      });
      // await 期间组件可能已卸载:cleanup 早于此处赋值会空跑,导致监听器悬挂永不取消。
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
  }, [enabled, refetchOnFocus, doFetch]);

  // hub:connection 状态订阅
  useEffect(() => {
    if (!enabled) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    // 先订阅再读 hub_state 回填(见 useHubSyncStatus 同款修复):先读后订阅会在两步间
    // 留 IPC 间隙,漏掉登录瞬间唯一一次 subscribed 事件,使连接态卡在 connecting。
    void (async () => {
      let gotEvent = false;
      const un = await listen<HubConnectionState>("hub:connection", (event) => {
        if (cancelled) return;
        gotEvent = true;
        setConnectionState(event.payload);
      });
      // await 期间组件可能已卸载:cleanup 早于此处赋值会空跑,导致监听器悬挂永不取消。
      if (cancelled) {
        un();
        return;
      }
      unlisten = un;
      try {
        const init = await invoke<HubConnectionState>("hub_state");
        // 回填期间监听器已收到事件则不用更旧的快照覆盖。
        if (!cancelled && !gotEvent) setConnectionState(init);
      } catch {
        // 命令未就绪时静默
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [enabled]);

  // 连接态切回 subscribed 时强制 refetch(lagged 兜底)。
  // Tauri broadcast 通道在 buffer 满时会丢事件(Lagged),客户端永远不知道。表现为长时
  // 离线再重连后数据卡在旧状态。这里:disconnected/connecting → subscribed 跃迁时,
  // 不管 ChangeBus 有没有触发,主动重拉一次。初始 null → subscribed 不算跃迁(mount
  // 的初次 fetch 已经覆盖),disconnected→subscribed / connecting→subscribed 才算。
  const prevConnStateRef = useRef<HubConnectionState | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const prev = prevConnStateRef.current;
    prevConnStateRef.current = connectionState;
    if (!connectionState || connectionState.state !== "subscribed") return;
    if (!prev) return; // 初始 null → subscribed:mount fetch 已处理,不重复
    if (prev.state === "subscribed") return; // 同态变化,无效跃迁
    void doFetch();
  }, [enabled, connectionState, doFetch]);

  return {
    data,
    loading,
    error,
    refresh,
    lastEventAt,
    lastRefreshAt,
    resyncing,
    connectionState,
    initialFetched,
    // data 已有值且其归属 scope 与当前 scope 不符 → scope 切换在途,当前展示的是旧 scope 数据。
    isStale: data !== null && dataScopeStr !== null && dataScopeStr !== scopeStr,
  };
}
