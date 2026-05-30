// ImageLightbox 单元测试
// 核心功能：展示原图、Esc 关闭、点击遮罩关闭、有下载按钮

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ImageLightbox } from "./ImageLightbox";

afterEach(() => {
  cleanup();
});

describe("ImageLightbox", () => {
  it("展示原图、有下载链接", () => {
    const onClose = vi.fn();
    render(<ImageLightbox src="https://filet.jdd51.com/a.png" alt="a" onClose={onClose} />);
    // 原图展示（img alt）
    const img = screen.getByAltText("a") as HTMLImageElement;
    expect(img.src).toContain("a.png");
    // 下载按钮（aria-label 含"下载"）—— getByRole 找到则非 null
    const downloadLink = screen.getByRole("link", { name: /下载|download/i });
    expect(downloadLink).toBeTruthy();
  });

  it("按 Esc 键触发 onClose", () => {
    const onClose = vi.fn();
    render(<ImageLightbox src="https://filet.jdd51.com/b.png" alt="b" onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("点击遮罩（最外层 dialog 区域）触发 onClose", () => {
    const onClose = vi.fn();
    render(<ImageLightbox src="https://filet.jdd51.com/c.png" alt="c" onClose={onClose} />);
    // createPortal 挂到 document.body，用 screen.getByRole 查找 dialog
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeTruthy();
    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalled();
  });

  it("点击图片本身不触发 onClose（stopPropagation）", () => {
    const onClose = vi.fn();
    render(<ImageLightbox src="https://filet.jdd51.com/d.png" alt="d" onClose={onClose} />);
    const img = screen.getByAltText("d");
    fireEvent.click(img);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("灯箱有 role=dialog aria-modal=true（无障碍）", () => {
    const onClose = vi.fn();
    render(<ImageLightbox src="https://filet.jdd51.com/e.png" alt="e" onClose={onClose} />);
    // createPortal 挂到 document.body，用 screen.getByRole 查找
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });

  it("卸载后 Esc 不再触发 onClose（cleanup 监听器）", () => {
    const onClose = vi.fn();
    const { unmount } = render(
      <ImageLightbox src="https://filet.jdd51.com/f.png" alt="f" onClose={onClose} />,
    );
    unmount();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
