import type { JSONContent } from "@tiptap/react";
import { useCallback, useSyncExternalStore } from "react";

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
        if (doc) persist(id, doc);
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

function persist(id: string, value: JSONContent): void {
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

function scheduleWrite(id: string, value: JSONContent): void {
  const existing = pendingWrites.get(id);
  if (existing) clearTimeout(existing);
  const handle = setTimeout(() => {
    pendingWrites.delete(id);
    persist(id, value);
  }, WRITE_DEBOUNCE_MS);
  pendingWrites.set(id, handle);
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
  scheduleWrite(conversationId, value);
  emit();
}

export function clearDraft(conversationId: string): void {
  setDraft(conversationId, EMPTY_DOC);
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
