import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = { children: ReactNode };

type State = { hasError: boolean; error: unknown };

/** pull a string field off a thrown value if present, else fall back to a default. */
function readStringField(error: unknown, key: 'name' | 'message' | 'stack'): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const v = (error as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : undefined;
}

/**
 * catches render errors so a single thrown exception does not white-screen the whole popup / side panel / onboarding.
 *
 * logs `name` / `message` / `stack` separately so non-Error throwables (DOMException, plain objects)
 * don't show up as the useless `[object DOMException]` in chrome://extensions.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[chromatika] ErrorBoundary', {
      name: readStringField(error, 'name') ?? Object.prototype.toString.call(error),
      message: readStringField(error, 'message') ?? String(error),
      stack: readStringField(error, 'stack'),
      raw: error,
      componentStack: info.componentStack,
    });
  }

  private handleRetry = (): void => {
    this.setState({ hasError: false, error: null });
  };

  private handleReload = (): void => {
    try {
      chrome?.runtime?.reload?.();
    } catch {
      window.location.reload();
    }
  };

  render(): ReactNode {
    if (this.state.hasError) {
      const name = readStringField(this.state.error, 'name');
      const message = readStringField(this.state.error, 'message') ?? String(this.state.error);
      const display = name && message ? `${name}: ${message}` : name ?? message;
      return (
        <div className="sp-root sp-unlock" style={{ padding: '1.25rem', maxWidth: 420, margin: '0 auto' }}>
          <h1 style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: '0.5rem' }}>Something went wrong</h1>
          <p style={{ fontSize: '0.875rem', opacity: 0.85, marginBottom: '1rem' }}>
            The wallet UI hit an unexpected error. You can try again or reload the extension.
          </p>
          <pre
            style={{
              fontSize: '0.7rem',
              overflow: 'auto',
              padding: '0.5rem',
              borderRadius: 6,
              background: 'rgba(0,0,0,0.2)',
              marginBottom: '1rem',
              maxHeight: 120,
            }}
          >
            {display}
          </pre>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button type="button" className="sp-btn sp-btn--primary" onClick={this.handleRetry}>
              Try again
            </button>
            <button type="button" className="sp-btn" onClick={this.handleReload}>
              Reload extension
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
