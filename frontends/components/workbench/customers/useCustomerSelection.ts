import { useCallback, useMemo, useState } from "react";

import { useEscKey } from "@/lib/useEscKey";

export interface CustomerSelectionState {
  selectedIds: ReadonlySet<string>;
  isMultiSelectActive: boolean;
  /** 退出多选模式并清空选中。 */
  exit: () => void;
  /** 多选模式开关；进入时清空、退出时也清空。 */
  toggleMode: () => void;
  /** 翻转某个客户的选中状态；非多选态会自动切入多选。 */
  toggle: (id: string) => void;
  /** 把传入 ids 全部"叠加"到现有选中（并集语义）。 */
  selectMany: (ids: readonly string[]) => void;
  /** 把选中状态精确替换为传入 ids（覆盖语义）。"全选当前视图" 用此 API 才正确。 */
  selectExactly: (ids: readonly string[]) => void;
  /** 把当前选中收敛到传入可见集的交集。过滤变化时调用，避免操作不可见的项。 */
  pruneTo: (visibleIds: ReadonlySet<string>) => void;
  /** 清空选中（保留多选态）。 */
  clear: () => void;
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

  const selectExactly = useCallback((ids: readonly string[]) => {
    setMultiSelect(true);
    setSelectedIds(new Set(ids));
  }, []);

  const pruneTo = useCallback((visibleIds: ReadonlySet<string>) => {
    setSelectedIds((prev) => {
      // 仅在确有需要剪除时才创建新 Set，避免无意义的 setState 触发 re-render。
      let needsPrune = false;
      for (const id of prev) {
        if (!visibleIds.has(id)) {
          needsPrune = true;
          break;
        }
      }
      if (!needsPrune) return prev;
      const next = new Set<string>();
      for (const id of prev) if (visibleIds.has(id)) next.add(id);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  // Esc 退出多选。共享 hook 处理 IME composition、输入框焦点、Radix popover
  // dismiss 的优先级——避免在搜索框/标签编辑器/popover 内按 Esc 误退出。
  useEscKey(exit, { enabled: isMultiSelectActive });

  return useMemo(
    () => ({
      selectedIds,
      isMultiSelectActive,
      exit,
      toggleMode,
      toggle,
      selectMany,
      selectExactly,
      pruneTo,
      clear,
      count: selectedIds.size,
    }),
    [
      clear,
      exit,
      isMultiSelectActive,
      pruneTo,
      selectExactly,
      selectMany,
      selectedIds,
      toggle,
      toggleMode,
    ],
  );
}
