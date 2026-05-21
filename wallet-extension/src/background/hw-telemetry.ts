import { captureException } from '@/background/analytics/sentry';

export function reportLedgerSignFailure(
  reason: string,
  context?: Record<string, string>,
): void {
  if (import.meta.env?.DEV) {
    console.warn('[chromatika][ledger]', reason);
  }
  captureException(new Error(`Ledger sign failure: ${reason}`), {
    feature: 'hardware',
    chain: context?.chain ?? 'unknown',
    ...context,
  });
}
