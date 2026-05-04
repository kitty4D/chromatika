/**
 * Shared mount helper for preview entries. Wraps the screen in a debug error
 * boundary so any render-time crash surfaces inline (with stack to console)
 * instead of leaving a blank iframe with no clue what went wrong.
 *
 * Usage: `mountPreview(<MyPreview />)` from any entry tsx after side-effect
 * imports (chrome-stub, css).
 */

import { Component, type ReactElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

class PreviewBoundary extends Component<
  { children: ReactNode; label: string },
  { err: Error | null }
> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) {
    return { err };
  }
  componentDidCatch(err: Error, info: { componentStack?: string }) {
    console.error(
      `[chromatika preview ${this.props.label}] render crash:`,
      err.message,
      err.stack?.slice(0, 1200),
      info.componentStack?.slice(0, 800),
    );
  }
  render() {
    if (this.state.err) {
      return (
        <div
          style={{
            padding: 16,
            color: '#f99',
            fontFamily: 'ui-monospace, monospace',
            fontSize: 12,
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          <strong>preview render error · {this.props.label}</strong>
          {'\n'}
          {this.state.err.message}
          {'\n\n'}
          stack (first 600 chars):
          {'\n'}
          {this.state.err.stack?.slice(0, 600) ?? '(no stack)'}
        </div>
      );
    }
    return this.props.children;
  }
}

export function mountPreview(node: ReactElement, label: string): void {
  const el = document.getElementById('root');
  if (!el) {
    console.error(`[chromatika preview ${label}] #root missing in HTML shell`);
    return;
  }
  createRoot(el).render(<PreviewBoundary label={label}>{node}</PreviewBoundary>);
}
