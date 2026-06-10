// 无选中会话时聊天区占位的回归测试:
//   切到无会话账号后,右侧不再渲染 ChatArea,但账号筛选入口(RangePill)必须常驻,
//   否则用户被困在空账号下无法切回(历史 BUG:入口随 ChatArea 一起消失 → 白屏死路)。

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Account } from "@/lib/types/account";

import { EmptyChatPane } from "./EmptyChatPane";
import { STRINGS } from "./strings";

const ACCOUNTS: readonly Account[] = [
  { id: "acc-1", name: "账号一", colorToken: 1 },
  { id: "acc-2", name: "账号二", colorToken: 2 },
];

beforeEach(() => {
  // AccountDropdown 打开时会对选中行调 scrollIntoView,jsdom 未实现 → 打桩。
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
});

function renderPane(selectedAccountId: string | null, onAccountChange = vi.fn()) {
  render(
    <EmptyChatPane
      accounts={ACCOUNTS}
      selectedAccountId={selectedAccountId}
      onAccountChange={onAccountChange}
    />,
  );
  return onAccountChange;
}

describe("EmptyChatPane(无会话占位)", () => {
  it("渲染空态文案与账号筛选入口", () => {
    renderPane("acc-2");
    expect(screen.getByText(STRINGS.conversationList.noConversation)).toBeTruthy();
    // 筛选入口(RangePill 触发器)必须存在 —— 这是空账号下唯一的"切回"通道
    expect(screen.getByLabelText(STRINGS.rangePill.selectAccount)).toBeTruthy();
  });

  it("可打开下拉并切换到其他账号", () => {
    const onAccountChange = renderPane("acc-2");
    fireEvent.click(screen.getByLabelText(STRINGS.rangePill.selectAccount));
    fireEvent.click(screen.getByRole("option", { name: "账号一" }));
    expect(onAccountChange).toHaveBeenCalledWith("acc-1");
  });

  it("可经下拉切回「全部账号」", () => {
    const onAccountChange = renderPane("acc-2");
    fireEvent.click(screen.getByLabelText(STRINGS.rangePill.selectAccount));
    fireEvent.click(
      screen.getByRole("option", { name: new RegExp(STRINGS.rangePill.allAccountsBare) }),
    );
    expect(onAccountChange).toHaveBeenCalledWith(null);
  });

  it("「清除筛选」直接回全部账号", () => {
    const onAccountChange = renderPane("acc-2");
    fireEvent.click(screen.getByText(STRINGS.rangePill.clearFilter));
    expect(onAccountChange).toHaveBeenCalledWith(null);
  });
});
