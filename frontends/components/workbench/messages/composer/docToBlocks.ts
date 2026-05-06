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
