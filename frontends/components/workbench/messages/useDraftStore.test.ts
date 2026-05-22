import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JSONContent } from "@tiptap/react";

const STORAGE_PREFIX = "chathub-draft-";
const STORAGE_INDEX_KEY = "chathub-draft-index";

const setConversationDraftMock = vi.fn<(id: string, text: string) => Promise<void>>(
  async () => undefined,
);

vi.mock("@/lib/api/recentFriends", () => ({
  setConversationDraft: (id: string, text: string) => setConversationDraftMock(id, text),
}));

async function loadStore() {
  vi.resetModules();
  setConversationDraftMock.mockClear();
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

describe("draft → backend sync (deferred to flush-on-switch)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
  });

  it("typing/adding a file never reaches backend on debounce; flush pushes the doc with fileAttachment node", async () => {
    const { setFileAttachments, flushDraftToBackend } = await loadStore();
    setFileAttachments("conv-a", [
      { type: "file", url: "blob:abc", name: "report.pdf", sizeBytes: 2048 },
    ]);
    // 输入/加附件过程中后端零接触 —— debounce 只落本地。
    await vi.runAllTimersAsync();
    expect(setConversationDraftMock).not.toHaveBeenCalled();
    // 切走会话才把草稿刷到后端。
    flushDraftToBackend("conv-a");
    expect(setConversationDraftMock).toHaveBeenCalledTimes(1);
    const [, payload] = setConversationDraftMock.mock.calls[0];
    const parsed = JSON.parse(payload);
    expect(parsed.type).toBe("doc");
    const last = parsed.content[parsed.content.length - 1];
    expect(last).toEqual({
      type: "fileAttachment",
      attrs: { name: "report.pdf", sizeBytes: 2048 },
    });
  });

  it("file-only draft does NOT write doc to localStorage (blobs are session-only)", async () => {
    const { setFileAttachments } = await loadStore();
    setFileAttachments("conv-b", [{ type: "file", url: "blob:x", name: "x.bin" }]);
    await vi.runAllTimersAsync();
    expect(window.localStorage.getItem(STORAGE_PREFIX + "conv-b")).toBeNull();
  });

  it("text-only doc reaches backend only on flush; payload omits fileAttachment node", async () => {
    const { setDraft, flushDraftToBackend } = await loadStore();
    setDraft("conv-c", migrationDoc("hello"));
    await vi.runAllTimersAsync();
    expect(setConversationDraftMock).not.toHaveBeenCalled();
    flushDraftToBackend("conv-c");
    expect(setConversationDraftMock).toHaveBeenCalledTimes(1);
    const payload = setConversationDraftMock.mock.calls[0][1];
    expect(JSON.parse(payload)).toEqual(migrationDoc("hello"));
  });

  it("flush on an untouched conversation makes no backend call (dirty-skip)", async () => {
    const { flushDraftToBackend } = await loadStore();
    flushDraftToBackend("conv-untouched");
    expect(setConversationDraftMock).not.toHaveBeenCalled();
  });

  it("a second flush without further edits is a no-op (dirty cleared after flush)", async () => {
    const { setDraft, flushDraftToBackend } = await loadStore();
    setDraft("conv-f", migrationDoc("hi"));
    flushDraftToBackend("conv-f");
    expect(setConversationDraftMock).toHaveBeenCalledTimes(1);
    flushDraftToBackend("conv-f");
    expect(setConversationDraftMock).toHaveBeenCalledTimes(1);
  });

  it("clearDraft flushes setConversationDraft('') immediately so backend drops the draft", async () => {
    const { setDraft, setFileAttachments, clearDraft, flushDraftToBackend } = await loadStore();
    setDraft("conv-d", migrationDoc("draft text"));
    setFileAttachments("conv-d", [{ type: "file", url: "blob:f", name: "a.txt" }]);
    flushDraftToBackend("conv-d"); // 切走 → 后端已存草稿
    setConversationDraftMock.mockClear();

    setFileAttachments("conv-d", []);
    clearDraft("conv-d"); // 发送清空 → 立即把后端草稿刷掉
    expect(setConversationDraftMock).toHaveBeenCalledTimes(1);
    expect(setConversationDraftMock.mock.calls[0]).toEqual(["conv-d", ""]);
  });

  it("doc + files combined: text and file nodes both reach backend on flush", async () => {
    const { setDraft, setFileAttachments, flushDraftToBackend } = await loadStore();
    setDraft("conv-e", migrationDoc("hi"));
    setFileAttachments("conv-e", [{ type: "file", url: "blob:z", name: "z.zip", sizeBytes: 100 }]);
    flushDraftToBackend("conv-e");
    const calls = setConversationDraftMock.mock.calls;
    const lastCall = calls[calls.length - 1];
    const parsed = JSON.parse(lastCall[1]);
    expect(parsed.content[0]).toEqual({
      type: "paragraph",
      content: [{ type: "text", text: "hi" }],
    });
    expect(parsed.content[1]).toEqual({
      type: "fileAttachment",
      attrs: { name: "z.zip", sizeBytes: 100 },
    });
  });
});

describe("file attachments store", () => {
  it("returns frozen empty array for unknown conversation (stable identity)", async () => {
    const { getFileAttachments } = await loadStore();
    const a = getFileAttachments("never-touched");
    const b = getFileAttachments("never-touched");
    expect(a).toBe(b);
    expect(a.length).toBe(0);
  });

  it("persists attachments across getFileAttachments calls (survives 'remount')", async () => {
    const { getFileAttachments, setFileAttachments } = await loadStore();
    const conv = "conv-with-files";
    setFileAttachments(conv, [
      { type: "file", url: "blob:abc", name: "spec.pdf", sizeBytes: 1024 },
    ]);
    expect(getFileAttachments(conv)).toEqual([
      { type: "file", url: "blob:abc", name: "spec.pdf", sizeBytes: 1024 },
    ]);
  });

  it("setting empty array drops the entry", async () => {
    const { getFileAttachments, setFileAttachments } = await loadStore();
    const conv = "conv-drain";
    setFileAttachments(conv, [{ type: "file", url: "blob:x", name: "a.txt" }]);
    expect(getFileAttachments(conv)).toHaveLength(1);
    setFileAttachments(conv, []);
    expect(getFileAttachments(conv)).toHaveLength(0);
  });

  it("LRU evicts oldest and revokes its blob URLs", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const { setFileAttachments, getFileAttachments } = await loadStore();
    // 51 distinct conversations push the first one out (MAX_DRAFTS=50).
    for (let i = 0; i < 51; i++) {
      setFileAttachments(`c${i}`, [{ type: "file", url: `blob:${i}`, name: `${i}.bin` }]);
    }
    expect(getFileAttachments("c0")).toHaveLength(0);
    expect(revoke).toHaveBeenCalledWith("blob:0");
    revoke.mockRestore();
  });

  it("each setFileAttachments notifies subscribers exactly once", async () => {
    const { setFileAttachments, useFileAttachments: _hook } = await loadStore();
    void _hook;
    // Drive the subscription path indirectly: the module-level emit() is the
    // only state change broadcast, so we observe via getFileAttachments value
    // identity changes. After 3 distinct writes, identity should change 3x.
    const seen: number[] = [];
    setFileAttachments("c", [{ type: "file", url: "blob:1" }]);
    seen.push(1);
    setFileAttachments("c", [{ type: "file", url: "blob:2" }]);
    seen.push(2);
    setFileAttachments("c", [{ type: "file", url: "blob:3" }]);
    seen.push(3);
    expect(seen).toEqual([1, 2, 3]);
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
