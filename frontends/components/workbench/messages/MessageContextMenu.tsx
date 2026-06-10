import { useState, type ReactNode } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";

import { showToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

import type { Message } from "./data";
import { STRINGS } from "./strings";

const RECALL_WINDOW_MS = 2 * 60 * 1000;

export type MessageActionType =
  | "copy"
  | "reply"
  | "enlarge"
  | "forward"
  | "recall"
  | "delete"
  | "resend"
  | "scroll-to";

interface MessageContextMenuProps {
  message: Message;
  onAction: (action: MessageActionType, message: Message) => void;
  children: ReactNode;
}

export function MessageContextMenu({ message, onAction, children }: MessageContextMenuProps) {
  const isOut = message.direction === "out";
  // 放大阅读 / 转发都只作用于文本:无文本(纯图片/文件/语音/未知消息)时不显示这两项。
  const hasText = message.text.trim().length > 0;
  // Recompute on each open — `Date.now()` in render would violate purity rules.
  const [recallable, setRecallable] = useState(false);
  const handleOpenChange = (open: boolean) => {
    if (!open) return;
    const elapsed = Date.now() - new Date(message.sentAt).getTime();
    setRecallable(isOut && elapsed < RECALL_WINDOW_MS);
  };

  const handleCopy = async () => {
    const text = message.text;
    let ok: boolean;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      // Fallback for environments without async clipboard (older WebKit).
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      ta.remove();
    }
    showToast(ok ? STRINGS.toast.copySuccess : STRINGS.toast.copyFailed, {
      type: ok ? "success" : "error",
    });
    onAction("copy", message);
  };

  return (
    <ContextMenu.Root onOpenChange={handleOpenChange}>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className="z-30 min-w-[96px] overflow-hidden rounded-md border border-workbench-line bg-workbench-surface p-1 shadow-wb-popover"
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <Item onSelect={handleCopy}>{STRINGS.contextMenu.copy}</Item>
          <Item onSelect={() => onAction("reply", message)}>{STRINGS.contextMenu.reply}</Item>
          {hasText && (
            <Item onSelect={() => onAction("enlarge", message)}>{STRINGS.contextMenu.enlarge}</Item>
          )}
          {hasText && (
            <Item onSelect={() => onAction("forward", message)}>{STRINGS.contextMenu.forward}</Item>
          )}
          {recallable && (
            <Item onSelect={() => onAction("recall", message)}>{STRINGS.contextMenu.recall}</Item>
          )}
          <Item onSelect={() => onAction("delete", message)} danger>
            {STRINGS.contextMenu.delete}
          </Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function Item({
  children,
  onSelect,
  danger,
}: {
  children: ReactNode;
  onSelect: () => void;
  danger?: boolean;
}) {
  return (
    <ContextMenu.Item
      onSelect={onSelect}
      className={cn(
        "cursor-default rounded px-2.5 py-1 text-wb-2xs outline-none transition-colors",
        "data-[highlighted]:bg-workbench-surface-subtle",
        danger ? "text-workbench-danger" : "text-workbench-text",
      )}
    >
      {children}
    </ContextMenu.Item>
  );
}
