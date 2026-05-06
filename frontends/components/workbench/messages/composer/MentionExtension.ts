import Mention from "@tiptap/extension-mention";
import { ReactRenderer } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
// Headless variant: we render our own UI inside <MentionList/>, so the default
// tippy theme + CSS hooks would only ship dead bytes. Headless drops those
// (~20-30KB gzipped) while keeping the popper positioning API identical.
import tippy, { type Instance } from "tippy.js/headless";

import { MentionList, type MentionListHandle, type MentionListProps } from "../MentionList";
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
        let component: ReactRenderer<MentionListHandle, MentionListProps> | null = null;
        let popup: Instance[] | null = null;

        return {
          onStart: (props) => {
            component = new ReactRenderer<MentionListHandle, MentionListProps>(MentionList, {
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
            // Escape always closes the popover and is consumed so the editor
            // does not, e.g., blur or trigger any global Esc handler.
            if (props.event.key === "Escape") {
              popup?.[0].hide();
              return true;
            }
            // Forward Arrow/Enter/Tab to the list's imperative handle so the
            // user can pick a candidate without a mouse. The list returns
            // false for keys it does not handle, so editor input keeps flowing.
            return component?.ref?.onKeyDown(props.event) ?? false;
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
