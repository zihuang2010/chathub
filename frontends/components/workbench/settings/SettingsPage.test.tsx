import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

// 平台开关用 getter 暴露,单测内可切换 Windows / macOS 两种渲染分支。
const platformMock = { isWindows: true, isMac: false };
vi.mock("@/lib/platform", () => ({
  get isWindows() {
    return platformMock.isWindows;
  },
  get isMac() {
    return platformMock.isMac;
  },
}));

import { invoke } from "@tauri-apps/api/core";

import {
  DEFAULT_SETTINGS,
  mergeSettings,
  useSettingsStore,
  type SettingsPatch,
} from "@/lib/data/settingsStore";

import { SettingsPage } from "./SettingsPage";

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  platformMock.isWindows = true;
  platformMock.isMac = false;
  useSettingsStore.setState({ settings: structuredClone(DEFAULT_SETTINGS), loaded: true });
  invokeMock.mockImplementation((cmd, args) => {
    switch (cmd) {
      case "update_settings": {
        const { patch } = (args ?? {}) as { patch: SettingsPatch };
        return Promise.resolve(mergeSettings(useSettingsStore.getState().settings, patch));
      }
      case "get_image_cache_usage":
        return Promise.resolve(42 * 1024 * 1024);
      case "clear_image_cache":
        return Promise.resolve(42 * 1024 * 1024);
      case "get_ai_defaults":
        return Promise.resolve({
          baseUrl: "https://default.example/v1",
          model: "qwen-flash",
          hasApiKey: true,
        });
      default:
        return Promise.resolve(null);
    }
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SettingsPage", () => {
  it("渲染四个设置分组", () => {
    render(<SettingsPage />);
    expect(screen.getByText("通知")).toBeTruthy();
    expect(screen.getByText("消息行为")).toBeTruthy();
    expect(screen.getByText("应用与存储")).toBeTruthy();
    expect(screen.getByText("高级")).toBeTruthy();
  });

  it("声音开关切换走 update_settings", async () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("switch", { name: "新消息声音提醒" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("update_settings", {
        patch: { notify: { sound: false } },
      }),
    );
  });

  it("Windows 显示任务栏闪烁项", () => {
    render(<SettingsPage />);
    expect(screen.getByText("任务栏闪烁")).toBeTruthy();
  });

  it("macOS 隐藏任务栏闪烁项", () => {
    platformMock.isWindows = false;
    platformMock.isMac = true;
    render(<SettingsPage />);
    expect(screen.queryByText("任务栏闪烁")).toBeNull();
  });

  it("高级区默认折叠,点开后显示日志级别与 AI 配置", async () => {
    render(<SettingsPage />);
    expect(screen.queryByText("日志级别")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /高级/ }));
    expect(screen.getByText("日志级别")).toBeTruthy();
    expect(screen.getByText("AI 润色")).toBeTruthy();
  });

  it("展示缓存占用并支持一键清理", async () => {
    render(<SettingsPage />);
    // mount 时拉取占用
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("get_image_cache_usage"));
    await screen.findByText(/42(\.0)? MB/);
    fireEvent.click(screen.getByRole("button", { name: "清理缓存" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("clear_image_cache"));
  });

  it("AI 模型/端点预填编译期默认值,Key 输入框恒空且提示内置 Key", async () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("button", { name: /高级/ }));
    const model = await screen.findByLabelText<HTMLInputElement>("AI 模型");
    await waitFor(() => expect(model.value).toBe("qwen-flash"));
    expect(screen.getByLabelText<HTMLInputElement>("AI 端点").value).toBe(
      "https://default.example/v1",
    );
    const key = screen.getByLabelText<HTMLInputElement>("AI API Key");
    expect(key.value).toBe("");
    expect(key.placeholder).toContain("内置");
  });

  it("只改端点保存:patch 不含 apiKey;模型等于默认回写空串(保持跟随默认)", async () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("button", { name: /高级/ }));
    const base = await screen.findByLabelText<HTMLInputElement>("AI 端点");
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLInputElement>("AI 模型").value).toBe("qwen-flash"),
    );
    fireEvent.change(base, { target: { value: "https://my.example/v1" } });
    fireEvent.click(screen.getByRole("button", { name: "保存 AI 配置" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("update_settings", {
        patch: { ai: { model: "", baseUrl: "https://my.example/v1" } },
      }),
    );
  });

  it("输入了 Key 才会进保存 patch", async () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("button", { name: /高级/ }));
    const key = await screen.findByLabelText<HTMLInputElement>("AI API Key");
    fireEvent.change(key, { target: { value: "sk-user-new-key-1234" } });
    fireEvent.click(screen.getByRole("button", { name: "保存 AI 配置" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("update_settings", {
        patch: { ai: { model: "", baseUrl: "", apiKey: "sk-user-new-key-1234" } },
      }),
    );
  });

  it("已设自定义 Key:placeholder 显示脱敏串,可一键清除回内置", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.ai.apiKey = "sk-…1234"; // 后端返回的已是脱敏串
    useSettingsStore.setState({ settings, loaded: true });
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("button", { name: /高级/ }));
    const key = await screen.findByLabelText<HTMLInputElement>("AI API Key");
    expect(key.placeholder).toContain("sk-…1234");
    fireEvent.click(screen.getByRole("button", { name: "清除自定义 Key" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("update_settings", {
        patch: { ai: { apiKey: "" } },
      }),
    );
  });

  it("关闭行为切到「直接退出」走 update_settings", async () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("radio", { name: "直接退出" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("update_settings", {
        patch: { app: { closeAction: "quit" } },
      }),
    );
  });

  it("拖拽文件发送开关:默认开,点击发 composer.dragDrop=false 的 patch", async () => {
    render(<SettingsPage />);
    const toggle = await screen.findByRole("switch", { name: "拖拽文件发送" });
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("update_settings", {
        patch: { composer: { dragDrop: false } },
      });
    });
  });
});
