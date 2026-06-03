// 附件三入口 + 语音独占态行为回归测试。覆盖:
//  1. 三个隐藏 file input 的 accept / multiple 配置正确(图片 / 语音 / 文档)。
//  2. 选入语音文件 → 进入语音独占态(出现语音 chip、编辑器置只读、内容输入按钮禁用)。
//  3. 语音独占态下语音按钮自身禁用 → 无法再加第二条。
//  4. 移除语音 chip → 退出独占态(编辑器恢复可写、按钮恢复可用)。
//  5. 向文档 input 灌入非 DOC_EXTS 文件被拒(不产生 chip)并提示 fileFormatOnly toast。
//  6. 编辑器已有文本时点语音按钮 → 弹确认框;点「确定」后文本被清空。
//
// 范式照搬 MessageComposer.switch.test.tsx:mock Tauri / recentFriends / AiPolishPopover,
// beforeAll 里 stub Range.prototype 的矩形方法,afterEach cleanup。文案一律取 STRINGS,
// 不硬编码中文字面量。toast 额外 mock 成 vi.fn() 以便断言被调用与文案。

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
// toast mock:断言格式校验失败时被调用 + 文案。
vi.mock("@/components/ui/toast", () => ({
  showToast: vi.fn(),
}));

import { showToast } from "@/components/ui/toast";
import { MessageComposer } from "./MessageComposer";
import { STRINGS } from "./strings";
import { EMPTY_DOC, setDraft, setFileAttachments } from "./useDraftStore";

const showToastMock = vi.mocked(showToast);

const CONV = "conv-T";

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

// 三个隐藏 file input 按 accept 特征区分(实现里它们都是 type=file + class hidden,
// 无独立 testid;accept 是唯一稳定判别特征)。
function fileInputs(container: HTMLElement) {
  const all = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="file"]'));
  const image = all.find((i) => (i.accept ?? "").includes(".png"));
  const voice = all.find((i) => (i.accept ?? "").includes(".amr"));
  const doc = all.find((i) => (i.accept ?? "").includes(".pdf"));
  return { all, image, voice, doc };
}

function editableEl(container: HTMLElement): HTMLElement | null {
  // contenteditable 属性在 editable 切换时会在 "true" / "false" 间变化,
  // 故用 [contenteditable] 而非 [contenteditable="true"] 取节点。
  return container.querySelector<HTMLElement>(".ProseMirror[contenteditable]");
}

// 在 body 范围内按 aria-label 取按钮(ToolButton/确认框按钮均有 aria-label)。
function buttonByLabel(label: string): HTMLButtonElement {
  const el = document.body.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!el) throw new Error(`找不到 aria-label="${label}" 的按钮`);
  return el;
}

// 模拟语音文件选择:直接对隐藏 voice input 派发 change(jsdom 下 input.click() 不会
// 弹原生选择器,故绕过点击,直接喂文件 + 触发 onChange)。
function pickVoiceFile(voiceInput: HTMLInputElement, name: string) {
  fireEvent.change(voiceInput, { target: { files: [fileNamed(name, "audio/amr")] } });
}

// 发送按钮:默认非静音文案「发送」,静音偏好下为「静默发送」,两者皆兜底。
function sendButton(): HTMLButtonElement {
  const el =
    document.body.querySelector<HTMLButtonElement>(
      `button[aria-label="${STRINGS.composer.send}"]`,
    ) ??
    document.body.querySelector<HTMLButtonElement>(
      `button[aria-label="${STRINGS.composer.sendSilentMain}"]`,
    );
  if (!el) throw new Error("找不到发送按钮");
  return el;
}

async function renderComposer() {
  const utils = render(<MessageComposer conversationId={CONV} {...baseProps} />);
  // 等编辑器在 effect 中创建(RichComposer immediatelyRender:false)。
  await act(async () => undefined);
  return utils;
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

describe("MessageComposer 附件三入口 + 语音独占态", () => {
  it("三个隐藏 file input 的 accept / multiple 配置正确", async () => {
    const { container } = await renderComposer();
    const { image, voice, doc } = fileInputs(container);

    expect(image).toBeTruthy();
    expect(voice).toBeTruthy();
    expect(doc).toBeTruthy();

    // 图片:含 .png,不含 .amr;可多选。
    expect(image!.accept).toContain(".png");
    expect(image!.accept).not.toContain(".amr");
    expect(image!.multiple).toBe(true);

    // 语音:含 .amr,不含 .png;单选(无 multiple)。
    expect(voice!.accept).toContain(".amr");
    expect(voice!.accept).not.toContain(".png");
    expect(voice!.multiple).toBe(false);

    // 文档:含 .pdf;可多选。
    expect(doc!.accept).toContain(".pdf");
    expect(doc!.multiple).toBe(true);
  });

  it("选入语音文件 → 进入语音独占态:出现语音 chip、编辑器置只读、内容按钮禁用", async () => {
    const { container } = await renderComposer();
    const { voice } = fileInputs(container);

    await act(async () => {
      pickVoiceFile(voice!, "hello.amr");
    });

    // chip 出现:文本含文件名(FileChip 优先显示 attachment.name)。
    await waitFor(() => {
      expect(container.textContent).toContain("hello.amr");
    });
    // 兜底语义:移除附件按钮存在 = 托盘里确有一条 chip。
    expect(buttonByLabel(STRINGS.composer.removeAttachment)).toBeTruthy();

    // 编辑器置只读:contenteditable 属性变为 "false"。
    await waitFor(() => {
      const el = editableEl(container);
      expect(el).not.toBeNull();
      expect(el!.getAttribute("contenteditable")).toBe("false");
    });

    // 内容输入相关按钮禁用(图片 / 添加附件 / 语音)。
    expect(buttonByLabel(STRINGS.composer.image).disabled).toBe(true);
    expect(buttonByLabel(STRINGS.composer.addAttachment).disabled).toBe(true);
    expect(buttonByLabel(STRINGS.composer.voice).disabled).toBe(true);
  });

  it("语音独占态下语音按钮 disabled,无法再加第二条语音", async () => {
    const { container } = await renderComposer();
    const { voice } = fileInputs(container);

    await act(async () => {
      pickVoiceFile(voice!, "first.amr");
    });
    await waitFor(() => expect(container.textContent).toContain("first.amr"));

    // 语音按钮已禁用 → 用户无法触发第二次语音选择。
    expect(buttonByLabel(STRINGS.composer.voice).disabled).toBe(true);

    // 即便仍能直接对隐藏 input 派发(测试越过 UI),实现为单选替换,
    // 托盘里语音 chip 始终只有一条(removeAttachment 按钮唯一)。
    const removeButtons = document.body.querySelectorAll(
      `button[aria-label="${STRINGS.composer.removeAttachment}"]`,
    );
    expect(removeButtons.length).toBe(1);
  });

  it("移除语音 chip → 退出独占态:编辑器恢复可写、按钮恢复可用", async () => {
    const { container } = await renderComposer();
    const { voice } = fileInputs(container);

    await act(async () => {
      pickVoiceFile(voice!, "clip.amr");
    });
    await waitFor(() =>
      expect(editableEl(container)!.getAttribute("contenteditable")).toBe("false"),
    );

    // 点 chip 上的「×」(aria-label = removeAttachment)。
    await act(async () => {
      fireEvent.click(buttonByLabel(STRINGS.composer.removeAttachment));
    });

    // 编辑器恢复可写。
    await waitFor(() => {
      expect(editableEl(container)!.getAttribute("contenteditable")).toBe("true");
    });
    // 按钮恢复可用。
    expect(buttonByLabel(STRINGS.composer.image).disabled).toBe(false);
    expect(buttonByLabel(STRINGS.composer.addAttachment).disabled).toBe(false);
    expect(buttonByLabel(STRINGS.composer.voice).disabled).toBe(false);
    // chip 已移除。
    expect(
      document.body.querySelector(`button[aria-label="${STRINGS.composer.removeAttachment}"]`),
    ).toBeNull();
  });

  it("向文档 input 灌入非法格式(.png)被拒:不产生 chip 并提示 fileFormatOnly", async () => {
    const { container } = await renderComposer();
    const { doc } = fileInputs(container);

    await act(async () => {
      fireEvent.change(doc!, { target: { files: [fileNamed("photo.png", "image/png")] } });
    });

    // 非 DOC_EXTS → 被 keepByExt 过滤掉,不生成 file chip。
    expect(
      document.body.querySelector(`button[aria-label="${STRINGS.composer.removeAttachment}"]`),
    ).toBeNull();
    // 提示文案为文件格式 only。
    expect(showToastMock).toHaveBeenCalled();
    const messages = showToastMock.mock.calls.map((c) => c[0]);
    expect(messages).toContain(STRINGS.toast.fileFormatOnly);
  });

  it("发送语音后不 revoke 其 blob URL:气泡需复用该 blob 做应用内播放", async () => {
    // jsdom 的 createObjectURL 返回真实 blob: URL,但内容不可控;此处 stub 成可预期串,
    // 便于断言「这条语音的 url 没被 revoke」。
    const created: string[] = [];
    const createSpy = vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      const u = `blob:voice-${created.length}`;
      created.push(u);
      return u;
    });
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    try {
      const { container } = await renderComposer();
      const { voice } = fileInputs(container);

      await act(async () => {
        pickVoiceFile(voice!, "memo.amr");
      });
      await waitFor(() => expect(container.textContent).toContain("memo.amr"));
      const voiceUrl = created[created.length - 1];

      await act(async () => {
        fireEvent.click(sendButton());
      });
      // onSend 被触发(确认确实走了 submitDraft)。
      expect(baseProps.onSend).toHaveBeenCalled();
      // 关键断言:语音 blob 未被 revoke —— 发送后 ownership 转给 MessageBubble,
      // 点击播放时 VoiceAttachment 仍要 fetch(part.url) 复用它。
      expect(revokeSpy).not.toHaveBeenCalledWith(voiceUrl);
    } finally {
      createSpy.mockRestore();
      revokeSpy.mockRestore();
    }
  });

  it("发送文件附件后照常 revoke 其 blob URL:气泡不复用文件 blob", async () => {
    const created: string[] = [];
    const createSpy = vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      const u = `blob:file-${created.length}`;
      created.push(u);
      return u;
    });
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    try {
      const { container } = await renderComposer();
      const { doc } = fileInputs(container);

      await act(async () => {
        fireEvent.change(doc!, { target: { files: [fileNamed("report.pdf", "application/pdf")] } });
      });
      await waitFor(() => expect(container.textContent).toContain("report.pdf"));
      const fileUrl = created[created.length - 1];

      await act(async () => {
        fireEvent.click(sendButton());
      });
      expect(baseProps.onSend).toHaveBeenCalled();
      // 文件附件下载链接被 isSafeUrl(link) 拦死、气泡不复用 blob → 发送即 revoke 释放内存。
      expect(revokeSpy).toHaveBeenCalledWith(fileUrl);
    } finally {
      createSpy.mockRestore();
      revokeSpy.mockRestore();
    }
  });

  it("编辑器已有文本时点语音按钮 → 弹确认框;点「确定」后文本被清空", async () => {
    // 预置草稿文本(实现切会话/初始挂载读 store)。
    setDraft(CONV, {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "待发送文本" }] }],
    });

    const { container } = await renderComposer();

    // 初始编辑器应载入草稿文本。
    await waitFor(() => {
      expect(editableEl(container)?.textContent).toContain("待发送文本");
    });

    // 点语音按钮:此时编辑器有内容 → 弹确认框(不直接打开选择器)。
    await act(async () => {
      fireEvent.click(buttonByLabel(STRINGS.composer.voice));
    });

    // 确认框出现(含标题文案)。
    await waitFor(() => {
      expect(document.body.textContent).toContain(STRINGS.composer.voiceExclusiveTitle);
    });

    // 点「确定」(voiceExclusiveConfirm)。确认按钮无 aria-label,按文本在弹窗 dialog 内定位。
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    const confirmBtn = within(dialog!).getByText(STRINGS.composer.voiceExclusiveConfirm);

    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    // 文本被清空:编辑器内容不再包含原文本。
    await waitFor(() => {
      expect(editableEl(container)?.textContent ?? "").not.toContain("待发送文本");
    });
  });
});

// E①:hub 断线时 composer 顶部出现离线横幅、发送按钮置灰(即便有内容)。
describe("MessageComposer 离线态(E①)", () => {
  const TEXT_DOC = {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "在吗" }] }],
  };

  it("offline 时显示离线横幅,且有内容也禁用发送", async () => {
    setDraft(CONV, TEXT_DOC);
    const utils = render(<MessageComposer conversationId={CONV} {...baseProps} offline />);
    await act(async () => undefined);

    expect(utils.getByText(STRINGS.composer.offlineBanner)).toBeTruthy();
    expect(sendButton().disabled).toBe(true);
  });

  it("在线(默认)时无横幅,有内容发送按钮可用", async () => {
    setDraft(CONV, TEXT_DOC);
    const utils = render(<MessageComposer conversationId={CONV} {...baseProps} />);
    await act(async () => undefined);

    expect(utils.queryByText(STRINGS.composer.offlineBanner)).toBeNull();
    expect(sendButton().disabled).toBe(false);
  });
});
