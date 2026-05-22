// ChangeBus — 全局变更订阅总线。
//
// 设计:
//   - 整个应用只有一个 `listen("hub:change")`(start() 在 App.tsx 顶层调一次)
//   - 各 useResource 通过 subscribe(topic, scope, cb) 注册;dispatch 时按 topic + scopeMatches
//     精准触发
//   - 多个 useResource 实例订阅同一 (topic, scope) 不去重 —— 各自 refetch(都自己的 setState)
//
// 不做的事:
//   - 不缓存 ChangeNotice payload(前端按需自己 refetch)
//   - 不批合并 dispatch(broadcast 单消费者,一条事件夹一条 callback,本地 refetch 自带 debounce)

import { listen } from "@tauri-apps/api/event";

import { scopeMatches, type ChangeNotice, type ChangeScope, type ChangeTopic } from "./types";

interface Listener {
  scope: ChangeScope;
  cb: (notice: ChangeNotice) => void;
}

class ChangeBus {
  private subs = new Map<ChangeTopic, Set<Listener>>();
  private started = false;
  private unlisten?: () => void;

  /**
   * 注册订阅。返回的函数调用一次即可取消(useEffect cleanup 用)。
   * 重复注册同一 cb 会自动 dedupe(Set 语义)。
   */
  subscribe(topic: ChangeTopic, scope: ChangeScope, cb: (n: ChangeNotice) => void): () => void {
    let listeners = this.subs.get(topic);
    if (!listeners) {
      listeners = new Set();
      this.subs.set(topic, listeners);
    }
    const listener: Listener = { scope, cb };
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
    };
  }

  /**
   * 启动全局 listen。幂等:重复调直接返回。在 App.tsx mount 时调一次。
   * 注意:listen 是异步注册,start() 返回后实际接收可能略晚 —— 但 ChangeNotice
   * 在用户登录之后才会被触发,正常时序里足够。
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.unlisten = await listen<ChangeNotice>("hub:change", (event) => {
      this.dispatch(event.payload);
    });
  }

  /** 测试用:重置内部 state。生产代码不要调。 */
  _resetForTest(): void {
    this.subs.clear();
    this.unlisten?.();
    this.unlisten = undefined;
    this.started = false;
  }

  /** 测试用:直接 dispatch 一条 notice(不走 Tauri listen)。 */
  _dispatchForTest(notice: ChangeNotice): void {
    this.dispatch(notice);
  }

  private dispatch(notice: ChangeNotice): void {
    const listeners = this.subs.get(notice.topic);
    if (!listeners) return;
    // 复制成数组遍历:cb 内部可能 unsubscribe 触发 Set 修改导致迭代抛错
    for (const l of Array.from(listeners)) {
      if (scopeMatches(notice.scope, l.scope)) {
        try {
          l.cb(notice);
        } catch (err) {
          // 单个 listener 抛错不应影响其他 listener
          console.error("[changeBus] listener threw", err);
        }
      }
    }
  }
}

/** 全局单例 —— 整个应用共享一个 ChangeBus。 */
export const changeBus = new ChangeBus();
