// 发送串行队列 + AIMD 自适应调速(防「发送过快」限流 + 「同会话已有发送进行中」会话锁)。
//
// 背景:业务后台对发送有两类限制——①频率限流(过快回 HTTP 403 RATE_LIMITED "send too fast",多按账号计);
// ②会话锁(同一会话已有发送在途时拒绝并发,回「同会话已有发送进行中」)。前端连发若「按固定时间匀速发起、
// 不等上一条发完」,既可能超频,也可能同会话两条在途撞会话锁。
//
// 方案:completion-gated 串行 —— 同一车道(lane=企微账号)任意时刻至多一条发送在途,发完(成功/失败)
// 再发下一条,严格 FIFO。两个约束一并根治:一条在途 ⊇ 同会话不并发(治会话锁),且把瞬时连发摊成
// 「逐条确认」的稳定节奏(治限流)。乐观气泡仍即时显示,UX 不变(气泡先出、逐条转已发送)。
//
// 调速:AIMD(加性减、乘性增)自动学习服务端真实上限,免人工猜间隔 —— 每条发完后按当前 interval 作 gap;
// 撞限流则乘性放大 interval(退避),持续顺畅则加性缩小(提速)。无限流时 interval 收敛到 0,以网络往返为
// 唯一节奏(最快且安全)。clientMsgId 幂等去重让撞限流时可安全重试同一条(由 deliverMessage 兜底)。

export interface SendPacingConfig {
  /** 发送之间的手动 gap 下限(ms)。0 = 不强制(交给 AIMD + completion-gating)。真机/测试可调。 */
  minIntervalMs: number;
}

const DEFAULT_CONFIG: SendPacingConfig = {
  minIntervalMs: 0,
};

let config: SendPacingConfig = { ...DEFAULT_CONFIG };

// 真机调参用:debug 包 devtools 里 `localStorage.setItem("chathub:send-min-interval-ms","800")` 强制 gap
// 下限(下一条发送即生效、免重新打包);AIMD 仍可在其上叠加。设非法/空值或删除则回落 config。
const STORAGE_OVERRIDE_KEY = "chathub:send-min-interval-ms";

/** 当前生效的「手动 gap 下限」(ms):localStorage override 优先,否则用 config(默认 0)。 */
export function getEffectiveMinIntervalMs(): number {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_OVERRIDE_KEY);
    if (raw != null && raw !== "") {
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  } catch {
    // localStorage 不可用(隐私模式 / 非浏览器环境):忽略,用 config。
  }
  return config.minIntervalMs;
}

/** 覆盖节流配置(主要供测试把 gap 下限置 0)。未传字段保留原值。 */
export function setSendPacingConfig(partial: Partial<SendPacingConfig>): void {
  config = { ...config, ...partial };
}

/** 重置为默认配置并清空所有车道状态(测试 teardown 用)。 */
export function resetSendPacing(): void {
  config = { ...DEFAULT_CONFIG };
  lanes.clear();
}

// AIMD 参数:乘性增(撞限流)/ 加性减(顺畅)。interval 收敛到「刚好不触发限流」的 gap。
export const AIMD_FIRST_BUMP_MS = 200; // 首次撞限流把 gap 抬到这
export const AIMD_FACTOR = 2; // 乘性放大因子
export const AIMD_MAX_MS = 4000; // gap 上限
export const AIMD_RECOVER_MS = 100; // 每条顺畅发送加性缩小量

// 限流命中后的自动重试上限(由 deliverMessage 使用),不含首发。
export const MAX_SEND_RETRY = 3;

/** 第 attempt 次(0-based)重试前的退避时长:400 / 800 / 1600…,封顶 3s。 */
export function sendRetryBackoffMs(attempt: number): number {
  return Math.min(400 * 2 ** attempt, 3000);
}

interface LaneState {
  /** 串行链尾:下一条 await 它 → 保证一条在途 + FIFO。 */
  tail: Promise<void>;
  /** AIMD 当前 gap(ms)。 */
  intervalMs: number;
}

const lanes = new Map<string, LaneState>();

function laneState(lane: string): LaneState {
  let s = lanes.get(lane);
  if (!s) {
    s = { tail: Promise.resolve(), intervalMs: 0 };
    lanes.set(lane, s);
  }
  return s;
}

/**
 * 把一次发送(含重试)作为一个任务投入该车道的串行队列:等上一条发完再开始(一条在途、FIFO),
 * 本条完成后按当前 gap(= max(手动下限, AIMD interval))延迟放行下一条。返回任务结果(透传)。
 * gap<=0 时同步放行(不引入多余宏任务)。任务抛错不打断队列:下一条照常进行。
 */
export async function runSerialSend<T>(lane: string, task: () => Promise<T>): Promise<T> {
  const s = laneState(lane);
  const prev = s.tail;
  let release!: () => void;
  s.tail = new Promise<void>((r) => {
    release = r;
  });
  try {
    await prev;
    return await task();
  } finally {
    const gap = Math.max(getEffectiveMinIntervalMs(), s.intervalMs);
    if (gap <= 0) release();
    else setTimeout(release, gap);
  }
}

/** 记一次发送结果以 AIMD 调速:撞限流 → 乘性放大 gap;顺畅 → 加性缩小。 */
export function noteSendOutcome(lane: string, kind: "ok" | "rateLimited"): void {
  const s = laneState(lane);
  if (kind === "rateLimited") {
    s.intervalMs = Math.min(AIMD_MAX_MS, Math.max(AIMD_FIRST_BUMP_MS, s.intervalMs * AIMD_FACTOR));
  } else {
    s.intervalMs = Math.max(0, s.intervalMs - AIMD_RECOVER_MS);
  }
}

/** 读取某车道当前 AIMD gap(ms),仅供测试/诊断。 */
export function getLaneIntervalMs(lane: string): number {
  return laneState(lane).intervalMs;
}

// 限流类错误特征:HTTP 403 / errorCode=RATE_LIMITED / "send too fast" / 中文「过快」。
// \b403\b 用词边界避免误伤含 403 的更长数字(如 14030)。
const RATE_LIMIT_PATTERN = /\b403\b|RATE_LIMITED|too fast|过快/i;

/**
 * 判定发送错误是否为「限流类」可重试错误。
 * 依据:业务后台过快限流回 HTTP 403,后端把它透传为通用 Internal 错(message 含 "...http 403"),
 * 故从错误对象取原始文案(err.msg / err.message / 字符串)做特征匹配。
 */
export function isRetryableSendError(err: unknown): boolean {
  let raw = "";
  if (err && typeof err === "object") {
    const o = err as { msg?: unknown; message?: unknown };
    if (typeof o.msg === "string") raw = o.msg;
    else if (typeof o.message === "string") raw = o.message;
  } else if (typeof err === "string") {
    raw = err;
  }
  return RATE_LIMIT_PATTERN.test(raw);
}

/** 简易延时(退避重试用)。 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
