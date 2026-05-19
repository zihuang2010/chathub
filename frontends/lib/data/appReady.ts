// appReady — module-level "首屏就绪" 信号。
//
// 用途:Splash 退场时机原本只看 (a) 自身计时 + (b) profile 已确定,导致登录态下
// MessagesPage 内的本地 cache 可能还没读出来,splash 退场后用户先看到 Skeleton,
// 再看到真组件 swap,感官上"闪一下"。
//
// 这个 module 提供一个全局单调向前的"messages ready"开关:
//   - MessagesPage 在 useRecentFriends.initialFetched=true 时调用 setMessagesReady()
//   - App 用 useMessagesReady() 订阅;splash 等待此信号后再 fade
//
// 为什么不用 Context:
//   - 仅有少量消费方(App / MessagesPage),Context 增加 boilerplate;
//   - "就绪信号"是 fire-and-forget 的单调状态,不需要 unmount 时回退;
//   - 测试时用 _resetForTests() 清状态,与 useResource 等其他 module-level singleton 风格一致。

import { useSyncExternalStore } from "react";

let messagesReady = false;
const listeners = new Set<() => void>();

/** 标记消息页首屏数据已就绪。幂等;后续调用 no-op,不再 publish 给监听者。 */
function setMessagesReady(): void {
  if (messagesReady) return;
  messagesReady = true;
  listeners.forEach((fn) => fn());
}

function isMessagesReady(): boolean {
  return messagesReady;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export const appReady = {
  setMessagesReady,
  isMessagesReady,
  subscribe,
  /** 测试用:重置全局态。生产代码不应调用。 */
  _resetForTests(): void {
    messagesReady = false;
    listeners.clear();
  },
};

/**
 * 订阅"消息页首屏就绪"信号的 React hook。
 * 仅前进,不回退:首次返回 true 后不再变 false。
 *
 * 用 useSyncExternalStore 直接挂到 module-level subscribe;
 * 比 useState+useEffect 的方案少一次 effect 同步,避免 lint
 * "set-state-in-effect" 报警,且 SSR-safe(`getServerSnapshot` 返回 false)。
 */
export function useMessagesReady(): boolean {
  return useSyncExternalStore(subscribe, isMessagesReady, () => false);
}
