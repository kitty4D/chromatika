import { useCallback, useEffect, useState } from 'react';

/**
 * preference for the Send Confirm step's amount input: classic `number + Max button` or `slider`.
 * persisted in localStorage (per-install pref, not synced to vault) under the key
 * `chromatika_send_amount_input_v1`. mirrors the existing `chromatika_vault_total_format_v1` /
 * `useExplorerPreferences` patterns - small, sync, no tRPC roundtrip.
 */

const STORAGE_KEY = 'chromatika_send_amount_input_v1';

export type SendAmountInputMode = 'number' | 'slider';

const DEFAULT: SendAmountInputMode = 'number';

function readMode(): SendAmountInputMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'slider' || raw === 'number') return raw;
  } catch {
    /* SSR or storage-disabled environments */
  }
  return DEFAULT;
}

export function getSendAmountInputMode(): SendAmountInputMode {
  return readMode();
}

export function setSendAmountInputMode(mode: SendAmountInputMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
    window.dispatchEvent(new CustomEvent('chromatika:send-amount-input-mode', { detail: mode }));
  } catch {
    /* best-effort */
  }
}

export function useSendAmountInputMode(): [SendAmountInputMode, (m: SendAmountInputMode) => void] {
  const [mode, setMode] = useState<SendAmountInputMode>(readMode);

  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== STORAGE_KEY) return;
      const v = e.newValue;
      if (v === 'slider' || v === 'number') setMode(v);
    }
    function onCustom(e: Event) {
      const detail = (e as CustomEvent<SendAmountInputMode>).detail;
      if (detail === 'slider' || detail === 'number') setMode(detail);
    }
    window.addEventListener('storage', onStorage);
    window.addEventListener('chromatika:send-amount-input-mode', onCustom as EventListener);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('chromatika:send-amount-input-mode', onCustom as EventListener);
    };
  }, []);

  const apply = useCallback((m: SendAmountInputMode) => {
    setMode(m);
    setSendAmountInputMode(m);
  }, []);

  return [mode, apply];
}
