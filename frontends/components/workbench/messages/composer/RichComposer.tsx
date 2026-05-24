import { useEffect, useMemo, useRef } from "react";
import {
  EditorContent,
  ReactNodeViewRenderer,
  useEditor,
  type Editor,
  type JSONContent,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import DOMPurify from "dompurify";

import type { Conversation } from "../data";
import { ImageNodeView } from "./ImageNodeView";
import { createMentionExtension, type MentionContext } from "./MentionExtension";

interface RichComposerProps {
  initialContent?: JSONContent;
  placeholder?: string;
  mentionCandidates?: Conversation[];
  onChange?: (doc: JSONContent) => void;
  onSubmit?: () => void;
  /** Returns true if the composer handled the files (and the editor should not perform default paste). */
  onPasteFiles?: (files: File[]) => boolean;
  /** Fired once on mount with the editor instance, so the parent can call commands imperatively. */
  onReady?: (editor: Editor) => void;
  className?: string;
}

export function RichComposer({
  initialContent,
  placeholder,
  mentionCandidates,
  onChange,
  onSubmit,
  onPasteFiles,
  onReady,
  className,
}: RichComposerProps) {
  const mentionCtx = useMemo<MentionContext>(
    () => ({ candidates: mentionCandidates ?? [] }),
    [mentionCandidates],
  );

  // IME 兜底:部分输入法(如搜狗)候选词上屏瞬间 isComposing 已转 false 且 keyCode!==229,
  // 此时回车会被误判为"发送"。compositionend 后短暂置位本标志,handleKeyDown 命中则吞掉该次
  // Enter,只放过真正的换行触发发送。
  const justComposedRef = useRef(false);

  const editor = useEditor({
    // 切会话时父组件按 conversation.id key 重挂载本组件 → 每次切换都销毁+重建编辑器。
    // 默认 immediatelyRender:true 会在 React render 阶段创建视图并用 flushSync 刷新
    // node-view/portal;React 19 + StrictMode 下会报 "flushSync ... while rendering"
    // 并中断刷新,旧编辑器的 fiber/portal/contenteditable DOM 未被完整回收 → 每切一次
    // 泄漏一个编辑器实例。置 false 把首次渲染推迟到 effect(commit 后),切换得以干净卸载。
    immediatelyRender: false,
    // 切会话时父组件按 conversation.id key 重挂载本组件,新 editor 实例需自动 focus
    // 到末尾,这样用户切到新会话可以直接打字,不必先点输入区。
    autofocus: "end",
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
    content: initialContent ?? {
      type: "doc",
      content: [{ type: "paragraph" }],
    },
    editorProps: {
      attributes: {
        class:
          "min-h-[64px] w-full px-2 pb-2 pt-0 text-wb-xs font-medium text-workbench-text outline-none",
      },
      // HTML 富文本粘贴净化:严格白名单只留基础格式标签,剥离所有属性
      // (href/style/on* 全去),杜绝 <script>/事件处理器/危险协议注入。链接文本
      // 保留为纯文本,接收端 formatRichText 仍会自动识别 http(s) 链接。
      transformPastedHTML: (html) =>
        DOMPurify.sanitize(html, {
          ALLOWED_TAGS: ["p", "br", "span", "b", "strong", "i", "em", "s", "strike", "code"],
          ALLOWED_ATTR: [],
          FORBID_TAGS: ["style"],
        }),
      handleDOMEvents: {
        compositionend: () => {
          justComposedRef.current = true;
          setTimeout(() => {
            justComposedRef.current = false;
          }, 50);
          return false; // 不拦截,让 ProseMirror 正常完成上屏
        },
      },
      handleKeyDown: (_view, event) => {
        if (
          event.key === "Enter" &&
          !event.shiftKey &&
          !event.isComposing &&
          event.keyCode !== 229 &&
          !justComposedRef.current
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

  // Keep onReady callable through the latest closure. Notify the parent ONCE
  // per editor instance (not per onReady identity change), so re-renders don't
  // re-fire the handshake.
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    onReadyRef.current = onReady;
  });
  useEffect(() => {
    if (editor) onReadyRef.current?.(editor);
  }, [editor]);

  useEffect(() => {
    return () => editor?.destroy();
  }, [editor]);

  return <EditorContent editor={editor} className={className} />;
}
