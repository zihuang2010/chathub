import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export async function checkForAppUpdates(opts: { silent?: boolean } = {}) {
  const { silent = false } = opts;
  try {
    const update = await check();
    if (!update) {
      if (!silent) console.info("[updater] already up to date");
      return;
    }
    const ok = window.confirm(
      `检测到新版本 ${update.version}，是否立即更新？\n\n${update.body ?? ""}`,
    );
    if (!ok) return;
    await update.downloadAndInstall();
    await relaunch();
  } catch (err) {
    if (!silent) console.error("[updater] check failed", err);
  }
}
