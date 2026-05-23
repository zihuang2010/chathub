// Tauri invoke 的超时封装。
//
// 裸 invoke 在 IPC 桥卡死时会永久 pending,调用方的"防重入"标志(如 useMessageHistory
// 的 readingRef / loadingOlderRef)便永远不被 finally 复位,静默吞掉后续所有实时刷新。
// 本封装在超时后 reject,让调用方的 catch/finally 正常走到,复位标志、暴露错误。
//
// 注:底层 invoke 无法取消,后端命令仍会跑完(读命令无副作用;send 由 clientMsgId 幂等),
// 这里只解除前端的等待。

import { invoke, type InvokeArgs } from "@tauri-apps/api/core";

export class InvokeTimeoutError extends Error {
  constructor(
    public readonly command: string,
    public readonly timeoutMs: number,
  ) {
    super(`invoke("${command}") 超时(${timeoutMs}ms)`);
    this.name = "InvokeTimeoutError";
  }
}

/** 默认超时:本地缓存读 / 轻量命令足够;网络命令请显式传更长值。 */
const DEFAULT_TIMEOUT_MS = 15_000;

export function invokeWithTimeout<T>(
  command: string,
  args?: InvokeArgs,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new InvokeTimeoutError(command, timeoutMs));
    }, timeoutMs);
    invoke<T>(command, args).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
