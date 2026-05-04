import '@/buffer-polyfill';
import '@/lib/dev-expose-trpc';
import { createRoot } from 'react-dom/client';
import { App } from '@/ui/App';
import { ErrorBoundary } from '@/ui/components/ErrorBoundary';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>,
  );
}
