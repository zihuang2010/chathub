import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import { invoke } from "@tauri-apps/api/core";

import {
  DEFAULT_SETTINGS,
  LEGACY_COMPOSER_PREFS_KEY,
  mergeSettings,
  useSettingsStore,
  type UserSettings,
} from "./settingsStore";

const invokeMock = vi.mocked(invoke);

function makeSettings(over: (s: UserSettings) => void): UserSettings {
  const s = structuredClone(DEFAULT_SETTINGS);
  over(s);
  return s;
}

beforeEach(() => {
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS, loaded: false });
  window.localStorage.clear();
  invokeMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mergeSettings 深合并", () => {
  it("partial patch 只覆盖给到的叶子,其余保持", () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, { notify: { sound: false } });
    expect(merged.notify.sound).toBe(false);
    expect(merged.notify.trayFlash).toBe(true);
    expect(merged.app.closeAction).toBe("tray");
  });

  it("不改入参(纯函数)", () => {
    const base = structuredClone(DEFAULT_SETTINGS);
    mergeSettings(base, { composer: { silent: true } });
    expect(base.composer.silent).toBe(false);
  });

  it("composer.dragDrop 默认开,patch 可关且不影响兄弟字段", () => {
    expect(DEFAULT_SETTINGS.composer.dragDrop).toBe(true);
    const merged = mergeSettings(DEFAULT_SETTINGS, { composer: { dragDrop: false } });
    expect(merged.composer.dragDrop).toBe(false);
    expect(merged.composer.silent).toBe(DEFAULT_SETTINGS.composer.silent);
    expect(merged.composer.jumpToNext).toBe(DEFAULT_SETTINGS.composer.jumpToNext);
  });
});

describe("load 登录回填", () => {
  it("get_settings 返回值整体替换 store 并置 loaded", async () => {
    const remote = makeSettings((s) => {
      s.notify.sound = false;
      s.net.silenceTimeoutSecs = 60;
    });
    invokeMock.mockResolvedValueOnce(remote);
    await useSettingsStore.getState().load();
    expect(invokeMock).toHaveBeenCalledWith("get_settings");
    expect(useSettingsStore.getState().settings.notify.sound).toBe(false);
    expect(useSettingsStore.getState().settings.net.silenceTimeoutSecs).toBe(60);
    expect(useSettingsStore.getState().loaded).toBe(true);
  });

  it("get_settings 失败保持默认值且不置 loaded", async () => {
    invokeMock.mockRejectedValueOnce(new Error("boom"));
    await useSettingsStore.getState().load();
    expect(useSettingsStore.getState().settings).toEqual(DEFAULT_SETTINGS);
    expect(useSettingsStore.getState().loaded).toBe(false);
  });

  it("旧 localStorage composer 偏好一次性迁移:patch 后端并删除旧键", async () => {
    window.localStorage.setItem(
      LEGACY_COMPOSER_PREFS_KEY,
      JSON.stringify({ silent: true, jumpToNext: true }),
    );
    invokeMock.mockResolvedValueOnce(structuredClone(DEFAULT_SETTINGS)); // get_settings
    invokeMock.mockResolvedValueOnce(
      makeSettings((s) => {
        s.composer.silent = true;
        s.composer.jumpToNext = true;
      }),
    ); // update_settings
    await useSettingsStore.getState().load();
    expect(invokeMock).toHaveBeenCalledWith("update_settings", {
      patch: { composer: { silent: true, jumpToNext: true } },
    });
    expect(window.localStorage.getItem(LEGACY_COMPOSER_PREFS_KEY)).toBeNull();
    expect(useSettingsStore.getState().settings.composer.silent).toBe(true);
  });

  it("无旧键时不触发迁移 update", async () => {
    invokeMock.mockResolvedValueOnce(structuredClone(DEFAULT_SETTINGS));
    await useSettingsStore.getState().load();
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});

describe("update 乐观更新", () => {
  it("立即生效,成功后采用后端返回值", async () => {
    const merged = makeSettings((s) => {
      s.notify.sound = false;
    });
    let resolveInvoke: (v: unknown) => void = () => {};
    invokeMock.mockImplementationOnce(() => new Promise((resolve) => (resolveInvoke = resolve)));
    const done = useSettingsStore.getState().update({ notify: { sound: false } });
    // 乐观:invoke 未返回前 UI 已生效
    expect(useSettingsStore.getState().settings.notify.sound).toBe(false);
    resolveInvoke(merged);
    await expect(done).resolves.toBe(true);
    expect(useSettingsStore.getState().settings.notify.sound).toBe(false);
  });

  it("失败回滚到改动前", async () => {
    invokeMock.mockRejectedValueOnce(new Error("write failed"));
    const ok = await useSettingsStore.getState().update({ composer: { silent: true } });
    expect(ok).toBe(false);
    expect(useSettingsStore.getState().settings.composer.silent).toBe(false);
  });
});

describe("reset / applyExternal", () => {
  it("reset 回默认值并清 loaded(登出/切账号)", () => {
    useSettingsStore.setState({
      settings: makeSettings((s) => {
        s.notify.sound = false;
      }),
      loaded: true,
    });
    useSettingsStore.getState().reset();
    expect(useSettingsStore.getState().settings).toEqual(DEFAULT_SETTINGS);
    expect(useSettingsStore.getState().loaded).toBe(false);
  });

  it("applyExternal 整体替换(settings:changed 多窗口同步)", () => {
    const next = makeSettings((s) => {
      s.log.level = "verbose";
    });
    useSettingsStore.getState().applyExternal(next);
    expect(useSettingsStore.getState().settings.log.level).toBe("verbose");
    expect(useSettingsStore.getState().loaded).toBe(true);
  });
});
