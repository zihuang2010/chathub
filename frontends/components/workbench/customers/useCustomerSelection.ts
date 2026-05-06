import { useCallback, useEffect, useMemo, useState } from "react";

export interface CustomerSelectionState {
  selectedIds: ReadonlySet<string>;
  isMultiSelectActive: boolean;
  /** 进入多选模式（不直接选中任何客户）。 */
  enter: () => void;
  /** 退出多选模式并清空选中。 */
  exit: () => void;
  /** 多选模式开关；进入时清空、退出时也清空。 */
  toggleMode: () => void;
  /** 翻转某个客户的选中状态；非多选态会自动切入多选。 */
  toggle: (id: string) => void;
  /** 把传入 ids 全部置为选中（不影响其他）。 */
  selectMany: (ids: readonly string[]) => void;
  /** 清空选中（保留多选态）。 */
  clear: () => void;
  /** 当前是否选中。 */
  isSelected: (id: string) => boolean;
  /** 当前选中数。 */
  count: number;
}

/**
 * 选中态聚合 hook。在容器组件中实例化，向下传递。
 *
 * 关键约束（来自计划 §10）：
 * - Esc / 退出按钮 / 切 Tab 等"退出动作"应在外部直接调用 `exit()`。
 * - 搜索框输入不应清空选中——这里不做 source 同步。
 */
export function useCustomerSelection(): CustomerSelectionState {
  const [isMultiSelectActive, setMultiSelect] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());

  const enter = useCallback(() => {
    setMultiSelect(true);
  }, []);

  const exit = useCallback(() => {
    setMultiSelect(false);
    setSelectedIds(new Set());
  }, []);

  const toggleMode = useCallback(() => {
    setMultiSelect((prev) => {
      if (prev) {
        setSelectedIds(new Set());
        return false;
      }
      return true;
    });
  }, []);

  const toggle = useCallback((id: string) => {
    setMultiSelect(true);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectMany = useCallback((ids: readonly string[]) => {
    setMultiSelect(true);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const isSelected = useCallback((id: string) => selectedIds.has(id), [selectedIds]);

  // Esc 全局退出多选；只在多选态绑定，避免无谓事件监听。
  useEffect(() => {
    if (!isMultiSelectActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") exit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [exit, isMultiSelectActive]);

  return useMemo(
    () => ({
      selectedIds,
      isMultiSelectActive,
      enter,
      exit,
      toggleMode,
      toggle,
      selectMany,
      clear,
      isSelected,
      count: selectedIds.size,
    }),
    [
      clear,
      enter,
      exit,
      isMultiSelectActive,
      isSelected,
      selectMany,
      selectedIds,
      toggle,
      toggleMode,
    ],
  );
}
