import { useState } from "react";

import { Modal } from "@/components/ui/Modal";
import { showToast } from "@/components/ui/toast";
import { clearImageDimsCache } from "@/components/workbench/messages/imageDimsCache";
import { clearLoadedImageSrcs } from "@/components/workbench/messages/loadedImageSrcs";
import { useChatStore } from "@/components/workbench/messages/store/chatStore";
import { clearChatMessages } from "@/lib/api/messageHistory";
import { cn } from "@/lib/utils";

/**
 * 清除聊天记录确认弹窗。被个人信息卡片(Sidebar 的 ProfilePopover)复用。
 *
 * 成功后:① 后端已删本地消息行 + 水位窗;② 这里同步清前端内存(reset 会话 store +
 * 图片缓存),与"切换员工"时的清理路径一致(见 useMessageHistory)。仅清本地缓存,
 * 不动服务端;重新打开会话会按需重新同步。
 */
export function ClearHistoryConfirmDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(false);

  const handleClear = async () => {
    if (loading) return;
    setLoading(true);
    try {
      await clearChatMessages();
      // 与切换员工同款清理:清空内存 store + 图片相关缓存,让已打开会话即时变空。
      useChatStore.getState().reset();
      clearImageDimsCache();
      clearLoadedImageSrcs();
      showToast("聊天记录已清除", { type: "success" });
      onClose();
    } catch (err) {
      showToast(`清除失败:${err instanceof Error ? err.message : String(err)}`, {
        type: "error",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal open={open} onClose={loading ? () => {} : onClose} labelledBy="clear-history-title">
      <div className="px-6 pb-5 pt-6">
        <h2 id="clear-history-title" className="text-[15px] font-semibold text-workbench-text">
          确定清除聊天记录？
        </h2>
        <p className="mt-2 text-[12.5px] leading-relaxed text-workbench-text-muted">
          将删除本地缓存的全部聊天消息,此操作不可撤销。
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
            onClick={handleClear}
            disabled={loading}
            className={cn(
              "focus-ring h-9 rounded-lg px-4 text-[13px] font-medium text-white transition-colors",
              "bg-workbench-danger hover:opacity-90 disabled:opacity-60",
            )}
          >
            {loading ? "清除中…" : "清除"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
