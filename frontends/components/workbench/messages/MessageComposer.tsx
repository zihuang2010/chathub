import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  Laugh,
  X,
} from "lucide-react";

import { showToast } from "@/components/ui/toast";
import { useEscKey } from "@/lib/useEscKey";
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
import { blocksToDoc, docToBlocks } from "./composer/docToBlocks";
import { RichComposer } from "./composer/RichComposer";
import { EmojiPicker } from "./EmojiPicker";
import type { ReplyTarget } from "./MessageBubble";
import { QuickRepliesPanel } from "./QuickRepliesPanel";
import { STRINGS } from "./strings";
import { clearDraft, useDraft, useFileAttachments } from "./useDraftStore";
import { formatFileSize } from "./utils";

interface MessageComposerProps {
  conversationId: string;
  height: number;
  onHeightChange: (height: number | ((height: number) => number)) => void;
  detailsOpen: boolean;
  onToggleDetails: () => void;
  /** Called with the trimmed draft text + rich blocks + any pending file attachments on submit. */
  onSend?: (
    text: string,
    blocks?: MessageBlock[],
    attachments?: MessageAttachment[],
    replyTo?: string,
  ) => void;
  /** Quick-reply templates available from the composer popover. */
  quickReplies?: QuickReply[];
  /** Contacts shown in the @mention popover when the user types `@`. */
  mentionCandidates?: Conversation[];
  /** Pinned reply target: when present, renders a quote preview above the toolbar
   *  and attaches `id` to the next outgoing message via `onSend`'s replyTo arg. */
  replyDraft?: (ReplyTarget & { id: string }) | null;
  onCancelReply?: () => void;
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
  replyDraft,
  onCancelReply,
}: MessageComposerProps) {
  const [draft, setDraftValue] = useDraft(conversationId);
  const [pendingFileAttachments, setPendingFileAttachments] = useFileAttachments(conversationId);
  const [isResizing, setIsResizing] = useState(false);
  const [quickRepliesOpen, setQuickRepliesOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const editorRef = useRef<Editor | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const resizeStartRef = useRef({ y: 0, height });

  // 文件附件 blob URL 的生命周期由 useFileAttachments store 持有,跨切会话存活:
  // - 用户显式移除 chip → removePendingFileAttachment 立即 revoke
  // - 发送消息 → ownership 转给 MessageBubble,submitDraft 仅从 store 清空但不 revoke
  // - LRU 淘汰(>50 会话)→ store 自动 revoke
  // - 页面 unload → 浏览器统一回收 document scope 内的所有 blob URL
  // 因此 composer 实例自身不再需要 unmount cleanup。

  // Esc 取消引用回复。skipIfInInput=false 因为编辑器是 contenteditable，用户
  // 在编辑器中正是最常按 Esc 取消引用的场景；IME composition 与 popover dismiss
  // 由 useEscKey 默认配置兜底。
  useEscKey(() => onCancelReply?.(), {
    enabled: !!replyDraft,
    skipIfInInput: false,
  });

  // Derive canSend from the TipTap doc and file tray.
  // useMemo([draft]) 包住 docToBlocks + 字符统计 —— 每字符输入都跑 filter/map/join
  // 在 IME 长输入下会卡顿,memo 后只在 draft 引用变化时重算。
  const { blocks, textJoined, charLength } = useMemo(() => {
    const blocks = docToBlocks(draft);
    const textBlocks = blocks.filter(
      (b): b is { type: "text"; value: string } => b.type === "text",
    );
    // 段间换行已由 docToBlocks 写入单个 text block 的 value 内("\n"),
    // 相邻 text block 之间的间隔代表"被图片打断",此时不该再注入额外换行。
    const textJoined = textBlocks.map((b) => b.value).join("");
    // [...str].length 比 Array.from(str).length 更地道,语义同(按 code point 计数)。
    const charLength = [...textJoined].length;
    return { blocks, textJoined, charLength };
  }, [draft]);
  const overLimit = charLength >= COMPOSER_MAX_CHARS;
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

  // 父组件持有 composerHeight 且按 conversation.id 重挂载本组件。若用户在会话 A
  // 加附件 → 高度 +84，切到 B 时本组件 unmount 但父高度仍是 +84，下一会话开局
  // 偏高。unmount cleanup 中若 bump 仍生效则回退，保证高度跨会话不漂移。
  useEffect(() => {
    return () => {
      if (chipBumpAppliedRef.current) {
        onHeightChange((prev) => clampComposerHeight(prev - CHIP_TRAY_FOOTPRINT_PX));
      }
    };
    // 仅依赖 onHeightChange；卸载时执行一次。父组件应保证 onHeightChange 引用稳定。
  }, [onHeightChange]);

  // ─── Attachment helpers ────────────────────────────────────────────────────

  /** Insert image files as inline image nodes in the TipTap editor. */
  const insertImageFiles = (files: File[]) => {
    if (!editorRef.current || files.length === 0) return;
    // 内嵌图片走 data: URL 而非 blob: URL。
    // blob URL 是 composer 实例级资源:切会话时本组件按 conversation.id 重挂载,
    // unmount cleanup(createdBlobUrlsRef effect) 会把所有 tracked blob 全 revoke,
    // 但 draft 存在 module-level useDraftStore.Map 中跨实例存活,image 节点 src 仍
    // 指向已死的 blob → 切回原会话时显示为损坏图。
    // data URL 把 bytes 编码进 src,无外部对象生命周期,切换/重载稳定显示。
    // 体积代价:base64 比 raw 多 ~33%;超过 useDraftStore 500KB 持久化上限时内存
    // 仍保留,仅丢失重载后的恢复——切会话场景不受影响。
    files.forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = typeof reader.result === "string" ? reader.result : null;
        if (!dataUrl || !editorRef.current) return;
        editorRef.current
          .chain()
          .focus()
          .insertContent({
            type: "image",
            attrs: { src: dataUrl, alt: file.name },
          })
          .run();
      };
      reader.readAsDataURL(file);
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
    setPendingFileAttachments([...pendingFileAttachments, ...next]);
    event.target.value = "";
  };

  const removePendingFileAttachment = (target: MessageAttachment) => {
    URL.revokeObjectURL(target.url);
    setPendingFileAttachments(pendingFileAttachments.filter((p) => p !== target));
  };

  // ─── Screenshot ───────────────────────────────────────────────────────────

  const handleScreenshot = useCallback(async () => {
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
  }, []);

  // ─── Quick replies & emoji ─────────────────────────────────────────────────
  // useCallback 包裹 → memo(ToolButton/popover children) 的 props 引用稳定,真正生效。

  const handleQuickReplySelect = useCallback((reply: QuickReply) => {
    editorRef.current?.chain().focus().insertContent(reply.preview).run();
    setQuickRepliesOpen(false);
  }, []);

  const handleEmojiSelect = useCallback((emoji: string) => {
    editorRef.current?.chain().focus().insertContent(emoji).run();
    setEmojiOpen(false);
  }, []);

  const handleImageButton = useCallback(() => imageInputRef.current?.click(), []);
  const handleFileButton = useCallback(() => fileInputRef.current?.click(), []);

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
      fileAttachments.length > 0 ? [...fileAttachments] : undefined,
      replyDraft?.id,
    );
    // 清空 store 中的待发送附件;blob URL 的 ownership 已交给 MessageBubble,
    // 故只删 store entry,不在此处 revoke。
    setPendingFileAttachments([]);
    // Reset draft (sets EMPTY_DOC in the store).
    clearDraft(conversationId);
    // Reset the editor's content AND collapse the selection back to position 0.
    // setContent alone doesn't move the caret — when the previous draft was tall
    // enough to scroll the editor, the browser keeps painting the caret at the
    // old DOM y-coordinate, leaving a phantom cursor floating in the empty
    // composer until the user clicks somewhere. focus('start') re-anchors both
    // ProseMirror's selection and the visible caret to the new empty paragraph.
    editorRef.current
      ?.chain()
      .setContent({
        type: "doc",
        content: [{ type: "paragraph" }],
      })
      .focus("start")
      .run();
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
      <div className="flex h-full w-full flex-col gap-1 bg-workbench-surface">
        {replyDraft && <ReplyPreview draft={replyDraft} onCancel={() => onCancelReply?.()} />}
        <div className="flex items-center gap-0.5 text-workbench-text-secondary">
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
                <Laugh size={18} strokeWidth={1.6} />
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
            onClick={handleImageButton}
            withHoverDot
          />
          <ToolButton icon={Paperclip} label={STRINGS.composer.file} onClick={handleFileButton} />
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
                className="focus-ring inline-flex h-9 items-center gap-1 rounded-md px-2.5 text-wb-2xs font-medium text-workbench-text-secondary transition-colors hover:bg-workbench-surface-subtle hover:text-workbench-text disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
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
            disabled={!textJoined.trim()}
            disabledReason={!textJoined.trim() ? STRINGS.composer.aiPolishEmptyHint : undefined}
            onApply={(newText) => {
              if (!editorRef.current) return;
              // polish replaces text content; images keep their original order at the end
              const currentBlocks = docToBlocks(editorRef.current.getJSON());
              const imageBlocks = currentBlocks.filter((b) => b.type === "image");
              const newBlocks: MessageBlock[] = newText
                ? [{ type: "text", value: newText }, ...imageBlocks]
                : [...imageBlocks];
              editorRef.current.chain().focus().setContent(blocksToDoc(newBlocks)).run();
            }}
          />
          <span
            className={cn(
              "wb-num ml-2 inline-flex items-center gap-2 text-wb-3xs font-medium text-workbench-text-muted",
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

// Memo:工具栏每次 composer state (draft / replyDraft / 高度) 变化都重渲;
// 各 ToolButton props 引用稳定时跳过重渲。
const ToolButton = memo(function ToolButton({
  icon: Icon,
  label,
  onClick,
  withHoverDot,
}: {
  icon: typeof Camera;
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
});

const ReplyPreview = memo(function ReplyPreview({
  draft,
  onCancel,
}: {
  draft: ReplyTarget & { id: string };
  onCancel: () => void;
}) {
  return (
    <div className="flex shrink-0 items-start gap-2 rounded-md bg-workbench-surface-soft px-2.5 py-1.5">
      <span
        aria-hidden
        className="mt-0.5 w-[2px] shrink-0 self-stretch rounded-full bg-workbench-accent/40"
      />
      <div className="min-w-0 flex-1 leading-snug">
        <div className="truncate text-wb-3xs text-workbench-text-secondary">
          {draft.senderName}：
        </div>
        <div className="truncate text-wb-2xs text-workbench-text-muted">{draft.text}</div>
      </div>
      <button
        type="button"
        onClick={onCancel}
        title={STRINGS.composer.cancelReply}
        aria-label={STRINGS.composer.cancelReply}
        className="focus-ring -mr-1 grid size-6 shrink-0 place-items-center rounded-full text-workbench-text-muted transition-colors hover:bg-workbench-surface-subtle hover:text-workbench-text"
      >
        <X size={12} strokeWidth={2} aria-hidden />
      </button>
    </div>
  );
});

const FileChip = memo(function FileChip({
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
        <span className="truncate text-wb-2xs font-medium text-workbench-text">
          {attachment.name ?? STRINGS.attachment.file}
        </span>
        <span className="wb-num text-wb-3xs text-workbench-text-muted">
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
});
