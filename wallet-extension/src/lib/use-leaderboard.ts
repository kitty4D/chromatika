/**
 * React hook for the ChromaLab dWallet leaderboard surface.
 *
 * fetches the initial list of leaderboard rows via tRPC and then subscribes to
 * `chrome.storage.onChanged` so the UI re-renders without polling whenever a
 * background tick lands new portfolio snapshots or grows the index. mirrors the
 * pattern in `use-operation-progress.ts:35` (filter by storage key prefix).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { STORAGE_KEYS } from '@/background/storage/keys';
import { DWALLET_PORTFOLIO_KEY_PREFIX } from '@/background/services/dwallet-portfolio-cache';

export type LeaderboardEntry = {
  dwalletId: string;
  firstSeenMs: number | null;
  lastFetchedMs: number | null;
  curve: 'SECP256K1' | 'ED25519' | 'unknown';
  stateKind: string;
  usdMicros: string;
  partial: boolean;
  hasPortfolio: boolean;
};

export type LeaderboardListResponse = {
  rows: LeaderboardEntry[];
  total: number;
  indexUpdatedAtMs: number;
  lastFullScanMs: number | null;
};

export type UseLeaderboardOptions = {
  limit?: number;
};

export type UseLeaderboardResult = {
  rows: LeaderboardEntry[];
  total: number;
  indexUpdatedAtMs: number;
  lastFullScanMs: number | null;
  loading: boolean;
  error: string | null;
  /** force re-fetch from background. used by the refresh button. */
  refetch: () => Promise<void>;
};

/** poll-on-mount + storage-event-push pattern. cheap because tRPC reads cached snapshots. */
export function useLeaderboard(opts: UseLeaderboardOptions = {}): UseLeaderboardResult {
  const limit = opts.limit ?? 100;
  const [rows, setRows] = useState<LeaderboardEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [indexUpdatedAtMs, setIndexUpdatedAtMs] = useState(0);
  const [lastFullScanMs, setLastFullScanMs] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // ref to avoid stale closures inside the storage listener.
  const limitRef = useRef(limit);
  limitRef.current = limit;

  const refetch = useCallback(async () => {
    try {
      const res = (await trpc.leaderboardListEntries.query({ limit: limitRef.current })) as LeaderboardListResponse;
      setRows(res.rows);
      setTotal(res.total);
      setIndexUpdatedAtMs(res.indexUpdatedAtMs);
      setLastFullScanMs(res.lastFullScanMs);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  useEffect(() => {
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: chrome.storage.AreaName) => {
      let touched = false;
      for (const key of Object.keys(changes)) {
        if (area === 'session' && key.startsWith(DWALLET_PORTFOLIO_KEY_PREFIX)) {
          touched = true;
          break;
        }
        if (area === 'local' && key === STORAGE_KEYS.DWALLET_INDEX_V1) {
          touched = true;
          break;
        }
      }
      if (touched) void refetch();
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, [refetch]);

  return { rows, total, indexUpdatedAtMs, lastFullScanMs, loading, error, refetch };
}

export type LeaderboardPortfolioPerChain = {
  chainKey: string;
  usdMicros: string;
  ok: boolean;
  reason?: string;
};

export type LeaderboardPortfolio = {
  dwalletId: string;
  curve: 'SECP256K1' | 'ED25519' | 'unknown';
  stateKind: string;
  addresses: {
    evm?: string;
    btcP2wpkh?: string;
    btcP2tr?: string;
    sui?: string;
    solana?: string;
    aptos?: string;
    deso?: string;
  };
  usdMicros: string;
  partial: boolean;
  lastFetchedMs: number;
  perChain: LeaderboardPortfolioPerChain[];
};
