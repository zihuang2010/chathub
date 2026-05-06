import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Custom fallback. Receives the caught error and a `reset` callback. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  /** Optional callback for telemetry hooks. */
  onError?: (error: Error, info: ErrorInfo) => void;
  /** Headline shown when the default fallback renders. Caller should pass a
   *  localized string. Defaults to a neutral English label. */
  title?: string;
  /** Retry button text in the default fallback. Localize at the call site. */
  retryLabel?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

const DEFAULT_TITLE = "Something went wrong";
const DEFAULT_RETRY = "Retry";

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onError?.(error, info);
    if (typeof console !== "undefined") {
      console.error("[ErrorBoundary]", error, info.componentStack);
    }
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback) return this.props.fallback(error, this.reset);

    const title = this.props.title ?? DEFAULT_TITLE;
    const retryLabel = this.props.retryLabel ?? DEFAULT_RETRY;

    return (
      <div
        role="alert"
        aria-live="assertive"
        className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center"
      >
        <p className="text-[14px] font-medium text-workbench-text">{title}</p>
        <p className="max-w-sm text-[12px] text-workbench-text-muted">{error.message}</p>
        <button
          type="button"
          onClick={this.reset}
          className="focus-ring inline-flex h-9 items-center rounded-md bg-workbench-accent px-3 text-[12px] font-medium text-white transition-colors hover:bg-workbench-accent-hover"
        >
          {retryLabel}
        </button>
      </div>
    );
  }
}
