import { useSyncExternalStore } from "react";
import { CheckCircle2, AlertCircle, X } from "lucide-react";

import { cn } from "@/lib/utils";

// ─── Lightweight toast store ───────────────────────────────────────────────
//
// Singleton pub-sub: components call `showToast(...)` from anywhere; the
// `<ToastViewport />` mounts once at the app root and re-renders via
// `useSyncExternalStore`. No provider tree required, so callers stay decoupled.

type ToastType = "success" | "error" | "info";

interface Toast {
  id: string;
  message: string;
  type: ToastType;
}

let toasts: Toast[] = [];
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function dismiss(id: string) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export function showToast(
  message: string,
  options: { type?: ToastType; durationMs?: number } = {},
) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const toast: Toast = { id, message, type: options.type ?? "success" };
  toasts = [...toasts, toast];
  emit();
  const duration = options.durationMs ?? 3000;
  if (duration > 0) {
    window.setTimeout(() => dismiss(id), duration);
  }
  return id;
}

function useToasts(): Toast[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => toasts,
    () => toasts,
  );
}

// ─── Viewport ───────────────────────────────────────────────────────────────

export function ToastViewport({ className }: { className?: string }) {
  const list = useToasts();

  return (
    <div
      role="region"
      aria-label="通知"
      className={cn(
        "pointer-events-none fixed bottom-4 right-4 z-[1000] flex flex-col items-end gap-2",
        className,
      )}
    >
      {list.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
      ))}
    </div>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const Icon = toast.type === "error" ? AlertCircle : CheckCircle2;
  const iconColor = toast.type === "error" ? "text-workbench-danger" : "text-workbench-online";

  return (
    <div
      role={toast.type === "error" ? "alert" : "status"}
      aria-live={toast.type === "error" ? "assertive" : "polite"}
      className={cn(
        "pointer-events-auto flex min-w-[200px] max-w-sm items-center gap-2 rounded-md border border-workbench-line bg-workbench-surface px-3 py-2 shadow-wb-popover",
        "animate-in fade-in slide-in-from-bottom-2",
      )}
    >
      <Icon size={14} className={cn("shrink-0", iconColor)} aria-hidden />
      <span className="flex-1 text-[12px] leading-[1.5] text-workbench-text">{toast.message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="关闭通知"
        className="focus-ring grid size-5 shrink-0 place-items-center rounded text-workbench-text-muted transition-colors hover:bg-workbench-surface-subtle hover:text-workbench-text"
      >
        <X size={12} />
      </button>
    </div>
  );
}
