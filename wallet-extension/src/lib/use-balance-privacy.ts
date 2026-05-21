import { useCallback, useEffect, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { BALANCE_PRIVACY_STORAGE_KEY } from '@/background/balance-privacy';

export const BALANCE_MASK = '••••';

export function useBalancePrivacy() {
  const [hidden, setHiddenState] = useState(false);

  useEffect(() => {
    trpc.getBalancePrivacy.query().then(setHiddenState).catch(() => {});
  }, []);

  useEffect(() => {
    const onStorage = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: chrome.storage.AreaName,
    ) => {
      if (area !== 'local' || !changes[BALANCE_PRIVACY_STORAGE_KEY]) return;
      setHiddenState(changes[BALANCE_PRIVACY_STORAGE_KEY].newValue === true);
    };
    chrome.storage.onChanged.addListener(onStorage);
    return () => chrome.storage.onChanged.removeListener(onStorage);
  }, []);

  const toggle = useCallback(async () => {
    const next = !hidden;
    await trpc.setBalancePrivacy.mutate({ hidden: next });
    setHiddenState(next);
  }, [hidden]);

  return { hidden, toggle };
}
