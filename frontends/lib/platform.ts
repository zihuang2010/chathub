// Lightweight platform detection. The Tauri WebView's user agent reliably
// identifies the host OS, so we avoid pulling in @tauri-apps/plugin-os just
// for a synchronous boolean check.
export const isMac =
  typeof navigator !== "undefined" && /Macintosh|Mac OS X|iPhone|iPad/i.test(navigator.userAgent);

export const isWindows = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);

// Win10 与 Win11 无法从 UA 字符串区分 —— 两者都报 "Windows NT 10.0"(微软没给
// Win11 升 NT 版本)。只有 UA Client Hints 的 platformVersion 能区分:Windows 上
// major >= 13 即 Win11。Tauri 在 Windows 用 WebView2(Chromium 内核),该 API 可用;
// 不可用(非 Chromium / 旧内核)或出错时一律按非 Win11 处理(回退 Win10 取值)。
interface UADataLike {
  getHighEntropyValues?: (hints: string[]) => Promise<{ platformVersion?: string }>;
}

export async function detectWindows11(): Promise<boolean> {
  if (!isWindows) return false;
  const uaData = (navigator as Navigator & { userAgentData?: UADataLike }).userAgentData;
  if (!uaData?.getHighEntropyValues) return false;
  try {
    const { platformVersion } = await uaData.getHighEntropyValues(["platformVersion"]);
    const major = Number.parseInt((platformVersion ?? "").split(".")[0] || "0", 10);
    return major >= 13;
  } catch {
    return false;
  }
}
