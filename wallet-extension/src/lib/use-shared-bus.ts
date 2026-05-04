/**
 * useSharedBus, connects this UI surface to the SharedWorker broadcast bus.
 * use broadcast() to emit events; subscribe via onMessage callback.
 * popup and side panel both use this to stay in sync without polling.
 */

import { useEffect, useRef, useCallback } from 'react';

export type WalletBusEvent =
  | { type: 'balances_updated' }
  | { type: 'network_changed'; chainId: number }
  | { type: 'prices_updated'; prices: Record<string, number | null> }
  | { type: 'account_changed' }
  | { type: 'ika_base_mode_changed'; mode: 'sui' | 'solana' }
  | { type: 'appearance_changed'; appearance: 'light' | 'dark' }
  | { type: 'ping' };

type Handler = (e: WalletBusEvent) => void;

export function useSharedBus(onMessage?: Handler) {
  const workerRef = useRef<SharedWorker | null>(null);
  const handlerRef = useRef<Handler | undefined>(onMessage);
  handlerRef.current = onMessage;

  useEffect(() => {
    try {
      const worker = new SharedWorker(
        new URL('@/shared/wallet-state-worker.ts', import.meta.url),
        { type: 'module', name: 'chromatika-state' },
      );
      workerRef.current = worker;
      worker.port.onmessage = (e: MessageEvent<WalletBusEvent>) => {
        if (e.data?.type === 'ping') return;
        handlerRef.current?.(e.data);
      };
      worker.port.start();
      return () => { worker.port.close(); };
    } catch {
      // SharedWorker not available (e.g. incognito in some configurations), silent fallback
    }
  }, []);

  const broadcast = useCallback((event: WalletBusEvent) => {
    try { workerRef.current?.port.postMessage(event); } catch { /* noop */ }
  }, []);

  return { broadcast };
}
