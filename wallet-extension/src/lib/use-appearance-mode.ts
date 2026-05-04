import { useCallback, useEffect, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc';
import type { WalletBusEvent } from '@/lib/use-shared-bus';
import type { AppearanceMode } from '@/background/appearance-mode';
import { APPEARANCE_STORAGE_KEY } from '@/background/appearance-mode';
import { runChromatikaThemeFlash } from '@/lib/run-chromatika-theme-flash';
import { shouldSkipStorageDrivenThemeFlash } from '@/lib/theme-flash-storage-suppress';

type BroadcastFn = (event: WalletBusEvent) => void;

export function useAppearanceMode(opts?: { broadcast?: BroadcastFn }) {
  const [appearance, setAppearanceState] = useState<AppearanceMode>('dark');
  const broadcastRef = useRef(opts?.broadcast);
  broadcastRef.current = opts?.broadcast;

  useEffect(() => {
    trpc.getAppearance.query().then(setAppearanceState).catch(() => {});
  }, []);

  useEffect(() => {
    const onStorage = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: chrome.storage.AreaName,
    ) => {
      if (area !== 'local' || !changes[APPEARANCE_STORAGE_KEY]) return;
      const v = changes[APPEARANCE_STORAGE_KEY].newValue;
      if (v !== 'light' && v !== 'dark') return;
      if (shouldSkipStorageDrivenThemeFlash()) return;
      void runChromatikaThemeFlash(() => setAppearanceState(v));
    };
    chrome.storage.onChanged.addListener(onStorage);
    return () => chrome.storage.onChanged.removeListener(onStorage);
  }, []);

  const setAppearance = useCallback(async (mode: AppearanceMode) => {
    await trpc.setAppearance.mutate({ appearance: mode });
    setAppearanceState(mode);
    broadcastRef.current?.({ type: 'appearance_changed', appearance: mode });
  }, []);

  return { appearance, setAppearance };
}
