import { memo } from "react";
import { Sparkles } from "lucide-react";

import { WorkbenchPanel } from "@/components/workbench/WorkbenchPanel";

import { NAV_ITEMS, type Section } from "./nav";

const FALLBACK = NAV_ITEMS[0];

interface PlaceholderPageProps {
  section: Section;
}

export const PlaceholderPage = memo(function PlaceholderPage({ section }: PlaceholderPageProps) {
  const item = NAV_ITEMS.find((n) => n.value === section) ?? FALLBACK;
  const Icon = item.Icon;

  return (
    <WorkbenchPanel>
      <div className="flex h-full min-w-0 flex-1 flex-col bg-[#F8FAFC]">
        <header className="flex min-h-[56px] items-center justify-between border-b border-[#EEF2F7] bg-white px-6">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="grid size-8 shrink-0 place-items-center rounded bg-[#EFF4FF] text-[#2563EB]">
              <Icon size={16} strokeWidth={1.8} />
            </span>
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-[15px] font-semibold text-[#1F2937]">
                {item.label}
              </span>
              <span className="text-[12px] text-[#9CA3AF]">敬请期待</span>
            </div>
          </div>
        </header>

        <div className="flex flex-1 items-center justify-center px-6">
          <div className="flex max-w-[360px] flex-col items-center gap-4 text-center">
            <div
              aria-hidden
              className="grid size-24 place-items-center rounded-full"
              style={{
                background: "radial-gradient(closest-side, #DCE6FF 0%, rgba(220,230,255,0) 70%)",
              }}
            >
              <Icon size={36} strokeWidth={1.5} className="text-[#9CB8DB]" />
            </div>
            <div className="flex flex-col gap-1">
              <p className="text-[15px] font-medium text-[#1F2937]">{item.label} · Coming Soon</p>
              <p className="text-[13px] text-[#9CA3AF]">此页面正在搭建中，欢迎稍后再来。</p>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#EFF4FF] px-3 py-1 text-[11.5px] font-medium text-[#2563EB]">
              <Sparkles size={12} />
              敬请期待
            </span>
          </div>
        </div>
      </div>
    </WorkbenchPanel>
  );
});
