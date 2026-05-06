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
