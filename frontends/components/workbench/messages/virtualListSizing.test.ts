import { describe, expect, it } from "vitest";

import type { Message, MessagePart } from "./data";
import type { TimelineItem } from "./hooks/useChatTimeline";
import { estimateTimelineRowHeight } from "./virtualListSizing";

function msg(parts: MessagePart[], text = ""): Message {
  return {
    id: "m1",
    conversationId: "c1",
    direction: "in",
    sentAt: "2026-05-19T00:00:00.000Z",
    text,
    parts,
  };
}

function messageItem(message: Message): TimelineItem {
  return { type: "message", id: "m1", message, isFirstInBurst: false };
}

// 无 image_meta dims 且缓存未命中时,estimateImageBoxHeight 回退 192 方盒。
const FALLBACK_IMAGE_BOX = 192;
// 续条行顶 padding 间距(pt-11);estimateTimelineRowHeight 把它并入实测盒口径。messageItem 的
// isFirstInBurst=false 故取续条间距 44(首条为 48)。
const BURST_TOP_SPACING = 44;

describe("estimateTimelineRowHeight:图片行额外高按 isMediaOnly 区分", () => {
  it("媒体独占图片消息:仅加 mediaOnly 额外高(无气泡 chrome),不再统一 +60", () => {
    const item = messageItem(msg([{ kind: "image", url: "https://e/x.png" }]));
    // 192(回退盒) + 12(mediaOnly 额外) + 44(行间距 pt-11)。
    expect(estimateTimelineRowHeight(item)).toBe(FALLBACK_IMAGE_BOX + 12 + BURST_TOP_SPACING);
  });

  it("图文混排消息:仍计气泡 chrome 额外高(+60)", () => {
    const item = messageItem(
      msg(
        [
          { kind: "text", text: "看图" },
          { kind: "image", url: "https://e/y.png" },
        ],
        "看图",
      ),
    );
    expect(estimateTimelineRowHeight(item)).toBe(FALLBACK_IMAGE_BOX + 60 + BURST_TOP_SPACING);
  });

  it("分隔行返回固定 64(内容 36 + pt-7 间距 28)", () => {
    const divider: TimelineItem = { type: "date-divider", id: "d1", label: "今天" };
    expect(estimateTimelineRowHeight(divider)).toBe(64);
  });
});
