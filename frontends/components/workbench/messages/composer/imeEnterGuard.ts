// IME 回车守卫:判断一次 Enter keydown 是否是输入法候选词上屏的"提交回车"——应被吞掉,
// 不触发发送。三层防护:
//  1. isComposing —— Blink(Windows WebView2)合成期 keydown 标 true;
//  2. keyCode 229 —— WebKit/部分输入法合成期 keydown 的特殊值;
//  3. compositionend 时间窗 —— 部分输入法(如搜狗)候选上屏瞬间 isComposing 已转 false 且
//     keyCode!==229,但该 keydown 与 compositionend 几乎同刻产生。用事件自带 timeStamp
//     比较(同一时间原点),不依赖 setTimeout 的任务调度:主线程卡顿不会拉长窗口,
//     Windows 与 macOS 输入法时序差异也不影响判定。

export const COMPOSITION_COMMIT_WINDOW_MS = 100;

export function isImeCommitEnter(
  event: { isComposing: boolean; keyCode: number; timeStamp: number },
  lastCompositionEndAt: number,
): boolean {
  if (event.isComposing || event.keyCode === 229) return true;
  return event.timeStamp - lastCompositionEndAt < COMPOSITION_COMMIT_WINDOW_MS;
}
