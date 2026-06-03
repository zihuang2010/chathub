// 接待列表同步状态色点(R7:多状态版)。
//
// 派生优先级(高 → 低):
//   1. error  != null         → 红 "错误: <msg>"  (来自 hook.error,网络/解析失败等)
//   2. resyncing  = true      → 蓝 "对齐中..."    (收到 hub:resync 信号期间)
//   3. connectionState ≠ subscribed → 橙 "连接中..." / "离线"  (Subscribe 流断开)
//   4. 时间档(原逻辑)         → 绿 / 黄 / 红
//
// 输入纪律:所有输入由 useRecentFriends 暴露。本组件不做 invoke / listen。
// 红点 (stale / offline / error) 可点击,触发 onRefresh。

import { useEffect, useState } from "react";

import type { HubConnectionState } from "@/lib/data/useResource";
import { cn } from "@/lib/utils";

const THRESHOLD_FRESH_MS = 30_000;
const THRESHOLD_STALE_MS = 5 * 60_000;
// 单位:ms。"Xs"档每秒刷,"Xm"档每分钟刷。fresh/stale/远端态不刷。
const SECOND = 1_000;
const MINUTE = 60_000;

/** 跟 Rust ConnectionState (serde tagged) 对齐。复用 useResource 的单一来源,避免类型副本漂移
 *  (含 rejected 终态)。`null` = 还没拿到任何 hub:connection。 */
export type ConnectionStatePayload = HubConnectionState;

export interface SyncStatusBadgeProps {
  /** 最近一次收到 recent_friends_changed 的本地 ms;null = 还没收到过。 */
  lastEventAt: number | null;
  /** 最近一次 refresh / refetchCache 成功的本地 ms;null = 还没成功过。 */
  lastRefreshAt: number | null;
  /** Subscribe 流状态。null = 还没接到首条 hub:connection,按"假设新鲜"处理。 */
  connectionState: ConnectionStatePayload | null;
  /** Hook 暴露的错误信息(网络错 / 解析错等)。null = 无错。 */
  error: string | null;
  /** 收到 hub:resync 信号后期间为 true(强制重拉对齐进行中)。 */
  resyncing: boolean;
  /** 红点(各 stale / offline / error 态)点击触发的强制刷新。 */
  onRefresh: () => void;
}

type Tone = "fresh" | "warn" | "stale" | "resyncing" | "offline" | "error";

interface Derived {
  tone: Tone;
  label: string;
  tooltip: string;
  clickable: boolean;
}

function deriveStatus(props: SyncStatusBadgeProps, now: number): Derived {
  const { error, resyncing, connectionState, lastEventAt, lastRefreshAt } = props;

  // 优先级 1:error
  if (error) {
    return {
      tone: "error",
      label: "出错",
      tooltip: `错误: ${error}(点此重试)`,
      clickable: true,
    };
  }

  // 优先级 2:resyncing
  if (resyncing) {
    return {
      tone: "resyncing",
      label: "对齐中…",
      tooltip: "正在与服务端全量对齐(收到 resync 信号)",
      clickable: false,
    };
  }

  // 优先级 3:连接态非 subscribed
  if (connectionState && connectionState.state !== "subscribed") {
    if (connectionState.state === "connecting") {
      return {
        tone: "offline",
        label: "连接中…",
        tooltip: "正在连接服务端",
        clickable: false,
      };
    }
    if (connectionState.state === "rejected") {
      // 鉴权被拒终态(verifyToken allowed=false / 会话失效):重试无意义 → 不可点;透传后台 reject 文案。
      return {
        tone: "offline",
        label: "未登录",
        tooltip: connectionState.message || "登录状态已失效,请重新登录",
        clickable: false,
      };
    }
    // disconnected:网络暂断,自动重连(点此立即刷新)
    return {
      tone: "offline",
      label: "离线",
      tooltip: "已与服务端断开,正在重连(点此立即刷新)",
      clickable: true,
    };
  }

  // 优先级 4:时间档
  const lastActive = Math.max(lastEventAt ?? 0, lastRefreshAt ?? 0);
  if (lastActive === 0) {
    return {
      tone: "stale",
      label: "未同步",
      tooltip: "未同步,点此刷新",
      clickable: true,
    };
  }
  const delta = now - lastActive;
  const short = humanizeDelta(delta);
  const long = humanizeDeltaLong(delta);
  if (delta < THRESHOLD_FRESH_MS) {
    return {
      tone: "fresh",
      label: "在线",
      tooltip: `在线 · ${long}更新`,
      clickable: false,
    };
  }
  if (delta < THRESHOLD_STALE_MS) {
    return {
      // 紧凑形态:Xm / Xs(单 token,Sidebar 窄列也能放下);完整中文进 tooltip
      tone: "warn",
      label: short,
      tooltip: `${long}未更新`,
      clickable: false,
    };
  }
  return {
    tone: "stale",
    label: "离线",
    tooltip: `${long}未更新,点此刷新`,
    clickable: true,
  };
}

/**
 * 紧凑相对时间(给 Sidebar 窄列 label 用):刚刚 / Xs / Xm / Xh。
 * 完整中文形态(如"1 分钟前")放在 tooltip 里,鼠标 hover 可见。
 */
function humanizeDelta(ms: number): string {
  if (ms < 1_000) return "刚刚";
  const sec = Math.floor(ms / 1_000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hour = Math.floor(min / 60);
  return `${hour}h`;
}

/** Tooltip 用的完整中文相对时间。 */
function humanizeDeltaLong(ms: number): string {
  if (ms < 1_000) return "刚刚";
  const sec = Math.floor(ms / 1_000);
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  return `${hour} 小时前`;
}

const TONE_STYLES: Record<Tone, { dot: string; text: string; hoverBg: string }> = {
  fresh: { dot: "bg-emerald-500", text: "text-emerald-700", hoverBg: "" },
  warn: { dot: "bg-amber-500", text: "text-amber-700", hoverBg: "" },
  stale: { dot: "bg-rose-500", text: "text-rose-700", hoverBg: "hover:bg-rose-50" },
  resyncing: { dot: "bg-sky-500", text: "text-sky-700", hoverBg: "" },
  offline: { dot: "bg-orange-500", text: "text-orange-700", hoverBg: "hover:bg-orange-50" },
  error: { dot: "bg-rose-600", text: "text-rose-800", hoverBg: "hover:bg-rose-50" },
};

export function SyncStatusBadge(props: SyncStatusBadgeProps) {
  // 按需 tick:只有 label 依赖经过时间时才唤醒,其它态(fresh/resyncing/offline/error/stale)
  // 不挂 interval。具体策略写在下面 useEffect。每次 setNow 都重排下一档 timeout。
  // 之前用 1s setInterval 全程 tick,在大多数态(label 固定)下纯属空转。
  const [now, setNow] = useState(() => Date.now());

  const { error, resyncing, connectionState, lastEventAt, lastRefreshAt } = props;
  useEffect(() => {
    if (error) return;
    if (resyncing) return;
    if (connectionState && connectionState.state !== "subscribed") return;
    const lastActive = Math.max(lastEventAt ?? 0, lastRefreshAt ?? 0);
    if (lastActive === 0) return;
    const delta = Date.now() - lastActive;
    let nextTickMs: number;
    if (delta < THRESHOLD_FRESH_MS) {
      // fresh:label="在线" 固定,只需在临界点叫醒一次让 tone 切到 warn。
      nextTickMs = THRESHOLD_FRESH_MS - delta + 50;
    } else if (delta < MINUTE) {
      // warn "Xs":每秒变。
      nextTickMs = SECOND;
    } else if (delta < THRESHOLD_STALE_MS) {
      // warn "Xm":每分钟变。
      nextTickMs = MINUTE;
    } else {
      // stale 之后 label="离线" 不变,不再 tick。
      return;
    }
    const id = setTimeout(() => setNow(Date.now()), nextTickMs);
    return () => clearTimeout(id);
  }, [now, error, resyncing, connectionState, lastEventAt, lastRefreshAt]);

  const { tone, label, tooltip, clickable } = deriveStatus(props, now);
  const styles = TONE_STYLES[tone];

  return (
    <button
      type="button"
      title={tooltip}
      aria-label={tooltip}
      onClick={clickable ? props.onRefresh : undefined}
      disabled={!clickable}
      className={cn(
        // 强制单行 + max-w 兜底:在窄容器(Sidebar w-36)下也不换行,超长时省略。
        "inline-flex max-w-full items-center gap-1 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[11px] font-medium leading-none transition-colors",
        styles.text,
        clickable ? `cursor-pointer ${styles.hoverBg}` : "cursor-default",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "inline-block size-1.5 shrink-0 rounded-full",
          styles.dot,
          tone === "resyncing" && "animate-pulse",
          tone === "offline" &&
            connectionStateIsConnecting(props.connectionState) &&
            "animate-pulse",
        )}
      />
      <span className="truncate">{label}</span>
    </button>
  );
}

function connectionStateIsConnecting(cs: ConnectionStatePayload | null): boolean {
  return cs?.state === "connecting";
}
