import { cn } from "@/lib/utils";

import { extractAccountOperator, pickAvatarColor } from "./utils";

// Resolve the background fill for an avatar. Explicit `color` wins (lets a
// caller pin a specific brand color or override during e.g. onboarding flows);
// otherwise we hash the seed onto the wb-avatar-* token palette. Returning a
// CSS color string keeps the call site agnostic to the underlying theme.
function resolveAvatarColor(seed: string, color?: string): string {
  return color && color.length > 0 ? color : pickAvatarColor(seed);
}

interface CustomerAvatarProps {
  name: string;
  color?: string;
  size: "header" | "sm";
}

export function CustomerAvatar({ name, color, size }: CustomerAvatarProps) {
  return (
    <div
      className={cn(
        "grid size-11 shrink-0 place-items-center rounded-xl font-semibold text-workbench-text shadow-[inset_0_0_0_1px_rgba(255,255,255,0.48)]",
        size === "header" ? "text-[16px]" : "text-[15px]",
      )}
      style={{ background: resolveAvatarColor(name, color) }}
    >
      {name.slice(0, 1)}
    </div>
  );
}

export function AgentAvatar({ account }: { account: string }) {
  const operator = extractAccountOperator(account);
  return (
    <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-workbench-surface-soft text-[12px] font-medium text-workbench-text-secondary shadow-[inset_0_0_0_1px_rgba(255,255,255,0.55)]">
      {operator.slice(-2)}
    </div>
  );
}

interface ConversationAvatarProps {
  name: string;
  color?: string;
  online: boolean;
}

export function ConversationAvatar({ name, color, online }: ConversationAvatarProps) {
  return (
    <div className="relative shrink-0">
      <div
        className="grid size-11 place-items-center rounded-xl text-[15px] font-medium text-workbench-text shadow-[inset_0_0_0_1px_rgba(255,255,255,0.45)]"
        style={{ background: resolveAvatarColor(name, color) }}
      >
        {name.slice(0, 1)}
      </div>
      {online && (
        <span
          aria-hidden
          className="absolute bottom-0 right-0 size-2.5 rounded-full border-2 border-workbench-line-strong bg-workbench-online"
        />
      )}
    </div>
  );
}
