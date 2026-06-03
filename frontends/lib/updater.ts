import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

import { showToast } from "@/components/ui/toast";

// ─── 更新弹窗单例 store ───────────────────────────────────────────────────────
//
// 仿 toast.tsx 的单例 pub-sub:updater.ts 维护更新状态,UpdateDialogViewport 通过
// useSyncExternalStore 订阅渲染。调用方(App 启动自查 / UserMenu 手动点)只调
// checkForAppUpdates(),不感知 UI;弹窗按钮调 startUpdateDownload / dismissUpdate。

export type UpdaterState =
  | { phase: "idle" }
  | { phase: "available"; version: string; body: string }
  | { phase: "downloading"; version: string; percent: number }
  | { phase: "error"; message: string };

let state: UpdaterState = { phase: "idle" };
const listeners = new Set<() => void>();
// check() 命中后保留 Update 实例,供「立即更新」时下载安装。
let pending: Update | null = null;

function setState(next: UpdaterState) {
  state = next;
  for (const listener of listeners) listener();
}

export function subscribeUpdater(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getUpdaterState(): UpdaterState {
  return state;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 检查更新。silent=true 为启动自查(无更新/出错都不打扰);silent=false 为用户手动
 * 点「检查更新」(无更新给 toast 提示,出错给 error toast)。命中新版本则置 available,
 * 由 UpdateDialogViewport 弹出确认。
 */
export async function checkForAppUpdates(opts: { silent?: boolean } = {}) {
  const { silent = false } = opts;
  // 下载中再次触发(如启动自查与手动点撞上)直接忽略,避免打断进行中的更新。
  if (state.phase === "downloading") return;
  try {
    const update = await check();
    if (!update) {
      if (!silent) showToast("已是最新版本", { type: "info" });
      return;
    }
    pending = update;
    setState({ phase: "available", version: update.version, body: update.body ?? "" });
  } catch (err) {
    if (silent) {
      console.error("[updater] check failed", err);
    } else {
      showToast(`检查更新失败:${errMessage(err)}`, { type: "error" });
    }
  }
}

/** 用户点「立即更新」/「重试」:下载并安装,完成后重启。进度写入 store。 */
export async function startUpdateDownload() {
  if (!pending) return;
  const version = pending.version;
  setState({ phase: "downloading", version, percent: 0 });
  let total: number | undefined;
  let downloaded = 0;
  try {
    await pending.downloadAndInstall((event: DownloadEvent) => {
      if (event.event === "Started") {
        total = event.data.contentLength;
      } else if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
        const percent = total ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;
        setState({ phase: "downloading", version, percent });
      } else if (event.event === "Finished") {
        setState({ phase: "downloading", version, percent: 100 });
      }
    });
    await relaunch();
  } catch (err) {
    setState({ phase: "error", message: errMessage(err) });
  }
}

/** 关闭弹窗(「稍后」/ 错误「关闭」):回到 idle 并释放 pending。 */
export function dismissUpdate() {
  pending = null;
  setState({ phase: "idle" });
}
