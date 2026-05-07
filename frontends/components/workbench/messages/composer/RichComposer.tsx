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
    content: initialContent ?? {
      type: "doc",
      content: [{ type: "paragraph" }],
    },
    editorProps: {
      attributes: {
        class:
          "min-h-[64px] w-full px-2 py-2 text-wb-xs font-medium text-workbench-text outline-none",
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
