import { useEffect, useRef, useState } from "react";
import type {
  ChangeEvent,
  ClipboardEvent as ReactClipboardEvent,
  KeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import * as Popover from "@radix-ui/react-popover";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  ChevronDown,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Scissors,
  Smile,
  Sparkles,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { showToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { WORKBENCH_ACTION_GRADIENT, WORKBENCH_ACTION_GRADIENT_HOVER } from "@/lib/theme";

import { COMPOSER_MAX_HEIGHT, COMPOSER_MIN_HEIGHT, RESIZE_KEYBOARD_STEP } from "./constants";
import type { Conversation, MessageAttachment, QuickReply } from "./data";
import { EmojiPicker } from "./EmojiPicker";
import { MentionList } from "./MentionList";
import { QuickRepliesPanel } from "./QuickRepliesPanel";
import { STRINGS } from "./strings";
import { clearDraft, useDraft } from "./useDraftStore";
import { formatFileSize } from "./utils";

interface MessageComposerProps {
  conversationId: string;
  height: number;
  onHeightChange: (height: number | ((height: number) => number)) => void;
  detailsOpen: boolean;
  onToggleDetails: () => void;
  /** Called with the trimmed draft text + any pending attachments on submit. */
  onSend?: (text: string, attachments?: MessageAttachment[]) => void;
  /** Quick-reply templates available from the composer popover. */
  quickReplies?: QuickReply[];
  /** Contacts shown in the @mention popover when the user types `@`. */
  mentionCandidates?: Conversation[];
}

interface PendingAttachment extends MessageAttachment {
  /** Local-only key for chip rendering and removal. Not part of the send payload. */
  tempId: string;
}

interface ScreenshotResult {
  cancelled: boolean;
  base64?: string | null;
}

function clampComposerHeight(height: number) {
  return Math.min(Math.max(height, COMPOSER_MIN_HEIGHT), COMPOSER_MAX_HEIGHT);
}

// Extra vertical room the composer needs when the pending-attachment tray is
// visible: 64px image-chip + 12px gap + ~8px slack for the X-button overhang.
const CHIP_TRAY_FOOTPRINT_PX = 84;

export function MessageComposer({
  conversationId,
  height,
  onHeightChange,
  detailsOpen,
  onToggleDetails,
  onSend,
  quickReplies,
  mentionCandidates,
}: MessageComposerProps) {
  const [draft, setDraftValue] = useDraft(conversationId);
  const [hover, setHover] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [quickRepliesOpen, setQuickRepliesOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  // @mention is keyed off textarea content + caret position. `mentionState`
  // is null when no `@<query>` token is currently being typed; otherwise it
  // holds the start index of the `@` and the partial query after it so the
  // popover can filter candidates and replace the right slice on commit.
  const [mentionState, setMentionState] = useState<{ start: number; query: string } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const resizeStartRef = useRef({ y: 0, height });
  const pendingAttachmentsRef = useRef<PendingAttachment[]>([]);
  const canSend = draft.trim().length > 0 || pendingAttachments.length > 0;

  useEffect(() => {
    pendingAttachmentsRef.current = pendingAttachments;
  }, [pendingAttachments]);

  useEffect(() => {
    return () => {
      pendingAttachmentsRef.current.forEach((p) => URL.revokeObjectURL(p.url));
      pendingAttachmentsRef.current = [];
    };
  }, []);

  // Keep the composer tall enough to show both the chip tray AND the send row
  // by bumping its height when chips appear and restoring it when they're
  // cleared. Tracking via ref ensures we bump exactly once per false↔true
  // transition (chip count fluctuating within "has chips" doesn't double-bump).
  const chipBumpAppliedRef = useRef(false);
  useEffect(() => {
    const shouldBump = pendingAttachments.length > 0;
    if (shouldBump === chipBumpAppliedRef.current) return;
    chipBumpAppliedRef.current = shouldBump;
    onHeightChange((prev) =>
      clampComposerHeight(prev + (shouldBump ? CHIP_TRAY_FOOTPRINT_PX : -CHIP_TRAY_FOOTPRINT_PX)),
    );
  }, [pendingAttachments.length, onHeightChange]);

  const addPendingAttachments = (files: File[], typeOverride?: "image" | "file") => {
    if (files.length === 0) return;
    const next: PendingAttachment[] = files.map((file) => ({
      tempId: `att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      type: typeOverride ?? (file.type.startsWith("image/") ? "image" : "file"),
      url: URL.createObjectURL(file),
      name: file.name,
      sizeBytes: file.size,
    }));
    setPendingAttachments((prev) => [...prev, ...next]);
  };

  const removePendingAttachment = (tempId: string) => {
    setPendingAttachments((prev) => {
      const target = prev.find((p) => p.tempId === tempId);
      if (target) URL.revokeObjectURL(target.url);
      return prev.filter((p) => p.tempId !== tempId);
    });
  };

  const handleFilePickerChange = (
    event: ChangeEvent<HTMLInputElement>,
    typeOverride: "image" | "file",
  ) => {
    const files = Array.from(event.target.files ?? []);
    addPendingAttachments(files, typeOverride);
    // Reset value so picking the same file twice in a row still triggers change.
    event.target.value = "";
  };

  const handleScreenshot = async () => {
    // Tauri webviews don't expose getDisplayMedia, so screenshots go through a
    // native Rust command. Outside Tauri (pure web preview), nudge the user to
    // use the OS screenshot tool + paste into the textarea instead.
    if (!isTauri()) {
      showToast(STRINGS.toast.screenshotPasteHint, { type: "info" });
      textareaRef.current?.focus();
      return;
    }
    try {
      const result = await invoke<ScreenshotResult>("take_screenshot");
      if (result.cancelled) {
        textareaRef.current?.focus();
        return;
      }

      const base64Png = result.base64 ?? "";
      if (!base64Png.trim()) {
        throw new Error(STRINGS.toast.screenshotEmpty);
      }

      const binary = atob(base64Png);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: "image/png" });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const file = new File([blob], `screenshot-${stamp}.png`, { type: "image/png" });
      addPendingAttachments([file], "image");
    } catch (err) {
      // Most common failure on macOS: user has not granted Screen Recording
      // permission yet. The native dialog will surface from the OS; the next
      // attempt after grant will succeed.
      const reason = err instanceof Error ? err.message : String(err);
      showToast(
        `${STRINGS.toast.screenshotFailed}：${reason}。${STRINGS.toast.screenshotPermissionHint}`,
        {
          type: "error",
        },
      );
    }
  };

  const handleTextareaPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const items = event.clipboardData?.items;
    if (!items || items.length === 0) return;
    const images: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) images.push(file);
      }
    }
    if (images.length === 0) return;
    // Prevent the default text paste (some clipboards include a filename string
    // alongside the image) and route the image into the pending tray instead.
    event.preventDefault();
    addPendingAttachments(images, "image");
  };

  const handleQuickReplySelect = (reply: QuickReply) => {
    // Append (or set) the reply preview text, joining with a newline so
    // multiple selections stack legibly. Trim trailing whitespace before
    // append to avoid double-blank lines.
    setDraftValue((draft.trimEnd() ? draft.trimEnd() + "\n" : "") + reply.preview);
    setQuickRepliesOpen(false);
  };

  const handleEmojiSelect = (emoji: string) => {
    const ta = textareaRef.current;
    if (!ta) {
      setDraftValue(draft + emoji);
    } else {
      // Insert at caret rather than appending — matches user expectation when
      // they paused mid-message to pick an emoji.
      const start = ta.selectionStart ?? draft.length;
      const end = ta.selectionEnd ?? draft.length;
      const next = draft.slice(0, start) + emoji + draft.slice(end);
      setDraftValue(next);
      // Restore caret AFTER React renders the new value.
      requestAnimationFrame(() => {
        ta.focus();
        const pos = start + emoji.length;
        ta.setSelectionRange(pos, pos);
      });
    }
    setEmojiOpen(false);
  };

  // Detect "@<query>" tokens at caret. Triggered on every textarea change so
  // the popover toggles itself based on what the user is typing.
  const handleDraftChange = (value: string) => {
    setDraftValue(value);
    const ta = textareaRef.current;
    const caret = ta?.selectionStart ?? value.length;
    const prefix = value.slice(0, caret);
    const at = prefix.lastIndexOf("@");
    if (at === -1) {
      setMentionState(null);
      return;
    }
    // Reject if there's whitespace between `@` and caret — the user has moved
    // past the mention token (e.g. typed a space) so the popover should close.
    const between = prefix.slice(at + 1);
    if (/\s/.test(between)) {
      setMentionState(null);
      return;
    }
    setMentionState({ start: at, query: between });
  };

  const handleMentionSelect = (name: string) => {
    if (!mentionState) return;
    const ta = textareaRef.current;
    const caret = ta?.selectionStart ?? draft.length;
    const before = draft.slice(0, mentionState.start);
    const after = draft.slice(caret);
    const inserted = `@${name} `;
    const next = before + inserted + after;
    setDraftValue(next);
    setMentionState(null);
    requestAnimationFrame(() => {
      ta?.focus();
      const pos = before.length + inserted.length;
      ta?.setSelectionRange(pos, pos);
    });
  };

  useEffect(() => {
    if (!isResizing) return;

    const handlePointerMove = (event: PointerEvent) => {
      const deltaY = resizeStartRef.current.y - event.clientY;
      onHeightChange(clampComposerHeight(resizeStartRef.current.height + deltaY));
    };
    const stopResizing = () => setIsResizing(false);
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResizing);
    window.addEventListener("pointercancel", stopResizing);

    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResizing);
      window.removeEventListener("pointercancel", stopResizing);
    };
  }, [isResizing, onHeightChange]);

  const handleResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    resizeStartRef.current = { y: event.clientY, height };
    setIsResizing(true);
  };

  const handleResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      event.key !== "ArrowUp" &&
      event.key !== "ArrowDown" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }
    event.preventDefault();
    onHeightChange((currentHeight) => {
      if (event.key === "Home") return COMPOSER_MIN_HEIGHT;
      if (event.key === "End") return COMPOSER_MAX_HEIGHT;
      const direction = event.key === "ArrowUp" ? 1 : -1;
      return clampComposerHeight(currentHeight + direction * RESIZE_KEYBOARD_STEP);
    });
  };

  const submitDraft = () => {
    if (!canSend) return;
    const attachments: MessageAttachment[] = pendingAttachments.map(
      ({ tempId: _tempId, ...rest }) => rest,
    );
    onSend?.(draft.trim(), attachments.length > 0 ? attachments : undefined);
    clearDraft(conversationId);
    // Hand ownership of the blob URLs to the message bubble; do NOT revoke
    // here or the rendered images/files would break.
    setPendingAttachments([]);
  };

  const handleTextareaKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter inserts a newline. Skip when an IME composition
    // is active (Chinese input picker uses Enter to confirm a candidate).
    if (event.key !== "Enter" || event.shiftKey) return;
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    submitDraft();
  };

  return (
    <div
      className="relative shrink-0 border-t border-workbench-line bg-workbench-surface px-3 pb-3 pt-2"
      style={{ height }}
    >
      <div
        role="separator"
        aria-label={STRINGS.composer.resizeHandle}
        aria-orientation="horizontal"
        aria-valuemin={COMPOSER_MIN_HEIGHT}
        aria-valuemax={COMPOSER_MAX_HEIGHT}
        aria-valuenow={Math.round(height)}
        tabIndex={0}
        onPointerDown={handleResizePointerDown}
        onKeyDown={handleResizeKeyDown}
        className="group absolute inset-x-0 top-0 z-10 flex h-3 -translate-y-1.5 cursor-row-resize items-center justify-center outline-none"
      >
        <span
          aria-hidden
          className={cn(
            "h-px w-10 rounded-full bg-transparent transition-colors group-hover:bg-workbench-accent-soft group-focus-visible:bg-workbench-accent-soft",
            isResizing && "bg-workbench-accent-soft",
          )}
        />
      </div>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => handleFilePickerChange(e, "file")}
      />
      <input
        ref={imageInputRef}
        type="file"
        multiple
        accept="image/*"
        className="hidden"
        onChange={(e) => handleFilePickerChange(e, "image")}
      />
      <div className="flex h-full w-full flex-col gap-2 bg-workbench-surface">
        <div className="flex items-center gap-3 text-workbench-text-secondary">
          <Popover.Root open={emojiOpen} onOpenChange={setEmojiOpen}>
            <Popover.Trigger asChild>
              <button
                type="button"
                title={STRINGS.composer.emoji}
                aria-label={STRINGS.composer.emoji}
                aria-haspopup="dialog"
                aria-expanded={emojiOpen}
                className="focus-ring grid size-9 place-items-center rounded-md text-workbench-text-secondary transition-colors hover:bg-workbench-surface-subtle hover:text-workbench-accent"
              >
                <Smile size={20} strokeWidth={1.45} className="-translate-y-px" />
              </button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content
                side="top"
                align="start"
                sideOffset={6}
                collisionPadding={12}
                className="z-30 w-[296px] rounded-lg border border-workbench-line bg-workbench-surface p-2 shadow-wb-popover-strong outline-none"
              >
                <EmojiPicker onSelect={handleEmojiSelect} />
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
          <ToolButton
            icon={Scissors}
            label={STRINGS.composer.screenshot}
            onClick={handleScreenshot}
          />
          <ToolButton
            icon={ImageIcon}
            label={STRINGS.composer.image}
            onClick={() => imageInputRef.current?.click()}
          />
          <ToolButton
            icon={FolderOpen}
            label={STRINGS.composer.file}
            onClick={() => fileInputRef.current?.click()}
          />
          <ToolButton icon={MoreHorizontal} label={STRINGS.composer.moreTools} />
          <button
            type="button"
            title={detailsOpen ? STRINGS.composer.collapseRight : STRINGS.composer.expandRight}
            aria-label={detailsOpen ? STRINGS.composer.collapseRight : STRINGS.composer.expandRight}
            aria-pressed={detailsOpen}
            onClick={onToggleDetails}
            className={cn(
              "focus-ring relative z-30 ml-auto grid size-9 place-items-center rounded-md transition-colors",
              detailsOpen
                ? "bg-workbench-surface-active text-workbench-accent"
                : "text-workbench-text-secondary hover:bg-workbench-surface-subtle hover:text-workbench-accent",
            )}
          >
            {detailsOpen ? (
              <PanelRightClose size={20} strokeWidth={1.45} className="-translate-y-px" />
            ) : (
              <PanelRightOpen size={20} strokeWidth={1.45} className="-translate-y-px" />
            )}
          </button>
        </div>
        {pendingAttachments.length > 0 && (
          <div className="flex shrink-0 flex-wrap gap-2 pb-0.5 pt-1">
            {pendingAttachments.map((att) => (
              <PendingChip
                key={att.tempId}
                attachment={att}
                onRemove={() => removePendingAttachment(att.tempId)}
              />
            ))}
          </div>
        )}
        <Popover.Root
          open={mentionState !== null && (mentionCandidates?.length ?? 0) > 0}
          onOpenChange={(open) => {
            if (!open) setMentionState(null);
          }}
        >
          <Popover.Anchor asChild>
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => handleDraftChange(e.currentTarget.value)}
              onKeyDown={handleTextareaKeyDown}
              onPaste={handleTextareaPaste}
              rows={3}
              placeholder={STRINGS.composer.placeholder}
              aria-keyshortcuts="Enter"
              className="focus-ring min-h-[64px] w-full flex-1 resize-none rounded-md border-0 bg-transparent px-2 py-2 text-[13px] leading-[1.65] text-workbench-text placeholder:text-workbench-text-muted"
            />
          </Popover.Anchor>
          <Popover.Portal>
            <Popover.Content
              side="top"
              align="start"
              sideOffset={6}
              collisionPadding={12}
              onOpenAutoFocus={(e) => e.preventDefault()}
              className="z-30 w-[260px] rounded-lg border border-workbench-line bg-workbench-surface p-1 shadow-wb-popover-strong outline-none"
            >
              <MentionList
                query={mentionState?.query ?? ""}
                candidates={mentionCandidates ?? []}
                onSelect={handleMentionSelect}
              />
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
        <div className="flex items-center gap-2 pt-0.5">
          <Popover.Root open={quickRepliesOpen} onOpenChange={setQuickRepliesOpen}>
            <Popover.Trigger asChild>
              <button
                type="button"
                aria-haspopup="dialog"
                aria-expanded={quickRepliesOpen}
                disabled={!quickReplies || quickReplies.length === 0}
                className="focus-ring inline-flex h-9 items-center gap-1 rounded-md px-2.5 text-[12px] font-medium text-workbench-text-secondary transition-colors hover:bg-workbench-surface-subtle hover:text-workbench-text disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
              >
                <span>{STRINGS.composer.quickReplies}</span>
              </button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content
                side="top"
                align="start"
                sideOffset={6}
                collisionPadding={12}
                className="z-30 w-[300px] rounded-lg border border-workbench-line bg-workbench-surface p-3 shadow-wb-popover-strong outline-none"
              >
                <QuickRepliesPanel items={quickReplies ?? []} onSelect={handleQuickReplySelect} />
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
          <button
            type="button"
            className="focus-ring inline-flex h-9 items-center gap-1 rounded-md bg-workbench-surface-soft px-2.5 text-[12px] font-medium text-workbench-accent transition-colors hover:bg-workbench-surface-active"
          >
            <Sparkles size={12} />
            <span>{STRINGS.composer.aiPolish}</span>
            <span className="rounded-sm bg-workbench-accent px-1 py-px text-[9px] font-semibold uppercase leading-none text-white">
              {STRINGS.composer.aiPolishNew}
            </span>
          </button>
          <button
            type="button"
            className="focus-ring inline-flex h-9 items-center gap-1 rounded-md border border-workbench-line px-2.5 text-[12px] text-workbench-text-secondary transition-colors hover:bg-workbench-surface-subtle"
          >
            <span>{STRINGS.composer.formal}</span>
            <ChevronDown size={11} />
          </button>
          <span
            aria-hidden
            className="ml-2 hidden font-numeric text-[11px] tabular-nums text-workbench-text-muted sm:inline"
          >
            {STRINGS.composer.enterToSend}
          </span>
          <div className="ml-auto flex items-center gap-0">
            <Button
              type="button"
              disabled={!canSend}
              onMouseEnter={() => setHover(true)}
              onMouseLeave={() => setHover(false)}
              onClick={submitDraft}
              aria-label={STRINGS.composer.send}
              className={cn(
                "focus-ring h-9 rounded-l-md rounded-r-none px-5 text-[13px] font-medium transition-all",
                canSend
                  ? "text-white"
                  : "bg-workbench-line text-workbench-text disabled:opacity-100",
              )}
              style={
                canSend
                  ? {
                      background: hover
                        ? WORKBENCH_ACTION_GRADIENT_HOVER
                        : WORKBENCH_ACTION_GRADIENT,
                    }
                  : undefined
              }
            >
              {STRINGS.composer.send}
            </Button>
            <Button
              type="button"
              disabled={!canSend}
              aria-label={STRINGS.composer.sendOptions}
              className={cn(
                "focus-ring h-9 rounded-l-none rounded-r-md border-l border-black/20 px-2 transition-all dark:border-white/30",
                canSend
                  ? "text-white"
                  : "bg-workbench-line text-workbench-text disabled:opacity-100",
              )}
              style={
                canSend
                  ? {
                      background: hover
                        ? WORKBENCH_ACTION_GRADIENT_HOVER
                        : WORKBENCH_ACTION_GRADIENT,
                    }
                  : undefined
              }
            >
              <ChevronDown size={12} />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ToolButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof Smile;
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="focus-ring grid size-9 place-items-center rounded-md text-workbench-text-secondary transition-colors hover:bg-workbench-surface-subtle hover:text-workbench-accent"
    >
      <Icon size={20} strokeWidth={1.45} className="-translate-y-px" />
    </button>
  );
}

function PendingChip({
  attachment,
  onRemove,
}: {
  attachment: PendingAttachment;
  onRemove: () => void;
}) {
  const isImage = attachment.type === "image";
  return (
    <div
      className={cn(
        "group relative flex items-center rounded-xl border border-workbench-line bg-workbench-surface shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-colors hover:bg-workbench-surface-subtle",
        isImage ? "size-16 overflow-hidden p-0.5" : "h-14 min-w-[160px] max-w-[240px] gap-2.5 px-3",
      )}
    >
      {isImage ? (
        <img
          src={attachment.url}
          alt={attachment.name ?? STRINGS.attachment.image}
          className="size-full rounded-[9px] object-cover"
        />
      ) : (
        <>
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-workbench-surface-soft text-workbench-accent">
            <FileText size={17} strokeWidth={1.55} aria-hidden />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-tight">
            <span className="truncate text-[12px] font-medium text-workbench-text">
              {attachment.name ?? STRINGS.attachment.file}
            </span>
            <span className="font-numeric text-[10px] tabular-nums text-workbench-text-muted">
              {formatFileSize(attachment.sizeBytes)}
            </span>
          </span>
        </>
      )}
      <button
        type="button"
        onClick={onRemove}
        title={STRINGS.composer.removeAttachment}
        aria-label={STRINGS.composer.removeAttachment}
        className="focus-ring absolute -right-1 -top-1 grid size-[18px] place-items-center rounded-full border border-white/80 bg-white/95 text-workbench-text-muted opacity-0 shadow-[0_1px_4px_rgba(15,23,42,0.16)] transition-all hover:border-workbench-line hover:bg-workbench-surface hover:text-workbench-text focus-visible:opacity-100 group-hover:opacity-100"
      >
        <X size={10} strokeWidth={2.1} aria-hidden />
      </button>
    </div>
  );
}
