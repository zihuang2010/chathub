// useNewMessageFlash — 新消息提醒。两路提醒,各管一个场景:
//
//   1. 托盘红点(主力,关到托盘也可见):有未读且窗口未获焦时,调后端 `set_tray_unread(总未读)`
//      给系统托盘图标叠红点 + tooltip "ChatHub · N 条新消息";窗口获焦或未读归零 →
//      `set_tray_unread(0)` 复原。关闭到托盘后没有任务栏按钮可闪,托盘红点是唯一可见提醒。
//   2. 任务栏闪烁(窗口未获焦但仍有任务栏按钮 —— 最小化 / 可见但失焦):服务端推送的新增
//      消息到达 → `requestUserAttention(Critical)`,任务栏按钮持续闪烁直到窗口获焦。
//      为何 Critical 而非 Informational:tao 0.35 下 Critical=FLASHW_ALL|FLASHW_TIMERNOFG(持续闪
//      到获焦),Informational=FLASHW_TRAY 仅闪 4 下即停 —— 最小化场景一晃而过、极易错过。
//      窗口已隐藏(关到托盘,无任务栏按钮)则跳过,只靠托盘红点。
//
// 未读总数复用 useRecentFriends(全部账号),它是本地 cache 单一真相源(list_top + 事件保鲜);
// 与消息页默认 scope 同键,filledScopes 去重,通常不产生额外远端预填。
//
// 已知取舍:ChangeNotice 不带消息方向,多端同步回灌「自己另一端发的消息」也是 server-event,
// 会让红点/轻提示轻微误触发。要精准需读那条消息 direction,留待后续。

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";

import { changeBus } from "./changeBus";
import { playNotificationSound } from "./notificationSound";
import { useSettingsStore } from "./settingsStore";
import type { ChangeNotice } from "./types";
import { useRecentFriends } from "@/lib/api/useRecentFriends";

const ATTENTION_COOLDOWN_MS = 1500;

// ─── 可单测纯逻辑 ────────────────────────────────────────────────────────────

/** 该送给托盘的未读数:获焦时一律 0(获焦即收敛红点),否则取总未读(下限 0)。 */
export function trayUnreadCount(focused: boolean, totalUnread: number): number {
  if (focused) return 0;
  return totalUnread > 0 ? totalUnread : 0;
}

/** 是否够格触发任务栏轻提示:服务端推送的新增消息 + 窗口「可见但失焦」。
 *  窗口隐藏(关到托盘)时返回 false —— 无任务栏按钮可闪,交给托盘红点。 */
export function shouldFlashTaskbar(
  notice: Pick<ChangeNotice, "kind" | "source">,
  ctx: { focused: boolean; visible: boolean },
): boolean {
  return (
    notice.kind === "upsert" && notice.source === "server-event" && !ctx.focused && ctx.visible
  );
}

/** 是否够格播放提示音:服务端推送的新增消息 + 窗口未获焦。
 *  与任务栏闪烁不同,窗口隐藏(关到托盘)也响 —— 此时声音反而是更重要的提醒通道。 */
export function shouldPlaySound(
  notice: Pick<ChangeNotice, "kind" | "source">,
  ctx: { focused: boolean },
): boolean {
  return notice.kind === "upsert" && notice.source === "server-event" && !ctx.focused;
}

async function setTrayUnread(count: number): Promise<void> {
  try {
    await invoke("set_tray_unread", { count });
  } catch {
    // 非 Tauri 运行时(纯 Vite 预览 / 单测)无此命令,忽略。
  }
}

// ─── Hook ────────────────────────────────────────────────────────────────────

// employeeId 由调用方(App)从权威登录态 profile 传入,而非内部 useCurrentEmployeeId 自读:
// 本 hook 挂在 App 顶层、登录【之前】就 mount,自读 current_session 会拿到 null,且因
// useCurrentEmployeeId 不监听登录而永久停在 null —— 登录后红点/闪烁全程失效(需重启才恢复)。
// 改由 profile 驱动后,登录瞬间 employeeId 变化即触发两个 effect 重跑,无需重启。
export function useNewMessageFlash(employeeId: string | null): void {
  // 全部账号的未读总数;useRecentFriends 内部按登录态 enabled,登出时 items 为空。
  const { items } = useRecentFriends({ accountFilter: null });
  const totalUnread = items.reduce((sum, it) => sum + (it.unreadCount > 0 ? it.unreadCount : 0), 0);

  // 设置页的通知开关(跟随登录账号):托盘红点 / 任务栏闪烁 / 声音。
  const notify = useSettingsStore((s) => s.settings.notify);

  // 窗口焦点态(初始读一次 + onFocusChanged 跟踪)。默认 true:常规启动即获焦,
  // 万一启动即失焦,isFocused() 解析后会立即纠正。
  const [focused, setFocused] = useState(true);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    const win = getCurrentWindow();
    void win
      .isFocused()
      .then((f) => {
        if (!disposed) setFocused(f);
      })
      .catch(() => {});
    void win
      .onFocusChanged(({ payload }) => setFocused(payload))
      .then((u) => {
        if (disposed) u();
        else unlisten = u;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // 驱动托盘红点。lastSentRef 去重,避免每次 render 重复打 IPC。
  // 设置关闭时恒送 0(关闭瞬间也把已亮的红点收掉)。
  const lastSentRef = useRef<number | null>(null);
  useEffect(() => {
    const next = employeeId && notify.trayFlash ? trayUnreadCount(focused, totalUnread) : 0;
    if (lastSentRef.current === next) return;
    lastSentRef.current = next;
    void setTrayUnread(next);
  }, [employeeId, focused, totalUnread, notify.trayFlash]);

  // 任务栏闪烁:新入站消息 + 窗口未获焦但仍有任务栏按钮(最小化 / 可见失焦)时持续闪。
  // 冷会话新消息只更新接待列表,故 conversation-messages / recent-sessions 两个 topic 都听。
  useEffect(() => {
    if (!employeeId) return;
    let lastAttentionAt = 0;
    let lastSoundAt = 0;
    const onNotice = (notice: ChangeNotice) => {
      void (async () => {
        const win = getCurrentWindow();
        const focusedNow = await win.isFocused();
        const now = Date.now();
        // 声音提醒:窗口隐藏(关到托盘)也响;独立冷却,与闪烁互不影响。
        if (
          notify.sound &&
          shouldPlaySound(notice, { focused: focusedNow }) &&
          now - lastSoundAt >= ATTENTION_COOLDOWN_MS
        ) {
          lastSoundAt = now;
          playNotificationSound();
        }
        if (!notify.taskbarFlash) return;
        const visibleNow = await win.isVisible();
        if (!shouldFlashTaskbar(notice, { focused: focusedNow, visible: visibleNow })) return;
        if (now - lastAttentionAt < ATTENTION_COOLDOWN_MS) return;
        lastAttentionAt = now;
        await win.requestUserAttention(UserAttentionType.Critical);
      })();
    };
    const offMessages = changeBus.subscribe("conversation-messages", { employeeId }, onNotice);
    const offRecents = changeBus.subscribe("recent-sessions", { employeeId }, onNotice);
    return () => {
      offMessages();
      offRecents();
    };
  }, [employeeId, notify.sound, notify.taskbarFlash]);
}
