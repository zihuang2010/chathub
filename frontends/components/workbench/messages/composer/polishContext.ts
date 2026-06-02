// AI 润色「关联对话上下文」转录器:把本会话最近若干条消息压成纯文本转录,交给后端拼进
// 提示词模板(前端只产出转录,不加【对话背景】/【待润色草稿】等标签)。
import type { Message } from "../data";
import { desensitize } from "./desensitize";

// 最近多少条参与转录(数组尾部 N 条)。
const MAX_MESSAGES = 10;
// 转录总长度上限(字符数);超出从最旧行开始丢弃,保留最近对话。
const MAX_CHARS = 1500;
// 时间窗(毫秒):只回看最近 2 小时;sentAt 距 now 超过此值的消息整条丢弃,
// 避免把昨天等久远、与当前草稿无关的对话带进润色背景。
const WINDOW_MS = 2 * 60 * 60 * 1000;

// 非文本消息按首个 part 的 kind 取占位文案;无可识别 part → [非文本消息]。
// 注:消息真实结构走 `parts`(判别联合,按 kind 区分),取值集合与 MessageAttachment.type 一致。
const PLACEHOLDER: Record<string, string> = {
  image: "[图片]",
  file: "[文件]",
  voice: "[语音]",
  video: "[视频]",
};

// sentAt 是否落在 now 往前 WINDOW_MS 的时间窗内(含边界)。
// 解析失败(NaN)按超窗处理(返回 false),宁可少带也不带脏数据。
function isWithinWindow(sentAt: string, now: number): boolean {
  const t = Date.parse(sentAt);
  if (Number.isNaN(t)) return false;
  return now - t <= WINDOW_MS;
}

// 取单条消息的转录内容:文本非空(trim 后)用文本(并脱敏),否则按首个非文本 part 取占位。
// 脱敏只作用于背景转录(只读语境),草稿走另一路径不脱敏。
function contentOf(msg: Message): string {
  const text = msg.text.trim();
  if (text) return desensitize(text);
  const firstPart = msg.parts.find((p) => p.kind !== "text");
  if (firstPart) return PLACEHOLDER[firstPart.kind] ?? "[非文本消息]";
  return "[非文本消息]";
}

/**
 * 把会话消息数组压成「关联对话上下文」转录(旧→新,每条一行)。
 * - 过滤撤回消息(isRecalled)。
 * - 过滤时间窗外消息:sentAt 距 now 超过 WINDOW_MS(2 小时)的整条丢弃。
 * - 取最近 MAX_MESSAGES 条,保持时间顺序。
 * - 行格式:in→「客户：内容」、out→「客服：内容」。
 * - 文本内容经 desensitize 脱敏(手机号/身份证/银行卡/邮箱→占位),降低隐私外泄。
 * - 总长度超 MAX_CHARS 时,从最旧行起逐行丢弃,直到 ≤ 上限。
 * - 无可用消息 → 返回空串。
 *
 * @param now 当前时间戳(毫秒);默认 Date.now(),测试时注入固定值以保持纯函数可测。
 */
export function buildPolishContext(messages: Message[], now: number = Date.now()): string {
  const usable = messages.filter((m) => !m.isRecalled && isWithinWindow(m.sentAt, now));
  const recent = usable.slice(-MAX_MESSAGES);

  const lines = recent.map((m) => {
    const role = m.direction === "in" ? "客户" : "客服";
    return `${role}：${contentOf(m)}`;
  });

  // 长度门控:从最旧行开始丢弃,直到拼接结果 ≤ 上限。
  while (lines.length > 0 && lines.join("\n").length > MAX_CHARS) {
    lines.shift();
  }

  return lines.join("\n");
}
