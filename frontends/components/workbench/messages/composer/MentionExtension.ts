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
