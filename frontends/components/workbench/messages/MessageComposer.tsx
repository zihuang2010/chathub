import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import * as Popover from "@radix-ui/react-popover";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { Editor, JSONContent } from "@tiptap/react";
import {
  FileText,
  FolderUp,
  Image,
  Mic,
  Laugh,
  PanelRightClose,
  PanelRightOpen,
  Scissors,
  WifiOff,
  X,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/Modal";
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
import { attachmentTypeFromExt, DOC_EXTS, IMAGE_EXTS, VOICE_EXTS } from "./data";
import { AiPolishPopover } from "./composer/AiPolishPopover";
import { SendButtonGroup } from "./composer/SendButtonGroup";
import { blocksToDoc, docToBlocks } from "./composer/docToBlocks";
import { RichComposer } from "./composer/RichComposer";
import { EmojiPicker } from "./EmojiPicker";
import { readImageFileDimensions } from "./imageFileDimensions";
import type { ReplyTarget } from "./MessageBubble";
import { QuickRepliesPanel } from "./QuickRepliesPanel";
import { STRINGS } from "./strings";
import {
  clearDraft,
  flushDraftToBackend,
  getDraft,
  setDraft,
  useDraft,
  useFileAttachments,
} from "./useDraftStore";
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
  /** 快捷回复增删改回调:存在则 popover 内开启管理(新增 / 编辑 / 删除)。 */
  onCreateQuickReply?: (title: string, content: string) => void;
  onUpdateQuickReply?: (id: string, title: string, content: string) => void;
  onDeleteQuickReply?: (id: string) => void;
  /** Contacts shown in the @mention popover when the user types `@`. */
  mentionCandidates?: Conversation[];
  /** Pinned reply target: when present, renders a quote preview above the toolbar
   *  and attaches `id` to the next outgoing message via `onSend`'s replyTo arg. */
  replyDraft?: (ReplyTarget & { id: string }) | null;
  onCancelReply?: () => void;
  /** 点 AI 润色「生成」那一刻取近期对话转录(可为空串),透传给 AiPolishPopover。 */
  getPolishContext?: () => string;
  /** hub 连接断开:置真时顶部显示离线横幅并禁用发送(用户仍可继续编辑草稿)。 */
  offline?: boolean;
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

// <input accept> 取值:Tauri/macOS 的 WKWebView **只认 MIME 类型,忽略纯扩展名**
// (".amr" 这种)→ 只给扩展名时原生文件框根本不过滤、任何文件都能选(点"语音"却能选图片)。
// 故必须带 MIME 才能让原生框真正按类型限制;扩展名一并附上(Chromium 网页预览据此过滤、
// 也便于阅读)。accept 仅是对话框提示、不可信,onChange 里仍用 keepByExt 按扩展名白名单二次校验。
const acceptFor = (mime: string, exts: readonly string[]) =>
  [mime, ...exts.map((e) => "." + e)].join(",");
const IMAGE_ACCEPT = acceptFor("image/jpeg,image/png,image/gif,image/webp", IMAGE_EXTS);
// 语音用 audio/* 通配:已核验 amr(本应用主力语音格式)的 UTI 归属 public.audio,通配可靠纳入
// amr/mp3/wav,不会因个别 MIME 未声明而把 amr 误排除;少数旁系音频(m4a/aac)露出由 keepByExt 拦下。
const VOICE_ACCEPT = acceptFor("audio/*", VOICE_EXTS);
const DOC_ACCEPT = acceptFor(
  "application/pdf,application/msword," +
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document," +
    "application/vnd.ms-excel," +
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet," +
    "application/vnd.ms-powerpoint," +
    "application/vnd.openxmlformats-officedocument.presentationml.presentation," +
    "text/plain,application/zip,application/vnd.rar",
  DOC_EXTS,
);

// 取文件名扩展名(不含点,小写);无扩展名返回空串。
const extOf = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
};

// 按扩展名白名单过滤文件,丢弃不在白名单内的(对话框 accept 提示的兜底二次校验)。
const keepByExt = (files: File[], exts: readonly string[]) =>
  files.filter((f) => (exts as readonly string[]).includes(extOf(f.name)));

// 单个附件体积上限(200 MiB):超限的图片/文件在选择/粘贴/截图入口即拦下,不入编辑器/托盘,
// 避免无谓读字节再上传到 OSS 才失败。语音另有 2MB/60s 硬限(见 useChatActions 的 voiceExceedsLimit)。
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const keepBySize = (files: File[], max: number) => files.filter((f) => f.size <= max);

// 选错文件 / 读取失败时的统一提示。
const reportPickError = (e: unknown) =>
  showToast(`选择文件失败：${e instanceof Error ? e.message : String(e)}`, { type: "error" });

// 扩展名 → MIME:给 new File 的 type 用(图片尤其需要正确 type 才能在编辑器/上传中正常处理)。
const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  amr: "audio/amr",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  zip: "application/zip",
  rar: "application/vnd.rar",
};

// 用 Tauri 原生文件框按扩展名过滤(macOS 上 <input accept> 无法过滤,见 wry#1191):选中路径经
// read_local_file 读回字节,就地组装成 File 交给与 <input> 完全一致的下游管线。仅在 Tauri 下调用;
// web 预览仍走隐藏 <input>(其 accept 在 Chromium 下有效)。
async function pickNativeFiles(
  label: string,
  exts: readonly string[],
  multiple: boolean,
): Promise<File[]> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const sel = await open({
    multiple,
    filters: [{ name: label, extensions: exts as unknown as string[] }],
  });
  if (!sel) return [];
  const paths = Array.isArray(sel) ? sel : [sel];
  return Promise.all(
    paths.map(async (path) => {
      const buf = await invoke<ArrayBuffer>("read_local_file", { path });
      const name = path.split(/[/\\]/).pop() || path;
      return new File([buf], name, {
        type: MIME_BY_EXT[extOf(name)] ?? "application/octet-stream",
      });
    }),
  );
}

export function MessageComposer({
  conversationId,
  height,
  onHeightChange,
  detailsOpen,
  onToggleDetails,
  onSend,
  quickReplies,
  onCreateQuickReply,
  onUpdateQuickReply,
  onDeleteQuickReply,
  mentionCandidates,
  replyDraft,
  onCancelReply,
  getPolishContext,
  offline = false,
}: MessageComposerProps) {
  const [draft] = useDraft(conversationId);
  const [pendingFileAttachments, setPendingFileAttachments] = useFileAttachments(conversationId);
  const [isResizing, setIsResizing] = useState(false);
  const [quickRepliesOpen, setQuickRepliesOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  // 点语音按钮时若编辑器已有内容,先弹此确认框(避免误清空);确认后才切到语音独占态。
  const [voiceConfirmOpen, setVoiceConfirmOpen] = useState(false);
  const editorRef = useRef<Editor | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const voiceInputRef = useRef<HTMLInputElement | null>(null);
  const resizeStartRef = useRef({ y: 0, height });
  // 防重复提交:连按 Enter 时 draft 清空(异步 setState)尚未生效,submitDraft 可能读到旧
  // draft 在同一拍内重复触发 onSend → 同一条消息发多份。提交后上锁,本帧内的重复提交被吞掉,
  // 下一帧(draft 已清空、canSend 已 false)放开。
  const submitLockRef = useRef(false);

  // ─── 草稿节流落库 ──────────────────────────────────────────────────────────
  // 连续输入时把 getJSON→store→MessageComposer 重渲 从「每字一次」降到 ~每 120ms 一次,
  // 降低输入期重渲。字数/canSend 显示随之滞后 ≤120ms(已与用户确认接受);发送与
  // 切会话/卸载分别用「实时编辑器内容」「flushPendingDraft」兜底,保证不丢字、不误判。
  //
  // pending 连同其所属 conversationId 一起暂存:切会话的 setContent 会触发一次 onUpdate,
  // 若只存 doc、由旧会话 cleanup 落库,会把「新会话内容」误写进旧会话(草稿串台,被
  // MessageComposer.switch.test.tsx 钉死)。带上 id 后,落库永远写回内容真正所属的会话。
  const pendingDraftRef = useRef<{ id: string; doc: JSONContent } | null>(null);
  const draftThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 把节流窗口内最新草稿立即落到「它所属的」会话 store 并清计时器 —— 切走/卸载/发送前调用。
  const flushPendingDraft = useCallback(() => {
    if (draftThrottleRef.current) {
      clearTimeout(draftThrottleRef.current);
      draftThrottleRef.current = null;
    }
    const pending = pendingDraftRef.current;
    if (pending) {
      pendingDraftRef.current = null;
      setDraft(pending.id, pending.doc);
    }
  }, []);

  // RichComposer 每次按键仍回调本函数,但只暂存最新 doc(连同当前 conversationId);真正写
  // store(触发重渲)被节流到 ~120ms 一次。切会话由下方 layout effect 先 flush 旧会话 pending
  // 再 setContent,故 setContent 触发的 onUpdate 暂存的已是新会话 id,落库不串台。
  const handleEditorChange = useCallback(
    (doc: JSONContent) => {
      pendingDraftRef.current = { id: conversationId, doc };
      if (draftThrottleRef.current) return; // 冷却窗口内:仅更新最新 doc,不重复排程
      draftThrottleRef.current = setTimeout(() => {
        draftThrottleRef.current = null;
        const pending = pendingDraftRef.current;
        if (pending) {
          pendingDraftRef.current = null;
          setDraft(pending.id, pending.doc);
        }
      }, 120);
    },
    [conversationId],
  );

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
  // 超限不再拦截发送:超过 COMPOSER_MAX_CHARS 的文本会被发送链路(buildSendUnits)自动落成
  // .txt 文件附件发出,故 canSend 不受 overLimit 约束;计数仍以 warning 色提示已超限。
  const canSend =
    textJoined.trim().length > 0 ||
    blocks.some((b) => b.type === "image") ||
    pendingFileAttachments.length > 0;

  // 语音独占态(派生,不引入独立 state):托盘里有一条 voice 附件时为真。
  // 真时禁用编辑器与所有内容输入控件,确保语音单独发送。退出独占态只需移除该 voice chip。
  const voiceMode = pendingFileAttachments.some((a) => a.type === "voice");

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

  // 本组件已是「持久化编辑器」:父组件(ChatArea)不再按 conversation.id 重挂载它,
  // 切会话只载草稿、不重建。故此 cleanup 仅在本组件真正卸载(ChatArea 整体卸载)时触发:
  // 若届时 chip bump 仍生效则把父高度回退 +84,避免残留高度。切会话时的高度回退由上方
  // 依赖 pendingFileAttachments.length 的 layout effect 正确驱动,不靠本 cleanup。
  useEffect(() => {
    return () => {
      if (chipBumpAppliedRef.current) {
        onHeightChange((prev) => clampComposerHeight(prev - CHIP_TRAY_FOOTPRINT_PX));
      }
    };
    // 仅依赖 onHeightChange；卸载时执行一次。父组件应保证 onHeightChange 引用稳定。
  }, [onHeightChange]);

  // 草稿"切走才更新会话列表":输入过程中只写本地(useDraftStore debounce),不动
  // 后端。本 effect 依赖 conversationId,其 cleanup 在 conversationId 变化(切到别的接待人)
  // 或卸载时以**旧** id 触发,此刻把旧会话草稿刷到后端 → 会话列表才出现 "[草稿]" 样式并按
  // localDraftAtMs 重排。flushDraftToBackend 对非 dirty 会话是 no-op,故初次挂载 / StrictMode
  // 双挂不会误把刚打开的会话标成草稿态。
  useEffect(() => {
    return () => {
      // 卸载(离开消息页)时把节流窗口内未提交的草稿落库,再刷后端,否则最后 <120ms 的输入会丢。
      // 切会话的落库已由下方 layout effect 在 setContent 前完成;此处主要兜住「整体卸载」路径。
      // pending 自带所属 id,flush 写回正确会话;flushDraftToBackend 用旧 conversationId 闭包。
      flushPendingDraft();
      flushDraftToBackend(conversationId);
    };
  }, [conversationId, flushPendingDraft]);

  // 持久化编辑器:过去靠 ChatArea 的 key={conversation.id} 让本组件每次切会话整块重挂 →
  // 重建整个 TipTap/ProseMirror 编辑器(本 UI 单次开销最大的对象),频繁切换接待列表时是
  // JS 堆锯齿上涨与切换卡顿的主因。现编辑器跨会话常驻,切会话时把新会话草稿载入同一实例并
  // 聚焦末尾——等价于原重挂时 `content=draft + autofocus:"end"` 的可见行为,但零编辑器重建。
  // 用 layout effect 在绘制前换内容,避免新会话标题下短暂残留旧会话草稿文本的闪帧。setContent
  // 沿用 submitDraft 写法不 emitUpdate(TipTap v3 默认),不会把内容回写 store。上一会话的草稿
  // 已由输入时的 onChange 实时写入 store、并由上面的 cleanup 刷到后端,故此处只读取新会话草稿。
  const prevConversationIdRef = useRef(conversationId);
  useLayoutEffect(() => {
    if (prevConversationIdRef.current === conversationId) return;
    // 切走前先把旧会话在节流窗口内未提交的草稿落库(pending 自带旧 id),且必须在 setContent
    // 之前——否则 setContent 触发的 onUpdate 会用新会话内容覆盖 pending,导致旧会话丢字。
    flushPendingDraft();
    const editor = editorRef.current;
    if (!editor) return; // 编辑器尚未就绪(极早期):本次跳过,下次切换再载入最新会话
    prevConversationIdRef.current = conversationId;
    editor.chain().setContent(getDraft(conversationId)).focus("end").run();
  }, [conversationId, flushPendingDraft]);

  // ─── Attachment helpers ────────────────────────────────────────────────────

  /** Insert image files as inline image nodes in the TipTap editor. */
  const insertImageFiles = (files: File[]) => {
    if (!editorRef.current) return;
    // 超 200MiB 的图片在入编辑器前拦下并提示(图片选择 / 粘贴 / 截图三入口共用此处收口)。
    const allowed = keepBySize(files, MAX_UPLOAD_BYTES);
    if (allowed.length < files.length) showToast(STRINGS.toast.fileTooLarge, { type: "error" });
    if (allowed.length === 0) return;
    files = allowed;
    // 内嵌图片走 data: URL 而非 blob: URL。
    // blob URL 是 composer 实例级资源:切会话时本组件按 conversation.id 重挂载,
    // unmount cleanup(createdBlobUrlsRef effect) 会把所有 tracked blob 全 revoke,
    // 但 draft 存在 module-level useDraftStore.Map 中跨实例存活,image 节点 src 仍
    // 指向已死的 blob → 切回原会话时显示为损坏图。
    // data URL 把 bytes 编码进 src,无外部对象生命周期,切换/重载稳定显示。
    // 体积代价:base64 比 raw 多 ~33%;超过 useDraftStore 500KB 持久化上限时内存
    // 仍保留,仅丢失重载后的恢复——切会话场景不受影响。
    files.forEach((file) => {
      const dimensions = readImageFileDimensions(file);
      const reader = new FileReader();
      reader.onload = async () => {
        const dataUrl = typeof reader.result === "string" ? reader.result : null;
        if (!dataUrl || !editorRef.current) return;
        const dims = await dimensions;
        editorRef.current
          .chain()
          .focus()
          .insertContent({
            type: "image",
            attrs: {
              src: dataUrl,
              alt: file.name,
              width: dims?.width,
              height: dims?.height,
            },
          })
          .run();
      };
      reader.readAsDataURL(file);
    });
  };

  // 选中文件的落地处理:原生 dialog 与 web <input> 两条路径共用。按扩展名白名单兜底过滤
  // (原生 dialog 已按扩展名过滤,这里对 web 路径与极端情况再兜一层),非法格式提示后插入/入托盘。
  const acceptImageFiles = useCallback((raw: File[]) => {
    const files = keepByExt(raw, IMAGE_EXTS);
    if (files.length < raw.length) showToast(STRINGS.toast.imageFormatOnly, { type: "error" });
    insertImageFiles(files);
  }, []);

  const acceptDocFiles = useCallback(
    (raw: File[]) => {
      const byExt = keepByExt(raw, DOC_EXTS);
      if (byExt.length < raw.length) showToast(STRINGS.toast.fileFormatOnly, { type: "error" });
      // 超 200MiB 的文件拦下并提示,不入托盘(避免上传到 OSS 才失败)。
      const files = keepBySize(byExt, MAX_UPLOAD_BYTES);
      if (files.length < byExt.length) showToast(STRINGS.toast.fileTooLarge, { type: "error" });
      // 按文件后缀判定附件类型,使 messageType 正确分流(如 amr→voice→4),与接收侧一致。
      const next: MessageAttachment[] = files.map((file) => ({
        type: attachmentTypeFromExt(extOf(file.name)),
        url: URL.createObjectURL(file),
        name: file.name,
        sizeBytes: file.size,
      }));
      // 追加到当前托盘(setPendingFileAttachments 取数组、不支持函数式更新)。原生 dialog 为模态,
      // 选择期间用户无法改动托盘,故依赖闭包捕获的 pendingFileAttachments 即当前值,不会丢已有附件。
      if (next.length > 0) setPendingFileAttachments([...pendingFileAttachments, ...next]);
    },
    [pendingFileAttachments, setPendingFileAttachments],
  );

  // 语音:单选,取第 1 个合法文件做成 type:"voice" 附件,替换托盘为单条(进入独占态)。
  const acceptVoiceFiles = useCallback(
    (raw: File[]) => {
      const files = keepByExt(raw, VOICE_EXTS);
      if (files.length < raw.length) showToast(STRINGS.toast.voiceFormatOnly, { type: "error" });
      const file = files[0];
      if (file) {
        setPendingFileAttachments([
          { type: "voice", url: URL.createObjectURL(file), name: file.name, sizeBytes: file.size },
        ]);
      }
    },
    [setPendingFileAttachments],
  );

  // web 预览(非 Tauri)的隐藏 <input> onChange:复用上面的 accept* 落地逻辑。
  const handleImagePicker = (event: ChangeEvent<HTMLInputElement>) => {
    acceptImageFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  };
  const handleFilePicker = (event: ChangeEvent<HTMLInputElement>) => {
    acceptDocFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  };
  const handleVoicePicker = (event: ChangeEvent<HTMLInputElement>) => {
    acceptVoiceFiles(Array.from(event.target.files ?? []));
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

  // 图片/文档/语音:Tauri 下走原生 dialog 按扩展名过滤(macOS 上 <input accept> 不过滤);
  // 非 Tauri(web 预览)回退隐藏 <input>。
  const handleImageButton = useCallback(() => {
    if (!isTauri()) return void imageInputRef.current?.click();
    pickNativeFiles("图片", IMAGE_EXTS, true).then(acceptImageFiles).catch(reportPickError);
  }, [acceptImageFiles]);
  const handleFileButton = useCallback(() => {
    if (!isTauri()) return void fileInputRef.current?.click();
    pickNativeFiles("文档", DOC_EXTS, true).then(acceptDocFiles).catch(reportPickError);
  }, [acceptDocFiles]);
  const openVoicePicker = useCallback(() => {
    if (!isTauri()) return void voiceInputRef.current?.click();
    pickNativeFiles("语音", VOICE_EXTS, false).then(acceptVoiceFiles).catch(reportPickError);
  }, [acceptVoiceFiles]);

  // 点语音按钮:编辑器已有内容(文本 / 内联图片 / 已有附件)时先弹确认框,避免误清空;
  // 否则直接打开语音选择器。
  const handleVoiceButton = useCallback(() => {
    const composerHasContent =
      textJoined.trim().length > 0 ||
      blocks.some((b) => b.type === "image") ||
      pendingFileAttachments.length > 0;
    if (composerHasContent) {
      setVoiceConfirmOpen(true);
    } else {
      openVoicePicker();
    }
  }, [textJoined, blocks, pendingFileAttachments, openVoicePicker]);

  // 确认"改用语音":清空文本与编辑器、revoke 并清空现有附件,再打开语音选择器。
  const confirmVoiceSwitch = useCallback(() => {
    setVoiceConfirmOpen(false);
    clearDraft(conversationId);
    editorRef.current
      ?.chain()
      .setContent({ type: "doc", content: [{ type: "paragraph" }] })
      .run();
    // 清空前先 revoke blob,避免底层 File 随附件丢弃后仍驻留进程内存。
    for (const a of pendingFileAttachments) {
      if (a.url.startsWith("blob:")) URL.revokeObjectURL(a.url);
    }
    setPendingFileAttachments([]);
    openVoicePicker();
  }, [conversationId, pendingFileAttachments, setPendingFileAttachments, openVoicePicker]);

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
    if (offline || submitLockRef.current) return;
    // 读实时编辑器内容算 blocks/canSend(而非 debounce 后的 draft):打字后立刻回车不丢最后
    // 几个字;空框敲首字立刻回车也不会被滞后的 canSend 误吞。
    const liveDoc = editorRef.current?.getJSON() ?? draft;
    const liveBlocks = docToBlocks(liveDoc);
    const liveText = liveBlocks
      .filter((b): b is { type: "text"; value: string } => b.type === "text")
      .map((b) => b.value)
      .join("");
    const liveCanSend =
      liveText.trim().length > 0 ||
      liveBlocks.some((b) => b.type === "image") ||
      pendingFileAttachments.length > 0;
    if (!liveCanSend) return;
    submitLockRef.current = true;
    const finalBlocks = liveBlocks.filter(
      (b) => !(b.type === "text" && b.value.trim().length === 0),
    );
    const fileAttachments = pendingFileAttachments;
    onSend?.(
      liveText.trim(),
      finalBlocks.length > 0 ? finalBlocks : undefined,
      fileAttachments.length > 0 ? [...fileAttachments] : undefined,
      replyDraft?.id,
    );
    // 释放已发送文件附件的 blob URL。下游不会再消费它:MessageContent 的 FileAttachment
    // 用 isSafeUrl(url, "link") 校验下载链接,blob: 不在 link 白名单 → href 恒为 undefined;
    // 且 setFileAttachments([]) 删 entry 时并不 revoke。不在此 revoke 会让底层 File(常达
    // 几十 MB)随每次发送永久驻留进程内存。
    // 例外:语音不能在此 revoke。语音乐观气泡未落库前,VoiceAttachment 点击播放走 isLocal
    // 分支 fetch(part.url) 复用这条 blob 做应用内解码(benz)。提前 revoke → fetch 抛错 →
    // 回退 openExternal(blob:) 无效 → 本地刚发的语音「点了播不了」。ownership 已转给气泡
    // (见上方文件附件 blob 生命周期注释),其 blob 随会话 LRU 淘汰 / 页面 unload 回收;语音
    // 体积小(≤2MB),驻留有界。图片不受此影响是因 <img> 在 revoke 前已即时加载解码。
    for (const a of fileAttachments) {
      if (a.type !== "voice" && a.url.startsWith("blob:")) URL.revokeObjectURL(a.url);
    }
    setPendingFileAttachments([]);
    // 取消未提交的草稿节流(马上要清空草稿,避免计时器回写已清空前的内容)。
    if (draftThrottleRef.current) {
      clearTimeout(draftThrottleRef.current);
      draftThrottleRef.current = null;
    }
    pendingDraftRef.current = null;
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
    // 下一帧放开提交锁:此时 draft 已清空、重渲后 canSend=false,跨拍的连发由 canSend 兜住。
    requestAnimationFrame(() => {
      submitLockRef.current = false;
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
        accept={DOC_ACCEPT}
        className="hidden"
        onChange={handleFilePicker}
      />
      <input
        ref={imageInputRef}
        type="file"
        multiple
        accept={IMAGE_ACCEPT}
        className="hidden"
        onChange={handleImagePicker}
      />
      <input
        ref={voiceInputRef}
        type="file"
        accept={VOICE_ACCEPT}
        className="hidden"
        onChange={handleVoicePicker}
      />
      <div className="flex h-full w-full flex-col gap-1 bg-workbench-surface">
        {/* 离线横幅:常驻挂载 + grid-rows 0fr↔1fr 高度过渡 + opacity 淡入淡出。常驻挂载才能在
            「重连成功 → 隐藏」时也走淡出(条件卸载只能淡入);offline 由 ChatArea 粘滞派生,重连
            期间保持 true 不变 → 不重放动画、稳定不闪。!offline 时 -mb-1 抵消父级 gap-1 给 0 高度
            子项留下的 4px 缝,在线时整体布局零变化。 */}
        <div
          data-testid="composer-offline-banner"
          data-visible={offline ? "true" : "false"}
          aria-hidden
          className={cn(
            "grid shrink-0 overflow-hidden transition-all duration-300 ease-out motion-reduce:transition-none",
            offline ? "grid-rows-[1fr] opacity-100" : "-mb-1 grid-rows-[0fr] opacity-0",
          )}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="text-wb-3xs flex items-center gap-1.5 rounded-md bg-workbench-surface-soft px-2.5 py-1 font-medium text-workbench-danger">
              <WifiOff size={12} strokeWidth={1.8} aria-hidden />
              <span>{STRINGS.composer.offlineBanner}</span>
            </div>
          </div>
        </div>
        {/* 屏幕阅读器播报:上方视觉横幅常驻挂载以走淡入「淡出」,故置 aria-hidden 装饰化;播报改由
            独立 sr-only live region 承担 —— 文本「空↔有」切换才能可靠触发(仅翻转 aria-hidden 多数
            浏览器不重播),与下方字数上限提示同一套路。 */}
        <span role="status" aria-live="polite" className="sr-only">
          {offline ? STRINGS.composer.offlineBanner : ""}
        </span>
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
                // 语音独占态禁用:TipTap 命令 API 仍能往非 editable 编辑器插表情,
                // 必须靠按钮 disabled 拦住,不能只靠编辑器 editable=false。
                disabled={voiceMode}
                className="focus-ring grid h-9 w-9 place-items-center rounded-lg text-workbench-text-secondary transition-colors hover:bg-workbench-surface-subtle hover:text-workbench-text disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
              >
                <Laugh size={18} strokeWidth={1.6} />
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
            disabled={voiceMode}
          />
          <ToolButton
            icon={Image}
            label={STRINGS.composer.image}
            onClick={handleImageButton}
            disabled={voiceMode}
          />
          <ToolButton
            icon={Mic}
            label={STRINGS.composer.voice}
            onClick={handleVoiceButton}
            disabled={voiceMode}
          />
          <ToolButton
            icon={FolderUp}
            label={STRINGS.composer.addAttachment}
            onClick={handleFileButton}
            disabled={voiceMode}
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
          // 语音独占态禁用文本编辑(置灰);editable=false 仅拦用户输入,
          // 表情/截图/快捷回复等命令式插入仍靠各自按钮 disabled 兜底。
          editable={!voiceMode}
          mentionCandidates={mentionCandidates}
          onChange={handleEditorChange}
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
                // 可管理(传了 onCreate)时即使列表为空也要能打开 popover 去新增第一条;
                // 纯展示场景(无管理回调)才在无数据时禁用。语音独占态下一并禁用,
                // 防止快捷回复经 TipTap 命令绕过 editable=false 把文本插进禁用编辑器。
                disabled={
                  ((!quickReplies || quickReplies.length === 0) && !onCreateQuickReply) || voiceMode
                }
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
                <QuickRepliesPanel
                  items={quickReplies ?? []}
                  onSelect={handleQuickReplySelect}
                  onCreate={onCreateQuickReply}
                  onUpdate={onUpdateQuickReply}
                  onDelete={onDeleteQuickReply}
                />
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
          <AiPolishPopover
            originalText={textJoined}
            getContext={getPolishContext}
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
              "wb-num text-wb-3xs ml-2 inline-flex items-center gap-2 font-medium text-workbench-text-muted",
              // 超限不再是错误态(会自动转 txt 发送),与接近上限统一用 warning 色提示。
              nearLimit && "text-workbench-warning",
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
            <SendButtonGroup canSend={canSend && !offline} onSend={submitDraft} />
          </div>
        </div>
      </div>
      {/* 改用语音前的二次确认:确认后清空文本与附件并打开语音选择器。 */}
      <Modal
        open={voiceConfirmOpen}
        onClose={() => setVoiceConfirmOpen(false)}
        ariaLabel={STRINGS.composer.voiceExclusiveTitle}
      >
        <div className="flex flex-col gap-3 p-5">
          <h2 className="text-wb-sm font-semibold text-workbench-text">
            {STRINGS.composer.voiceExclusiveTitle}
          </h2>
          <p className="text-wb-2xs leading-relaxed text-workbench-text-secondary">
            {STRINGS.composer.voiceExclusiveBody}
          </p>
          <div className="mt-1 flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setVoiceConfirmOpen(false)}>
              {STRINGS.composer.voiceExclusiveCancel}
            </Button>
            <Button variant="default" size="sm" onClick={confirmVoiceSwitch}>
              {STRINGS.composer.voiceExclusiveConfirm}
            </Button>
          </div>
        </div>
      </Modal>
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
  disabled,
}: {
  icon: LucideIcon;
  label: string;
  onClick?: () => void;
  withHoverDot?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "focus-ring grid h-9 w-9 place-items-center rounded-lg text-workbench-text-secondary transition-colors hover:bg-workbench-surface-subtle hover:text-workbench-text disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
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
        <div className="text-wb-3xs truncate text-workbench-text-secondary">
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
  // 语音附件用 Mic 图标 + "语音"缺省名,与普通文件 chip 轻量区分。
  const isVoice = attachment.type === "voice";
  return (
    <div className="group relative flex h-14 min-w-[160px] max-w-[240px] items-center gap-2.5 rounded-xl border border-workbench-line bg-workbench-surface px-3 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-colors hover:bg-workbench-surface-subtle">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-workbench-surface-soft text-workbench-accent">
        {isVoice ? (
          <Mic size={17} strokeWidth={1.55} aria-hidden />
        ) : (
          <FileText size={17} strokeWidth={1.55} aria-hidden />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-tight">
        <span className="truncate text-wb-2xs font-medium text-workbench-text">
          {attachment.name ?? (isVoice ? STRINGS.attachment.voice : STRINGS.attachment.file)}
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
