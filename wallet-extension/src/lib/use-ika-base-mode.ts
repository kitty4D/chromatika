import { useCallback, useEffect, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc';
import type { WalletBusEvent } from '@/lib/use-shared-bus';
import type { IkaBaseMode } from '@/background/ika-base-mode';
import { IK_BASE_MODE_STORAGE_KEY } from '@/background/ika-base-mode';
import { runChromatikaThemeFlash } from '@/lib/run-chromatika-theme-flash';
import { shouldSkipStorageDrivenThemeFlash } from '@/lib/theme-flash-storage-suppress';

type BroadcastFn = (event: WalletBusEvent) => void;

export function useIkaBaseMode(opts?: { broadcast?: BroadcastFn }) {
  const [mode, setModeState] = useState<IkaBaseMode | null>(null);
  const broadcastRef = useRef(opts?.broadcast);
  broadcastRef.current = opts?.broadcast;

  useEffect(() => {
    trpc.getIkaBaseMode
      .query()
      .then(setModeState)
      .catch(() => setModeState('sui'));
  }, []);

  useEffect(() => {
    const onStorage = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: chrome.storage.AreaName,
    ) => {
      if (area !== 'local' || !changes[IK_BASE_MODE_STORAGE_KEY]) return;
      const v = changes[IK_BASE_MODE_STORAGE_KEY].newValue;
      if (v !== 'sui' && v !== 'solana') return;
      // the local-document suppress window (2s) only skips the *flash animation*,
      // bailing out before `setModeState(v)` would leave sibling hooks (e.g. the
      // ChooseStep's `useIkaBaseMode` instance, which never called `setMode` itself)
      // permanently desynced from storage. the file comment in
      // `theme-flash-storage-suppress.ts` codifies this: "persist still sets state".
      if (shouldSkipStorageDrivenThemeFlash()) {
        setModeState(v);
        return;
      }
      void runChromatikaThemeFlash(() => setModeState(v));
    };
    chrome.storage.onChanged.addListener(onStorage);
    return () => chrome.storage.onChanged.removeListener(onStorage);
  }, []);

  const setMode = useCallback(async (m: IkaBaseMode) => {
    await trpc.setIkaBaseMode.mutate({ mode: m });
    setModeState(m);
    broadcastRef.current?.({ type: 'ika_base_mode_changed', mode: m });
  }, []);

  return {
    mode,
    setMode,
    /** false until first tRPC load completes */
    ready: mode !== null,
  };
}
