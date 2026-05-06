# MessageComposer 富内容混排 + Typography 整改 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把消息页输入区从 textarea + 独立附件托盘改造为支持「文字+图片+文字」内联混排的 TipTap 编辑器，同时把消息页全部字号/字重/行高/数字字体收口到既有 token 体系。

**Architecture:** 新增 `composer/*` 子目录承载 TipTap 编辑器及其 NodeView、序列化工具、AI 润色 popover、发送按钮组。原 `MessageComposer` 退化为壳：组装这些子组件，统一处理高度/草稿/快捷键。`MessageContent` 增加 `blocks[]` 优先渲染分支，旧 `text + attachments[]` 分支保留以兼容历史 mock 数据。Typography sweep 在功能闭环后作为独立 phase 一次性 grep + 替换。

**Tech Stack:** React 19 / TypeScript / TipTap 3 (ProseMirror) / Tailwind / Vitest（新增）/ pnpm。

**Spec:** `docs/superpowers/specs/2026-05-06-composer-rich-content-design.md`

---

## Phase 0 — 测试基础设施

### Task 0: 安装 vitest 并跑通一个示例测试

**Files:**

- Modify: `package.json` (scripts + devDependencies)
- Create: `vitest.config.ts`
- Create: `frontends/lib/__smoke__/sanity.test.ts`

- [ ] **Step 1: 安装 vitest**

```bash
pnpm add -D vitest @vitest/ui
```

Expected: `pnpm-lock.yaml` 更新，`devDependencies` 新增 `vitest` / `@vitest/ui`。

- [ ] **Step 2: 创建 `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["frontends/**/*.{test,spec}.{ts,tsx}"],
    globals: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "frontends"),
    },
  },
});
```

- [ ] **Step 3: 在 `package.json` `scripts` 加 `test`**

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 4: 写一个冒烟测试**

`frontends/lib/__smoke__/sanity.test.ts`:

```ts
import { describe, it, expect } from "vitest";

describe("sanity", () => {
  it("can run vitest", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 5: 跑测试**

```bash
pnpm test
```

Expected: PASS, `1 passed`.

- [ ] **Step 6: 提交**

```bash
git add package.json pnpm-lock.yaml vitest.config.ts frontends/lib/__smoke__/sanity.test.ts
git commit -m "chore: 引入 vitest 单测框架"
```

---

## Phase A — 数据模型 & TipTap 依赖

### Task A1: 在 `data.ts` 加 `MessageBlock` 与 `Message.blocks`

**Files:**

- Modify: `frontends/components/workbench/messages/data.ts`

- [ ] **Step 1: 在文件中现有 `MessageAttachment` 之后新增类型，并扩展 `Message`**

在 `MessageAttachment` 接口下方插入：

```ts
export type MessageBlock =
  | { type: "text"; value: string }
  | {
      type: "image";
      url: string;
      name?: string;
      sizeBytes?: number;
      width?: number;
      height?: number;
    };
```

在 `Message` 接口的 `attachments?: MessageAttachment[];` 行下方新增一行：

```ts
  blocks?: MessageBlock[];
```

并在 `Message` 接口注释中补一句：「`blocks` 存在时由渲染端优先消费，`text` 仍存原始字符串作为兜底。」

- [ ] **Step 2: 跑类型检查**

```bash
npx tsc --noEmit
```

Expected: 0 报错。

- [ ] **Step 3: 提交**

```bash
git add frontends/components/workbench/messages/data.ts
git commit -m "feat(messages): 新增 MessageBlock 与 Message.blocks 字段"
```

### Task A2: 安装 TipTap 依赖

**Files:**

- Modify: `package.json` / `pnpm-lock.yaml`

- [ ] **Step 1: 安装 TipTap 全家桶**

```bash
pnpm add @tiptap/react @tiptap/pm @tiptap/starter-kit @tiptap/extension-image @tiptap/extension-mention @tiptap/extension-placeholder
```

Expected: `dependencies` 新增 6 项；锁文件更新。

- [ ] **Step 2: 跑 build 确认安装可用**

```bash
pnpm run build
```

Expected: build 通过；如果 build 因为 strict-mode 大文件 chunk 报警告可忽略，但不能有编译错误。

- [ ] **Step 3: 提交**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: 引入 TipTap 编辑器依赖"
```

---

## Phase B — `docToBlocks` / `blocksToDoc` (TDD)

`docToBlocks` 把 TipTap `JSONContent` 序列化成 `MessageBlock[]`，`blocksToDoc` 反之。两者都是纯函数，必须先写完整测试。

### Task B1: 测试与实现 `docToBlocks` — 纯文本场景

**Files:**

- Create: `frontends/components/workbench/messages/composer/docToBlocks.ts`
- Create: `frontends/components/workbench/messages/composer/docToBlocks.test.ts`

- [ ] **Step 1: 写失败测试**

`docToBlocks.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { docToBlocks } from "./docToBlocks";

describe("docToBlocks", () => {
  it("空文档返回空数组", () => {
    expect(docToBlocks({ type: "doc", content: [] })).toEqual([]);
  });

  it("单段纯文本", () => {
    expect(
      docToBlocks({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "你好" }],
          },
        ],
      }),
    ).toEqual([{ type: "text", value: "你好" }]);
  });

  it("两段文本之间用换行连接", () => {
    expect(
      docToBlocks({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "第一行" }] },
          { type: "paragraph", content: [{ type: "text", text: "第二行" }] },
        ],
      }),
    ).toEqual([{ type: "text", value: "第一行\n第二行" }]);
  });

  it("hardBreak 在段落内插入换行", () => {
    expect(
      docToBlocks({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "上半行" },
              { type: "hardBreak" },
              { type: "text", text: "下半行" },
            ],
          },
        ],
      }),
    ).toEqual([{ type: "text", value: "上半行\n下半行" }]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm test docToBlocks
```

Expected: FAIL（找不到模块）。

- [ ] **Step 3: 实现 `docToBlocks`（最小化）**

`docToBlocks.ts`:

```ts
import type { MessageBlock } from "../data";

// TipTap 的 JSONContent 是递归节点树。这里只声明本模块用到的字段。
export interface JSONNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: JSONNode[];
}

interface AccumulatorState {
  blocks: MessageBlock[];
  /** 累积中的 text 片段；遇到 image 时需要先 flush。 */
  pendingText: string;
}

function flushText(state: AccumulatorState) {
  if (state.pendingText.length === 0) return;
  state.blocks.push({ type: "text", value: state.pendingText });
  state.pendingText = "";
}

function visit(node: JSONNode, state: AccumulatorState) {
  switch (node.type) {
    case "doc": {
      const paragraphs = node.content ?? [];
      paragraphs.forEach((p, i) => {
        if (i > 0) state.pendingText += "\n";
        visit(p, state);
      });
      return;
    }
    case "paragraph": {
      (node.content ?? []).forEach((child) => visit(child, state));
      return;
    }
    case "text": {
      state.pendingText += node.text ?? "";
      return;
    }
    case "hardBreak": {
      state.pendingText += "\n";
      return;
    }
    case "image": {
      flushText(state);
      const attrs = node.attrs ?? {};
      state.blocks.push({
        type: "image",
        url: String(attrs.src ?? ""),
        name: typeof attrs.alt === "string" ? attrs.alt : undefined,
      });
      return;
    }
    case "mention": {
      const label = (node.attrs as { label?: string } | undefined)?.label ?? "";
      state.pendingText += `@${label} `;
      return;
    }
    default:
      // 未知节点：递归子节点，避免吞内容
      (node.content ?? []).forEach((child) => visit(child, state));
  }
}

export function docToBlocks(doc: JSONNode): MessageBlock[] {
  const state: AccumulatorState = { blocks: [], pendingText: "" };
  visit(doc, state);
  flushText(state);
  // 合并相邻 text block（保险，理论上不会出现）
  const merged: MessageBlock[] = [];
  for (const b of state.blocks) {
    const last = merged[merged.length - 1];
    if (b.type === "text" && last?.type === "text") {
      last.value += b.value;
    } else {
      merged.push(b);
    }
  }
  return merged;
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm test docToBlocks
```

Expected: PASS（4 个用例）。

- [ ] **Step 5: 提交**

```bash
git add frontends/components/workbench/messages/composer/docToBlocks.ts \
        frontends/components/workbench/messages/composer/docToBlocks.test.ts
git commit -m "feat(composer): docToBlocks 支持纯文本与 hardBreak"
```

### Task B2: `docToBlocks` — 图片与混排场景

**Files:**

- Modify: `frontends/components/workbench/messages/composer/docToBlocks.test.ts`

- [ ] **Step 1: 追加失败测试**

在 `describe("docToBlocks", ...)` 内追加：

```ts
it("文-图-文 混排", () => {
  expect(
    docToBlocks({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "你好，" },
            { type: "image", attrs: { src: "blob:abc" } },
            { type: "text", text: "结束" },
          ],
        },
      ],
    }),
  ).toEqual([
    { type: "text", value: "你好，" },
    { type: "image", url: "blob:abc" },
    { type: "text", value: "结束" },
  ]);
});

it("连续图片不被合并", () => {
  expect(
    docToBlocks({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "image", attrs: { src: "blob:1" } },
            { type: "image", attrs: { src: "blob:2" } },
          ],
        },
      ],
    }),
  ).toEqual([
    { type: "image", url: "blob:1" },
    { type: "image", url: "blob:2" },
  ]);
});

it("纯图片不带任何 text block", () => {
  expect(
    docToBlocks({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "image", attrs: { src: "blob:x" } }],
        },
      ],
    }),
  ).toEqual([{ type: "image", url: "blob:x" }]);
});

it("mention 转成 @label 文本", () => {
  expect(
    docToBlocks({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "mention", attrs: { label: "小美" } },
            { type: "text", text: "处理一下" },
          ],
        },
      ],
    }),
  ).toEqual([{ type: "text", value: "@小美 处理一下" }]);
});
```

- [ ] **Step 2: 跑测试**

```bash
pnpm test docToBlocks
```

Expected: PASS（既有实现已覆盖，无需改 src，纯增量验收）。

> 如果失败，回到 `docToBlocks.ts` 修复 `flushText` 时机或 `image`/`mention` 分支。

- [ ] **Step 3: 提交**

```bash
git add frontends/components/workbench/messages/composer/docToBlocks.test.ts
git commit -m "test(composer): docToBlocks 图片/混排/mention 用例"
```

### Task B3: `blocksToDoc` 反向序列化

**Files:**

- Modify: `frontends/components/workbench/messages/composer/docToBlocks.ts` (新增 export)
- Modify: `frontends/components/workbench/messages/composer/docToBlocks.test.ts`

- [ ] **Step 1: 写失败测试**

在测试文件顶部 import 中加入 `blocksToDoc`，并新增 describe：

```ts
import { blocksToDoc, docToBlocks } from "./docToBlocks";

describe("blocksToDoc", () => {
  it("空数组生成单空段落 doc", () => {
    expect(blocksToDoc([])).toEqual({
      type: "doc",
      content: [{ type: "paragraph" }],
    });
  });

  it("纯文本拆段", () => {
    expect(blocksToDoc([{ type: "text", value: "第一行\n第二行" }])).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "第一行" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "第二行" }],
        },
      ],
    });
  });

  it("文-图-文 round-trip", () => {
    const blocks = [
      { type: "text" as const, value: "你好，" },
      { type: "image" as const, url: "blob:abc" },
      { type: "text" as const, value: "结束" },
    ];
    const doc = blocksToDoc(blocks);
    expect(docToBlocks(doc)).toEqual(blocks);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm test docToBlocks
```

Expected: FAIL（`blocksToDoc` 未导出）。

- [ ] **Step 3: 在 `docToBlocks.ts` 末尾追加 `blocksToDoc`**

```ts
export function blocksToDoc(blocks: MessageBlock[]): JSONNode {
  if (blocks.length === 0) {
    return { type: "doc", content: [{ type: "paragraph" }] };
  }
  // 把 blocks 序列里的 text 段按 \n 拆段；image 块作为当前段的 inline 节点。
  const paragraphs: JSONNode[] = [{ type: "paragraph", content: [] }];
  const currentContent = () => {
    const last = paragraphs[paragraphs.length - 1];
    last.content ??= [];
    return last.content;
  };
  const startNewParagraph = () => {
    paragraphs.push({ type: "paragraph", content: [] });
  };

  for (const block of blocks) {
    if (block.type === "image") {
      currentContent().push({
        type: "image",
        attrs: { src: block.url, alt: block.name ?? null },
      });
      continue;
    }
    const lines = block.value.split("\n");
    lines.forEach((line, idx) => {
      if (idx > 0) startNewParagraph();
      if (line.length > 0) {
        currentContent().push({ type: "text", text: line });
      }
    });
  }

  // 清理空 content 数组（让 paragraph 输出与上面 round-trip 期望一致）
  return {
    type: "doc",
    content: paragraphs.map((p) => (p.content && p.content.length > 0 ? p : { type: "paragraph" })),
  };
}
```

- [ ] **Step 4: 跑测试**

```bash
pnpm test docToBlocks
```

Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add frontends/components/workbench/messages/composer/docToBlocks.ts \
        frontends/components/workbench/messages/composer/docToBlocks.test.ts
git commit -m "feat(composer): blocksToDoc 反向序列化（含 round-trip 测试）"
```

---

## Phase C — TipTap 编辑器组件

### Task C1: `ImageNodeView` — 内联图片 React 渲染

**Files:**

- Create: `frontends/components/workbench/messages/composer/ImageNodeView.tsx`

- [ ] **Step 1: 实现 NodeView**

```tsx
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

import { STRINGS } from "../strings";

export function ImageNodeView({ node, selected, deleteNode }: NodeViewProps) {
  const src = String(node.attrs.src ?? "");
  const alt = typeof node.attrs.alt === "string" ? node.attrs.alt : "";
  return (
    <NodeViewWrapper
      as="span"
      className={cn(
        "group relative mx-1 inline-block overflow-hidden rounded-lg align-middle ring-offset-1 transition-shadow",
        selected ? "ring-2 ring-workbench-accent" : "ring-1 ring-workbench-line",
      )}
      data-drag-handle
    >
      <img
        src={src}
        alt={alt}
        draggable={false}
        className="block max-h-[200px] max-w-[260px] object-contain"
      />
      <button
        type="button"
        contentEditable={false}
        onClick={(event) => {
          event.preventDefault();
          deleteNode();
        }}
        title={STRINGS.composer.removeAttachment}
        aria-label={STRINGS.composer.removeAttachment}
        className="focus-ring absolute right-1 top-1 grid size-[18px] place-items-center rounded-full border border-white/80 bg-white/95 text-workbench-text-muted opacity-0 shadow-[0_1px_4px_rgba(15,23,42,0.16)] transition-opacity hover:text-workbench-text focus-visible:opacity-100 group-hover:opacity-100"
      >
        <X size={10} strokeWidth={2.1} aria-hidden />
      </button>
    </NodeViewWrapper>
  );
}
```

- [ ] **Step 2: 类型检查**

```bash
npx tsc --noEmit
```

Expected: 0 报错。如 `STRINGS.composer.removeAttachment` 已存在则不需要新增；缺则在 `strings.ts` 补上 `removeAttachment: "移除"`（保留旧 key）。

- [ ] **Step 3: 提交**

```bash
git add frontends/components/workbench/messages/composer/ImageNodeView.tsx
git commit -m "feat(composer): ImageNodeView 内联图片节点渲染"
```

### Task C2: `MentionExtension` — 接通现有 MentionList

**Files:**

- Create: `frontends/components/workbench/messages/composer/MentionExtension.ts`

- [ ] **Step 1: 配置 Mention extension**

```ts
import Mention from "@tiptap/extension-mention";
import { ReactRenderer } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import tippy, { type Instance } from "tippy.js";

import { MentionList } from "../MentionList";
import type { Conversation } from "../data";

export interface MentionContext {
  candidates: Conversation[];
}

export function createMentionExtension(getCtx: () => MentionContext) {
  return Mention.configure({
    HTMLAttributes: { class: "mention" },
    suggestion: {
      char: "@",
      items: ({ query }) => {
        const lower = query.toLowerCase();
        return getCtx()
          .candidates.filter((c) => c.name.toLowerCase().includes(lower))
          .slice(0, 8);
      },
      render: () => {
        let component: ReactRenderer | null = null;
        let popup: Instance[] | null = null;

        return {
          onStart: (props) => {
            component = new ReactRenderer(MentionList, {
              props: {
                query: props.query ?? "",
                candidates: props.items as Conversation[],
                onSelect: (name: string) => props.command({ id: name, label: name }),
              },
              editor: props.editor as unknown as Editor,
            });
            popup = tippy("body", {
              getReferenceClientRect: props.clientRect as () => DOMRect,
              appendTo: () => document.body,
              content: component.element,
              showOnCreate: true,
              interactive: true,
              trigger: "manual",
              placement: "top-start",
            });
          },
          onUpdate: (props) => {
            component?.updateProps({
              query: props.query ?? "",
              candidates: props.items as Conversation[],
              onSelect: (name: string) => props.command({ id: name, label: name }),
            });
            popup?.[0].setProps({
              getReferenceClientRect: props.clientRect as () => DOMRect,
            });
          },
          onKeyDown: (props) => {
            if (props.event.key === "Escape") {
              popup?.[0].hide();
              return true;
            }
            return false;
          },
          onExit: () => {
            popup?.[0].destroy();
            component?.destroy();
            popup = null;
            component = null;
          },
        };
      },
    },
  });
}
```

- [ ] **Step 2: 安装 tippy.js（TipTap suggestion 推荐 popper）**

```bash
pnpm add tippy.js
```

- [ ] **Step 3: 类型检查**

```bash
npx tsc --noEmit
```

Expected: 0 报错。

- [ ] **Step 4: 提交**

```bash
git add frontends/components/workbench/messages/composer/MentionExtension.ts package.json pnpm-lock.yaml
git commit -m "feat(composer): MentionExtension 接通现有 MentionList"
```

### Task C3: `RichComposer` — TipTap 编辑器壳

**Files:**

- Create: `frontends/components/workbench/messages/composer/RichComposer.tsx`

- [ ] **Step 1: 实现 RichComposer**

```tsx
import { useEffect, useMemo } from "react";
import { EditorContent, ReactNodeViewRenderer, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import type { JSONContent } from "@tiptap/core";

import type { Conversation } from "../data";
import { ImageNodeView } from "./ImageNodeView";
import { createMentionExtension, type MentionContext } from "./MentionExtension";

export interface RichComposerHandle {
  editor: Editor | null;
}

interface RichComposerProps {
  initialContent?: JSONContent;
  placeholder?: string;
  mentionCandidates?: Conversation[];
  onChange?: (doc: JSONContent) => void;
  onSubmit?: () => void;
  onPasteFiles?: (files: File[]) => boolean; // 返回 true 表示 composer 已处理，阻止默认
  className?: string;
}

export function RichComposer({
  initialContent,
  placeholder,
  mentionCandidates,
  onChange,
  onSubmit,
  onPasteFiles,
  className,
}: RichComposerProps) {
  const mentionCtx = useMemo<MentionContext>(
    () => ({ candidates: mentionCandidates ?? [] }),
    [mentionCandidates],
  );

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        blockquote: false,
        codeBlock: false,
        horizontalRule: false,
      }),
      Image.extend({
        inline: () => true,
        group: () => "inline",
        addNodeView() {
          return ReactNodeViewRenderer(ImageNodeView);
        },
      }).configure({ inline: true }),
      Placeholder.configure({ placeholder: placeholder ?? "" }),
      createMentionExtension(() => mentionCtx),
    ],
    content: initialContent ?? { type: "doc", content: [{ type: "paragraph" }] },
    editorProps: {
      attributes: {
        class:
          "focus-ring min-h-[64px] w-full rounded-md px-2 py-2 text-wb-xs text-workbench-text outline-none",
      },
      handleKeyDown: (_view, event) => {
        if (
          event.key === "Enter" &&
          !event.shiftKey &&
          !event.isComposing &&
          event.keyCode !== 229
        ) {
          event.preventDefault();
          onSubmit?.();
          return true;
        }
        return false;
      },
      handlePaste: (_view, event) => {
        const files: File[] = [];
        for (const item of Array.from(event.clipboardData?.items ?? [])) {
          if (item.kind === "file" && item.type.startsWith("image/")) {
            const file = item.getAsFile();
            if (file) files.push(file);
          }
        }
        if (files.length === 0) return false;
        return onPasteFiles?.(files) ?? false;
      },
    },
    onUpdate: ({ editor }) => {
      onChange?.(editor.getJSON());
    },
  });

  // 通过实例方法 imperative 操作的接口（外层用 editor 读写）
  useEffect(() => {
    return () => editor?.destroy();
  }, [editor]);

  return <EditorContent editor={editor} className={className} />;
}

export function useEditorInstance() {
  // 给外层一个让位的占位 hook（保留扩展空间，目前未用到）
  return null;
}
```

- [ ] **Step 2: 类型检查**

```bash
npx tsc --noEmit
```

Expected: 0 报错。

- [ ] **Step 3: 提交**

```bash
git add frontends/components/workbench/messages/composer/RichComposer.tsx
git commit -m "feat(composer): RichComposer 基于 TipTap 的编辑器壳"
```

---

## Phase D — `MessageComposer` 切换到 RichComposer

`MessageComposer.tsx` 现长 ~600 行，全量替换 textarea + chip tray。改造分两步：先把 RichComposer 接进去且保留全部既有功能（粘贴/截图/Emoji/@提及/草稿/Enter 发送），再删除已死代码。

### Task D1: `useDraftStore` 改存 `JSONContent`

**Files:**

- Modify: `frontends/components/workbench/messages/useDraftStore.ts`

- [ ] **Step 1: 阅读现状**

```bash
cat frontends/components/workbench/messages/useDraftStore.ts
```

记下当前 `Map<string, string>` 的 API（`useDraft` / `clearDraft`）签名。

- [ ] **Step 2: 把存储类型从 string 改成 JSONContent**

替换文件内容：

```ts
import { useEffect, useState } from "react";
import type { JSONContent } from "@tiptap/core";

const EMPTY_DOC: JSONContent = { type: "doc", content: [{ type: "paragraph" }] };

const drafts = new Map<string, JSONContent>();
const subscribers = new Map<string, Set<(value: JSONContent) => void>>();

function notify(conversationId: string, value: JSONContent) {
  subscribers.get(conversationId)?.forEach((fn) => fn(value));
}

export function useDraft(conversationId: string): [JSONContent, (next: JSONContent) => void] {
  const [value, setLocal] = useState<JSONContent>(drafts.get(conversationId) ?? EMPTY_DOC);

  useEffect(() => {
    const set = subscribers.get(conversationId) ?? new Set();
    set.add(setLocal);
    subscribers.set(conversationId, set);
    setLocal(drafts.get(conversationId) ?? EMPTY_DOC);
    return () => {
      set.delete(setLocal);
    };
  }, [conversationId]);

  const setValue = (next: JSONContent) => {
    drafts.set(conversationId, next);
    notify(conversationId, next);
  };

  return [value, setValue];
}

export function clearDraft(conversationId: string) {
  drafts.delete(conversationId);
  notify(conversationId, EMPTY_DOC);
}
```

> 注意：之前 `useDraft` 返回 `[string, setter]`；现在变 `[JSONContent, setter]`。这是破坏性改动——本任务结束时 `MessageComposer.tsx` 会编译失败，下一任务修复。

- [ ] **Step 3: 提交**

```bash
git add frontends/components/workbench/messages/useDraftStore.ts
git commit -m "refactor(messages): 草稿存储升级为 TipTap JSONContent"
```

### Task D2: 在 `MessageComposer` 中接入 `RichComposer`

**Files:**

- Modify: `frontends/components/workbench/messages/MessageComposer.tsx`
- Modify: `frontends/components/workbench/messages/strings.ts` (如缺 key)

- [ ] **Step 1: 升级 props 签名**

把 `MessageComposerProps.onSend` 从

```ts
onSend?: (text: string, attachments?: MessageAttachment[]) => void;
```

改为

```ts
onSend?: (
  text: string,
  blocks?: MessageBlock[],
  attachments?: MessageAttachment[],
) => void;
```

（保留 `?` 可选，调用方在 E2 同步）。

- [ ] **Step 2: 替换 import 与状态**

文件顶部：

```ts
import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import * as Popover from "@radix-ui/react-popover";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  Camera,
  ChevronDown,
  ImagePlus,
  PanelRightClose,
  PanelRightOpen,
  Paperclip,
  Smile,
  Sparkles,
} from "lucide-react";
import type { JSONContent, Editor } from "@tiptap/core";

import { Button } from "@/components/ui/button";
import { showToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { WORKBENCH_ACTION_GRADIENT, WORKBENCH_ACTION_GRADIENT_HOVER } from "@/lib/theme";

import { COMPOSER_MAX_HEIGHT, COMPOSER_MIN_HEIGHT, RESIZE_KEYBOARD_STEP } from "./constants";
import type { Conversation, MessageAttachment, MessageBlock, QuickReply } from "./data";
import { EmojiPicker } from "./EmojiPicker";
import { QuickRepliesPanel } from "./QuickRepliesPanel";
import { STRINGS } from "./strings";
import { clearDraft, useDraft } from "./useDraftStore";
import { docToBlocks } from "./composer/docToBlocks";
import { RichComposer } from "./composer/RichComposer";
```

> 删除：`FileText / FolderOpen / MoreHorizontal / Scissors / Image as ImageIcon / X` 几个 lucide 图标 import 和 `formatFileSize` import；删除 `MentionList` import（mention 已迁移到扩展里）。

- [ ] **Step 3: 替换组件主体（保留 height 调节、popover、详情按钮、发送按钮等外层）**

把整个 `MessageComposer` 函数体改成（保留 props 签名）：

```tsx
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
  const [pendingFileAttachments, setPendingFileAttachments] = useState<MessageAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const resizeStartRef = useRef({ y: 0, height });

  const blocks = docToBlocks(draft);
  const textJoined = blocks
    .filter((b): b is { type: "text"; value: string } => b.type === "text")
    .map((b) => b.value)
    .join("\n");
  const canSend =
    textJoined.trim().length > 0 ||
    blocks.some((b) => b.type === "image") ||
    pendingFileAttachments.length > 0;

  useEffect(() => {
    return () => {
      pendingFileAttachments.forEach((p) => URL.revokeObjectURL(p.url));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅卸载时回收
  }, []);

  const insertImageFiles = (files: File[]) => {
    if (!editorRef.current || files.length === 0) return;
    files.forEach((file) => {
      const url = URL.createObjectURL(file);
      editorRef.current!
        .chain()
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

  const handleScreenshot = async () => {
    if (!isTauri()) {
      showToast(STRINGS.toast.screenshotPasteHint, { type: "info" });
      editorRef.current?.commands.focus();
      return;
    }
    try {
      const result = await invoke<{ cancelled: boolean; base64?: string | null }>(
        "take_screenshot",
      );
      if (result.cancelled) return;
      const base64 = result.base64 ?? "";
      if (!base64.trim()) throw new Error(STRINGS.toast.screenshotEmpty);
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: "image/png" });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const file = new File([blob], `screenshot-${stamp}.png`, { type: "image/png" });
      insertImageFiles([file]);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      showToast(
        `${STRINGS.toast.screenshotFailed}：${reason}。${STRINGS.toast.screenshotPermissionHint}`,
        { type: "error" },
      );
    }
  };

  const handleEmojiSelect = (emoji: string) => {
    editorRef.current?.chain().focus().insertContent(emoji).run();
    setEmojiOpen(false);
  };

  const handleQuickReplySelect = (reply: QuickReply) => {
    editorRef.current?.chain().focus().insertContent(reply.preview).run();
    setQuickRepliesOpen(false);
  };

  const submitDraft = () => {
    if (!canSend) return;
    const finalBlocks = blocks.filter((b, i, arr) => {
      if (b.type === "text" && b.value.trim().length === 0) return false;
      // 单一空 text block 也丢
      void arr;
      void i;
      return true;
    });
    const fileAttachments = pendingFileAttachments;
    onSend?.(textJoined.trim(), finalBlocks.length > 0 ? finalBlocks : undefined, fileAttachments);
    clearDraft(conversationId);
    pendingFileAttachments.forEach((p) => URL.revokeObjectURL(p.url));
    setPendingFileAttachments([]);
  };

  // height 调节 / 占位 / 工具栏 / 发送按钮 / details 按钮 沿用原文件——本步只改 textarea 部分
```

> 完整 JSX 树用下面的渲染骨架替代原 `<textarea ...>` 段落（保留外部 `<div ... style={{ height }}>` 容器、resize 把手、发送按钮组、QuickReplies popover 等，逐字按现状保留）：

```tsx
return (
  <div
    className="relative shrink-0 border-t border-workbench-line bg-workbench-surface px-3 pb-3 pt-2"
    style={{ height }}
  >
    {/* resize handle 不变 */}
    {/* hidden inputs 不变（imageInputRef onChange=handleImagePicker / fileInputRef onChange=handleFilePicker） */}
    <div className="flex h-full w-full flex-col gap-2 bg-workbench-surface">
      <div className="flex items-center gap-3 text-workbench-text-secondary">
        {/* Emoji popover 不变，onSelect=handleEmojiSelect */}
        <ToolButton icon={Camera} label={STRINGS.composer.screenshot} onClick={handleScreenshot} />
        <ToolButton
          icon={ImagePlus}
          label={STRINGS.composer.image}
          onClick={() => imageInputRef.current?.click()}
        />
        <ToolButton
          icon={Paperclip}
          label={STRINGS.composer.file}
          onClick={() => fileInputRef.current?.click()}
        />
        {/* 删除原 MoreHorizontal */}
        {/* 详情切换按钮（PanelRightOpen/Close）保留 */}
      </div>
      {pendingFileAttachments.length > 0 && (
        <div className="flex shrink-0 flex-wrap gap-2 pb-0.5 pt-1">
          {pendingFileAttachments.map((att, i) => (
            <FileChip
              key={`${att.url}-${i}`}
              attachment={att}
              onRemove={() => {
                URL.revokeObjectURL(att.url);
                setPendingFileAttachments((prev) => prev.filter((p) => p !== att));
              }}
            />
          ))}
        </div>
      )}
      <RichComposer
        initialContent={draft}
        placeholder={STRINGS.composer.placeholder}
        mentionCandidates={mentionCandidates}
        onChange={(doc) => setDraftValue(doc)}
        onSubmit={submitDraft}
        onPasteFiles={(files) => {
          insertImageFiles(files);
          return true;
        }}
        className="flex-1 overflow-y-auto"
      />
      {/* 引用 ref 桥：在 RichComposer 内部把 editor 通过回调送回外层；可在 RichComposer 上加 onReady 回调 */}
      {/* 发送按钮组（QuickReplies popover、AI 润色、字数提示、SendButtonGroup）暂保留旧版本 UI，下一阶段升级 */}
    </div>
  </div>
);
```

> RichComposer 的 `editor` 实例需要外露给 MessageComposer。简单做法：给 RichComposer 加 `onReady?: (editor: Editor) => void` prop，挂载后回调一次，外层存 `editorRef.current`。把 Task C3 的 RichComposer 末尾 `useEffect(() => return () => editor?.destroy(), [editor])` 之前补：

```tsx
const onReadyRef = useRef(onReady);
onReadyRef.current = onReady;
useEffect(() => {
  if (editor) onReadyRef.current?.(editor);
}, [editor]);
```

并在 `RichComposerProps` 中加 `onReady?: (editor: Editor) => void`。

> `FileChip` 是替代旧 `PendingChip` 的精简版，仅渲染文件型 attachment（不再处理 image，因为图片已进 editor）。把它附加到本文件内或单独抽 `composer/FileChip.tsx`。

- [ ] **Step 4: 给 RichComposer 暴露 editor 实例**

修改 `composer/RichComposer.tsx`：

a) 在 `RichComposerProps` 加 `onReady?: (editor: Editor) => void;`
b) 函数签名加上 `onReady` 参数
c) 在 `useEffect(() => return () => editor?.destroy(), [editor])` 之上插入：

```tsx
const onReadyRef = useRef(onReady);
onReadyRef.current = onReady;
useEffect(() => {
  if (editor) onReadyRef.current?.(editor);
}, [editor]);
```

并补 `import { useRef } from "react";`。

外层在 `<RichComposer ... />` 加 `onReady={(editor) => (editorRef.current = editor)}`。

- [ ] **Step 5: 类型检查 + lint**

```bash
npx tsc --noEmit && pnpm run lint
```

Expected: 0 报错。

- [ ] **Step 6: 启动 dev server 手测**

```bash
pnpm dev
```

打开 messages 页：

1. 输入文字 + 选择图片 + 输入文字 → 内联混排出现
2. 粘贴剪贴板图片 → 出现在 caret 位置
3. @ 触发 mention 候选
4. Emoji 插入 caret 位置
5. Enter 发送（中文输入法不误发）

修复任何回归后再下一步。

- [ ] **Step 7: 提交**

```bash
git add frontends/components/workbench/messages/MessageComposer.tsx \
        frontends/components/workbench/messages/strings.ts \
        frontends/components/workbench/messages/composer/RichComposer.tsx
git commit -m "feat(composer): MessageComposer 切换到 TipTap，文图内联混排"
```

---

## Phase E — 气泡渲染读 `blocks[]`

### Task E1: `MessageContent` 增加 blocks 分支

**Files:**

- Modify: `frontends/components/workbench/messages/MessageContent.tsx`

- [ ] **Step 1: 改造组件签名**

```tsx
import { Fragment } from "react";
import { Download, FileText, Play } from "lucide-react";

import type { MessageAttachment, MessageBlock } from "./data";
import { STRINGS } from "./strings";
import { formatFileSize, formatRichText } from "./utils";

interface MessageContentProps {
  text: string;
  blocks?: MessageBlock[];
  attachments?: MessageAttachment[];
}

export function MessageContent({ text, blocks, attachments }: MessageContentProps) {
  if (blocks && blocks.length > 0) {
    return <BlocksContent blocks={blocks} attachments={attachments} />;
  }
  // 旧分支保持不变（下方原样保留）
  ...
}

function BlocksContent({
  blocks,
  attachments,
}: {
  blocks: MessageBlock[];
  attachments?: MessageAttachment[];
}) {
  const standalone = blocks.length === 1 && blocks[0].type === "image";
  if (standalone) {
    const block = blocks[0] as Extract<MessageBlock, { type: "image" }>;
    return (
      <ImageStandalone block={block} />
    );
  }
  const nonImageAttachments = (attachments ?? []).filter((a) => a.type !== "image");
  return (
    <>
      {blocks.map((b, i) => {
        if (b.type === "text") return <TextRun key={i} value={b.value} />;
        return <InlineImage key={i} block={b} />;
      })}
      {nonImageAttachments.length > 0 && (
        <div className="mt-2 flex flex-col gap-2">
          {nonImageAttachments.map((att, i) => (
            <AttachmentCard key={`${att.type}-${i}`} attachment={att} />
          ))}
        </div>
      )}
    </>
  );
}

function TextRun({ value }: { value: string }) {
  const segs = formatRichText(value);
  return (
    <>
      {segs.map((seg, i) => {
        const key = `${seg.type}-${i}`;
        switch (seg.type) {
          case "link":
            return (
              <a
                key={key}
                href={seg.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-workbench-accent underline-offset-2 hover:underline"
              >
                {seg.value}
              </a>
            );
          case "mention":
            return (
              <span key={key} className="font-medium text-workbench-accent">
                {seg.value}
              </span>
            );
          case "emoji":
          case "text":
            return <Fragment key={key}>{seg.value}</Fragment>;
        }
      })}
    </>
  );
}

function InlineImage({ block }: { block: Extract<MessageBlock, { type: "image" }> }) {
  return (
    <a
      href={block.url}
      target="_blank"
      rel="noopener noreferrer"
      className="focus-ring mx-1 inline-block overflow-hidden rounded-lg align-middle ring-1 ring-workbench-line transition-shadow hover:ring-workbench-accent"
    >
      <img
        src={block.url}
        alt={block.name ?? STRINGS.attachment.image}
        className="block max-h-[200px] max-w-[260px] object-contain"
      />
    </a>
  );
}

function ImageStandalone({ block }: { block: Extract<MessageBlock, { type: "image" }> }) {
  return (
    <a
      href={block.url}
      target="_blank"
      rel="noopener noreferrer"
      title={STRINGS.attachment.openImage}
      className="focus-ring inline-block max-w-full overflow-hidden rounded-xl border border-workbench-line bg-workbench-surface p-1 shadow-wb-bubble transition-colors hover:bg-workbench-surface-subtle"
    >
      <img
        src={block.url}
        alt={STRINGS.attachment.imageAlt(block.name)}
        loading="lazy"
        className="block max-h-72 max-w-full rounded-lg object-contain"
      />
    </a>
  );
}
```

> 旧的 `AttachmentCard / ImageAttachment / FileAttachment / VoiceAttachment / VideoAttachment` 子组件保留在文件下方原位，老 mock 数据仍然走旧路径。

- [ ] **Step 2: 类型 + lint**

```bash
npx tsc --noEmit && pnpm run lint
```

Expected: 0 报错。

- [ ] **Step 3: 提交**

```bash
git add frontends/components/workbench/messages/MessageContent.tsx
git commit -m "feat(messages): MessageContent 支持 blocks[] 内联渲染"
```

### Task E2: `MessageBubble` 透传 blocks，`ChatArea` 升级 handleSend 签名

**Files:**

- Modify: `frontends/components/workbench/messages/MessageBubble.tsx`
- Modify: `frontends/components/workbench/messages/ChatArea.tsx`

- [ ] **Step 1: MessageBubble 透传 blocks**

`MessageBubble.tsx` 第 128 行附近 (`<MessageContent text={message.text} attachments={message.attachments} />` 共两处) 改为：

```tsx
<MessageContent text={message.text} blocks={message.blocks} attachments={message.attachments} />
```

- [ ] **Step 2: ChatArea handleSend 升级**

`ChatArea.tsx` 第 223-240 行的 `handleSend` 改为：

```ts
const handleSend = useCallback(
  (text: string, blocks?: MessageBlock[], attachments?: MessageAttachment[]) => {
    const id = `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const newMessage: Message = {
      id,
      conversationId: conversation.id,
      direction: "out",
      text,
      blocks: blocks?.length ? blocks : undefined,
      attachments: attachments?.length ? attachments : undefined,
      sentAt: new Date().toISOString(),
      status: "sending",
    };
    setLocalMessages((current) => [...current, newMessage]);
    wasAtBottomRef.current = true;
    completeMockSend(id);
  },
  [conversation.id, completeMockSend],
);
```

并在文件顶部把 `MessageAttachment` 的 import 改为 `import type { Message, MessageAttachment, MessageBlock } from "./data";`。

- [ ] **Step 3: 同步 `MessageComposer` 的 onSend 签名**

`MessageComposerProps.onSend` 已在 D2 改为 `(text, blocks?, attachments?) => void`。`ChatArea` 调用点保持 `onSend={handleSend}` 即可。如类型不匹配报错，回到 `MessageComposer.tsx` 的 props 定义微调。

- [ ] **Step 4: 类型 + lint + dev 手测**

```bash
npx tsc --noEmit && pnpm run lint && pnpm dev
```

发送一条 「文-图-文」 消息，确认气泡按 blocks 顺序内联渲染。

- [ ] **Step 5: 提交**

```bash
git add frontends/components/workbench/messages/MessageBubble.tsx \
        frontends/components/workbench/messages/ChatArea.tsx
git commit -m "feat(messages): 气泡接通 blocks，handleSend 透传"
```

---

## Phase F — 工具栏图标重选

### Task F1: 替换图标 + 统一容器/描边参数

**Files:**

- Modify: `frontends/components/workbench/messages/MessageComposer.tsx`

- [ ] **Step 1: 修改 ToolButton 默认参数**

把 `ToolButton` 函数体改为：

```tsx
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
      className="focus-ring grid h-9 w-9 place-items-center rounded-lg text-workbench-text-secondary transition-colors hover:bg-workbench-surface-subtle hover:text-workbench-text"
    >
      <Icon size={18} strokeWidth={1.6} />
    </button>
  );
}
```

> 删掉 `-translate-y-px` 微调和 `size-9`（容器换语义化的 `h-9 w-9 rounded-lg`），hover 颜色不再变 accent。

- [ ] **Step 2: Emoji 触发器与 Toggle Details 按钮同步**

将 Emoji `Popover.Trigger` 内 button 的 className 改为与 ToolButton 一致；Smile 图标的 `size`/`strokeWidth`/`-translate-y-px` 同步。Toggle details 按钮（PanelRightOpen/Close）只把 `size={20}` 改 `size={18}`、`strokeWidth={1.45}` 改 `strokeWidth={1.6}`、删 `-translate-y-px`。

- [ ] **Step 3: 给 popover-bearing 按钮加 hover 指示点**

为 Emoji 触发器与 Image (`ImagePlus`) 触发器外层 button 增加 `relative` 与子元素：

```tsx
<button ... className="... relative">
  <Smile size={18} strokeWidth={1.6} />
  <span
    aria-hidden
    className="pointer-events-none absolute bottom-1.5 right-1.5 size-[3px] rounded-full bg-current opacity-0 transition-opacity group-hover:opacity-60"
  />
</button>
```

> 父 button 在 `className` 中加 `group`。Image 触发器同理。其他工具按钮（Camera 截图、Paperclip 文件）不带指示点（这些是直接动作，不打开 popover）。

- [ ] **Step 4: 验证（D2 已经把图标 import 换了，这一步只调样式）**

```bash
pnpm run lint && pnpm dev
```

肉眼确认工具栏图标尺寸、hover 效果一致。Emoji / Image hover 时右下角出现 3px 指示点。

- [ ] **Step 5: 提交**

```bash
git add frontends/components/workbench/messages/MessageComposer.tsx
git commit -m "style(composer): 工具栏图标统一描边/容器规格"
```

---

## Phase G — 发送面板升级

### Task G1: `useComposerPrefs` (TDD)

**Files:**

- Create: `frontends/components/workbench/messages/useComposerPrefs.ts`
- Create: `frontends/components/workbench/messages/useComposerPrefs.test.ts`

- [ ] **Step 1: 写测试**

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  loadComposerPrefs,
  saveComposerPrefs,
  useComposerPrefs,
  COMPOSER_PREFS_KEY,
  DEFAULT_PREFS,
} from "./useComposerPrefs";

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("composer prefs persistence", () => {
  it("默认值在没有存储时返回", () => {
    expect(loadComposerPrefs()).toEqual(DEFAULT_PREFS);
  });

  it("写入后读出", () => {
    saveComposerPrefs({ silent: true, jumpToNext: false });
    expect(loadComposerPrefs()).toEqual({ silent: true, jumpToNext: false });
  });

  it("损坏的 JSON 回退默认", () => {
    window.localStorage.setItem(COMPOSER_PREFS_KEY, "not-json");
    expect(loadComposerPrefs()).toEqual(DEFAULT_PREFS);
  });
});

describe("useComposerPrefs hook", () => {
  it("toggle 持久化到 localStorage", () => {
    const { result } = renderHook(() => useComposerPrefs());
    act(() => result.current.setSilent(true));
    expect(loadComposerPrefs().silent).toBe(true);
    expect(result.current.prefs.silent).toBe(true);
  });
});
```

- [ ] **Step 2: 安装 testing-library 用于 React hook 测试**

```bash
pnpm add -D @testing-library/react @testing-library/dom react-test-renderer jsdom
```

并在 `vitest.config.ts` 中增加 `environment: "jsdom"`（替换现有 `node`）。

- [ ] **Step 3: 实现**

`useComposerPrefs.ts`:

```ts
import { useEffect, useState } from "react";

export interface ComposerPrefs {
  silent: boolean;
  jumpToNext: boolean;
}

export const COMPOSER_PREFS_KEY = "workbench.composer.prefs.v1";
export const DEFAULT_PREFS: ComposerPrefs = { silent: false, jumpToNext: false };

const subscribers = new Set<(prefs: ComposerPrefs) => void>();

export function loadComposerPrefs(): ComposerPrefs {
  if (typeof window === "undefined") return DEFAULT_PREFS;
  try {
    const raw = window.localStorage.getItem(COMPOSER_PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<ComposerPrefs>;
    return {
      silent: Boolean(parsed.silent),
      jumpToNext: Boolean(parsed.jumpToNext),
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function saveComposerPrefs(prefs: ComposerPrefs) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(COMPOSER_PREFS_KEY, JSON.stringify(prefs));
  subscribers.forEach((fn) => fn(prefs));
}

export function useComposerPrefs() {
  const [prefs, setPrefs] = useState<ComposerPrefs>(loadComposerPrefs);

  useEffect(() => {
    subscribers.add(setPrefs);
    setPrefs(loadComposerPrefs());
    return () => {
      subscribers.delete(setPrefs);
    };
  }, []);

  return {
    prefs,
    setSilent: (next: boolean) => saveComposerPrefs({ ...prefs, silent: next }),
    setJumpToNext: (next: boolean) => saveComposerPrefs({ ...prefs, jumpToNext: next }),
  };
}
```

- [ ] **Step 4: 跑测试**

```bash
pnpm test useComposerPrefs
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add frontends/components/workbench/messages/useComposerPrefs.ts \
        frontends/components/workbench/messages/useComposerPrefs.test.ts \
        package.json pnpm-lock.yaml vitest.config.ts
git commit -m "feat(composer): useComposerPrefs 静默/跳下一条偏好持久化"
```

### Task G2: `AiPolishPopover`

**Files:**

- Create: `frontends/components/workbench/messages/composer/AiPolishPopover.tsx`
- Modify: `frontends/components/workbench/messages/strings.ts` (新增 polish 文案)

- [ ] **Step 1: 加文案**

`strings.ts` `composer` 段下追加：

```ts
polishTitle: "AI 润色",
polishTones: {
  formal: "正式",
  warm: "亲切",
  humor: "幽默",
  concise: "简洁",
},
polishOriginal: "原文",
polishPreview: "润色预览",
polishCancel: "取消",
polishApply: "替换草稿",
```

- [ ] **Step 2: 实现 popover**

```tsx
import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";
import { STRINGS } from "../strings";

export type PolishTone = keyof typeof STRINGS.composer.polishTones;

interface AiPolishPopoverProps {
  originalText: string;
  onApply: (newText: string) => void;
  disabled?: boolean;
}

const TONE_KEYS: PolishTone[] = ["formal", "warm", "humor", "concise"];

function mockPolish(text: string, tone: PolishTone): string {
  const label = STRINGS.composer.polishTones[tone];
  return `[${label}] ${text}`;
}

export function AiPolishPopover({ originalText, onApply, disabled }: AiPolishPopoverProps) {
  const [open, setOpen] = useState(false);
  const [tone, setTone] = useState<PolishTone>("formal");
  const preview = originalText ? mockPolish(originalText, tone) : "";

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="focus-ring inline-flex h-9 items-center gap-1 rounded-md bg-workbench-surface-soft px-2.5 text-wb-2xs font-medium text-workbench-accent transition-colors hover:bg-workbench-surface-active disabled:opacity-50"
        >
          <Sparkles size={12} />
          <span>{STRINGS.composer.polishTitle}</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          className="z-30 w-[320px] rounded-lg border border-workbench-line bg-workbench-surface p-3 shadow-wb-popover-strong outline-none"
        >
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-1">
              {TONE_KEYS.map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setTone(k)}
                  className={cn(
                    "focus-ring h-7 rounded-full px-3 text-wb-3xs transition-colors",
                    tone === k
                      ? "bg-workbench-accent text-workbench-surface"
                      : "bg-workbench-surface-subtle text-workbench-text-secondary hover:bg-workbench-surface-active",
                  )}
                >
                  {STRINGS.composer.polishTones[k]}
                </button>
              ))}
            </div>
            <Section label={STRINGS.composer.polishOriginal}>
              <p className="line-clamp-3 text-wb-2xs text-workbench-text-muted">
                {originalText || "—"}
              </p>
            </Section>
            <Section label={STRINGS.composer.polishPreview}>
              <p className="max-h-32 overflow-y-auto rounded-md bg-workbench-surface-subtle px-2.5 py-2 text-wb-2xs text-workbench-text">
                {preview || "—"}
              </p>
            </Section>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="focus-ring h-8 rounded-md px-3 text-wb-2xs text-workbench-text-secondary hover:bg-workbench-surface-subtle"
              >
                {STRINGS.composer.polishCancel}
              </button>
              <button
                type="button"
                disabled={!preview}
                onClick={() => {
                  onApply(preview);
                  setOpen(false);
                }}
                className="focus-ring h-8 rounded-md bg-workbench-accent px-3 text-wb-2xs font-medium text-workbench-surface transition-colors hover:bg-workbench-accent-hover disabled:opacity-50"
              >
                {STRINGS.composer.polishApply}
              </button>
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-wb-3xs font-medium text-workbench-text-secondary">{label}</span>
      {children}
    </div>
  );
}
```

- [ ] **Step 3: 在 `MessageComposer.tsx` 接入**

替换原有「`✨ AI 润色 NEW` + `正式 ▼`」两个按钮为：

```tsx
<AiPolishPopover
  originalText={textJoined}
  disabled={!textJoined.trim()}
  onApply={(newText) => {
    if (!editorRef.current) return;
    editorRef.current
      .chain()
      .focus()
      .setContent({
        type: "doc",
        content: [{ type: "paragraph", content: newText ? [{ type: "text", text: newText }] : [] }],
      })
      .run();
  }}
/>
```

> 替换草稿当前用纯文本覆盖；图片节点会被清掉，未来接真实润色 API 时再保留 image 节点。

- [ ] **Step 4: lint + 手测**

```bash
pnpm run lint && pnpm dev
```

确认 popover 打开、切语气、替换草稿都正常。

- [ ] **Step 5: 提交**

```bash
git add frontends/components/workbench/messages/composer/AiPolishPopover.tsx \
        frontends/components/workbench/messages/MessageComposer.tsx \
        frontends/components/workbench/messages/strings.ts
git commit -m "feat(composer): AiPolishPopover 语气下拉 + 草稿替换"
```

### Task G3: `SendButtonGroup` 分裂下拉菜单

**Files:**

- Create: `frontends/components/workbench/messages/composer/SendButtonGroup.tsx`
- Modify: `frontends/components/workbench/messages/strings.ts`
- Modify: `frontends/components/workbench/messages/MessageComposer.tsx`

- [ ] **Step 1: 加文案**

`STRINGS.composer` 增量：

```ts
sendImmediately: "立即发送",
sendSchedule: "定时发送…",
sendSilent: "静默发送",
sendJumpToNext: "发送后跳到下一条",
sendSilentMain: "静默发送",
```

- [ ] **Step 2: 实现 SendButtonGroup**

```tsx
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, Clock3, Forward, VolumeX, Zap } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { WORKBENCH_ACTION_GRADIENT, WORKBENCH_ACTION_GRADIENT_HOVER } from "@/lib/theme";

import { useComposerPrefs } from "../useComposerPrefs";
import { STRINGS } from "../strings";

interface SendButtonGroupProps {
  canSend: boolean;
  hover: boolean;
  setHover: (v: boolean) => void;
  onSend: () => void;
  onScheduleSend?: () => void;
}

export function SendButtonGroup({
  canSend,
  hover,
  setHover,
  onSend,
  onScheduleSend,
}: SendButtonGroupProps) {
  const { prefs, setSilent, setJumpToNext } = useComposerPrefs();
  const mainLabel = prefs.silent ? STRINGS.composer.sendSilentMain : STRINGS.composer.send;
  const styleSend = canSend
    ? { background: hover ? WORKBENCH_ACTION_GRADIENT_HOVER : WORKBENCH_ACTION_GRADIENT }
    : undefined;
  const cls = cn(
    "focus-ring h-9 px-5 text-wb-xs font-medium transition-all",
    canSend ? "text-white" : "bg-workbench-line text-workbench-text disabled:opacity-100",
  );

  return (
    <div className="flex items-center gap-0">
      <Button
        type="button"
        disabled={!canSend}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onClick={onSend}
        aria-label={mainLabel}
        className={cn(cls, "rounded-l-md rounded-r-none")}
        style={styleSend}
      >
        {mainLabel}
      </Button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button
            type="button"
            aria-label={STRINGS.composer.sendOptions}
            className={cn(
              cls,
              "rounded-l-none rounded-r-md border-l border-black/20 px-2 dark:border-white/30",
            )}
            style={styleSend}
          >
            <ChevronDown size={12} />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={6}
            className="z-30 min-w-[200px] rounded-lg border border-workbench-line bg-workbench-surface p-1 shadow-wb-popover-strong outline-none"
          >
            <Item
              icon={Zap}
              label={STRINGS.composer.sendImmediately}
              onSelect={onSend}
              disabled={!canSend}
            />
            <Item
              icon={Clock3}
              label={STRINGS.composer.sendSchedule}
              onSelect={() => onScheduleSend?.()}
            />
            <DropdownMenu.Separator className="my-1 h-px bg-workbench-line" />
            <Toggle
              icon={VolumeX}
              label={STRINGS.composer.sendSilent}
              checked={prefs.silent}
              onChange={() => setSilent(!prefs.silent)}
            />
            <Toggle
              icon={Forward}
              label={STRINGS.composer.sendJumpToNext}
              checked={prefs.jumpToNext}
              onChange={() => setJumpToNext(!prefs.jumpToNext)}
            />
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}

function Item({
  icon: Icon,
  label,
  onSelect,
  disabled,
}: {
  icon: typeof Zap;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}) {
  return (
    <DropdownMenu.Item
      disabled={disabled}
      onSelect={(e) => {
        e.preventDefault();
        onSelect();
      }}
      className="flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-wb-2xs text-workbench-text outline-none data-[highlighted]:bg-workbench-surface-subtle data-[disabled]:opacity-50"
    >
      <Icon size={14} />
      <span>{label}</span>
    </DropdownMenu.Item>
  );
}

function Toggle({
  icon: Icon,
  label,
  checked,
  onChange,
}: {
  icon: typeof VolumeX;
  label: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <DropdownMenu.CheckboxItem
      checked={checked}
      onCheckedChange={onChange}
      onSelect={(e) => e.preventDefault()}
      className="flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-wb-2xs text-workbench-text outline-none data-[highlighted]:bg-workbench-surface-subtle"
    >
      <Icon size={14} />
      <span className="flex-1">{label}</span>
      {checked && <Check size={14} className="text-workbench-accent" />}
    </DropdownMenu.CheckboxItem>
  );
}
```

- [ ] **Step 3: 安装 dropdown-menu（已有，跳过）**

`@radix-ui/react-dropdown-menu` 在 package.json 已存在，确认即可。

- [ ] **Step 4: 在 `MessageComposer.tsx` 替换发送按钮组**

把原来两个 `<Button ...>` 主按钮 + 下拉箭头改为：

```tsx
<SendButtonGroup canSend={canSend} hover={hover} setHover={setHover} onSend={submitDraft} />
```

`MessageComposer` 中 `const [hover, setHover] = useState(false);` 保留，作为 prop 传入 SendButtonGroup（用于渐变背景在 hover 时切换）。

- [ ] **Step 5: lint + 手测**

```bash
pnpm run lint && pnpm dev
```

确认菜单展开、勾选项持久化（刷新页面后开关仍记得）。

- [ ] **Step 6: 提交**

```bash
git add frontends/components/workbench/messages/composer/SendButtonGroup.tsx \
        frontends/components/workbench/messages/MessageComposer.tsx \
        frontends/components/workbench/messages/strings.ts
git commit -m "feat(composer): 发送按钮分裂下拉菜单（含偏好持久化）"
```

### Task G4: 字数 + 快捷键提示

**Files:**

- Modify: `frontends/components/workbench/messages/MessageComposer.tsx`
- Modify: `frontends/components/workbench/messages/constants.ts`
- Modify: `frontends/components/workbench/messages/strings.ts`

- [ ] **Step 1: 加常量**

`constants.ts` 末尾追加：

```ts
export const COMPOSER_MAX_CHARS = 5000;
export const COMPOSER_WARN_CHARS = 4500;
```

- [ ] **Step 2: 加文案**

`strings.ts` `composer` 段追加：

```ts
charCount: (n: number) => `${n} 字`,
```

并把现有 `enterToSend: "Enter 发送 / Shift+Enter 换行"` 留作复用。

- [ ] **Step 3: 渲染提示并禁用超限发送**

在 `MessageComposer.tsx` 的发送行内（QuickReplies + AiPolishPopover 之后、SendButtonGroup 之前）插入：

```tsx
const charLength = Array.from(textJoined).length;
const overLimit = charLength > COMPOSER_MAX_CHARS;
const nearLimit = charLength >= COMPOSER_WARN_CHARS;

// ...在 return 的发送行 JSX：

<span
  className={cn(
    "ml-auto inline-flex items-center gap-2 font-numeric text-wb-3xs tabular-nums text-workbench-text-muted",
    nearLimit && !overLimit && "text-amber-500",
    overLimit && "text-workbench-danger",
  )}
>
  <span>{STRINGS.composer.charCount(charLength)}</span>
  <span className="hidden sm:inline">·</span>
  <span className="hidden sm:inline">{STRINGS.composer.enterToSend}</span>
</span>;
```

> 这里先用基础 `font-numeric tabular-nums` 两个 class，避免依赖尚未实现的 `wb-num`。`Phase H6` sweep 会把它统一替换为 `wb-num`。

把 `canSend` 的判断追加 `&& !overLimit`：

```ts
const canSend =
  !overLimit &&
  (textJoined.trim().length > 0 ||
    blocks.some((b) => b.type === "image") ||
    pendingFileAttachments.length > 0);
```

> `wb-num` 工具类在 Phase H 才加；本步先用，等 H 实施时一并解决。如执行顺序倒过来，请先去 `frontends/index.css` 加 `.wb-num`。

- [ ] **Step 4: lint + 手测**

```bash
pnpm run lint && pnpm dev
```

输入超过 4500 / 5000 字测试颜色与禁用。

- [ ] **Step 5: 提交**

```bash
git add frontends/components/workbench/messages/MessageComposer.tsx \
        frontends/components/workbench/messages/constants.ts \
        frontends/components/workbench/messages/strings.ts
git commit -m "feat(composer): 字数 + 快捷键提示，超限禁用发送"
```

---

## Phase H — Typography 一致性整改

### Task H1: 新增 `.wb-num` utility

**Files:**

- Modify: `frontends/index.css`

- [ ] **Step 1: 在 `@layer components` 中加入**

打开 `frontends/index.css`，在已有 `@layer components { ... }` 内加：

```css
.wb-num {
  @apply font-numeric tabular-nums;
}
```

如果文件没有 `@layer components`，在末尾追加：

```css
@layer components {
  .wb-num {
    @apply font-numeric tabular-nums;
  }
}
```

- [ ] **Step 2: 校验 build**

```bash
pnpm run build
```

Expected: 无 PostCSS / Tailwind 报错。

- [ ] **Step 3: 提交**

```bash
git add frontends/index.css
git commit -m "style: 新增 .wb-num utility 收口数字字体"
```

### Task H2: Sweep — top-level (`MessagesPage`, `ConversationList`, `MessageContextMenu`)

**Files:**

- Modify: `frontends/components/workbench/messages/MessagesPage.tsx`
- Modify: `frontends/components/workbench/messages/ConversationList.tsx`
- Modify: `frontends/components/workbench/messages/MessageContextMenu.tsx`

- [ ] **Step 1: grep 现状**

```bash
grep -nE 'text-\[[0-9]+(\.[0-9]+)?px\]|text-wb-[a-z0-9]+|leading-\[[^]]+\]|font-(bold|normal|medium|semibold)|font-numeric|tabular-nums' \
  frontends/components/workbench/messages/MessagesPage.tsx \
  frontends/components/workbench/messages/ConversationList.tsx \
  frontends/components/workbench/messages/MessageContextMenu.tsx
```

- [ ] **Step 2: 按映射替换（逐文件 Edit 工具调用）**

按下表替换：

| 旧                                                                                                | 新                       |
| ------------------------------------------------------------------------------------------------- | ------------------------ |
| `text-[9px]` `text-[10px]` `text-[10.5px]` `text-[11px]` `text-[11.5px]`                          | `text-wb-3xs`            |
| `text-[12px]` `text-[12.5px]`                                                                     | `text-wb-2xs`            |
| `text-[13px]` `text-[13.5px]`                                                                     | `text-wb-xs`             |
| `text-[14px]`                                                                                     | `text-wb-sm`             |
| `text-[15px]`                                                                                     | `text-wb-base`           |
| `text-[16px]`                                                                                     | `text-wb-md`             |
| `font-numeric tabular-nums` 同时出现的 className                                                  | `wb-num`（保留语义不变） |
| `font-bold`                                                                                       | `font-semibold`          |
| `font-normal`                                                                                     | 删除（默认即可）         |
| `leading-[1.65]` `leading-[18px]` `leading-[17px]` `leading-[16px]` `leading-[15px]` 等 arbitrary | 删除（用 token 自带）    |

> 例外：`text-[18px]` 与 `text-[22px]` 保留（avatar 大字与极少标题）。

- [ ] **Step 3: lint + tsc**

```bash
pnpm run lint && npx tsc --noEmit
```

- [ ] **Step 4: 肉眼比对**

```bash
pnpm dev
```

打开 messages 页对比改动前后会话列表行高、未读数显示。

- [ ] **Step 5: 提交**

```bash
git add frontends/components/workbench/messages/MessagesPage.tsx \
        frontends/components/workbench/messages/ConversationList.tsx \
        frontends/components/workbench/messages/MessageContextMenu.tsx
git commit -m "style(messages): typography sweep — 顶层与会话列表"
```

### Task H3: Sweep — 气泡簇 (`MessageBubble`, `MessageContent`, `Avatar`)

**Files:**

- Modify: `frontends/components/workbench/messages/MessageBubble.tsx`
- Modify: `frontends/components/workbench/messages/MessageContent.tsx`
- Modify: `frontends/components/workbench/messages/Avatar.tsx`

- [ ] **Step 1: grep + 映射替换（同 H2 表）**

```bash
grep -nE 'text-\[[0-9]+(\.[0-9]+)?px\]|leading-\[[^]]+\]|font-numeric|tabular-nums|font-bold|font-normal' \
  frontends/components/workbench/messages/MessageBubble.tsx \
  frontends/components/workbench/messages/MessageContent.tsx \
  frontends/components/workbench/messages/Avatar.tsx
```

按 H2 表替换。

- [ ] **Step 2: 验证 + 手测**

```bash
pnpm run lint && npx tsc --noEmit && pnpm dev
```

发送/接收消息查看气泡正文、状态行、时间戳显示。

- [ ] **Step 3: 提交**

```bash
git add frontends/components/workbench/messages/MessageBubble.tsx \
        frontends/components/workbench/messages/MessageContent.tsx \
        frontends/components/workbench/messages/Avatar.tsx
git commit -m "style(messages): typography sweep — 气泡与头像"
```

### Task H4: Sweep — chrome (`ChatHeader`, `ChatStates`, `TypingIndicator`, `RangePill`, `WeChatBadge`)

**Files:**

- Modify: 上述 5 个文件

- [ ] **Step 1: grep + 替换（同表）**

- [ ] **Step 2: 验证**

```bash
pnpm run lint && npx tsc --noEmit
```

- [ ] **Step 3: 提交**

```bash
git add frontends/components/workbench/messages/ChatHeader.tsx \
        frontends/components/workbench/messages/ChatStates.tsx \
        frontends/components/workbench/messages/TypingIndicator.tsx \
        frontends/components/workbench/messages/RangePill.tsx \
        frontends/components/workbench/messages/WeChatBadge.tsx
git commit -m "style(messages): typography sweep — chrome"
```

### Task H5: Sweep — 面板 (`CustomerDetails`, `QuickRepliesPanel`, `MentionList`, `EmojiPicker`)

**Files:** 同名文件

- [ ] **Step 1: grep + 替换** (同表)

- [ ] **Step 2: 验证**

```bash
pnpm run lint && npx tsc --noEmit
```

- [ ] **Step 3: 提交**

```bash
git add frontends/components/workbench/messages/CustomerDetails.tsx \
        frontends/components/workbench/messages/QuickRepliesPanel.tsx \
        frontends/components/workbench/messages/MentionList.tsx \
        frontends/components/workbench/messages/EmojiPicker.tsx
git commit -m "style(messages): typography sweep — 面板"
```

### Task H6: Sweep — `MessageComposer.tsx` 与 `composer/*`

**Files:**

- Modify: `frontends/components/workbench/messages/MessageComposer.tsx`
- Modify: `frontends/components/workbench/messages/composer/AiPolishPopover.tsx`
- Modify: `frontends/components/workbench/messages/composer/SendButtonGroup.tsx`
- Modify: `frontends/components/workbench/messages/composer/ImageNodeView.tsx`

- [ ] **Step 1: grep**

```bash
grep -nE 'text-\[[0-9]+(\.[0-9]+)?px\]|leading-\[[^]]+\]|font-bold|font-normal' \
  frontends/components/workbench/messages/MessageComposer.tsx \
  frontends/components/workbench/messages/composer/*.tsx
```

- [ ] **Step 2: 按映射替换**

复用 H2 表。这一步同时把 G2/G3/G4 已经写的 `text-wb-xs/2xs/3xs` 留下不动。

- [ ] **Step 3: 验证**

```bash
pnpm run lint && npx tsc --noEmit && pnpm dev
```

- [ ] **Step 4: 提交**

```bash
git add frontends/components/workbench/messages/MessageComposer.tsx \
        frontends/components/workbench/messages/composer/*.tsx
git commit -m "style(messages): typography sweep — composer"
```

### Task H7: Sweep 验收 grep

**Files:**

无文件改动；仅校验。

- [ ] **Step 1: 跑收口 grep**

```bash
grep -rE 'text-\[[0-9]+(\.[0-9]+)?px\]|leading-\[[^]]+\]' \
  frontends/components/workbench/messages
```

Expected：仅返回 `text-[18px]` 与 `text-[22px]` 各 1 处（spec §12.3 约定的例外）；其他必须 0 命中。如有漏网，补一个 commit 修掉。

- [ ] **Step 2: 跑数字 utility 收口 grep**

```bash
grep -rEn 'font-numeric.*tabular-nums|tabular-nums.*font-numeric' \
  frontends/components/workbench/messages
```

Expected：0 命中（全部已被 `wb-num` 替换）。漏网的补 commit。

- [ ] **Step 3: 提交（如有修复）**

```bash
git commit -am "style(messages): typography sweep 验收补漏"
```

---

## Phase I — 收尾验证

### Task I1: 全量自动化检查

**Files:** 无

- [ ] **Step 1: lint**

```bash
pnpm run lint
```

Expected: exit 0。

- [ ] **Step 2: typecheck**

```bash
npx tsc --noEmit
```

Expected: 0 报错。

- [ ] **Step 3: 单测**

```bash
pnpm test
```

Expected: docToBlocks / useComposerPrefs / sanity 全部 PASS。

- [ ] **Step 4: build**

```bash
pnpm run build
```

Expected: build 成功。

### Task I2: 手测矩阵

**Files:** 无

打开 `pnpm dev`（或 `pnpm tauri dev`），逐项验证：

- [ ] 输入「你好，」+ 选择图片 + 输入「请确认」 → 内联混排发送 → 气泡按相同顺序渲染
- [ ] 粘贴剪贴板图片 → 出现在 caret 位置
- [ ] macOS Tauri 内调用截图 → 内联插入（仅 Tauri 环境）
- [ ] 拖拽图片调整顺序 → blocks[] 顺序对应变化
- [ ] @ 提及 → 候选列表正常，提交后是 mention 节点
- [ ] 中文输入法 Enter 不误发
- [ ] 字数 ≥4500 变橙、≥5000 变红 + 禁用发送
- [ ] AI 润色 popover：选语气 → 预览刷新 → 替换草稿
- [ ] 发送菜单：静默偏好持久化跨刷新
- [ ] 老 mock 消息（仅 text + image attachment）显示与改造前一致
- [ ] 消息页字号/数字/字重视觉协调，无半像素跳动

如有失败项回到对应 Task 修复并补 commit。
