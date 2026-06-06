import type { HubConnectionState } from "@/lib/data/useResource";

/**
 * 离线横幅的「粘滞」派生 —— 消除重连期间横幅闪烁的根因。
 *
 * 背景:hub 断线后 run_loop 退避重连,会反复 `Connecting ↔ Disconnected` 跳变。若直接把
 * disconnected 当离线、connecting 当在线,composer 顶部的离线横幅就会随每次重连尝试显隐
 * → 一闪一闪。
 *
 * 规则(带记忆,故需 prev):
 *   - disconnected / rejected → 离线(true)
 *   - subscribed             → 在线(false)
 *   - connecting / null(未知)→ 维持上一稳定态(prev)
 *
 * 这样整段重连期间保持 true 不变,只在真正订阅成功后才转 false;首次连接
 * (connecting → subscribed)从 false 起,全程不误显。
 */
export function nextOfflineSticky(prev: boolean, conn: HubConnectionState | null): boolean {
  switch (conn?.state) {
    case "disconnected":
    case "rejected":
      return true;
    case "subscribed":
      return false;
    default:
      // connecting / null:维持上一态,避免重连中途翻转造成闪烁。
      return prev;
  }
}
