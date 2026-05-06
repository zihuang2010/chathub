import { STRINGS } from "./strings";

// Curated set of high-frequency emojis for the composer popover. Sourced from
// industry-standard "frequently used" buckets (Apple, Google) and weighted
// toward customer-service tone (acknowledgement, empathy, polite reactions).
// Keep ≤56 entries — fits in a 8×7 grid without scrolling at 280px width.
const EMOJI_SET = [
  "😊",
  "😂",
  "😆",
  "🙂",
  "😉",
  "😍",
  "🥰",
  "😘",
  "😅",
  "🤔",
  "😇",
  "😎",
  "🥳",
  "😋",
  "😴",
  "🙌",
  "👍",
  "👎",
  "👌",
  "👏",
  "🙏",
  "💪",
  "✌️",
  "🤝",
  "❤️",
  "🧡",
  "💛",
  "💚",
  "💙",
  "💜",
  "🖤",
  "💯",
  "🔥",
  "✨",
  "🎉",
  "🎊",
  "💡",
  "⭐",
  "⚡",
  "✅",
  "❌",
  "❗",
  "❓",
  "⚠️",
  "📌",
  "📎",
  "📋",
  "📷",
  "🚀",
  "💎",
  "🎁",
  "🍀",
  "☕",
  "🌹",
  "👀",
  "🤗",
];

interface EmojiPickerProps {
  /** Called with the chosen emoji string. Caller appends it to the draft. */
  onSelect: (emoji: string) => void;
}

export function EmojiPicker({ onSelect }: EmojiPickerProps) {
  return (
    <div
      role="grid"
      aria-label={STRINGS.composer.emojiPickerLabel}
      className="grid grid-cols-8 gap-0.5"
    >
      {EMOJI_SET.map((emoji) => (
        <button
          key={emoji}
          type="button"
          role="gridcell"
          onClick={() => onSelect(emoji)}
          aria-label={emoji}
          className="focus-ring grid size-8 place-items-center rounded text-[18px] leading-none transition-colors hover:bg-workbench-surface-subtle"
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}
