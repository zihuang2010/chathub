import { useEffect, useRef, useState } from "react";

interface TransientVisibility {
  /** 是否渲染该元素（含退出淡出阶段仍为 true）。 */
  rendered: boolean;
  /** 是否处于退出淡出阶段（供 data-state 切出场动画）。 */
  leaving: boolean;
}

interface Options {
  /** 一旦显示，至少停留这么久才允许进入退出（消除快加载一闪）。默认 400ms。 */
  minVisibleMs?: number;
  /** 退出淡出动画时长；这段时间后才真正卸载。默认 180ms。 */
  fadeMs?: number;
}

/**
 * 把"是否该显示"的布尔，转成带「最小展示时长 + 退出淡出」的渲染状态。
 *
 * - active 立即点亮 rendered；
 * - active 转 false：先补足 minVisibleMs（消除快加载一闪），再进入 leaving 持续
 *   fadeMs，最后卸载；
 * - 退出期间 active 再转 true：取消挂起的退出，回到常显。
 *
 * 纯计时、无数据副作用；最坏退化为"立即显隐"。
 */
export function useTransientVisibility(
  active: boolean,
  { minVisibleMs = 400, fadeMs = 180 }: Options = {},
): TransientVisibility {
  const [rendered, setRendered] = useState(active);
  const [leaving, setLeaving] = useState(false);
  const shownAtRef = useRef<number>(0);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // 显示：active 时在渲染期收敛点亮（React 官方「渲染期 setState」模式，React 丢弃当前渲染
  // 并立即重渲，条件收敛不死循环）。渲染期保持纯净，不调用 Date.now() 等不纯函数。
  if (active && !rendered) setRendered(true);
  if (active && leaving) setLeaving(false);

  // 记录"变为显示"的时刻：effect 可用不纯的 Date.now，且只写 ref、不 setState。
  useEffect(() => {
    if (active) shownAtRef.current = Date.now();
  }, [active]);

  // 隐藏：active 转 false 时排程「补足最小展示 → 淡出 → 卸载」。所有 setState 都在计时器
  // 回调里（异步，符合 react-hooks/set-state-in-effect）；effect 体内只做排程/清理。
  useEffect(() => {
    if (active || !rendered) {
      timersRef.current.forEach(clearTimeout);
      timersRef.current = [];
      return;
    }
    const elapsed = Date.now() - shownAtRef.current;
    const holdMs = Math.max(0, minVisibleMs - elapsed);
    const beginLeave = () => {
      setLeaving(true);
      timersRef.current.push(
        setTimeout(() => {
          setRendered(false);
          setLeaving(false);
        }, fadeMs),
      );
    };
    timersRef.current.push(setTimeout(beginLeave, holdMs));
    return () => {
      timersRef.current.forEach(clearTimeout);
      timersRef.current = [];
    };
  }, [active, rendered, minVisibleMs, fadeMs]);

  return { rendered, leaving };
}
