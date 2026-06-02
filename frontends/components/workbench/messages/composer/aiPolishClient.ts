// AI 润色流式客户端。Tauri 环境走真实后端命令(Channel 推流);非 Tauri 环境(web/dev/test)
// 回落到本地 mock,用定时器逐字模拟流式,保证两端交互行为一致。
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";

import { STRINGS } from "../strings";

export type PolishTone = "formal" | "warm" | "humor" | "concise";

// 与后端 serde 标签枚举形状保持一致:{ type: "delta", text } | { type: "done" } | { type: "error", message }
type PolishEvent =
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

interface PolishCallbacks {
  onDelta: (t: string) => void;
  onDone: () => void;
  onError: (msg: string) => void;
}

interface PolishHandle {
  cancel: () => void;
}

// 非 Tauri 回落:复刻原 mockPolish——给原文加「[语气label]」前缀。
function mockPolishResult(text: string, tone: PolishTone): string {
  const label = STRINGS.composer.polishTones[tone];
  return `[${label}] ${text}`;
}

// 逐字模拟流式:每个定时器吐一个字符,吐完 onDone。cancel 清定时器后不再回调。
// mock 分支忽略 context(本地回放行为不变)。
function streamPolishMock(text: string, tone: PolishTone, cb: PolishCallbacks): PolishHandle {
  const chars = Array.from(mockPolishResult(text, tone));
  let index = 0;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const step = () => {
    if (cancelled) return;
    if (index >= chars.length) {
      cb.onDone();
      return;
    }
    cb.onDelta(chars[index]);
    index += 1;
    timer = setTimeout(step, 16);
  };

  timer = setTimeout(step, 16);

  return {
    cancel: () => {
      cancelled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}

// Tauri 真实流:Channel 推流 + invoke。cancel 调后端取消命令并置标志,忽略后续回调。
// context 为前端组装的近期对话转录(可为空串),透传给后端拼进提示词模板。
function streamPolishTauri(
  text: string,
  tone: PolishTone,
  context: string,
  cb: PolishCallbacks,
): PolishHandle {
  let cancelled = false;
  const channel = new Channel<PolishEvent>();

  channel.onmessage = (event) => {
    if (cancelled) return;
    switch (event.type) {
      case "delta":
        cb.onDelta(event.text);
        break;
      case "done":
        cb.onDone();
        break;
      case "error":
        cb.onError(event.message);
        break;
    }
  };

  invoke("ai_polish", { text, tone, context, onEvent: channel }).catch((err: unknown) => {
    if (cancelled) return;
    cb.onError(err instanceof Error ? err.message : String(err));
  });

  return {
    cancel: () => {
      cancelled = true;
      // 取消失败无需向用户暴露(已停止接收回调),静默吞掉。
      void invoke("cancel_ai_polish").catch(() => {});
    },
  };
}

/**
 * 发起一次 AI 润色流。返回的 handle.cancel() 中断当前流并忽略后续回调。
 * Tauri 环境走后端命令(携带 context),否则本地 mock 逐字回放(忽略 context)。
 */
export function streamPolish(
  text: string,
  tone: PolishTone,
  context: string,
  cb: PolishCallbacks,
): PolishHandle {
  return isTauri() ? streamPolishTauri(text, tone, context, cb) : streamPolishMock(text, tone, cb);
}
