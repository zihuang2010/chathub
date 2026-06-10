import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VideoPlayer } from "./VideoPlayer";

// 平台开关:用 getter 让每条用例可切换 Windows / 非 Windows。
const platformState = vi.hoisted(() => ({ isWindows: false }));
vi.mock("@/lib/platform", () => ({
  get isWindows() {
    return platformState.isWindows;
  },
}));

const openExternalMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/openExternal", () => ({ openExternal: openExternalMock }));
vi.mock("@/lib/downloadAttachment", () => ({ downloadAttachment: vi.fn() }));

const SRC = "https://filet.example.com/t/dev/video.mp4";

beforeEach(() => {
  platformState.isWindows = false;
  openExternalMock.mockClear();
  // jsdom 未实现 HTMLMediaElement.play(返回 undefined),组件里 .play().catch 会炸,stub 成 resolved Promise。
  window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
});

afterEach(cleanup);

/** 主播放视频 = 带 controls 的那个;氛围铺底视频无 controls。 */
function mainVideo(container: HTMLElement): HTMLVideoElement {
  const video = container.querySelector("video[controls]");
  if (!video) throw new Error("main video not found");
  return video as HTMLVideoElement;
}

describe("VideoPlayer", () => {
  it("非 Windows 渲染氛围铺底视频(共 2 个 video)", () => {
    const { container } = render(<VideoPlayer src={SRC} />);
    expect(container.querySelectorAll("video")).toHaveLength(2);
  });

  it("Windows 下不渲染氛围铺底视频(仅 1 个主 video),避免双路解码与重模糊", () => {
    platformState.isWindows = true;
    const { container } = render(<VideoPlayer src={SRC} />);
    expect(container.querySelectorAll("video")).toHaveLength(1);
    expect(mainVideo(container)).toBeTruthy();
  });

  it("主视频解码失败显示错误占位,并提供「用系统播放器打开」兜底", () => {
    const { container } = render(<VideoPlayer src={SRC} />);
    fireEvent.error(mainVideo(container));

    expect(screen.getByText("此视频无法在应用内播放")).toBeTruthy();
    // 失败的 <video> 不再渲染(白屏根因),由占位接管。
    expect(container.querySelector("video[controls]")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "用系统播放器打开" }));
    expect(openExternalMock).toHaveBeenCalledWith(SRC);
  });

  it("解码失败后下载按钮仍可用", () => {
    const { container } = render(<VideoPlayer src={SRC} />);
    fireEvent.error(mainVideo(container));
    expect(screen.getByRole("button", { name: "下载" })).toBeTruthy();
  });
});
