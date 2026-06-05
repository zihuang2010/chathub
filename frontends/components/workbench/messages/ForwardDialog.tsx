import { useMemo, useState } from "react";
import { Check, Search, X } from "lucide-react";

import { Modal } from "@/components/ui/Modal";
import { cn } from "@/lib/utils";

import { CustomerAvatar } from "./Avatar";
import { STRINGS } from "./strings";

/** 转发目标:由最近会话条目派生,携带发送所需的会话身份 + 展示字段。 */
export interface ForwardTarget {
  conversationId: string;
  wecomAccountId: string;
  externalUserId: string;
  name: string;
  avatar?: string;
  account: string;
}

/** 一次转发的目标上限(对齐企微弹层):最多选 50 个。 */
const MAX_TARGETS = 50;

interface ForwardDialogProps {
  /** 可转发到的最近会话(已在 MessagesPage 由 recentEntries 派生)。 */
  targets: ForwardTarget[];
  /** 被转发消息的文本,展示在右侧预览卡。 */
  previewText?: string;
  /** 点「确定」时一次性回传所有勾选目标:批量发送由上层处理(toast 成功/失败)。 */
  onForward: (targets: ForwardTarget[]) => void;
  onClose: () => void;
}

/**
 * 转发弹层(本期仅转发文本):双列布局——左侧搜索 + 最近会话多选勾选,右侧「已选择(N/50)」
 * + 被转发内容预览 + 取消/确定。点「确定」一次性把原消息批量转发给所有勾选目标。
 * 复用 ui/Modal;目标列表为"已加载的最近会话",搜索为本地按名字过滤。
 */
export function ForwardDialog({ targets, previewText, onForward, onClose }: ForwardDialogProps) {
  const [query, setQuery] = useState("");
  // 有序勾选 id:右侧「已选择」按勾选先后展示。
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // 在途守卫:点「确定」后置位,防关闭动画期间二次提交。
  const [submitting, setSubmitting] = useState(false);

  const targetById = useMemo(
    () => new Map(targets.map((t) => [t.conversationId, t] as const)),
    [targets],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return targets;
    return targets.filter((t) => t.name.toLowerCase().includes(q));
  }, [targets, query]);

  const selectedTargets = useMemo(
    () =>
      selectedIds
        .map((id) => targetById.get(id))
        .filter((t): t is ForwardTarget => t !== undefined),
    [selectedIds, targetById],
  );

  const atCap = selectedIds.length >= MAX_TARGETS;

  const toggle = (id: string) => {
    setSelectedIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= MAX_TARGETS) return prev; // 达上限忽略新增
      return [...prev, id];
    });
  };

  const handleConfirm = () => {
    if (!selectedIds.length || submitting) return;
    setSubmitting(true);
    onForward(selectedTargets);
    onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      ariaLabel={STRINGS.forward.title}
      className="flex h-[min(80vh,560px)] w-[min(92vw,720px)] flex-col rounded-[10px]"
    >
      {/* 顶部:标题 + 关闭。 */}
      <div className="flex shrink-0 items-center justify-between border-b border-workbench-line-subtle px-4 py-3">
        <span className="text-[15px] font-semibold text-workbench-text">
          {STRINGS.forward.title}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={STRINGS.forward.close}
          title={STRINGS.forward.close}
          className="focus-ring grid size-8 place-items-center rounded-lg text-workbench-text-muted transition-colors hover:bg-workbench-surface-subtle hover:text-workbench-accent"
        >
          <X size={16} strokeWidth={2} aria-hidden />
        </button>
      </div>

      {/* 主体:左侧选择 / 右侧已选。 */}
      <div className="flex min-h-0 flex-1">
        {/* 左列:搜索 + 三入口 + 最近聊天多选列表。 */}
        <div className="flex w-[300px] shrink-0 flex-col border-r border-workbench-line-subtle">
          {/* 搜索框。 */}
          <div className="shrink-0 px-3 pt-3">
            <div className="relative">
              <Search
                size={15}
                strokeWidth={1.8}
                aria-hidden
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-workbench-text-muted"
              />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={STRINGS.forward.searchPlaceholder}
                className="focus-ring w-full rounded-lg border border-workbench-line bg-workbench-surface-soft py-1.5 pl-8 pr-3 text-wb-xs text-workbench-text placeholder:text-workbench-text-muted"
              />
            </div>
          </div>

          {/* 最近聊天标题。 */}
          <div className="text-wb-3xs shrink-0 px-4 pb-1 pt-3 font-medium text-workbench-text-muted">
            {STRINGS.forward.recent}
          </div>

          {/* 最近会话列表(多选,点行切换勾选)。 */}
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {filtered.length === 0 ? (
              <div className="grid place-items-center py-10 text-wb-2xs text-workbench-text-muted">
                {STRINGS.forward.empty}
              </div>
            ) : (
              filtered.map((target) => {
                const checked = selectedIds.includes(target.conversationId);
                const disabled = !checked && atCap;
                return (
                  <button
                    key={target.conversationId}
                    type="button"
                    onClick={() => toggle(target.conversationId)}
                    disabled={disabled}
                    className={cn(
                      "focus-ring flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors",
                      disabled
                        ? "cursor-not-allowed opacity-40"
                        : "hover:bg-workbench-surface-subtle",
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "grid size-[18px] shrink-0 place-items-center rounded-md border transition-colors",
                        checked
                          ? "border-workbench-accent bg-workbench-accent text-white"
                          : "border-workbench-line",
                      )}
                    >
                      {checked && <Check size={12} strokeWidth={3} />}
                    </span>
                    <CustomerAvatar name={target.name} avatarUrl={target.avatar} size="sm" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-wb-xs font-medium text-workbench-text">
                        {target.name}
                      </span>
                      <span className="text-wb-3xs truncate text-workbench-text-muted">
                        {target.account}
                      </span>
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* 右列:已选择 + 预览 + 操作。 */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* 已选择计数。 */}
          <div className="shrink-0 px-4 pb-2 pt-3 text-wb-xs font-medium text-workbench-text-secondary">
            {STRINGS.forward.selected}（{selectedIds.length}/{MAX_TARGETS}）
          </div>

          {/* 已选列表(可逐个移除) / 空态占位。 */}
          <div className="min-h-0 flex-1 overflow-y-auto px-2">
            {selectedTargets.length === 0 ? (
              <div className="grid h-full place-items-center px-4 text-center text-wb-2xs text-workbench-text-muted">
                {STRINGS.forward.emptySelection}
              </div>
            ) : (
              selectedTargets.map((target) => (
                <div
                  key={target.conversationId}
                  className="flex items-center gap-2.5 rounded-lg px-2 py-1.5"
                >
                  <CustomerAvatar name={target.name} avatarUrl={target.avatar} size="sm" />
                  <span className="min-w-0 flex-1 truncate text-wb-xs text-workbench-text">
                    {target.name}
                  </span>
                  <button
                    type="button"
                    onClick={() => toggle(target.conversationId)}
                    aria-label={`移除 ${target.name}`}
                    className="focus-ring grid size-6 shrink-0 place-items-center rounded-md text-workbench-text-muted transition-colors hover:bg-workbench-surface-subtle hover:text-workbench-accent"
                  >
                    <X size={14} strokeWidth={2} aria-hidden />
                  </button>
                </div>
              ))
            )}
          </div>

          {/* 被转发内容预览。 */}
          <div className="shrink-0 border-t border-workbench-line-subtle px-4 pt-3">
            <div className="rounded-lg bg-workbench-surface-soft px-3 py-2 text-wb-2xs text-workbench-text-muted">
              <div className="line-clamp-2 [overflow-wrap:anywhere]">
                {previewText?.trim() ? previewText : "[消息]"}
              </div>
            </div>
          </div>

          {/* 操作按钮。 */}
          <div className="flex shrink-0 items-center justify-end gap-2 px-4 py-3">
            <button
              type="button"
              onClick={onClose}
              className="focus-ring h-9 rounded-lg border border-workbench-line px-4 text-[13px] font-medium text-workbench-text transition-colors hover:bg-workbench-surface-subtle"
            >
              {STRINGS.forward.cancel}
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={selectedIds.length === 0 || submitting}
              className="focus-ring h-9 rounded-lg bg-workbench-accent px-4 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {STRINGS.forward.confirm}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
