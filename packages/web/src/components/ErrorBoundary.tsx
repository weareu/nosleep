/**
 * Per-route error boundary. Wraps the brain/admin page outlet so a single
 * page crash doesn't kill the dashboard shell. The shell's nav, picker, and
 * other tabs stay responsive; the user sees a recoverable error card.
 */

import { Component, Fragment, type ReactNode, type ErrorInfo } from "react";

/**
 * Trivial keyed wrapper used by ErrorBoundary.reset to force a full
 * subtree remount on retry. Bumps the `key` on the element so React
 * discards the cached lazy-import promise rejections.
 */
function KeyedSubtree({ children }: { children: ReactNode }): ReactNode {
  return <Fragment>{children}</Fragment>;
}

interface State {
  hasError: boolean;
  error: Error | null;
  /**
   * Bumped on each retry. Used as a `key` on the wrapped children so
   * `React.lazy` and other promise-cached resources are forced to
   * re-create instead of replaying the cached rejection.
   */
  retryKey: number;
}

interface Props {
  children: ReactNode;
  /** Override the default fallback UI. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  /** Optional name shown in the error card so users know which surface broke. */
  scope?: string;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null, retryKey: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error(
      `[ErrorBoundary${this.props.scope ? ` · ${this.props.scope}` : ""}]`,
      error,
      info.componentStack,
    );
  }

  reset = (): void => {
    // Bump retryKey so any `lazy()` children below are forced to remount,
    // bypassing React's cached rejected import promise.
    this.setState((s) => ({
      hasError: false,
      error: null,
      retryKey: s.retryKey + 1,
    }));
  };

  hardReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (!this.state.hasError || !this.state.error) {
      // Keyed Fragment forces a full remount of the subtree on retry,
      // bypassing React's lazy() cached rejection promise.
      return <KeyedSubtree key={this.state.retryKey}>{this.props.children}</KeyedSubtree>;
    }
    if (this.props.fallback) {
      return this.props.fallback(this.state.error, this.reset);
    }
    return (
      <div className="m-6 p-5 bg-red-950/30 border border-red-900 rounded-lg text-slate-200 max-w-2xl">
        <h2 className="text-lg font-semibold text-red-300 mb-1">
          Something broke{this.props.scope ? ` in ${this.props.scope}` : ""}
        </h2>
        <p className="text-sm text-slate-400 mb-3">
          The rest of the dashboard is still working — pick another tab or
          retry this page.
        </p>
        <pre className="bg-slate-950 border border-slate-800 rounded p-3 text-xs text-red-200 overflow-x-auto whitespace-pre-wrap break-words mb-3 max-h-48">
          {this.state.error.message}
          {this.state.error.stack ? `\n\n${this.state.error.stack}` : ""}
        </pre>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={this.reset}
            className="px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-sm"
          >
            Retry
          </button>
          <button
            type="button"
            onClick={this.hardReload}
            className="px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-sm text-slate-400"
            title="Use this if Retry doesn't work — a stale bundle or post-deploy chunk-load error needs a full page reload."
          >
            Hard reload
          </button>
        </div>
      </div>
    );
  }
}
