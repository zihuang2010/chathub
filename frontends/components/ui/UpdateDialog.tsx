import { useSyncExternalStore } from "react";

import { Modal } from "@/components/ui/Modal";
import {
  dismissUpdate,
  getUpdaterState,
  startUpdateDownload,
  subscribeUpdater,
} from "@/lib/updater";

// 复用 ClearHistoryConfirmDialog 同款按钮样式,保持弹窗风格统一。
const BTN_SECONDARY =
  "focus-ring h-9 rounded-lg border border-workbench-line px-4 text-[13px] font-medium text-workbench-text transition-colors hover:bg-workbench-surface-subtle";
const BTN_PRIMARY =
  "focus-ring h-9 rounded-lg bg-workbench-accent px-4 text-[13px] font-medium text-white transition-colors hover:opacity-90";

/**
 * 应用更新弹窗。订阅 updater store(单例 pub-sub),按状态机渲染:
 * available(确认)→ downloading(进度)→ error(失败)。idle 时不渲染。
 * 挂在 App 根,登录前后均覆盖(启动自查与手动「检查更新」共用)。
 */
export function UpdateDialogViewport() {
  const state = useSyncExternalStore(subscribeUpdater, getUpdaterState, getUpdaterState);

  if (state.phase === "available") {
    return (
      <Modal open onClose={dismissUpdate} labelledBy="update-title">
        <div className="px-6 pb-5 pt-6">
          <h2 id="update-title" className="text-[15px] font-semibold text-workbench-text">
            发现新版本 v{state.version}
          </h2>
          <p className="mt-2 whitespace-pre-wrap text-[12.5px] leading-relaxed text-workbench-text-muted">
            {state.body || "是否立即更新到最新版本？"}
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" onClick={dismissUpdate} className={BTN_SECONDARY}>
              稍后
            </button>
            <button
              type="button"
              onClick={() => void startUpdateDownload()}
              className={BTN_PRIMARY}
            >
              立即更新
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  if (state.phase === "downloading") {
    // 下载中锁住弹窗(onClose 空函数),避免中途关闭导致安装中断。
    return (
      <Modal open onClose={() => {}} labelledBy="update-progress-title">
        <div className="px-6 pb-5 pt-6">
          <h2 id="update-progress-title" className="text-[15px] font-semibold text-workbench-text">
            正在下载更新…
          </h2>
          <p className="mt-2 text-[12.5px] leading-relaxed text-workbench-text-muted">
            v{state.version} 下载完成后将自动重启。
          </p>
          <div className="mt-4 flex items-center gap-3">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-workbench-surface-subtle">
              <div
                className="h-full bg-workbench-accent transition-all"
                style={{ width: `${state.percent}%` }}
              />
            </div>
            <span className="wb-num shrink-0 text-[12px] font-medium text-workbench-text-muted">
              {state.percent}%
            </span>
          </div>
        </div>
      </Modal>
    );
  }

  if (state.phase === "error") {
    return (
      <Modal open onClose={dismissUpdate} labelledBy="update-error-title">
        <div className="px-6 pb-5 pt-6">
          <h2 id="update-error-title" className="text-[15px] font-semibold text-workbench-text">
            更新失败
          </h2>
          <p className="mt-2 whitespace-pre-wrap text-[12.5px] leading-relaxed text-workbench-text-muted">
            {state.message}
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" onClick={dismissUpdate} className={BTN_SECONDARY}>
              关闭
            </button>
            <button
              type="button"
              onClick={() => void startUpdateDownload()}
              className={BTN_PRIMARY}
            >
              重试
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  return null;
}
