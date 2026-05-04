/**
 * optional hooks for hardware signing diagnostics (no network IO by default).
 * wire to product analytics when Chromatika ships telemetry consent.
 */

export function reportLedgerSignFailure(reason: string, context?: Record<string, string>): void {
  void context;
  if (import.meta.env?.DEV) {
    console.warn('[chromatika][ledger]', reason);
  }
}
