import { useState } from "react";

import { Modal } from "@/components/ui/Modal";
import { showToast } from "@/components/ui/toast";
import { invokeWithTimeout } from "@/lib/api/invokeClient";
import { cn } from "@/lib/utils";

/**
 * 退出登录确认弹窗。被个人信息卡片(Sidebar 的 ProfilePopover)复用。
 *
 * 退出无需在此 setProfile —— 后端 `logout` 命令会 broadcast Manual,经 lib.rs 桥接为
 * `auth:logged_out{reason:"manual"}`,App.tsx 监听后自动切回登录页(见 App.tsx C2)。
 */
export function LogoutConfirmDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [loading, setLoading] = useState(false);

  const handleLogout = async () => {
    if (loading) return;
    setLoading(true);
    try {
      await invokeWithTimeout<void>("logout");
      // 成功后无需在此处理:App.tsx 收到 auth:logged_out 事件会切回登录页并卸载本组件。
    } catch (err) {
      showToast(`退出失败:${err instanceof Error ? err.message : String(err)}`, {
        type: "error",
      });
      setLoading(false);
    }
  };

  return (
    <Modal open={open} onClose={loading ? () => {} : onClose} labelledBy="logout-title">
      <div className="px-6 pb-5 pt-6">
        <h2 id="logout-title" className="text-[15px] font-semibold text-workbench-text">
          确定退出登录？
        </h2>
        <p className="mt-2 text-[12.5px] leading-relaxed text-workbench-text-muted">
          退出后需重新登录才能继续使用。
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="focus-ring h-9 rounded-lg border border-workbench-line px-4 text-[13px] font-medium text-workbench-text transition-colors hover:bg-workbench-surface-subtle disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleLogout}
            disabled={loading}
            className={cn(
              "focus-ring h-9 rounded-lg px-4 text-[13px] font-medium text-white transition-colors",
              "bg-workbench-danger hover:opacity-90 disabled:opacity-60",
            )}
          >
            {loading ? "退出中…" : "退出"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
