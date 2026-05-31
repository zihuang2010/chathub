import type { Message } from "./data";
import { getMeasuredDims } from "./imageDimsCache";
import type { TimelineItem } from "./hooks/useChatTimeline";

const DEFAULT_VIRTUAL_OVERSCAN = 5;
const IMAGE_DENSE_VIRTUAL_OVERSCAN = 3;
const MEDIA_ROW_EXTRA_HEIGHT = 60;
const IMAGE_BOX_MAX_WIDTH = 256;
const IMAGE_BOX_MAX_HEIGHT = 320;
const IMAGE_BOX_FALLBACK_HEIGHT = 192;

function estimateImageBoxHeight(message: Message): number {
  const image = message.parts.find((part) => part.kind === "image");
  if (!image) return IMAGE_BOX_FALLBACK_HEIGHT;
  // 估高尺寸源与渲染盒一致:后端 image_meta dims 优先,否则用 MessageImage 测得并缓存的
  // 固有宽高 —— 使滚出再滚入的图片行「估高」与「实测」相符,虚拟器不再据差值重排(消抖动)。
  const measured = getMeasuredDims(image.url);
  const w = image.width ?? measured?.w;
  const h = image.height ?? measured?.h;
  if (!w || !h || w <= 0 || h <= 0) return IMAGE_BOX_FALLBACK_HEIGHT;
  const widthScale = IMAGE_BOX_MAX_WIDTH / w;
  const heightScale = IMAGE_BOX_MAX_HEIGHT / h;
  const scale = Math.min(widthScale, heightScale, 1);
  return Math.max(72, Math.round(h * scale));
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
