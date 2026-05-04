/**
 * dev only: `trpc` is not a global. in the popup or side panel DevTools console run:
 *   await __chromatikaTrpc.ikaTransportDebug.query()
 */
import { trpc } from '@/lib/trpc';

if (import.meta.env.DEV) {
  (window as unknown as { __chromatikaTrpc: typeof trpc }).__chromatikaTrpc = trpc;
}
