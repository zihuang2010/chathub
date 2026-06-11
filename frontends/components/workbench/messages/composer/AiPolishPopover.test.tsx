// AiPolishPopover 交互回归:mock 掉 aiPolishClient.streamPolish,手动触发 onDelta/onDone/onError、
// 记录 cancel 调用,验证状态机驱动的预览渲染与按钮切换。
// 注:项目未引入 @testing-library/user-event(现有测试统一用 fireEvent),此处沿用 fireEvent。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { STRINGS } from "../strings";

// streamPolish 的回调容器:测试里手动驱动,模拟流式事件。
type PolishCallbacks = {
  onDelta: (t: string) => void;
  onDone: () => void;
  onError: (msg: string) => void;
};

let lastCallbacks: PolishCallbacks | null = null;
const cancelSpy = vi.fn();
const streamPolishMock = vi.fn(
  (_text: string, _tone: string, _context: string, cb: PolishCallbacks) => {
    lastCallbacks = cb;
    return { cancel: cancelSpy };
  },
);

vi.mock("./aiPolishClient", () => ({
  streamPolish: (text: string, tone: string, context: string, cb: PolishCallbacks) =>
    streamPolishMock(text, tone, context, cb),
}));

import { DEFAULT_SETTINGS, useSettingsStore } from "@/lib/data/settingsStore";

import { AiPolishPopover } from "./AiPolishPopover";

const C = STRINGS.composer;

/** 设置 AI 润色开关(其余设置保持默认)。 */
function setAiEnabled(enabled: boolean) {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.ai.enabled = enabled;
  useSettingsStore.setState({ settings, loaded: true });
}

function openPopover(originalText = "原始草稿", getContext?: () => string) {
  const onApply = vi.fn();
  render(<AiPolishPopover originalText={originalText} onApply={onApply} getContext={getContext} />);
  // 点触发按钮(AI 润色)打开 Popover。
  fireEvent.click(screen.getByText(C.polishTitle));
  return { onApply };
}

beforeEach(() => {
  lastCallbacks = null;
  cancelSpy.mockClear();
  streamPolishMock.mockClear();
  useSettingsStore.setState({ settings: structuredClone(DEFAULT_SETTINGS), loaded: true });
});

afterEach(() => {
  cleanup();
});

describe("AiPolishPopover", () => {
  it("点「生成」→ 调 streamPolish、delta 累加进预览、onDone 后「替换草稿」可点并回传完整文本", () => {
    const { onApply } = openPopover("你好");

    // 初始 idle:按钮为「生成」。
    const generateBtn = screen.getByText(C.polishGenerate);
    fireEvent.click(generateBtn);

    // streamPolish 被调用,且拿到 originalText / tone(默认 formal)/ context(无 getContext → "")。
    expect(streamPolishMock).toHaveBeenCalledTimes(1);
    expect(streamPolishMock).toHaveBeenCalledWith("你好", "formal", "", expect.anything());
    expect(lastCallbacks).not.toBeNull();

    // 流式累加两段 delta。
    act(() => {
      lastCallbacks!.onDelta("[正式] ");
      lastCallbacks!.onDelta("你好");
    });
    expect(screen.getByText("[正式] 你好")).toBeTruthy();

    // 完成前「替换草稿」不可点。
    const applyBtn = screen.getByText(C.polishApply) as HTMLButtonElement;
    expect(applyBtn.disabled).toBe(true);

    // onDone → done 态,「替换草稿」可点。
    act(() => {
      lastCallbacks!.onDone();
    });
    expect(applyBtn.disabled).toBe(false);
    // 生成按钮文案变为「重新生成」。
    expect(screen.getByText(C.polishRegenerate)).toBeTruthy();

    // 点「替换草稿」回传完整预览文本。
    fireEvent.click(applyBtn);
    expect(onApply).toHaveBeenCalledWith("[正式] 你好");
  });

  it("点「生成」时取 getContext() 并作为第三实参传给 streamPolish", () => {
    openPopover("你好", () => "客户：在吗");
    fireEvent.click(screen.getByText(C.polishGenerate));

    expect(streamPolishMock).toHaveBeenCalledTimes(1);
    expect(streamPolishMock).toHaveBeenCalledWith(
      "你好",
      "formal",
      "客户：在吗",
      expect.anything(),
    );
  });

  it("onError → 显示错误前缀+消息,按钮变「重新生成」", () => {
    openPopover();
    fireEvent.click(screen.getByText(C.polishGenerate));

    act(() => {
      lastCallbacks!.onError("网络异常");
    });

    expect(screen.getByText(C.polishErrorPrefix + "网络异常")).toBeTruthy();
    expect(screen.getByText(C.polishRegenerate)).toBeTruthy();
    // 错误态下「替换草稿」不可点。
    expect((screen.getByText(C.polishApply) as HTMLButtonElement).disabled).toBe(true);
  });

  it("点「停止」→ 调 cancel() 并回到可重生成态", () => {
    openPopover();
    fireEvent.click(screen.getByText(C.polishGenerate));

    // streaming 态:按钮为「停止」。
    act(() => {
      lastCallbacks!.onDelta("半截");
    });
    const stopBtn = screen.getByText(C.polishStop);
    fireEvent.click(stopBtn);

    expect(cancelSpy).toHaveBeenCalledTimes(1);
    // 停止后固化为 done 态:出现「重新生成」,已累加文本保留。
    expect(screen.getByText(C.polishRegenerate)).toBeTruthy();
    expect(screen.getByText("半截")).toBeTruthy();
  });

  it("流式中切换语气 → 调 cancel() 并清空预览回到 idle", () => {
    openPopover();
    fireEvent.click(screen.getByText(C.polishGenerate));
    act(() => {
      lastCallbacks!.onDelta("已生成内容");
    });

    // 切到「亲切」语气(role=radio,aria-checked 区分)。
    fireEvent.click(screen.getByText(C.polishTones.warm));

    expect(cancelSpy).toHaveBeenCalledTimes(1);
    // 回到 idle:按钮变回「生成」,预览清空(已生成内容消失)。
    expect(screen.getByText(C.polishGenerate)).toBeTruthy();
    expect(screen.queryByText("已生成内容")).toBeNull();
  });
});

describe("AiPolishPopover —— 设置开关门控", () => {
  it("设置里关闭 AI 润色 → 触发按钮置灰禁点(带提示),点击不打开弹层", () => {
    setAiEnabled(false);
    render(<AiPolishPopover originalText="你好" onApply={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: new RegExp(C.polishTitle) });
    expect((trigger as HTMLButtonElement).disabled).toBe(true);
    expect(trigger.getAttribute("title")).toContain("设置");
    fireEvent.click(trigger);
    expect(screen.queryByText(C.polishGenerate)).toBeNull();
  });

  it("开关开启 + 有文本 → 按钮可点", () => {
    setAiEnabled(true);
    render(<AiPolishPopover originalText="你好" onApply={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: new RegExp(C.polishTitle) });
    expect((trigger as HTMLButtonElement).disabled).toBe(false);
  });

  it("开关开启但外部 disabled(空文本)仍禁点,沿用外部提示", () => {
    setAiEnabled(true);
    render(
      <AiPolishPopover
        originalText=""
        onApply={vi.fn()}
        disabled
        disabledReason={C.aiPolishEmptyHint}
      />,
    );
    const trigger = screen.getByRole("button", { name: new RegExp(C.polishTitle) });
    expect((trigger as HTMLButtonElement).disabled).toBe(true);
    expect(trigger.getAttribute("title")).toBe(C.aiPolishEmptyHint);
  });
});
