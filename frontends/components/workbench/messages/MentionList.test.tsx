import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { MentionList, type MentionListHandle } from "./MentionList";
import type { Conversation } from "./data";

afterEach(() => {
  cleanup();
});

// Minimal Conversation rows — only fields the component actually reads. Three
// items keeps wrap-around assertions unambiguous (idx 0 ↔ 2).
const CANDIDATES: Conversation[] = [
  {
    id: "a",
    name: "Alice",
    preview: "",
    account: "wechat-1",
    time: "",
    unread: 0,
    online: true,
  },
  {
    id: "b",
    name: "Bob",
    preview: "",
    account: "wechat-2",
    time: "",
    unread: 0,
    online: true,
  },
  {
    id: "c",
    name: "Carol",
    preview: "",
    account: "wechat-3",
    time: "",
    unread: 0,
    online: true,
  },
];

function press(ref: React.RefObject<MentionListHandle | null>, key: string): boolean {
  let handled = false;
  act(() => {
    handled = ref.current?.onKeyDown(new KeyboardEvent("keydown", { key })) ?? false;
  });
  return handled;
}

describe("MentionList keyboard navigation", () => {
  it("初始渲染：首行 aria-selected=true，其余为 false", () => {
    const ref = createRef<MentionListHandle>();
    render(<MentionList ref={ref} query="" candidates={CANDIDATES} onSelect={() => {}} />);

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(3);
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    expect(options[1].getAttribute("aria-selected")).toBe("false");
    expect(options[2].getAttribute("aria-selected")).toBe("false");
  });

  it("ArrowDown 推进到下一行", () => {
    const ref = createRef<MentionListHandle>();
    render(<MentionList ref={ref} query="" candidates={CANDIDATES} onSelect={() => {}} />);

    expect(press(ref, "ArrowDown")).toBe(true);

    const options = screen.getAllByRole("option");
    expect(options[0].getAttribute("aria-selected")).toBe("false");
    expect(options[1].getAttribute("aria-selected")).toBe("true");
  });

  it("ArrowDown 越过末尾时回绕到 0", () => {
    const ref = createRef<MentionListHandle>();
    render(<MentionList ref={ref} query="" candidates={CANDIDATES} onSelect={() => {}} />);

    press(ref, "ArrowDown");
    press(ref, "ArrowDown");
    press(ref, "ArrowDown");

    const options = screen.getAllByRole("option");
    expect(options[0].getAttribute("aria-selected")).toBe("true");
  });

  it("ArrowUp 从 0 回绕到末尾", () => {
    const ref = createRef<MentionListHandle>();
    render(<MentionList ref={ref} query="" candidates={CANDIDATES} onSelect={() => {}} />);

    expect(press(ref, "ArrowUp")).toBe(true);

    const options = screen.getAllByRole("option");
    expect(options[2].getAttribute("aria-selected")).toBe("true");
  });

  it("Enter 用当前选中候选触发 onSelect 并返回 true", () => {
    const onSelect = vi.fn();
    const ref = createRef<MentionListHandle>();
    render(<MentionList ref={ref} query="" candidates={CANDIDATES} onSelect={onSelect} />);

    press(ref, "ArrowDown"); // index 1 -> Bob
    expect(press(ref, "Enter")).toBe(true);
    expect(onSelect).toHaveBeenCalledWith("Bob");
  });

  it("Tab 提交当前选中并返回 true", () => {
    const onSelect = vi.fn();
    const ref = createRef<MentionListHandle>();
    render(<MentionList ref={ref} query="" candidates={CANDIDATES} onSelect={onSelect} />);

    expect(press(ref, "Tab")).toBe(true);
    expect(onSelect).toHaveBeenCalledWith("Alice");
  });

  it("其他按键返回 false 让编辑器继续处理", () => {
    const ref = createRef<MentionListHandle>();
    render(<MentionList ref={ref} query="" candidates={CANDIDATES} onSelect={() => {}} />);

    expect(press(ref, "a")).toBe(false);
  });

  it("query 变更时 selectedIndex 重置回 0", () => {
    const ref = createRef<MentionListHandle>();
    const { rerender } = render(
      <MentionList ref={ref} query="" candidates={CANDIDATES} onSelect={() => {}} />,
    );

    press(ref, "ArrowDown");
    press(ref, "ArrowDown");
    expect(screen.getAllByRole("option")[2].getAttribute("aria-selected")).toBe("true");

    rerender(<MentionList ref={ref} query="b" candidates={CANDIDATES} onSelect={() => {}} />);

    // After filter, only Bob matches. Selection resets to 0 i.e. that single row.
    const options = screen.getAllByRole("option");
    expect(options[0].getAttribute("aria-selected")).toBe("true");
  });

  it("点击行依旧通过 onSelect 提交（保留旧行为）", () => {
    const onSelect = vi.fn();
    const ref = createRef<MentionListHandle>();
    render(<MentionList ref={ref} query="" candidates={CANDIDATES} onSelect={onSelect} />);

    fireEvent.click(screen.getByRole("option", { name: /Carol/ }));
    expect(onSelect).toHaveBeenCalledWith("Carol");
  });
});
