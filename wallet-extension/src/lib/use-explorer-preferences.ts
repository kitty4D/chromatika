import { useEffect, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { DEFAULT_EXPLORER_PREFERENCES, type ExplorerPreferences } from '@/config/explorers';

let cache: ExplorerPreferences | null = null;

/**
 * cached prefs so multiple components (header, cards, vault) do not each cold-call tRPC.
 */
export function useExplorerPreferences(): ExplorerPreferences {
  const [prefs, setPrefs] = useState<ExplorerPreferences>(() => cache ?? DEFAULT_EXPLORER_PREFERENCES);

  useEffect(() => {
    if (cache) {
      setPrefs(cache);
      return;
    }
    void trpc.getExplorerPreferences
      .query()
      .then((p) => {
        cache = p;
        setPrefs(p);
      })
      .catch(() => {});
  }, []);

  return prefs;
}
