import { extractAccountOperator, pickAvatarColor, pickCustomerAvatarImage } from "./utils";

// Customers render as illustrated portraits sourced from public/avatars/.
// We keep the legacy `avatarColor` (or hashed palette token) as the underlying
// background fill so a missing or slow-loading image degrades to a soft tint
// rather than a blank white square.
function resolveAvatarColor(seed: string, color?: string): string {
  return color && color.length > 0 ? color : pickAvatarColor(seed);
}

interface CustomerAvatarProps {
  name: string;
  color?: string;
  size: "header" | "sm";
}

export function CustomerAvatar({ name, color }: CustomerAvatarProps) {
  return (
    <div
      role="img"
      aria-label={name}
      className="size-11 shrink-0 rounded-xl bg-cover bg-center shadow-[inset_0_0_0_1px_rgba(255,255,255,0.48)]"
      style={{
        backgroundColor: resolveAvatarColor(name, color),
        backgroundImage: `url(${pickCustomerAvatarImage(name)})`,
      }}
    />
  );
}

export function AgentAvatar({ account }: { account: string }) {
  const operator = extractAccountOperator(account);
  return (
    <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-workbench-surface-soft text-wb-2xs font-medium text-workbench-text-secondary shadow-[inset_0_0_0_1px_rgba(255,255,255,0.55)]">
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
        role="img"
        aria-label={name}
        className="size-11 rounded-xl bg-cover bg-center shadow-[inset_0_0_0_1px_rgba(255,255,255,0.45)]"
        style={{
          backgroundColor: resolveAvatarColor(name, color),
          backgroundImage: `url(${pickCustomerAvatarImage(name)})`,
        }}
      />
      {online && (
        <span
          aria-hidden
          className="absolute bottom-0 right-0 size-2.5 rounded-full border-2 border-workbench-line-strong bg-workbench-online"
        />
      )}
    </div>
  );
}
