// Account strings look like "杭州企微-小美"; UIs that show the operator initials
// only want the trailing segment.
export function extractAccountOperator(account: string): string {
  const parts = account.split("-");
  return parts[parts.length - 1] || account;
}

const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "long",
  day: "numeric",
});

const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// Stable day key for grouping/divider detection. Independent of the user-facing
// label, so today's messages all share one key (and thus one divider) even
// though their display labels are time-based and differ per message.
export function getMessageDayKey(sentAt: string): string {
  const d = new Date(sentAt);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

// Returns the time-only label for messages sent today and the full date label
// otherwise. The date divider and the hover tooltip both consume this — when
// the conversation is happening today the year/month/day prefix is redundant
// noise, so we collapse to just HH:mm.
export function formatMessageDate(sentAt: string): string {
  const date = new Date(sentAt);
  if (isSameLocalDay(date, new Date())) {
    return timeFormatter.format(date);
  }
  return dateFormatter.format(date);
}

export function formatMessageTime(sentAt: string): string {
  return timeFormatter.format(new Date(sentAt));
}

export function formatMessageDateTime(sentAt: string): string {
  // For today's messages, formatMessageDate already yields the time, so
  // concatenating with another time would print the same value twice.
  const datePart = formatMessageDate(sentAt);
  const timePart = formatMessageTime(sentAt);
  return datePart === timePart ? timePart : `${datePart} ${timePart}`;
}

// ─── Rich-text segmentation ─────────────────────────────────────────────────
//
// Splits a plain-text message into typed segments so the renderer can wrap
// links / mentions / emoji shortcodes in the appropriate elements without
// leaving raw HTML floating around.

export type RichSegment =
  | { type: "text"; value: string }
  | { type: "link"; value: string; href: string }
  | { type: "mention"; value: string; handle: string }
  | { type: "emoji"; value: string };

const URL_PATTERN = /(https?:\/\/[^\s<>]+)/g;
const MENTION_PATTERN = /@([一-龥A-Za-z0-9_-]{1,32})/g;
const EMOJI_PATTERN = /:([a-z_+-]{2,20}):/g;

const EMOJI_MAP: Record<string, string> = {
  smile: "😊",
  joy: "😂",
  laugh: "😆",
  heart: "❤️",
  thumbsup: "👍",
  "+1": "👍",
  thumbsdown: "👎",
  "-1": "👎",
  ok: "👌",
  fire: "🔥",
  tada: "🎉",
  pray: "🙏",
  rocket: "🚀",
  eyes: "👀",
  thinking: "🤔",
  wave: "👋",
  check: "✅",
  warning: "⚠️",
  bulb: "💡",
};

interface Match {
  start: number;
  end: number;
  segment: RichSegment;
}

function collectMatches(
  text: string,
  pattern: RegExp,
  build: (match: RegExpExecArray) => RichSegment | null,
): Match[] {
  const out: Match[] = [];
  pattern.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    const segment = build(m);
    if (segment) out.push({ start: m.index, end: m.index + m[0].length, segment });
  }
  return out;
}

export function formatRichText(text: string): RichSegment[] {
  if (!text) return [];

  const matches: Match[] = [
    ...collectMatches(text, URL_PATTERN, (m) => ({
      type: "link",
      value: m[0],
      href: m[0],
    })),
    ...collectMatches(text, MENTION_PATTERN, (m) => ({
      type: "mention",
      value: m[0],
      handle: m[1],
    })),
    ...collectMatches(text, EMOJI_PATTERN, (m) => {
      const emoji = EMOJI_MAP[m[1]];
      return emoji ? { type: "emoji", value: emoji } : null;
    }),
  ].sort((a, b) => a.start - b.start);

  // Drop overlapping matches greedily — first one wins.
  const filtered: Match[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start < cursor) continue;
    filtered.push(match);
    cursor = match.end;
  }

  const segments: RichSegment[] = [];
  let pos = 0;
  for (const match of filtered) {
    if (match.start > pos) {
      segments.push({ type: "text", value: text.slice(pos, match.start) });
    }
    segments.push(match.segment);
    pos = match.end;
  }
  if (pos < text.length) segments.push({ type: "text", value: text.slice(pos) });
  return segments;
}

// ─── Misc helpers ───────────────────────────────────────────────────────────

export function isAtBottom(node: HTMLElement, threshold = 24): boolean {
  return node.scrollHeight - node.scrollTop - node.clientHeight < threshold;
}

// Human-readable byte size with locale-aware decimal separator. Falls back to
// "0 B" for zero/negative inputs to keep the UI stable when sizes are missing.
export function formatFileSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  // Whole bytes display without decimals; KB+ gets one decimal so 1.5 MB is
  // distinguishable from 1.0 MB.
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`;
}

// Avatar palette used when an entity (e.g. Customer) has no `avatarColor` on
// its data record. Hashing the id keeps the colour stable across renders.
// Values are CSS color expressions referencing tokens in index.css, so the
// palette responds to theme switches without code changes.
const AVATAR_PALETTE = [
  "hsl(var(--wb-avatar-1))",
  "hsl(var(--wb-avatar-2))",
  "hsl(var(--wb-avatar-3))",
  "hsl(var(--wb-avatar-4))",
  "hsl(var(--wb-avatar-5))",
  "hsl(var(--wb-avatar-6))",
  "hsl(var(--wb-avatar-7))",
  "hsl(var(--wb-avatar-8))",
];

export function pickAvatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
}

// Customer avatars use illustrated portraits served from public/avatars/.
// Drop files named a01.png … a05.png in that directory; seed-based hashing
// keeps the assignment stable per customer across renders.
const CUSTOMER_AVATAR_IMAGE_COUNT = 5;

export function pickCustomerAvatarImage(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  const index = (hash % CUSTOMER_AVATAR_IMAGE_COUNT) + 1;
  return `/avatars/a${String(index).padStart(2, "0")}.png`;
}
