// MessageComposer 拖拽落地句柄 acceptDroppedFiles 的行为回归测试。
// 覆盖:
//  1. 文档进托盘,不支持格式(exe)被忽略并 toast dropUnsupported。
//  2. 混合拖入夹语音:语音被忽略并 toast dropVoiceAlone,文档照常进托盘。
//  3. 纯语音拖入 + 编辑器为空:直接进语音独占态(出现语音 chip)。
//  4. 纯语音拖入 + 编辑器有文本:弹确认框,确认后语音落地。
//  5. 纯语音拖入 + 有文本 + 点取消:语音不落地,确认框关闭。
//
// 范式照搬 MessageComposer.attachments.test.tsx:mock Tauri / recentFriends /
// AiPolishPopover / toast,beforeAll stub Range.prototype 矩形方法,afterEach cleanup。

import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Tauri / 后端边界 mock —— jsdom 无原生 Tauri。
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
  isTauri: () => false,
}));
vi.mock("@/lib/api/recentFriends", () => ({
  setConversationDraft: vi.fn(() => Promise.resolve()),
}));
// AI 润色弹层与本测试无关 → 占位 mock,避免牵入额外依赖。
vi.mock("./composer/AiPolishPopover", () => ({
  AiPolishPopover: () => null,
}));
// toast mock:断言分流报错时被调用 + 文案。
vi.mock("@/components/ui/toast", () => ({
  showToast: vi.fn(),
}));

import { showToast } from "@/components/ui/toast";
import type { ComposerDropHandle } from "./MessageComposer";
import { MessageComposer } from "./MessageComposer";
import { STRINGS } from "./strings";
import { EMPTY_DOC, setDraft, setFileAttachments } from "./useDraftStore";

const showToastMock = vi.mocked(showToast);

// 用独立 CONV 避免与其他测试文件的草稿 store 串台。
const CONV = "conv-DD";

const baseProps = {
  height: 240,
  onHeightChange: vi.fn(),
  detailsOpen: false,
  onToggleDetails: vi.fn(),
  onSend: vi.fn(),
};

// 用文件名后缀做一个最小 File(jsdom 的 File 构造可用)。
function fileNamed(name: string, type = "application/octet-stream"): File {
  return new File(["x"], name, { type });
}

beforeAll(() => {
  // ProseMirror 在 setContent/focus 后做 scrollToSelection 会调用 Range 的矩形方法,
  // jsdom 未实现 → 补空矩形 stub,消除无害的 unhandled error 噪声。
  if (typeof Range.prototype.getClientRects !== "function") {
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  }
  if (typeof Range.prototype.getBoundingClientRect !== "function") {
    Range.prototype.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        toJSON: () => ({}),
      }) as DOMRect;
  }
});

beforeEach(() => {
  // 清掉跨用例草稿 / 附件残留(module-level store 跨用例存活)。
  setDraft(CONV, EMPTY_DOC);
  setFileAttachments(CONV, []);
  showToastMock.mockClear();
});

afterEach(() => {
  cleanup();
  setFileAttachments(CONV, []);
  setDraft(CONV, EMPTY_DOC);
  vi.clearAllMocks();
});

describe("acceptDroppedFiles 分流", () => {
  it("文档进托盘,exe 被忽略并 toast dropUnsupported", async () => {
    const dropRef: { current: ComposerDropHandle | null } = { current: null };
    const { container } = render(
      <MessageComposer {...baseProps} conversationId={CONV} dropHandleRef={dropRef} />,
    );
    await waitFor(() => expect(dropRef.current).not.toBeNull());
    act(() => {
      dropRef.current!.acceptDroppedFiles([fileNamed("合同.pdf"), fileNamed("evil.exe")]);
    });
    await waitFor(() => expect(within(container).getByText("合同.pdf")).toBeTruthy());
    expect(within(container).queryByText("evil.exe")).toBeNull();
    expect(showToastMock).toHaveBeenCalledWith(STRINGS.toast.dropUnsupported, { type: "error" });
  });

  it("混合拖入夹语音:语音被忽略并 toast dropVoiceAlone,文档照常进托盘", async () => {
    const dropRef: { current: ComposerDropHandle | null } = { current: null };
    const { container } = render(
      <MessageComposer {...baseProps} conversationId={CONV} dropHandleRef={dropRef} />,
    );
    await waitFor(() => expect(dropRef.current).not.toBeNull());
    act(() => {
      dropRef.current!.acceptDroppedFiles([fileNamed("a.pdf"), fileNamed("v.amr")]);
    });
    await waitFor(() => expect(within(container).getByText("a.pdf")).toBeTruthy());
    expect(within(container).queryByText("v.amr")).toBeNull();
    expect(showToastMock).toHaveBeenCalledWith(STRINGS.toast.dropVoiceAlone, { type: "error" });
  });

  it("纯语音拖入 + 编辑器为空:直接进语音独占态", async () => {
    const dropRef: { current: ComposerDropHandle | null } = { current: null };
    const { container } = render(
      <MessageComposer {...baseProps} conversationId={CONV} dropHandleRef={dropRef} />,
    );
    await waitFor(() => expect(dropRef.current).not.toBeNull());
    act(() => {
      dropRef.current!.acceptDroppedFiles([fileNamed("v.amr")]);
    });
    await waitFor(() => expect(within(container).getByText("v.amr")).toBeTruthy());
  });

  it("纯语音拖入 + 编辑器有文本:弹确认框,确认后语音落地", async () => {
    // 预置草稿文本(实现切会话/初始挂载读 store)。
    setDraft(CONV, {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "已有文字" }] }],
    });
    const dropRef: { current: ComposerDropHandle | null } = { current: null };
    const { container, getByText } = render(
      <MessageComposer {...baseProps} conversationId={CONV} dropHandleRef={dropRef} />,
    );
    await waitFor(() => expect(dropRef.current).not.toBeNull());
    act(() => {
      dropRef.current!.acceptDroppedFiles([fileNamed("v.amr")]);
    });
    // 确认框弹出,语音尚未落地。
    expect(getByText(STRINGS.composer.voiceExclusiveTitle)).toBeTruthy();
    expect(within(container).queryByText("v.amr")).toBeNull();
    // 点「清空并选择语音」确认。
    fireEvent.click(getByText(STRINGS.composer.voiceExclusiveConfirm));
    await waitFor(() => expect(within(container).getByText("v.amr")).toBeTruthy());
  });

  it("纯语音拖入 + 有文本 + 点取消:语音不落地", async () => {
    // 预置草稿文本。
    setDraft(CONV, {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "已有文字" }] }],
    });
    const dropRef: { current: ComposerDropHandle | null } = { current: null };
    const { container, getByText } = render(
      <MessageComposer {...baseProps} conversationId={CONV} dropHandleRef={dropRef} />,
    );
    await waitFor(() => expect(dropRef.current).not.toBeNull());
    act(() => {
      dropRef.current!.acceptDroppedFiles([fileNamed("v.amr")]);
    });
    // 确认框弹出。
    expect(getByText(STRINGS.composer.voiceExclusiveTitle)).toBeTruthy();
    // 点取消。
    fireEvent.click(getByText(STRINGS.composer.voiceExclusiveCancel));
    // 确认框关闭,语音不落地。
    await waitFor(() =>
      expect(within(container).queryByText(STRINGS.composer.voiceExclusiveTitle)).toBeNull(),
    );
    expect(within(container).queryByText("v.amr")).toBeNull();
  });
});
