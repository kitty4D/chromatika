import type { BrowserClient } from '@sentry/browser';
import { getAnalyticsConsent, setAnalyticsConsent } from './consent';
import { scrubEvent, scrubBreadcrumb } from './scrub';

let sentryModule: typeof import('@sentry/browser') | null = null;

async function loadSentry(): Promise<typeof import('@sentry/browser')> {
  if (sentryModule) return sentryModule;
  sentryModule = await import('@sentry/browser');
  return sentryModule;
}

export async function maybeInitSentry(): Promise<void> {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return;

  const { errorTracking } = await getAnalyticsConsent();
  if (!errorTracking) return;

  const Sentry = await loadSentry();
  Sentry.init({
    dsn,
    release: `chromatika@${chrome.runtime.getManifest().version}`,
    environment: import.meta.env.MODE,
    sampleRate: 1.0,
    beforeSend(event) {
      return scrubEvent(event) as typeof event;
    },
    beforeBreadcrumb(breadcrumb) {
      return scrubBreadcrumb(breadcrumb) as typeof breadcrumb;
    },
    integrations: [],
    allowUrls: [/^chrome-extension:\/\//],
  });
}

export async function teardownSentry(): Promise<void> {
  if (!sentryModule) return;
  const client = sentryModule.getClient() as BrowserClient | undefined;
  if (client) await client.close(2000);
  sentryModule = null;
}

export function captureException(
  error: unknown,
  tags?: Record<string, string>,
): void {
  if (!sentryModule) return;
  sentryModule.captureException(error, tags ? { tags } : undefined);
}

export async function toggleErrorTracking(enabled: boolean): Promise<void> {
  await setAnalyticsConsent({ errorTracking: enabled });
  if (enabled) {
    await maybeInitSentry();
  } else {
    await teardownSentry();
  }
}
