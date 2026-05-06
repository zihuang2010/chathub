import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JSONContent } from "@tiptap/react";

const STORAGE_PREFIX = "chathub-draft-";
const STORAGE_INDEX_KEY = "chathub-draft-index";

async function loadStore() {
  vi.resetModules();
  return await import("./useDraftStore");
}

function migrationDoc(text: string): JSONContent {
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

describe("stripBlobImageSrcs", () => {
  it("blanks blob: src on a top-level image node", async () => {
    const { stripBlobImageSrcs } = await loadStore();
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "image", attrs: { src: "blob:abc", alt: "x.png" } }],
        },
      ],
    };
    expect(stripBlobImageSrcs(doc)).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "image", attrs: { src: "", alt: "x.png" } }],
        },
      ],
    });
  });

  it("preserves non-blob src untouched", async () => {
    const { stripBlobImageSrcs } = await loadStore();
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "image", attrs: { src: "https://example.com/x.png" } }],
        },
      ],
    };
    // Referential equality is preserved when nothing changes.
    expect(stripBlobImageSrcs(doc)).toBe(doc);
  });

  it("walks deeply nested paragraphs", async () => {
    const { stripBlobImageSrcs } = await loadStore();
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "hi" },
            { type: "image", attrs: { src: "blob:nested" } },
          ],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "tail" }],
        },
      ],
    };
    const out = stripBlobImageSrcs(doc);
    const firstPara = out.content?.[0];
    const img = firstPara?.content?.[1];
    expect(img).toEqual({ type: "image", attrs: { src: "" } });
    // Untouched sibling subtree retains identity.
    expect(out.content?.[1]).toBe(doc.content?.[1]);
  });

  it("empty doc passes through", async () => {
    const { stripBlobImageSrcs } = await loadStore();
    const doc: JSONContent = { type: "doc", content: [] };
    expect(stripBlobImageSrcs(doc)).toBe(doc);
  });

  it("doc with no images passes through", async () => {
    const { stripBlobImageSrcs } = await loadStore();
    const doc: JSONContent = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }],
    };
    expect(stripBlobImageSrcs(doc)).toBe(doc);
  });
});

describe("legacy draft migration", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
  });

  it("reads a raw plain-text legacy draft as a paragraph doc", async () => {
    const id = "conv-legacy-raw";
    window.localStorage.setItem(STORAGE_PREFIX + id, "你好");
    window.localStorage.setItem(STORAGE_INDEX_KEY, JSON.stringify([id]));

    const { getDraft } = await loadStore();
    expect(getDraft(id)).toEqual(migrationDoc("你好"));
  });

  it("re-persists the migrated draft in the new shape", async () => {
    const id = "conv-legacy-raw-2";
    window.localStorage.setItem(STORAGE_PREFIX + id, "迁移内容");
    window.localStorage.setItem(STORAGE_INDEX_KEY, JSON.stringify([id]));

    await loadStore();
    // Drain queueMicrotask + any queued setTimeout(0) fallback.
    await Promise.resolve();
    await vi.runAllTimersAsync();

    const persisted = window.localStorage.getItem(STORAGE_PREFIX + id);
    expect(persisted).not.toBeNull();
    expect(JSON.parse(persisted!)).toEqual(migrationDoc("迁移内容"));
  });

  it("migrates a JSON-encoded raw string draft", async () => {
    const id = "conv-legacy-jsonstr";
    window.localStorage.setItem(STORAGE_PREFIX + id, JSON.stringify("你好"));
    window.localStorage.setItem(STORAGE_INDEX_KEY, JSON.stringify([id]));

    const { getDraft } = await loadStore();
    expect(getDraft(id)).toEqual(migrationDoc("你好"));
  });
});

describe("oversized drafts", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
  });

  it(">500KB doc skips setItem and warns", async () => {
    const { setDraft } = await loadStore();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const setItem = vi.spyOn(window.localStorage, "setItem");

    // Build a doc whose JSON serialization is well above 500KB.
    const huge = "a".repeat(600_000);
    const doc: JSONContent = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: huge }] }],
    };
    const id = "conv-huge";
    setDraft(id, doc);
    // Flush the 500ms write debounce.
    await vi.runAllTimersAsync();

    // localStorage should NOT contain the per-conversation key.
    expect(window.localStorage.getItem(STORAGE_PREFIX + id)).toBeNull();
    // setItem may still have been called for the index key, but never with the per-draft payload.
    const draftWriteCalls = setItem.mock.calls.filter(([key]) => key === STORAGE_PREFIX + id);
    expect(draftWriteCalls).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    const msg = warn.mock.calls[0]?.[0];
    expect(typeof msg).toBe("string");
    expect(msg).toContain("exceeds 500KB");

    warn.mockRestore();
    setItem.mockRestore();
  });
});
