import { useCallback, useEffect, useState } from 'react';

/**
 * preference for the Send Confirm step's amount-input currency display: enter token amount
 * directly, or enter a USD amount that the wallet converts to the token at the current spot
 * price. mirrors `useSendAmountInputMode` (number vs slider) and shares the same storage +
 * sync mechanism so flips propagate across open extension pages.
 *
 * persisted in localStorage under `chromatika_send_amount_currency_v1`. default `'token'`
 * for safety - users coming from other wallets expect to type the token amount they're
 * sending, not a dollar value that might silently round to the wrong number of tokens.
 */

const STORAGE_KEY = 'chromatika_send_amount_currency_v1';

export type SendAmountCurrencyMode = 'token' | 'fiat';

const DEFAULT: SendAmountCurrencyMode = 'token';

function readMode(): SendAmountCurrencyMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'token' || raw === 'fiat') return raw;
  } catch {
    /* SSR or storage-disabled environments */
  }
  return DEFAULT;
}

export function getSendAmountCurrencyMode(): SendAmountCurrencyMode {
  return readMode();
}

export function setSendAmountCurrencyMode(mode: SendAmountCurrencyMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
    window.dispatchEvent(new CustomEvent('chromatika:send-amount-currency-mode', { detail: mode }));
  } catch {
    /* best-effort */
  }
}

export function useSendAmountCurrencyMode(): [SendAmountCurrencyMode, (m: SendAmountCurrencyMode) => void] {
  const [mode, setMode] = useState<SendAmountCurrencyMode>(readMode);

  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== STORAGE_KEY) return;
      const v = e.newValue;
      if (v === 'token' || v === 'fiat') setMode(v);
    }
    function onCustom(e: Event) {
      const detail = (e as CustomEvent<SendAmountCurrencyMode>).detail;
      if (detail === 'token' || detail === 'fiat') setMode(detail);
    }
    window.addEventListener('storage', onStorage);
    window.addEventListener('chromatika:send-amount-currency-mode', onCustom as EventListener);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('chromatika:send-amount-currency-mode', onCustom as EventListener);
    };
  }, []);

  const apply = useCallback((m: SendAmountCurrencyMode) => {
    setMode(m);
    setSendAmountCurrencyMode(m);
  }, []);

  return [mode, apply];
}
