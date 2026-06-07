// 切会话首屏遮罩「何时揭开」的逐帧判定(从 ChatArea 抽出,纯函数无副作用,供单测)。
//
// 背景:react-virtuoso 用扁平 defaultItemHeight 估高,重挂后按估高把列表定位到「估算的底部」;
// 真实行高测出后列表撑大,Virtuoso 为保持最后一条贴底会再向下滚一段 —— 这段「滚轮从上滑到下」
// 正是切会话要遮住的闪。若遮罩在估高布局这一帧就判「已贴底」而揭开,真实高度修正就暴露在用户眼前。
//
// 故揭开必须等「测量收敛」:监听 Virtuoso 的 totalListHeightChanged,每测得新总高就 bump 一个版本号;
// 本判定要求版本号连续 STABLE_FRAMES 帧不再变化(= 测量收敛,估高→真实高度的修正会刷新版本、
// 重置计数,故收敛必在修正之后)且 Scroller 真实贴底(或内容不足一屏无需滚)才揭开。帧数只在
// Scroller 已挂载且有高度时推进,避免冷会话等 IPC 期间空耗兜底额度。
//
// ⚠️「真实贴底」是所有揭开路径(含兜底)的硬前提,绝不可在非贴底状态揭开:react-virtuoso 用
// initialTopMostItemIndex 定位时会先跑一个 scrollTop:0 的渲染周期 —— 此时只渲染最后几行、但它们被
// 绝对定位浮在内容底部,视口(在顶部)看到的是上方那段空白。这一帧 atBottom/fitsNoScroll 恒 false。
// 若兜底分支无视贴底强行揭开,就会把这帧「空白 + 滚动条」露给用户(切会话闪烁的真凶)。故:
//   · 正常:测量收敛(版本稳定)+ 真实贴底/满屏 → 揭开。
//   · 兜底①(MAX_FRAMES):图片陆续加载令高度永远抖、永不收敛,但已真实贴底 → 放宽稳定要求但仍要求贴底。
//   · 兜底②(HARD_MAX_FRAMES):极端卡死(从未贴底)的绝对保险,防永久隐藏,实务中几乎不触发。

/** 高度版本连续不变达到此帧数视为测量收敛。 */
export const REVEAL_STABLE_FRAMES = 2;
/** 兜底①:已观测帧数达到此值时放宽「测量收敛」要求,但仍要求真实贴底/满屏(应对图片陆续加载令高度永抖)。 */
export const REVEAL_MAX_FRAMES = 40;
/** 兜底②:绝对保险,已观测帧数达到此值无条件揭开,防贴底信号始终缺席导致永久隐藏(极端卡死才触发)。 */
export const REVEAL_HARD_MAX_FRAMES = 180;
/** 真实贴底判定容差(像素)。 */
export const REVEAL_AT_BOTTOM_EPSILON = 4;

export interface RevealGateState {
  /** 上一帧观测到的 totalListHeightChanged 版本号;-1 表示尚未观测。 */
  lastHeightVersion: number;
  /** 高度版本连续未变化的帧数(测量收敛计数)。 */
  stableFrames: number;
  /** 已推进的观测帧数(仅 Scroller 已挂载且有高度的帧计入),用于兜底超时。 */
  frames: number;
}

export interface RevealGateInput {
  /** 当前 totalListHeightChanged 版本号(测量每变一次 +1)。 */
  heightVersion: number;
  /** Scroller 已挂载且 scrollHeight>0(已可测量)。 */
  measured: boolean;
  /** 由真实 scrollTop 判定的「已贴底」(scrollHeight - clientHeight - scrollTop ≤ 容差)。 */
  atBottom: boolean;
  /** 内容不足一屏、无需滚动(scrollHeight ≤ clientHeight + 容差)。 */
  fitsNoScroll: boolean;
}

export function initialRevealGateState(): RevealGateState {
  return { lastHeightVersion: -1, stableFrames: 0, frames: 0 };
}

/**
 * 推进一帧遮罩揭开判定。
 * @returns state 下一帧状态;reveal 是否揭开(true 后调用方即停止轮询)。
 */
export function stepRevealGate(
  prev: RevealGateState,
  input: RevealGateInput,
): { state: RevealGateState; reveal: boolean } {
  // Scroller 尚未挂载/无高度(冷会话等 IPC):不推进帧、不计稳定帧,继续轮询等其挂载。
  if (!input.measured) {
    return { state: prev, reveal: false };
  }
  const changed = input.heightVersion !== prev.lastHeightVersion;
  const stableFrames = changed ? 0 : prev.stableFrames + 1;
  const frames = prev.frames + 1;
  const settled = stableFrames >= REVEAL_STABLE_FRAMES;
  // 真实贴底(或内容不足一屏)是揭开的硬前提:scrollTop:0 渲染周期里这两者恒 false,据此挡掉
  // 「空白 + 滚动条」那一帧。兜底只放宽「测量收敛」要求,绝不放宽贴底要求(HARD_MAX 除外)。
  const atBottomOrFits = input.atBottom || input.fitsNoScroll;
  const reveal =
    (settled && atBottomOrFits) ||
    (frames >= REVEAL_MAX_FRAMES && atBottomOrFits) ||
    frames >= REVEAL_HARD_MAX_FRAMES;
  return {
    state: { lastHeightVersion: input.heightVersion, stableFrames, frames },
    reveal,
  };
}
