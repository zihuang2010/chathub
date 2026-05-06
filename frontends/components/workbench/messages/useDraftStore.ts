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

function readFromStorage(): void {
  const w = safeWindow();
  if (!w) return;
  try {
    const indexRaw = w.localStorage.getItem(STORAGE_INDEX_KEY);
    if (!indexRaw) return;
    const ids = JSON.parse(indexRaw) as string[];
    if (!Array.isArray(ids)) return;
    for (const id of ids) {
      const raw = w.localStorage.getItem(STORAGE_PREFIX + id);
      if (typeof raw === "string" && raw.length > 0) {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (isValidJSONContent(parsed)) {
            drafts.set(id, parsed);
            order.push(id);
          }
        } catch {
          // Corrupted or old-format string draft — skip silently.
        }
      }
    }
  } catch {
    // Corrupted index — abandon recovery, start fresh in memory.
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

function persist(id: string, value: JSONContent): void {
  const w = safeWindow();
  if (!w) return;
  try {
    if (isEmptyDoc(value)) {
      w.localStorage.removeItem(STORAGE_PREFIX + id);
    } else {
      w.localStorage.setItem(STORAGE_PREFIX + id, JSON.stringify(value));
    }
    writeIndex();
  } catch {
    // Best-effort only.
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
