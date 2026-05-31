import type { JSONContent } from "@tiptap/react";
import { useCallback, useSyncExternalStore } from "react";

import { setConversationDraft } from "@/lib/api/recentFriends";

import type { MessageAttachment } from "./data";

// ─── Persistent draft store ─────────────────────────────────────────────────
//
// Module-level pub/sub backed by localStorage:
//   - In-memory `Map` is the source of truth at runtime; localStorage is the
//     persistence side-channel (writes are debounced 500ms to avoid thrashing
//     during fast typing).
//   - `MAX_DRAFTS = 50` caps storage so a long-lived workbench can't grow
//     unbounded; oldest-touched entries fall off via LRU.
//   - All localStorage access is wrapped in try/catch — Safari private mode,
//     SSR, and quota-exhausted scenarios degrade gracefully to memory-only.
//   - Writing an empty doc deletes the entry (free up the slot).

const STORAGE_PREFIX = "chathub-draft-";
const STORAGE_INDEX_KEY = "chathub-draft-index";
const MAX_DRAFTS = 50;
const WRITE_DEBOUNCE_MS = 500;

export const EMPTY_DOC: JSONContent = { type: "doc", content: [{ type: "paragraph" }] };

function isEmptyDoc(doc: JSONContent): boolean {
  if (!doc || doc.type !== "doc") return true;
  const content = doc.content;
  if (!content || content.length === 0) return true;
  if (content.length === 1) {
    const only = content[0];
    if (only.type === "paragraph" && (!only.content || only.content.length === 0)) {
      return true;
    }
  }
  return false;
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

/**
 * Walk a TipTap doc tree and blank the `src` attr of any image node whose src
 * starts with `"blob:"`. Object URLs are session-scoped — once the page reloads
 * they're dead, so persisting them is worse than persisting nothing (the user
 * sees a broken image and may submit the dead URL by accident).
 *
 * Pure: preserves referential equality on subtrees with no blob images so the
 * caller can cheaply detect "nothing was stripped".
 */
export function stripBlobImageSrcs(doc: JSONContent): JSONContent {
  return stripNode(doc);
}

function stripNode(node: JSONContent): JSONContent {
  if (
    node.type === "image" &&
    typeof node.attrs?.src === "string" &&
    node.attrs.src.startsWith("blob:")
  ) {
    return { ...node, attrs: { ...node.attrs, src: "" } };
  }
  const children = node.content;
  if (!children || children.length === 0) return node;
  let changed = false;
  const next: JSONContent[] = new Array(children.length);
  for (let i = 0; i < children.length; i++) {
    const original = children[i];
    const replaced = stripNode(original);
    if (replaced !== original) changed = true;
    next[i] = replaced;
  }
  if (!changed) return node;
  return { ...node, content: next };
}

/** Wrap a legacy raw-string draft in a TipTap doc with a single paragraph. */
function legacyStringToDoc(text: string): JSONContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  };
}

const drafts = new Map<string, JSONContent>();
// LRU order — most recently touched at the END.
const order: string[] = [];
const listeners = new Set<() => void>();
const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>();
// 本会话内改动过、但尚未同步到后端的会话。后端同步(驱动会话列表的"[草稿]"样式
// 与排名)推迟到切走会话时由 flushDraftToBackend 触发;dirty 标记让 flush 能跳过
// 从未编辑过的会话,避免纯切会话(click-through)也打一发冗余 IPC。
const dirtyBackend = new Set<string>();

function safeWindow(): Window | null {
  return typeof window !== "undefined" ? window : null;
}

function isValidJSONContent(value: unknown): value is JSONContent {
  return (
    typeof value === "object" && value !== null && (value as { type?: unknown }).type === "doc"
  );
}

/**
 * Try to interpret a localStorage entry as a draft and stash it in the
 * in-memory map. Returns the legacy-migration source string if a re-persist is
 * needed (caller schedules it asynchronously to keep this fn sync-safe).
 */
function ingestRawDraft(id: string, raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Old format: raw plain text written via `localStorage.setItem(key, text)`.
    if (raw.length === 0) return null;
    drafts.set(id, legacyStringToDoc(raw));
    order.push(id);
    return raw;
  }
  if (isValidJSONContent(parsed)) {
    drafts.set(id, parsed);
    order.push(id);
    return null;
  }
  if (typeof parsed === "string") {
    // Old format that happened to be JSON-encoded (e.g. `JSON.stringify("你好")`).
    if (parsed.length === 0) return null;
    drafts.set(id, legacyStringToDoc(parsed));
    order.push(id);
    return parsed;
  }
  return null;
}

function readFromStorage(): void {
  const w = safeWindow();
  if (!w) return;
  const pendingMigrations: string[] = [];
  try {
    const indexRaw = w.localStorage.getItem(STORAGE_INDEX_KEY);
    if (!indexRaw) return;
    const ids = JSON.parse(indexRaw) as string[];
    if (!Array.isArray(ids)) return;
    for (const id of ids) {
      const raw = w.localStorage.getItem(STORAGE_PREFIX + id);
      if (typeof raw === "string" && raw.length > 0) {
        if (ingestRawDraft(id, raw) !== null) {
          pendingMigrations.push(id);
        }
      }
    }
  } catch {
    // Corrupted index — abandon recovery, start fresh in memory.
    return;
  }
  // Re-persist migrated legacy drafts asynchronously so the read path stays
  // sync (it may be invoked during a render via getSnapshot).
  if (pendingMigrations.length > 0) {
    const reflow = () => {
      for (const id of pendingMigrations) {
        const doc = drafts.get(id);
        if (!doc) continue;
        persistLocal(id, doc);
        syncBackend(id);
      }
    };
    if (typeof queueMicrotask === "function") {
      queueMicrotask(reflow);
    } else {
      setTimeout(reflow, 0);
    }
  }
}

function writeIndex(): void {
  const w = safeWindow();
  if (!w) return;
  try {
    w.localStorage.setItem(STORAGE_INDEX_KEY, JSON.stringify(order));
  } catch {
    // Quota exceeded or denied — silently keep memory copy.
  }
}

const MAX_PERSISTED_BYTES = 500_000;

/** localStorage:仅持久化 TipTap doc(text+image data URL)。文件附件走内存 +
 *  后端通道,blob URL 跨 reload 即死,localStorage 留它无意义。 */
function persistLocal(id: string, value: JSONContent): void {
  const w = safeWindow();
  if (!w) return;
  if (isEmptyDoc(value)) {
    try {
      w.localStorage.removeItem(STORAGE_PREFIX + id);
      writeIndex();
    } catch {
      // Best-effort only.
    }
    return;
  }
  // Strip live blob URLs first — they're worthless after a reload.
  const sanitized = stripBlobImageSrcs(value);
  const serialized = JSON.stringify(sanitized);
  if (serialized.length > MAX_PERSISTED_BYTES) {
    console.warn(
      "[useDraftStore] draft for conversation %s exceeds 500KB (%d chars), skipping persist",
      id,
      serialized.length,
    );
    return;
  }
  try {
    w.localStorage.setItem(STORAGE_PREFIX + id, serialized);
    writeIndex();
  } catch (err) {
    console.warn("[useDraftStore] failed to persist draft for conversation %s (%o)", id, err);
  }
}

/** 把当前 doc + 文件附件元数据合成"会话列表用的"草稿 JSON;文件作为
 *  fileAttachment 节点追加在 content 末尾,extractDraftPreview 读这棵树时
 *  把它输出为 "[文件]" 占位。Composer 自身读 in-memory drafts,看不到该节点,
 *  TipTap schema 不会冲突。 */
function buildBackendDraft(id: string): JSONContent | null {
  const doc = drafts.get(id);
  const files = fileAttachments.get(id) ?? EMPTY_FILES;
  const docEmpty = !doc || isEmptyDoc(doc);
  if (docEmpty && files.length === 0) return null;
  const baseDoc: JSONContent = doc && !docEmpty ? stripBlobImageSrcs(doc) : EMPTY_DOC;
  if (files.length === 0) return baseDoc;
  const fileNodes: JSONContent[] = files.map((att) => ({
    type: "fileAttachment",
    attrs: { name: att.name ?? "", sizeBytes: att.sizeBytes ?? 0 },
  }));
  return {
    ...baseDoc,
    content: [...(baseDoc.content ?? []), ...fileNodes],
  };
}

/** 后端 SQLite:用合成 doc 表示"会话当前草稿"。空状态写 "" 让后端清掉
 *  localDraftAtMs/localDraftText,让会话列表的"草稿态"消失。未登录时后端拒绝,
 *  catch 接住,不影响本地。 */
function syncBackend(id: string): void {
  const combined = buildBackendDraft(id);
  if (!combined) {
    void setConversationDraft(id, "").catch(() => undefined);
    return;
  }
  const serialized = JSON.stringify(combined);
  if (serialized.length > MAX_PERSISTED_BYTES) return;
  void setConversationDraft(id, serialized).catch(() => undefined);
}

/** debounce 后只刷 localStorage(本地崩溃恢复)并标记 dirty;后端同步推迟到
 *  flushDraftToBackend(切走会话 / 发送清空),避免输入过程中实时改动会话列表的
 *  排名与草稿样式。Flush 时再从两个 Map 取最新状态,多次 setDraft/setFileAttachments
 *  交叉调用时只写一次合成结果。 */
function scheduleWrite(id: string): void {
  dirtyBackend.add(id);
  const existing = pendingWrites.get(id);
  if (existing) clearTimeout(existing);
  const handle = setTimeout(() => {
    pendingWrites.delete(id);
    persistLocal(id, drafts.get(id) ?? EMPTY_DOC);
  }, WRITE_DEBOUNCE_MS);
  pendingWrites.set(id, handle);
}

/** 切走会话(或发送清空)时把该会话最新草稿一次性刷到后端:此刻才让会话列表出现
 *  "[草稿]" 样式并按 localDraftAtMs 重排。从未编辑过(非 dirty)的会话直接跳过,
 *  不发冗余 IPC;顺带把待写的 localStorage debounce 一并落盘。 */
export function flushDraftToBackend(id: string): void {
  if (!dirtyBackend.has(id)) return;
  dirtyBackend.delete(id);
  const pending = pendingWrites.get(id);
  if (pending) {
    clearTimeout(pending);
    pendingWrites.delete(id);
  }
  persistLocal(id, drafts.get(id) ?? EMPTY_DOC);
  syncBackend(id);
}

function touchLRU(id: string): void {
  const idx = order.indexOf(id);
  if (idx !== -1) order.splice(idx, 1);
  order.push(id);
  // Evict oldest entries beyond the cap.
  while (order.length > MAX_DRAFTS) {
    const evicted = order.shift();
    if (evicted) {
      drafts.delete(evicted);
      // 与 drafts 一致淘汰以该 id 索引的旁路集合:dirtyBackend 仅在 flush 时 delete,
      // 若会话未切走就被挤掉淘汰则永不 flush,其 id 会随会话总数无上界残留;一并清掉,
      // 并提前释放仍挂着的防抖 timer(被淘汰会话本就不该再写回)。
      dirtyBackend.delete(evicted);
      const pending = pendingWrites.get(evicted);
      if (pending) {
        clearTimeout(pending);
        pendingWrites.delete(evicted);
      }
      const w = safeWindow();
      if (w) {
        try {
          w.localStorage.removeItem(STORAGE_PREFIX + evicted);
        } catch {
          // ignore
        }
      }
    }
  }
}

function emit(): void {
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// Hydrate once on module load. Safe to call multiple times — Map.set is idempotent.
readFromStorage();

export function getDraft(conversationId: string): JSONContent {
  return drafts.get(conversationId) ?? EMPTY_DOC;
}

export function setDraft(conversationId: string, value: JSONContent): void {
  if (isEmptyDoc(value)) {
    drafts.delete(conversationId);
    const idx = order.indexOf(conversationId);
    if (idx !== -1) order.splice(idx, 1);
  } else {
    drafts.set(conversationId, value);
    touchLRU(conversationId);
  }
  scheduleWrite(conversationId);
  emit();
}

/** 发送后清空:本地置空 + 立刻把后端草稿清掉。否则若该会话此前切走时已同步过
 *  草稿,会话列表的 "[草稿]" 样式会在消息发出后仍残留。 */
export function clearDraft(conversationId: string): void {
  setDraft(conversationId, EMPTY_DOC);
  flushDraftToBackend(conversationId);
}

export function useDraft(conversationId: string): [JSONContent, (value: JSONContent) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => getDraft(conversationId),
    () => EMPTY_DOC,
  );
  const setValue = useCallback((v: JSONContent) => setDraft(conversationId, v), [conversationId]);
  return [value, setValue];
}

// ─── Pending file attachments (session-only) ────────────────────────────────
//
// 文件附件不能像图片那样持久化:blob URL 跨 reload 即失效,而 base64 嵌入对文件
// 体积(常达几十 MB)不可承受。这里只做 module-level 内存 Map,目标是让 chip
// 跨"切会话 unmount → 切回 remount"幸存,匹配 file input 本就不能跨 reload 的
// 浏览器语义。blob URL 由 store 持有,仅在用户显式移除 / 发送 / LRU 淘汰时 revoke。
//
// EMPTY_FILES 是稳定空数组,作为 getSnapshot/getServerSnapshot 兜底,避免每次
// 调用 getFileAttachments 都新建数组触发 useSyncExternalStore 的"无限循环"检测。

const EMPTY_FILES: readonly MessageAttachment[] = Object.freeze([]);

const fileAttachments = new Map<string, MessageAttachment[]>();
const fileOrder: string[] = [];
const fileListeners = new Set<() => void>();

function revokeAttachmentUrl(url: string): void {
  const revoke = globalThis.URL?.revokeObjectURL;
  if (!revoke) return;
  try {
    revoke.call(globalThis.URL, url);
  } catch {
    // ignore
  }
}

function touchFileLRU(id: string): void {
  const idx = fileOrder.indexOf(id);
  if (idx !== -1) fileOrder.splice(idx, 1);
  fileOrder.push(id);
  while (fileOrder.length > MAX_DRAFTS) {
    const evicted = fileOrder.shift();
    if (!evicted) continue;
    const dropped = fileAttachments.get(evicted);
    if (dropped) {
      for (const att of dropped) revokeAttachmentUrl(att.url);
    }
    fileAttachments.delete(evicted);
  }
}

function emitFiles(): void {
  fileListeners.forEach((fn) => fn());
}

function subscribeFiles(fn: () => void): () => void {
  fileListeners.add(fn);
  return () => {
    fileListeners.delete(fn);
  };
}

export function getFileAttachments(conversationId: string): readonly MessageAttachment[] {
  return fileAttachments.get(conversationId) ?? EMPTY_FILES;
}

export function setFileAttachments(
  conversationId: string,
  value: readonly MessageAttachment[],
): void {
  if (value.length === 0) {
    fileAttachments.delete(conversationId);
    const idx = fileOrder.indexOf(conversationId);
    if (idx !== -1) fileOrder.splice(idx, 1);
  } else {
    // 复制成可变数组,杜绝外部继续持有写入引用导致的 tearing。
    fileAttachments.set(conversationId, value.slice());
    touchFileLRU(conversationId);
  }
  // 同 setDraft 路径:标记 dirty + debounce 落本地;后端同步(让列表行排到顶并显示
  // "[文件]")推迟到切走会话时由 flushDraftToBackend 触发。
  scheduleWrite(conversationId);
  emitFiles();
}

export function useFileAttachments(
  conversationId: string,
): [readonly MessageAttachment[], (value: readonly MessageAttachment[]) => void] {
  const value = useSyncExternalStore(
    subscribeFiles,
    () => getFileAttachments(conversationId),
    () => EMPTY_FILES,
  );
  const setValue = useCallback(
    (v: readonly MessageAttachment[]) => setFileAttachments(conversationId, v),
    [conversationId],
  );
  return [value, setValue];
}
