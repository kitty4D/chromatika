import { useEffect, useState } from 'react';
import { trpc } from '@/lib/trpc';
import {
  vaultTotalCacheKey,
  parseStoredWireSnapshot,
  type VaultTotalSnapshot,
} from '@/background/services/vault-total-cache';

/** how often the hook re-polls the tRPC procedure. matches the existing
 *  `VaultTotalLine` cadence so the BTTF circuits and any other consumer don't
 *  hammer the SW twice per minute. */
const POLL_MS = 60_000;

/**
 * shared snapshot subscription for the vault USD total. one tRPC poller +
 * one chrome.storage.onChanged listener per active vault, regardless of how
 * many components mount.
 *
 * returns the current snapshot, a `pending` flag for the in-flight fetch,
 * and a `refresh()` you can call from a user action (eg a manual refresh
 * button) to force a re-poll outside the 60s tick.
 */
export function useVaultTotalSnapshot(vaultId: string | null): {
  snap: VaultTotalSnapshot | null;
  pending: boolean;
  refresh: () => void;
} {
  const [snap, setSnap] = useState<VaultTotalSnapshot | null>(null);
  const [pending, setPending] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    if (!vaultId) {
      setSnap(null);
      return;
    }
    let cancelled = false;
    const run = async () => {
      setPending(true);
      try {
        const got = await trpc.getVaultTotal.query({ vaultId });
        if (!cancelled) setSnap(got);
      } catch {
        if (!cancelled) setSnap(null);
      } finally {
        if (!cancelled) setPending(false);
      }
    };
    void run();
    const t = window.setInterval(() => void run(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [vaultId, refreshNonce]);

  useEffect(() => {
    if (!vaultId) return;
    const key = vaultTotalCacheKey(vaultId);
    const handler = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'session') return;
      if (!(key in changes)) return;
      const next = parseStoredWireSnapshot(changes[key].newValue);
      if (next) setSnap(next);
    };
    chrome.storage.onChanged.addListener(handler);
    return () => chrome.storage.onChanged.removeListener(handler);
  }, [vaultId]);

  return { snap, pending, refresh: () => setRefreshNonce((n) => n + 1) };
}
