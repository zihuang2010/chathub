import type { Message } from "./data";
import type { TimelineItem } from "./hooks/useChatTimeline";

const DEFAULT_VIRTUAL_OVERSCAN = 5;
const IMAGE_DENSE_VIRTUAL_OVERSCAN = 3;
const MEDIA_ROW_EXTRA_HEIGHT = 60;
const IMAGE_BOX_MAX_WIDTH = 256;
const IMAGE_BOX_MAX_HEIGHT = 320;
const IMAGE_BOX_FALLBACK_HEIGHT = 192;

function estimateImageBoxHeight(message: Message): number {
  const image = message.parts.find((part) => part.kind === "image");
  if (!image || !image.width || !image.height || image.width <= 0 || image.height <= 0) {
    return IMAGE_BOX_FALLBACK_HEIGHT;
  }
  const widthScale = IMAGE_BOX_MAX_WIDTH / image.width;
  const heightScale = IMAGE_BOX_MAX_HEIGHT / image.height;
  const scale = Math.min(widthScale, heightScale, 1);
  return Math.max(72, Math.round(image.height * scale));
}

function estimateTextRowHeight(message: Message): number {
  const text = message.text || message.parts.find((part) => part.kind === "text")?.text || "";
  const lineBreaks = text.split(/\r?\n/);
  const visualRows = lineBreaks.reduce(
    (rows, line) => rows + Math.max(1, Math.ceil(line.length / 28)),
    0,
  );
  return Math.min(220, 52 + Math.max(0, visualRows - 1) * 20);
}

export function estimateTimelineRowHeight(item: TimelineItem): number {
  if (item.type !== "message") return 64;
  const parts = item.message.parts;
  if (parts.some((part) => part.kind === "image")) {
    return estimateImageBoxHeight(item.message) + MEDIA_ROW_EXTRA_HEIGHT;
  }
  if (parts.some((part) => part.kind === "video")) return 212;
  if (parts.some((part) => part.kind === "file")) return 88;
  if (parts.some((part) => part.kind === "voice")) return 72;
  return estimateTextRowHeight(item.message);
}

export function getVirtualOverscan(timelineItems: readonly TimelineItem[]): number {
  if (timelineItems.length === 0) return DEFAULT_VIRTUAL_OVERSCAN;
  const imageRows = timelineItems.reduce(
    (count, item) =>
      item.type === "message" && item.message.parts.some((part) => part.kind === "image")
        ? count + 1
        : count,
    0,
  );
  return imageRows >= 8 && imageRows / timelineItems.length > 0.35
    ? IMAGE_DENSE_VIRTUAL_OVERSCAN
    : DEFAULT_VIRTUAL_OVERSCAN;
}
