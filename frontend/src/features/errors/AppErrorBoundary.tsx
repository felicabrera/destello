// Top-level boundary for render errors outside the router (providers, router itself).
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { UnexpectedError } from './UnexpectedError';

interface State {
  error: unknown;
  failed: boolean;
}

export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, failed: false };

  static getDerivedStateFromError(error: unknown): State {
    return { error, failed: true };
  }

  componentDidCatch(_error: unknown, _info: ErrorInfo): void {
    // Reporting happens in UnexpectedError and in the React root handlers (deduplicated).
  }

  reset = (): void => {
    this.setState({ error: null, failed: false });
  };

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="flex min-h-dvh flex-col bg-bg">
        <UnexpectedError error={this.state.error} onRetry={this.reset} />
      </div>
    );
  }
}
