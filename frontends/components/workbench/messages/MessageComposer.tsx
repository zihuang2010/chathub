import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import * as Popover from "@radix-ui/react-popover";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { Editor, JSONContent } from "@tiptap/react";
import {
  Camera,
  FileText,
  ImagePlus,
  PanelRightClose,
  PanelRightOpen,
  Paperclip,
  Smile,
  X,
} from "lucide-react";

import { showToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

import {
  COMPOSER_MAX_CHARS,
  COMPOSER_MAX_HEIGHT,
  COMPOSER_MIN_HEIGHT,
  COMPOSER_WARN_CHARS,
  RESIZE_KEYBOARD_STEP,
} from "./constants";
import type { Conversation, MessageAttachment, MessageBlock, QuickReply } from "./data";
import { AiPolishPopover } from "./composer/AiPolishPopover";
import { SendButtonGroup } from "./composer/SendButtonGroup";
import { docToBlocks } from "./composer/docToBlocks";
import { RichComposer } from "./composer/RichComposer";
import { EmojiPicker } from "./EmojiPicker";
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
  /** Called with the trimmed draft text + rich blocks + any pending file attachments on submit. */
  onSend?: (text: string, blocks?: MessageBlock[], attachments?: MessageAttachment[]) => void;
  /** Quick-reply templates available from the composer popover. */
  quickReplies?: QuickReply[];
  /** Contacts shown in the @mention popover when the user types `@`. */
  mentionCandidates?: Conversation[];
}

interface ScreenshotResult {
  cancelled: boolean;
  base64?: string | null;
}

function clampComposerHeight(height: number) {
  return Math.min(Math.max(height, COMPOSER_MIN_HEIGHT), COMPOSER_MAX_HEIGHT);
}

// Extra vertical room the composer needs when the pending-attachment tray is
// visible: 64px file-chip + 12px gap + ~8px slack for the X-button overhang.
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
  const [isResizing, setIsResizing] = useState(false);
  const [quickRepliesOpen, setQuickRepliesOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [pendingFileAttachments, setPendingFileAttachments] = useState<MessageAttachment[]>([]);
  const editorRef = useRef<Editor | null>(null);
  const pendingFileAttachmentsRef = useRef<MessageAttachment[]>([]);
  useEffect(() => {
    pendingFileAttachmentsRef.current = pendingFileAttachments;
  }, [pendingFileAttachments]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const resizeStartRef = useRef({ y: 0, height });

  // Cleanup blob URLs on unmount only (do NOT revoke on send — bubbles still need them).
  useEffect(() => {
    return () => {
      pendingFileAttachmentsRef.current.forEach((a) => URL.revokeObjectURL(a.url));
    };
  }, []);

  // Derive canSend from the TipTap doc and file tray.
  const blocks = docToBlocks(draft);
  const textBlocks = blocks.filter((b): b is { type: "text"; value: string } => b.type === "text");
  const textJoined = textBlocks.map((b) => b.value).join("\n");
  const hasImageBlocks = blocks.some((b) => b.type === "image");
  const charLength = Array.from(textJoined).length;
  const overLimit = charLength > COMPOSER_MAX_CHARS;
  const nearLimit = charLength >= COMPOSER_WARN_CHARS;
  const canSend =
    !overLimit &&
    (textJoined.trim().length > 0 ||
      blocks.some((b) => b.type === "image") ||
      pendingFileAttachments.length > 0);

  // Keep the composer tall enough to show both the chip tray AND the send row
  // by bumping its height when chips appear and restoring it when they're
  // cleared. Tracking via ref ensures we bump exactly once per false↔true
  // transition (chip count fluctuating within "has chips" doesn't double-bump).
  const chipBumpAppliedRef = useRef(false);
  useEffect(() => {
    const shouldBump = pendingFileAttachments.length > 0;
    if (shouldBump === chipBumpAppliedRef.current) return;
    chipBumpAppliedRef.current = shouldBump;
    onHeightChange((prev) =>
      clampComposerHeight(prev + (shouldBump ? CHIP_TRAY_FOOTPRINT_PX : -CHIP_TRAY_FOOTPRINT_PX)),
    );
  }, [pendingFileAttachments.length, onHeightChange]);

  // ─── Attachment helpers ────────────────────────────────────────────────────

  /** Insert image files as inline image nodes in the TipTap editor. */
  const insertImageFiles = (files: File[]) => {
    if (!editorRef.current || files.length === 0) return;
    files.forEach((file) => {
      const url = URL.createObjectURL(file);
      editorRef
        .current!.chain()
        .focus()
        .insertContent({
          type: "image",
          attrs: { src: url, alt: file.name },
        })
        .run();
    });
  };

  const handleImagePicker = (event: ChangeEvent<HTMLInputElement>) => {
    insertImageFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  };

  const handleFilePicker = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    const next: MessageAttachment[] = files.map((file) => ({
      type: "file",
      url: URL.createObjectURL(file),
      name: file.name,
      sizeBytes: file.size,
    }));
    setPendingFileAttachments((prev) => [...prev, ...next]);
    event.target.value = "";
  };

  const removePendingFileAttachment = (target: MessageAttachment) => {
    URL.revokeObjectURL(target.url);
    setPendingFileAttachments((prev) => prev.filter((p) => p !== target));
  };

  // ─── Screenshot ───────────────────────────────────────────────────────────

  const handleScreenshot = async () => {
    // Tauri webviews don't expose getDisplayMedia, so screenshots go through a
    // native Rust command. Outside Tauri (pure web preview), nudge the user to
    // use the OS screenshot tool + paste into the editor instead.
    if (!isTauri()) {
      showToast(STRINGS.toast.screenshotPasteHint, { type: "info" });
      editorRef.current?.commands.focus();
      return;
    }
    try {
      const result = await invoke<ScreenshotResult>("take_screenshot");
      if (result.cancelled) {
        editorRef.current?.commands.focus();
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
      insertImageFiles([file]);
    } catch (err) {
      // Most common failure on macOS: user has not granted Screen Recording
      // permission yet. The native dialog will surface from the OS; the next
      // attempt after grant will succeed.
      const reason = err instanceof Error ? err.message : String(err);
      showToast(
        `${STRINGS.toast.screenshotFailed}：${reason}。${STRINGS.toast.screenshotPermissionHint}`,
        { type: "error" },
      );
    }
  };

  // ─── Quick replies & emoji ─────────────────────────────────────────────────

  const handleQuickReplySelect = (reply: QuickReply) => {
    editorRef.current?.chain().focus().insertContent(reply.preview).run();
    setQuickRepliesOpen(false);
  };

  const handleEmojiSelect = (emoji: string) => {
    editorRef.current?.chain().focus().insertContent(emoji).run();
    setEmojiOpen(false);
  };

  // ─── Resize ───────────────────────────────────────────────────────────────

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

  // ─── Submit ───────────────────────────────────────────────────────────────

  const submitDraft = () => {
    if (!canSend) return;
    const finalBlocks = blocks.filter((b) => !(b.type === "text" && b.value.trim().length === 0));
    const fileAttachments = pendingFileAttachments;
    onSend?.(
      textJoined.trim(),
      finalBlocks.length > 0 ? finalBlocks : undefined,
      fileAttachments.length > 0 ? fileAttachments : undefined,
    );
    // Hand ownership of file blob URLs to the message bubble; do NOT revoke here.
    setPendingFileAttachments([]);
    // Reset draft (sets EMPTY_DOC in the store).
    clearDraft(conversationId);
    // Also reset the editor's content.
    editorRef.current?.commands.setContent({
      type: "doc",
      content: [{ type: "paragraph" }],
    });
  };

  // ─── Render ───────────────────────────────────────────────────────────────

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
        onChange={handleFilePicker}
      />
      <input
        ref={imageInputRef}
        type="file"
        multiple
        accept="image/*"
        className="hidden"
        onChange={handleImagePicker}
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
                className="focus-ring group relative grid h-9 w-9 place-items-center rounded-lg text-workbench-text-secondary transition-colors hover:bg-workbench-surface-subtle hover:text-workbench-text"
              >
                <Smile size={18} strokeWidth={1.6} />
                <span
                  aria-hidden
                  className="pointer-events-none absolute bottom-1.5 right-1.5 size-[3px] rounded-full bg-current opacity-0 transition-opacity group-hover:opacity-60"
                />
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
            icon={Camera}
            label={STRINGS.composer.screenshot}
            onClick={handleScreenshot}
          />
          <ToolButton
            icon={ImagePlus}
            label={STRINGS.composer.image}
            onClick={() => imageInputRef.current?.click()}
            withHoverDot
          />
          <ToolButton
            icon={Paperclip}
            label={STRINGS.composer.file}
            onClick={() => fileInputRef.current?.click()}
          />
          <button
            type="button"
            title={detailsOpen ? STRINGS.composer.collapseRight : STRINGS.composer.expandRight}
            aria-label={detailsOpen ? STRINGS.composer.collapseRight : STRINGS.composer.expandRight}
            aria-pressed={detailsOpen}
            onClick={onToggleDetails}
            className={cn(
              "focus-ring relative z-30 ml-auto grid h-9 w-9 place-items-center rounded-lg transition-colors",
              detailsOpen
                ? "bg-workbench-surface-active text-workbench-accent"
                : "text-workbench-text-secondary hover:bg-workbench-surface-subtle hover:text-workbench-text",
            )}
          >
            {detailsOpen ? (
              <PanelRightClose size={18} strokeWidth={1.6} />
            ) : (
              <PanelRightOpen size={18} strokeWidth={1.6} />
            )}
          </button>
        </div>
        {pendingFileAttachments.length > 0 && (
          <div className="flex shrink-0 flex-wrap gap-2 pb-0.5 pt-1">
            {pendingFileAttachments.map((att, i) => (
              <FileChip
                key={`${att.url}-${i}`}
                attachment={att}
                onRemove={() => removePendingFileAttachment(att)}
              />
            ))}
          </div>
        )}
        <RichComposer
          initialContent={draft}
          placeholder={STRINGS.composer.placeholder}
          mentionCandidates={mentionCandidates}
          onChange={(doc: JSONContent) => setDraftValue(doc)}
          onSubmit={submitDraft}
          onPasteFiles={(files) => {
            insertImageFiles(files);
            return true;
          }}
          onReady={(editor) => {
            editorRef.current = editor;
          }}
          className="min-h-0 flex-1 overflow-y-auto"
        />
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
          <AiPolishPopover
            originalText={textJoined}
            disabled={!textJoined.trim() || hasImageBlocks}
            disabledReason={hasImageBlocks ? STRINGS.composer.polishImageHint : undefined}
            onApply={(newText) => {
              if (!editorRef.current) return;
              editorRef.current
                .chain()
                .focus()
                .setContent({
                  type: "doc",
                  content: [
                    {
                      type: "paragraph",
                      content: newText ? [{ type: "text", text: newText }] : [],
                    },
                  ],
                })
                .run();
            }}
          />
          <span
            className={cn(
              "ml-2 inline-flex items-center gap-2 font-numeric text-[11px] tabular-nums text-workbench-text-muted",
              nearLimit && !overLimit && "text-workbench-warning",
              overLimit && "text-workbench-danger",
            )}
          >
            <span aria-hidden>{STRINGS.composer.charCount(charLength)}</span>
            <span aria-hidden className="hidden sm:inline">
              ·
            </span>
            <span aria-hidden className="hidden sm:inline">
              {STRINGS.composer.enterToSend}
            </span>
            <span role="status" aria-live="polite" className="sr-only">
              {overLimit
                ? STRINGS.composer.charLimitOver
                : nearLimit
                  ? STRINGS.composer.charLimitNear
                  : ""}
            </span>
          </span>
          <div className="ml-auto">
            <SendButtonGroup canSend={canSend} onSend={submitDraft} />
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
  withHoverDot,
}: {
  icon: typeof Smile;
  label: string;
  onClick?: () => void;
  withHoverDot?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "focus-ring grid h-9 w-9 place-items-center rounded-lg text-workbench-text-secondary transition-colors hover:bg-workbench-surface-subtle hover:text-workbench-text",
        withHoverDot && "group relative",
      )}
    >
      <Icon size={18} strokeWidth={1.6} />
      {withHoverDot && (
        <span
          aria-hidden
          className="pointer-events-none absolute bottom-1.5 right-1.5 size-[3px] rounded-full bg-current opacity-0 transition-opacity group-hover:opacity-60"
        />
      )}
    </button>
  );
}

function FileChip({
  attachment,
  onRemove,
}: {
  attachment: MessageAttachment;
  onRemove: () => void;
}) {
  return (
    <div className="group relative flex h-14 min-w-[160px] max-w-[240px] items-center gap-2.5 rounded-xl border border-workbench-line bg-workbench-surface px-3 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-colors hover:bg-workbench-surface-subtle">
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
