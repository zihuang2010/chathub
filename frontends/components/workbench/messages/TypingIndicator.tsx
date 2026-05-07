import { STRINGS } from "./strings";

export function TypingIndicator() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex shrink-0 items-center gap-2 border-t border-workbench-line bg-workbench-surface px-4 py-1.5 text-wb-2xs font-medium text-workbench-text-muted"
    >
      <span className="flex items-center gap-1" aria-hidden>
        <Dot delay="0s" />
        <Dot delay="0.15s" />
        <Dot delay="0.3s" />
      </span>
      <span>{STRINGS.status.typing}</span>
    </div>
  );
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      aria-hidden
      className="size-1.5 rounded-full bg-workbench-text-muted"
      style={{
        animation: "chTyping 1.2s infinite ease-in-out",
        animationDelay: delay,
      }}
    />
  );
}
