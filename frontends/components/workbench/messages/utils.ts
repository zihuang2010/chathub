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

// 仅本文件内使用(被 formatMessageDateTime 调用),不对外导出。
function formatMessageTime(sentAt: string): string {
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

// ─── URL 安全白名单 ──────────────────────────────────────────────────────────
//
// 后端附件 URL 在进入 href / <img src> / CSS url() 前必须过滤。Tauri WebView 下
// 未过滤的 javascript: / file: / data:text/html 协议可被点击触发脚本执行或本地
// 文件读取。link 仅放行 http(s) 与站内相对路径;image 额外放行 data:image/、blob:。
export function isSafeUrl(url: string | undefined, kind: "link" | "image"): boolean {
  if (!url) return false;
  // 去掉空白与控制字符(charCode <= 0x20 或 = 0x7f),防止形如 "java<LF>script:"
  // 的 URL 在浏览器去掉空白后变成可执行协议的绕过。
  let value = "";
  for (const ch of url) {
    const code = ch.charCodeAt(0);
    if (code > 0x20 && code !== 0x7f) value += ch;
  }
  if (!value) return false;
  // 站内绝对路径放行,但排除协议相对 "//host"。
  if (value.startsWith("/")) return !value.startsWith("//");
  const proto = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
  // 无协议前缀 = 相对路径,不能注入脚本,放行。
  if (!proto) return true;
  if (proto === "http" || proto === "https") return true;
  // mediaproxy:应用自有媒体代理协议,前端在 messageHistory 统一构造 `mediaproxy://${mediaId}`
  // (图片 src 与文件/视频 href 都用它),前缀固定、非外部可注入,放行。
  if (proto === "mediaproxy") return true;
  if (kind === "image") {
    if (proto === "blob") return true;
    if (proto === "data" && /^data:image\//i.test(value)) return true;
    // cachedimg:本地图片缓存自定义协议(由 cachedImageSrc 生成,macOS/Linux 形态),
    // 前缀固定、非外部可注入,放行;Windows 形态是 http://cachedimg.localhost,已被 http 放行。
    if (proto === "cachedimg") return true;
  }
  return false;
}

// CSS url() 上下文专用守卫。isSafeUrl 只保证协议安全(适用于 href / <img src>,
// 浏览器按 URL 语义解析),但把外部 URL 放进 CSS `background: url(...)` 时,URL 里
// 裸的引号/括号/反斜杠/尖括号/分号/空白可提前闭合 url() 并追加任意 CSS 声明
// (外链加载做追踪、数据外带)。此函数在 isSafeUrl 通过后额外拒绝一切 CSS 元字符:
// 合法的 http(s)/mediaproxy/blob/data:image/cachedimg URL 不含这些裸字符
// (会被 %-编码),故对正常输入零影响。不安全返回 null,调用方回退占位/不设背景。
// 注意:调用方仍应使用带引号的 url("...") 形式作为第二层防御。
export function cssUrlSafe(url: string | undefined, kind: "link" | "image"): string | null {
  if (!url || !isSafeUrl(url, kind)) return null;
  if (/["'()\\<>;\s]/.test(url)) return null;
  return url;
}

// ─── Reply preview ──────────────────────────────────────────────────────────
//
// 引用预览(composer 顶上的引用条 + 气泡内 ReplyBlock)优先展示文本;若文本
// 为空(纯图片 / 纯文件 / 纯语音 / 纯视频消息),按内容类型回退为占位 "[图片]"
// 等。否则引用块只剩 "senderName：" 一行,正文为空,视觉上 "引用内容消失"。
//
// 与 extractDraftPreview 的占位约定保持一致(草稿预览 / 引用预览同语义)。

import type { Message, MessagePart } from "./data";

function partTypePlaceholder(kind: Exclude<MessagePart["kind"], "text">): string {
  switch (kind) {
    case "image":
      return "[图片]";
    case "file":
      return "[文件]";
    case "voice":
      return "[语音]";
    case "video":
      return "[视频]";
  }
}

export function messageReplyPreview(message: Message): string {
  const trimmed = message.text.trim();
  if (trimmed) return trimmed;
  // 无文本 → 取第一个媒体 part 的占位("[图片]" 等)。
  for (const p of message.parts) {
    if (p.kind !== "text") return partTypePlaceholder(p.kind);
  }
  return "";
}

// ─── Misc helpers ───────────────────────────────────────────────────────────

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

// 缩略图请求宽度:按 CSS 显示宽 × 设备像素比(高分屏上限 2×),并封顶在历史固定值 384px。
// → 视网膜屏(dpr≥2)仍取 cssWidth×2(对 192 盒即 384,画质与此前一致);低分屏(如 Windows
//   1× / 1.25×)据此降到接近显示宽,webview 解码的位图随面积平方下降(1× 时约为原 1/4),
//   直接削减「切会话 + 滑动图片历史」时的解码内存峰值。封顶 384 保证任何情况都不比此前更耗内存。
export function thumbWidth(cssWidth: number): number {
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  return Math.min(384, Math.round(cssWidth * Math.min(dpr, 2)));
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

// seed 字符串哈希:逐字符 hash = (hash*31 + charCode) >>> 0(无符号 32 位)。
// pickAvatarColor 用它保证同一 seed 选色稳定(letter-tile 底色)。
function hashSeed(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export function pickAvatarColor(seed: string): string {
  return AVATAR_PALETTE[hashSeed(seed) % AVATAR_PALETTE.length];
}
