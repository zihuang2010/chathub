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
