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
  | "forward"
  | "recall"
  | "delete"
  | "details"
  | "resend"
  | "scroll-to";

interface MessageContextMenuProps {
  message: Message;
  onAction: (action: MessageActionType, message: Message) => void;
  children: ReactNode;
}

export function MessageContextMenu({ message, onAction, children }: MessageContextMenuProps) {
  const isOut = message.direction === "out";
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
          className="z-30 min-w-[140px] overflow-hidden rounded-md border border-workbench-line bg-workbench-surface p-1 shadow-wb-popover"
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <Item onSelect={handleCopy}>{STRINGS.contextMenu.copy}</Item>
          <Item onSelect={() => onAction("reply", message)}>{STRINGS.contextMenu.reply}</Item>
          <Item onSelect={() => onAction("forward", message)}>{STRINGS.contextMenu.forward}</Item>
          {recallable && (
            <Item onSelect={() => onAction("recall", message)}>{STRINGS.contextMenu.recall}</Item>
          )}
          <Separator />
          <Item onSelect={() => onAction("details", message)}>{STRINGS.contextMenu.details}</Item>
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
        "cursor-default rounded px-2 py-1.5 text-wb-2xs outline-none transition-colors",
        "data-[highlighted]:bg-workbench-surface-subtle",
        danger
          ? "text-workbench-danger data-[highlighted]:bg-workbench-danger/10"
          : "text-workbench-text",
      )}
    >
      {children}
    </ContextMenu.Item>
  );
}

function Separator() {
  return <ContextMenu.Separator className="my-1 h-px bg-workbench-line-subtle" />;
}
