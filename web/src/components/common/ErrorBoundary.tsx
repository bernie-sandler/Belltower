import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ErrorScreen } from './Status';

interface State {
  error: Error | null;
}

/**
 * Last-resort catch for render errors (including a lazy chunk that fails to load twice), so the
 * page shows a way out instead of going blank.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('Tower Tracker crashed while rendering', error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <ErrorScreen
          title="Something went wrong"
          message="Tower Tracker hit an unexpected error. Reloading usually fixes it; your saved data is safe."
          onRetry={() => window.location.reload()}
        />
      );
    }
    return this.props.children;
  }
}
