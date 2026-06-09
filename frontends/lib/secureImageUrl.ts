/**
 * 把图片 URL 的明文 `http://` 升级为 `https://`，避免在 macOS 正式包里被「混合内容
 * (mixed content)」策略拦掉。
 *
 * 背景：macOS 正式包页面源是 `tauri://localhost`，被 WebKit 当作 secure context；在
 * secure context 下加载 `http://` 子资源会被直接拦截（CSP 即便放行 `img-src http:` 也
 * 无效——混合内容拦截是独立于 CSP 的机制）。企微/微信头像 CDN（wx.qlogo.cn、qpic.cn 等）
 * 默认下发 http:// 头像 URL，于是 Mac 正式包里头像全部加载失败、回退首字母色块。
 * Windows（页面源 `http://tauri.localhost`，非 secure）与 dev（`http://localhost`，非
 * secure）不触发混合内容拦截，故不受影响。这些头像域均支持 https，升级 scheme 即可。
 *
 * 仅替换开头的明文 `http://`；`https://`、`blob:`、`data:`、自定义协议（cachedimg://）等
 * 一律原样返回。空值返回 undefined。
 */
export function secureImageUrl(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  return url.replace(/^http:\/\//i, "https://");
}
