import { useEffect, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";
import { STRINGS } from "../strings";
import { streamPolish, type PolishTone } from "./aiPolishClient";

export type { PolishTone };

interface AiPolishPopoverProps {
  originalText: string;
  onApply: (newText: string) => void;
  disabled?: boolean;
  disabledReason?: string;
  /** 点「生成/重新生成」那一刻取近期对话转录(可为空串),透传给后端拼进提示词。 */
  getContext?: () => string;
}

const TONE_KEYS: PolishTone[] = ["formal", "warm", "humor", "concise"];

// 润色流的四态:空闲 / 流式中 / 完成 / 失败。
type PolishStatus = "idle" | "streaming" | "done" | "error";

type StreamHandle = ReturnType<typeof streamPolish>;

export function AiPolishPopover({
  originalText,
  onApply,
  disabled,
  disabledReason,
  getContext,
}: AiPolishPopoverProps) {
  const [open, setOpen] = useState(false);
  const [tone, setTone] = useState<PolishTone>("formal");
  const [status, setStatus] = useState<PolishStatus>("idle");
  const [preview, setPreview] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  // 保存在途流句柄,用于切语气 / 停止 / 关闭 / 卸载时取消。
  const streamRef = useRef<StreamHandle | null>(null);

  // 取消并清空在途流句柄(幂等)。
  const cancelStream = () => {
    streamRef.current?.cancel();
    streamRef.current = null;
  };

  // 组件卸载时清理在途流。
  useEffect(() => {
    return () => {
      streamRef.current?.cancel();
      streamRef.current = null;
    };
  }, []);

  // 发起一次润色(生成 / 重新生成)。重置预览与状态后开始流式。
  const startPolish = () => {
    if (!originalText) return;
    cancelStream();
    setPreview("");
    setErrorMsg("");
    setStatus("streaming");
    // 在点击那一刻取上下文,确保拿到最新消息(而非组件渲染时的旧快照)。
    const ctx = getContext?.() ?? "";
    streamRef.current = streamPolish(originalText, tone, ctx, {
      onDelta: (t) => setPreview((prev) => prev + t),
      onDone: () => setStatus("done"),
      onError: (msg) => {
        setErrorMsg(msg);
        setStatus("error");
      },
    });
  };

  // 停止:中断在途流,把已累加文本固化为 done 态(可替换或重生成)。
  const stopPolish = () => {
    cancelStream();
    setStatus("done");
  };

  // 切换语气:若正在流式,先取消并回到 idle、清空预览(保留新选 tone),不自动重发。
  const selectTone = (next: PolishTone) => {
    if (next === tone) return;
    setTone(next);
    if (status === "streaming") {
      cancelStream();
    }
    setStatus("idle");
    setPreview("");
    setErrorMsg("");
  };

  // 开/关 Popover。打开时回到干净的 idle 态(清空上一次的润色预览/错误),避免残留上条草稿
  // 的润色结果;关闭时取消在途流。打开时重置可覆盖所有关闭路径(含「替换草稿」直接 setOpen)。
  const handleOpenChange = (next: boolean) => {
    if (next) {
      setStatus("idle");
      setPreview("");
      setErrorMsg("");
    } else {
      cancelStream();
    }
    setOpen(next);
  };

  const canApply = status === "done" && preview.length > 0;
  const generateDisabled = disabled || !originalText.trim();

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          title={disabled ? disabledReason : undefined}
          className="focus-ring inline-flex h-9 items-center gap-1 rounded-md bg-workbench-surface-soft px-2.5 text-wb-2xs font-medium text-workbench-accent transition-colors hover:bg-workbench-surface-active disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Sparkles size={12} />
          <span>{STRINGS.composer.polishTitle}</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          className="z-30 w-[320px] rounded-lg border border-workbench-line bg-workbench-surface p-3 shadow-wb-popover-strong outline-none"
        >
          <div className="flex flex-col gap-3">
            <div
              role="radiogroup"
              aria-label={STRINGS.composer.polishTitle}
              className="flex flex-wrap gap-1"
            >
              {TONE_KEYS.map((k) => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={tone === k}
                  onClick={() => selectTone(k)}
                  className={cn(
                    "focus-ring text-wb-3xs h-7 rounded-full px-3 font-medium transition-colors",
                    tone === k
                      ? "bg-workbench-accent text-workbench-surface"
                      : "bg-workbench-surface-subtle text-workbench-text-secondary hover:bg-workbench-surface-active",
                  )}
                >
                  {STRINGS.composer.polishTones[k]}
                </button>
              ))}
            </div>
            <Section label={STRINGS.composer.polishOriginal}>
              <p className="line-clamp-3 text-wb-2xs font-medium text-workbench-text-muted">
                {originalText || "—"}
              </p>
            </Section>
            <Section label={STRINGS.composer.polishPreview}>
              <p
                className={cn(
                  "max-h-32 overflow-y-auto rounded-md bg-workbench-surface-subtle px-2.5 py-2 text-wb-2xs",
                  status === "error" ? "text-workbench-danger" : "text-workbench-text",
                )}
              >
                {renderPreviewBody({ status, preview, errorMsg })}
              </p>
            </Section>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => handleOpenChange(false)}
                className="focus-ring h-8 rounded-md px-3 text-wb-2xs text-workbench-text-secondary hover:bg-workbench-surface-subtle"
              >
                {STRINGS.composer.polishCancel}
              </button>
              {status === "streaming" ? (
                <button
                  type="button"
                  onClick={stopPolish}
                  className="focus-ring h-8 rounded-md bg-workbench-surface-subtle px-3 text-wb-2xs font-medium text-workbench-text-secondary transition-colors hover:bg-workbench-surface-active"
                >
                  {STRINGS.composer.polishStop}
                </button>
              ) : (
                <button
                  type="button"
                  disabled={generateDisabled}
                  onClick={startPolish}
                  className="focus-ring h-8 rounded-md bg-workbench-surface-subtle px-3 text-wb-2xs font-medium text-workbench-text-secondary transition-colors hover:bg-workbench-surface-active disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {status === "idle"
                    ? STRINGS.composer.polishGenerate
                    : STRINGS.composer.polishRegenerate}
                </button>
              )}
              <button
                type="button"
                disabled={!canApply}
                onClick={() => {
                  onApply(preview);
                  setOpen(false);
                }}
                className="focus-ring h-8 rounded-md bg-workbench-accent px-3 text-wb-2xs font-medium text-workbench-surface transition-colors hover:bg-workbench-accent-hover disabled:opacity-50"
              >
                {STRINGS.composer.polishApply}
              </button>
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// 预览区文案:按状态分支渲染。idle 占位 / streaming 实时累加 / done 完整结果 / error 错误前缀+消息。
function renderPreviewBody({
  status,
  preview,
  errorMsg,
}: {
  status: PolishStatus;
  preview: string;
  errorMsg: string;
}): string {
  if (status === "error") {
    return STRINGS.composer.polishErrorPrefix + errorMsg;
  }
  if (status === "streaming") {
    return preview || STRINGS.composer.polishGenerating;
  }
  return preview || "—";
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-wb-3xs font-medium text-workbench-text-secondary">{label}</span>
      {children}
    </div>
  );
}
