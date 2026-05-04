import '@/buffer-polyfill';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { OnboardingPage } from '@/onboarding/OnboardingPage';
import { ErrorBoundary } from '@/ui/components/ErrorBoundary';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary>
        <OnboardingPage />
      </ErrorBoundary>
    </StrictMode>,
  );
}
