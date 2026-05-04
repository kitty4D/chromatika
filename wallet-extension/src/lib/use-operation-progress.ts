/**
 * UI subscription to the background's operation-progress channel
 * (`@/background/progress/operation-progress`). reads the current entry from
 * `chrome.storage.session` on mount, then subscribes to `chrome.storage.onChanged` so the
 * banner updates synchronously across popup + side panel + open extension pages.
 */

import { useEffect, useState } from 'react';
import {
  OPERATION_PROGRESS_STORAGE_KEY,
  type OperationProgress,
} from '@/background/progress/operation-progress';

export function useOperationProgress(): OperationProgress | null {
  const [progress, setProgress] = useState<OperationProgress | null>(null);

  useEffect(() => {
    let cancelled = false;
    chrome.storage.session.get(OPERATION_PROGRESS_STORAGE_KEY).then((r) => {
      if (cancelled) return;
      const v = r?.[OPERATION_PROGRESS_STORAGE_KEY];
      setProgress((v ?? null) as OperationProgress | null);
    }).catch(() => { /* session storage unavailable - silent fallback */ });

    const onStorage = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: chrome.storage.AreaName,
    ) => {
      if (area !== 'session') return;
      const change = changes[OPERATION_PROGRESS_STORAGE_KEY];
      if (!change) return;
      const next = (change.newValue ?? null) as OperationProgress | null;
      setProgress(next);
    };
    chrome.storage.onChanged.addListener(onStorage);
    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(onStorage);
    };
  }, []);

  return progress;
}
