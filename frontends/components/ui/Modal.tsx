import { type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";

import { useEscKey } from "@/lib/useEscKey";
import { TRANSITION_DURATIONS, TRANSITION_EASE } from "@/lib/theme";
import { cn } from "@/lib/utils";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** 卡片无障碍名:有标题用 aria-labelledby,否则传 aria-label。 */
  labelledBy?: string;
  ariaLabel?: string;
  /** 覆盖卡片样式(宽度等);默认居中小卡片。 */
  className?: string;
}

/**
 * 轻量居中模态。项目未装 radix dialog,这里用 createPortal + framer-motion 自建,
 * 复用 toast 同款过渡常量。Esc / 点遮罩关闭;遮罩与卡片各自淡入,卡片附带轻微缩放。
 *
 * 不做 focus-trap:本应用模态内容极简(关于展示 / 二次确认),Esc + 遮罩关闭已足够;
 * 刻意不引入 radix-dialog 依赖(最小改动)。
 */
export function Modal({ open, onClose, children, labelledBy, ariaLabel, className }: ModalProps) {
  // Esc 关闭。复用 useEscKey:它已正确判输入法 composition(isComposing / keyCode===229),
  // 避免中文输入候选框按 Esc 误关模态。enabled 仅在 open 时挂监听;skipIfInInput 关掉以保持
  // 原行为(模态内 input 聚焦时按 Esc 仍关闭模态)。
  useEscKey(onClose, { enabled: open, skipIfInInput: false });

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[1000] grid place-items-center p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: TRANSITION_DURATIONS.quick / 1000 }}
        >
          {/* 遮罩 */}
          <div aria-hidden className="absolute inset-0 bg-black/30" onClick={onClose} />
          {/* 卡片 */}
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby={labelledBy}
            aria-label={ariaLabel}
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ duration: TRANSITION_DURATIONS.normal / 1000, ease: TRANSITION_EASE }}
            className={cn(
              "relative w-[320px] overflow-hidden rounded-2xl border border-workbench-line bg-workbench-surface shadow-wb-popover-strong",
              className,
            )}
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
