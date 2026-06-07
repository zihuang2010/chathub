import type { Message } from "./data";
import { getMeasuredDims } from "./imageDimsCache";
import type { TimelineItem } from "./hooks/useChatTimeline";

// overscan:视口外多挂的行数。适度增大让翻页 prepend 进来的行 + 参照锚点行更可能同时在 DOM 里,
// 使 useScrollController 的 prepend 参照行锚走「querySelector 实测」主路径而非闭式差值回退 → 翻页更稳。
// 仅在关掉 react-virtual 自动 scrollTop 补偿(见 ChatArea shouldAdjustScrollPositionOnItemSizeChange:false)
// 之后才安全:否则更多上方行同帧进测量 = 同帧更多补偿 = 上滑更闪。图片 remount 不闪骨架(loadedImageSrcs
// 缓存),故多挂行仅多占 DOM,无重载代价。
const DEFAULT_VIRTUAL_OVERSCAN = 8;
const IMAGE_DENSE_VIRTUAL_OVERSCAN = 5;
// 图片行在「图片盒高」之外的额外高度,按是否套气泡 chrome 区分(向实测对齐):
//  - 媒体独占消息(isMediaOnly):气泡不套底色/内边距/描边(见 MessageBubble),仅圆角,
//    额外高接近 0,给 12 兜底行间微差。原先统一用 60 对这类(占图片消息绝大多数)系统性高估,
//    首帧 measureElement 校正幅度大 → 可见「整列下沉」。
//  - 图文混排(图片 + 文本同条):仍有气泡 padding + 时间戳,沿用 60。
const MEDIA_ONLY_ROW_EXTRA_HEIGHT = 12;
const MEDIA_IN_BUBBLE_EXTRA_HEIGHT = 60;
const IMAGE_BOX_MAX_WIDTH = 256;
const IMAGE_BOX_MAX_HEIGHT = 320;
const IMAGE_BOX_FALLBACK_HEIGHT = 192;

// 行顶间距:Stage B 起行间距由 margin(mt-*)改成 padding(pt-*),计入了 measureElement 实测盒高,
// 但下面的估高基线是「内容盒」(沿用 margin 在盒外时代的值),故每条系统性低估一个间距 → measureElement
// 持续校正 totalSize。这里把间距并回估高,与实测盒对齐:续条 pt-11=44 / burst 首条 pt-12=48 /
// 分隔条 pt-7=28(首行 index 0 无间距,仅差一行,可忽略;估高不知 index,统一计入偏保守、稳)。
const BURST_TOP_SPACING = 44;
const FIRST_IN_BURST_TOP_SPACING = 48;
const DIVIDER_TOP_SPACING = 28;

// 与 MessageBubble.isMediaOnly 同义:仅图片/视频、无文本的消息不套气泡 chrome。
function isMediaOnlyMessage(message: Message): boolean {
  const parts = message.parts;
  return parts.length > 0 && parts.every((part) => part.kind === "image" || part.kind === "video");
}

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
  // 分隔条:内容基线 36 + pt-7 间距(原先 64 = 含间距的旧值,拆成内容 + 间距与消息行口径一致)。
  if (item.type !== "message") return 36 + DIVIDER_TOP_SPACING;
  // 行顶 padding 间距(计入实测盒,见常量注释):burst 首条 pt-12 / 续条 pt-11。
  const spacing = item.isFirstInBurst ? FIRST_IN_BURST_TOP_SPACING : BURST_TOP_SPACING;
  const parts = item.message.parts;
  if (parts.some((part) => part.kind === "image")) {
    const extra = isMediaOnlyMessage(item.message)
      ? MEDIA_ONLY_ROW_EXTRA_HEIGHT
      : MEDIA_IN_BUBBLE_EXTRA_HEIGHT;
    return estimateImageBoxHeight(item.message) + extra + spacing;
  }
  if (parts.some((part) => part.kind === "video")) return 212 + spacing;
  if (parts.some((part) => part.kind === "file")) return 88 + spacing;
  if (parts.some((part) => part.kind === "voice")) return 72 + spacing;
  return estimateTextRowHeight(item.message) + spacing;
}

export function timelineItemHeightSignature(item: TimelineItem): string {
  if (item.type !== "message") return item.type;
  const imageParts = item.message.parts.filter((part) => part.kind === "image");
  if (imageParts.length === 0) return item.message.parts.map((part) => part.kind).join(",");
  return imageParts
    .map((image) => {
      const measured = getMeasuredDims(image.url);
      const w = image.width ?? measured?.w ?? 0;
      const h = image.height ?? measured?.h ?? 0;
      return `${image.url}:${w}x${h}`;
    })
    .join("|");
}

export function timelineRowHeightCacheKey(conversationId: string, item: TimelineItem): string {
  return `${conversationId}:${item.id}:${timelineItemHeightSignature(item)}`;
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
