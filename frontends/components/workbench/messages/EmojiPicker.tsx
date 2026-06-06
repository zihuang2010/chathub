import { useRef, useState, type KeyboardEvent } from "react";

import { STRINGS } from "./strings";

// 网格列数,需与下方 grid-cols-8 保持一致(方向键换行/换列按此计算)。
const GRID_COLUMNS = 8;

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
  // roving-tabindex:网格内仅 activeIndex 那一格可被 Tab 聚焦,方向键在网格内移动焦点。
  const [activeIndex, setActiveIndex] = useState(0);
  const cellRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // 把焦点移到目标格并记为活动格;clamp 防越界(末行不足一列时不跳空)。
  const focusCell = (index: number) => {
    const next = Math.max(0, Math.min(index, EMOJI_SET.length - 1));
    setActiveIndex(next);
    cellRefs.current[next]?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    switch (event.key) {
      case "ArrowRight":
        event.preventDefault();
        focusCell(index + 1);
        break;
      case "ArrowLeft":
        event.preventDefault();
        focusCell(index - 1);
        break;
      case "ArrowDown":
        event.preventDefault();
        focusCell(index + GRID_COLUMNS);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusCell(index - GRID_COLUMNS);
        break;
      case "Enter":
      case " ": // Space
        event.preventDefault();
        onSelect(EMOJI_SET[index]);
        break;
      default:
        break;
    }
  };

  return (
    <div
      role="grid"
      aria-label={STRINGS.composer.emojiPickerLabel}
      className="grid grid-cols-8 gap-0.5"
    >
      {EMOJI_SET.map((emoji, index) => (
        <button
          key={emoji}
          ref={(el) => {
            cellRefs.current[index] = el;
          }}
          type="button"
          role="gridcell"
          // roving-tabindex:仅活动格进入 Tab 序,其余 -1,方向键负责格间移动。
          tabIndex={index === activeIndex ? 0 : -1}
          onClick={() => onSelect(emoji)}
          onKeyDown={(event) => handleKeyDown(event, index)}
          onFocus={() => setActiveIndex(index)}
          aria-label={emoji}
          className="focus-ring grid size-8 place-items-center rounded text-[18px] leading-none transition-colors hover:bg-workbench-surface-subtle"
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}
