// 持久化编辑器回归测试:验证"切会话不重建 TipTap 编辑器"(内存修复根因)+ 切会话载入
// 正确草稿(正确性)。过去 ChatArea 用 key={conversation.id} 让 MessageComposer 整块重挂 →
// 每次切换销毁并重建整个 ProseMirror 编辑器(本 UI 单次开销最大对象,频繁切换内存锯齿上涨)。
// 现去掉 key + MessageComposer 内 layout effect 切会话 setContent;本测试钉死这一行为防回归。

import { act, cleanup, render } from "@testing-library/react";
import { Editor, type JSONContent } from "@tiptap/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Tauri / 后端边界 mock —— jsdom 无原生 Tauri;syncBackend 走 setConversationDraft。
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
  isTauri: () => false,
}));
vi.mock("@/lib/api/recentFriends", () => ({
  setConversationDraft: vi.fn(() => Promise.resolve()),
}));
// AI 润色弹层会在模块加载牵入额外依赖,与编辑器生命周期无关 → 占位 mock。
vi.mock("./composer/AiPolishPopover", () => ({
  AiPolishPopover: () => null,
}));

import { MessageComposer } from "./MessageComposer";
import { setDraft, getDraft, EMPTY_DOC } from "./useDraftStore";

function docWith(text: string): JSONContent {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}

function editableEl(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[contenteditable="true"]');
}

const baseProps = {
  height: 200,
  onHeightChange: vi.fn(),
  detailsOpen: false,
  onToggleDetails: vi.fn(),
  onSend: vi.fn(),
};

beforeAll(() => {
  // jsdom 未实现 Range.getClientRects / getBoundingClientRect;ProseMirror 在 setContent/focus
  // 后做 scrollToSelection 会调用它们。补一个空矩形 stub,避免无害的 unhandled error 噪声。
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
  // 清掉可能的跨用例草稿残留。
  setDraft("conv-A", EMPTY_DOC);
  setDraft("conv-B", EMPTY_DOC);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MessageComposer 持久化编辑器:切会话不重建", () => {
  it("切 conversationId 时复用同一编辑器实例(不销毁重建),并载入新会话草稿", async () => {
    setDraft("conv-A", docWith("草稿甲"));
    setDraft("conv-B", docWith("草稿乙"));

    const destroySpy = vi.spyOn(Editor.prototype, "destroy");

    const { container, rerender } = render(
      <MessageComposer conversationId="conv-A" {...baseProps} />,
    );
    // 等编辑器在 effect 中创建(immediatelyRender:false)。
    await act(async () => undefined);

    const elA = editableEl(container);
    expect(elA).not.toBeNull();
    expect(elA?.textContent).toContain("草稿甲");
    const destroyCallsBeforeSwitch = destroySpy.mock.calls.length;

    // 切到会话 B(无 key → 不重挂)。
    rerender(<MessageComposer conversationId="conv-B" {...baseProps} />);
    await act(async () => undefined);

    const elB = editableEl(container);
    // 关键:同一个 contenteditable DOM 节点 = 编辑器未被重建(内存修复根因)。
    expect(elB).toBe(elA);
    // 切换过程中没有发生编辑器销毁。
    expect(destroySpy.mock.calls.length).toBe(destroyCallsBeforeSwitch);
    // 正确性:载入了 B 的草稿,而非残留 A 的内容。
    expect(elB?.textContent).toContain("草稿乙");
    expect(elB?.textContent).not.toContain("草稿甲");
  });

  it("切回原会话恢复其草稿;真正卸载时才销毁编辑器", async () => {
    setDraft("conv-A", docWith("甲内容"));
    setDraft("conv-B", docWith("乙内容"));

    const destroySpy = vi.spyOn(Editor.prototype, "destroy");

    const { container, rerender, unmount } = render(
      <MessageComposer conversationId="conv-A" {...baseProps} />,
    );
    await act(async () => undefined);

    rerender(<MessageComposer conversationId="conv-B" {...baseProps} />);
    await act(async () => undefined);
    expect(editableEl(container)?.textContent).toContain("乙内容");

    rerender(<MessageComposer conversationId="conv-A" {...baseProps} />);
    await act(async () => undefined);
    expect(editableEl(container)?.textContent).toContain("甲内容");

    // 全程零销毁(都是切换,不是卸载)。
    expect(destroySpy).not.toHaveBeenCalled();

    // 真正卸载时编辑器才销毁(确认没有泄漏:卸载路径仍清理)。
    unmount();
    await act(async () => undefined);
    expect(destroySpy).toHaveBeenCalled();
  });

  it("空草稿会话切到有草稿会话:正确反映 store,不写脏数据回 store", async () => {
    setDraft("conv-A", EMPTY_DOC);
    setDraft("conv-B", docWith("乙稿"));

    const { container, rerender } = render(
      <MessageComposer conversationId="conv-A" {...baseProps} />,
    );
    await act(async () => undefined);

    rerender(<MessageComposer conversationId="conv-B" {...baseProps} />);
    await act(async () => undefined);

    expect(editableEl(container)?.textContent).toContain("乙稿");
    // setContent 不 emitUpdate → 不应把内容回写,A 仍为空草稿。
    expect(getDraft("conv-A")).toEqual(EMPTY_DOC);
  });

  // 量化证据:存活编辑器数 O(1) 而非 O(切换次数)——这才是"频繁切换内存不再单调增长"的根因证明。
  it("100 次快速切换:编辑器 DOM 节点恒为 1、destroy 零调用(旧 key 方案会是 ~100 创建/99 销毁)", async () => {
    const destroySpy = vi.spyOn(Editor.prototype, "destroy");
    const seenNodes = new Set<Element>();

    const { container, rerender } = render(
      <MessageComposer conversationId="conv-0" {...baseProps} />,
    );
    await act(async () => undefined);
    const first = editableEl(container);
    if (first) seenNodes.add(first);

    const N = 100;
    for (let i = 1; i <= N; i++) {
      rerender(<MessageComposer conversationId={`conv-${i}`} {...baseProps} />);
      await act(async () => undefined);
      const el = editableEl(container);
      if (el) seenNodes.add(el);
    }

    // 100 次切换后始终是同一个 contenteditable 节点 = 同一个 ProseMirror 实例,期间零销毁。
    // 即每次切换的编辑器分配为 0 → 截图里随切换累积的堆 churn 按构造被消除。
    expect(seenNodes.size).toBe(1);
    expect(destroySpy).not.toHaveBeenCalled();
  });

  // 同环境前后对照:在同一 React+TipTap 运行时里复现旧 key 重挂方案的"churn"(每次切换都
  // 新建+销毁一个 ProseMirror 编辑器 —— 正是截图里堆随切换攀升的来源),并证明新持久方案把它
  // 降为「全程 1 个编辑器、切换期间 0 次销毁」。这是"症状已消除"的可量化、可复跑证据。
  it("对照旧 key 重挂 vs 新持久:100 次切换的编辑器分配量(截图堆增长的根因)", async () => {
    const run = async (keyed: boolean) => {
      const destroySpy = vi.spyOn(Editor.prototype, "destroy");
      const nodes = new Set<Element>();
      const view = (i: number) =>
        keyed ? (
          <MessageComposer key={`c${i}`} conversationId={`c${i}`} {...baseProps} />
        ) : (
          <MessageComposer conversationId={`c${i}`} {...baseProps} />
        );

      const { container, rerender, unmount } = render(view(0));
      await act(async () => undefined);
      const first = editableEl(container);
      if (first) nodes.add(first);

      for (let i = 1; i <= 100; i++) {
        rerender(view(i));
        await act(async () => undefined);
        const el = editableEl(container);
        if (el) nodes.add(el);
      }
      const destroyDuringSwitch = destroySpy.mock.calls.length;
      unmount();
      await act(async () => undefined);
      destroySpy.mockRestore();
      return { distinctEditors: nodes.size, destroyDuringSwitch };
    };

    const oldWay = await run(true);
    const newWay = await run(false);

    console.log(
      `[churn] 旧key方案: 不同编辑器实例=${oldWay.distinctEditors}, 切换期间销毁=${oldWay.destroyDuringSwitch}` +
        ` | 新持久方案: 不同编辑器实例=${newWay.distinctEditors}, 切换期间销毁=${newWay.destroyDuringSwitch}`,
    );

    // 旧方案:~101 个不同编辑器 + ~100 次销毁 = 截图里随切换累积的堆 churn。
    expect(oldWay.distinctEditors).toBeGreaterThan(50);
    expect(oldWay.destroyDuringSwitch).toBeGreaterThan(50);
    // 新方案:全程同一个编辑器,切换期间零销毁 —— churn 被按构造消除。
    expect(newWay.distinctEditors).toBe(1);
    expect(newWay.destroyDuringSwitch).toBe(0);
    // 量级对照:新方案编辑器分配量至少比旧方案低 50×。
    expect(oldWay.distinctEditors).toBeGreaterThan(newWay.distinctEditors * 50);
  });

  // 真实 V8 堆趋势:gc 后测「再切 120 次」前后的 heapUsed,断言每次切换的净保留远低于
  // "驻留一个编辑器"的量级。需 --expose-gc(NODE_OPTIONS),否则跳过(上面的实例数测试已是
  // 确定性证据)。
  it("快速切换后 JS 堆不随切换次数线性增长(需 --expose-gc)", async () => {
    const gc = (globalThis as { gc?: () => void }).gc;
    if (typeof gc !== "function") return; // 无 --expose-gc:跳过精确堆测

    const { rerender } = render(<MessageComposer conversationId="warm-0" {...baseProps} />);
    await act(async () => undefined);
    for (let i = 1; i <= 30; i++) {
      rerender(<MessageComposer conversationId={`warm-${i}`} {...baseProps} />);
      await act(async () => undefined);
    }
    gc();
    const before = process.memoryUsage().heapUsed;

    const rounds = 120;
    for (let i = 1; i <= rounds; i++) {
      rerender(<MessageComposer conversationId={`m-${i}`} {...baseProps} />);
      await act(async () => undefined);
    }
    gc();
    const after = process.memoryUsage().heapUsed;

    const perSwitch = (after - before) / rounds;
    console.log(
      `[heap] ${rounds} 次切换 heapUsed Δ=${((after - before) / 1024).toFixed(1)}KB, ` +
        `每次切换≈${perSwitch.toFixed(0)}B`,
    );
    // 单个 ProseMirror 编辑器实例 + DOM 通常数十~上百 KB;持久化后每次切换的净保留应远小于此。
    expect(perSwitch).toBeLessThan(30_000); // < 30KB/switch
  });
});
