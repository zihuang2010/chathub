import { Pencil, Search } from "lucide-react";

import { Input } from "@/components/ui/input";

import type { QuickReply } from "./data";

export function QuickRepliesPanel({ items }: { items: QuickReply[] }) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-semibold text-workbench-text">快捷回复</span>
        <button type="button" className="text-[11.5px] font-medium text-workbench-blue">
          管理
        </button>
      </div>
      <Input
        icon={<Search size={12} />}
        placeholder="搜索快捷回复"
        className="h-8 rounded border-transparent bg-workbench-surface-soft text-[12px]"
      />
      <ul className="flex flex-col gap-0.5">
        {items.map((q) => (
          <li
            key={q.id}
            className="group flex items-start gap-1.5 rounded px-1.5 py-1.5 transition-colors hover:bg-workbench-surface-subtle"
          >
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-medium text-workbench-text">{q.title}</div>
              <p className="mt-0.5 truncate text-[11px] text-workbench-text-muted">{q.preview}</p>
            </div>
            <button
              type="button"
              aria-label={`编辑 ${q.title}`}
              className="grid size-6 shrink-0 place-items-center rounded text-workbench-text-muted opacity-0 transition-opacity hover:bg-white hover:text-workbench-blue-strong group-hover:opacity-100"
            >
              <Pencil size={11} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
