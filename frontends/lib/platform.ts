// Lightweight platform detection. The Tauri WebView's user agent reliably
// identifies the host OS, so we avoid pulling in @tauri-apps/plugin-os just
// for a synchronous boolean check.
export const isMac =
  typeof navigator !== "undefined" && /Macintosh|Mac OS X|iPhone|iPad/i.test(navigator.userAgent);

export const isWindows = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
