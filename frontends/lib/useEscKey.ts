import { useEffect } from "react";

interface UseEscKeyOptions {
  /** Disable the listener entirely. Defaults to true. */
  enabled?: boolean;
  /** Skip the handler if an IME composition is in progress (Chinese/Japanese/Korean
   *  input). Defaults to true — pressing Esc to dismiss IME candidates should
   *  never be hijacked by app-level shortcuts. */
  skipIfComposing?: boolean;
  /** Skip if the focused element is an input/textarea/contenteditable so users
   *  can press Esc to clear/blur form fields without triggering the handler.
   *  Defaults to true. */
  skipIfInInput?: boolean;
  /** Skip if a child element already handled the Esc (e.g. a Radix popover
   *  closing itself). Defaults to true. */
  skipIfDefaultPrevented?: boolean;
}

/** Window-level Escape key listener with IME and focus awareness.
 *
 *  Two prior implementations of this pattern (MessageComposer's reply cancel
 *  and useCustomerSelection's bulk-mode exit) both incorrectly fired during
 *  IME composition cancel and inside form fields, dropping user state. This
 *  hook is the canonical replacement.
 */
export function useEscKey(handler: () => void, options: UseEscKeyOptions = {}) {
  const {
    enabled = true,
    skipIfComposing = true,
    skipIfInInput = true,
    skipIfDefaultPrevented = true,
  } = options;

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (skipIfDefaultPrevented && event.defaultPrevented) return;
      // `isComposing` is the standard property; `keyCode === 229` is the
      // legacy fallback some browsers still emit for IME-active keys.
      if (skipIfComposing && (event.isComposing || event.keyCode === 229)) return;
      if (skipIfInInput) {
        const target = event.target as Element | null;
        if (
          target &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            (target as HTMLElement).isContentEditable)
        ) {
          return;
        }
      }
      handler();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, handler, skipIfComposing, skipIfInInput, skipIfDefaultPrevented]);
}
