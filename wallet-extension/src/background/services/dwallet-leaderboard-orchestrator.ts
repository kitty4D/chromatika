/**
 * ChromaLab dWallet leaderboard - aggregation orchestrator.
 *
 * coordinates the two halves of the leaderboard pipeline:
 *   1. `refreshDWalletIndex` - on-chain DWalletCap enumeration (`dwallet-leaderboard-index`).
 *   2. `computeDWalletPortfolio` - per-dWallet USD probe (`dwallet-portfolio-value`).
 *
 * scheduling policy (rolling top-N + oldest-stale):
 *   - top 20 by current USD always refresh per tick - they're what users care about most
 *     and slow staleness on the leader rows would be the worst-looking failure mode.
 *   - 20 oldest-stale entries also refresh - rotates the long tail so eventual
 *     consistency converges in roughly `ceil(indexSize / 20)` ticks.
 *   - concurrency 2: leaderboard ticks hammer many public RPCs at once. each
 *     dWallet is ~13 RPC calls (12 mainnet EVMs batched 4-parallel + sui + sol + sol-spl
 *     + apt for ED25519 / + btc for SECP256K1). running 2 dWallets concurrent keeps
 *     total in-flight EVM RPCs around 8, safe for free-tier endpoints.
 *
 * mutex via session storage so concurrent `refreshLeaderboardBatch` calls don't
 * stack on top of each other - the tRPC `leaderboardRefreshNow` mutation reads
 * the flag and returns `alreadyRunning: true` without firing a second batch.
 */

import { isUnlocked } from '@/background/session';
import {
  readDWalletIndex,
  refreshDWalletIndex,
  type RefreshOptions as IndexRefreshOptions,
  type RefreshResult as IndexRefreshResult,
} from '@/background/services/dwallet-leaderboard-index';
import {
  computeDWalletPortfolio,
} from '@/background/services/dwallet-portfolio-value';
import {
  readDWalletPortfolioSnapshot,
  type DWalletPortfolioSnapshot,
} from '@/background/services/dwallet-portfolio-cache';

const LEADERBOARD_BATCH_CONCURRENCY = 2;
const TOP_N_ALWAYS_REFRESH = 20;
const OLDEST_STALE_REFRESH = 20;

const LEADERBOARD_MUTEX_KEY = 'chromatika_leaderboard_inflight_v1';

async function readMutex(): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.storage.session.get([LEADERBOARD_MUTEX_KEY], (result) => {
      resolve(Boolean(result[LEADERBOARD_MUTEX_KEY]));
    });
  });
}

async function setMutex(value: boolean): Promise<void> {
  return new Promise((resolve) => {
    if (value) {
      chrome.storage.session.set({ [LEADERBOARD_MUTEX_KEY]: true }, () => resolve());
    } else {
      chrome.storage.session.remove([LEADERBOARD_MUTEX_KEY], () => resolve());
    }
  });
}

/**
 * refresh one explicit set of dwallet ids in concurrency-2 batches.
 * caller chose the set; this just runs the probes.
 */
export async function refreshLeaderboardBatch(
  ids: string[],
): Promise<DWalletPortfolioSnapshot[]> {
  const out: DWalletPortfolioSnapshot[] = [];
  for (let i = 0; i < ids.length; i += LEADERBOARD_BATCH_CONCURRENCY) {
    const slice = ids.slice(i, i + LEADERBOARD_BATCH_CONCURRENCY);
    const got = await Promise.all(
      slice.map((id) =>
        computeDWalletPortfolio(id).catch((err) => {
          console.warn('[leaderboard] portfolio compute failed:', id, err);
          return null;
        }),
      ),
    );
    for (const snap of got) {
      if (snap) out.push(snap);
    }
  }
  return out;
}

/**
 * select the next set of dwallet ids to refresh based on the rolling top-N policy.
 * - merge top-N by cached USD (skipping ids without a cached snapshot for the
 *   first time so we don't perma-starve them; instead they fall into the
 *   oldest-stale bucket below).
 * - then add the oldest-stale ids by `lastFetchedMs` ascending until we hit
 *   `topN + oldestStale` total.
 */
async function pickIdsToRefresh(
  topN: number,
  oldestStale: number,
): Promise<string[]> {
  const index = await readDWalletIndex();
  if (index.ids.length === 0) return [];

  // build a map of id -> snapshot (may be null for never-probed).
  const snapshots = await Promise.all(
    index.ids.map(async (id) => ({ id, snap: await readDWalletPortfolioSnapshot(id) })),
  );

  // top-N by usdMicros, only counting ids with a known snapshot.
  const ranked = snapshots
    .filter((row) => row.snap != null)
    .sort((a, b) => {
      const ua = a.snap?.usdMicros ?? 0n;
      const ub = b.snap?.usdMicros ?? 0n;
      if (ub > ua) return 1;
      if (ub < ua) return -1;
      return 0;
    })
    .slice(0, topN)
    .map((row) => row.id);

  // oldest-stale: ids ordered by lastFetchedMs ascending (never-probed counts as 0).
  const stale = [...snapshots]
    .sort((a, b) => {
      const la = a.snap?.lastFetchedMs ?? 0;
      const lb = b.snap?.lastFetchedMs ?? 0;
      return la - lb;
    })
    .map((row) => row.id);

  const picked = new Set<string>();
  for (const id of ranked) picked.add(id);
  for (const id of stale) {
    if (picked.size >= topN + oldestStale) break;
    picked.add(id);
  }
  return [...picked];
}

export type OrchestratorTickResult = {
  alreadyRunning: boolean;
  indexRefresh?: IndexRefreshResult;
  portfoliosRefreshed: number;
};

/**
 * one full leaderboard tick:
 *   - try to acquire the mutex; if it's already taken, return alreadyRunning: true.
 *   - refresh the dwallet id index (cheap incremental walk by default).
 *   - pick top-N + oldest-stale ids and re-probe them.
 *
 * the alarm handler in `src/background/index.ts` calls this on the
 * `chromatika-leaderboard-portfolio` cadence. the tRPC `leaderboardRefreshNow`
 * mutation also calls it directly when the user clicks the refresh button.
 */
export async function runLeaderboardTick(
  opts: { forceFullIndexScan?: boolean } = {},
): Promise<OrchestratorTickResult> {
  if (!isUnlocked()) {
    return { alreadyRunning: false, portfoliosRefreshed: 0 };
  }

  if (await readMutex()) {
    return { alreadyRunning: true, portfoliosRefreshed: 0 };
  }
  await setMutex(true);

  try {
    const idxOpts: IndexRefreshOptions = opts.forceFullIndexScan
      ? { forceFullScan: true }
      : {};
    let indexRefresh: IndexRefreshResult | undefined;
    try {
      indexRefresh = await refreshDWalletIndex(idxOpts);
    } catch (err) {
      console.warn('[leaderboard] index refresh failed:', err);
    }

    const picked = await pickIdsToRefresh(TOP_N_ALWAYS_REFRESH, OLDEST_STALE_REFRESH);
    const refreshed = await refreshLeaderboardBatch(picked);

    return {
      alreadyRunning: false,
      indexRefresh,
      portfoliosRefreshed: refreshed.length,
    };
  } finally {
    await setMutex(false);
  }
}

/** index-only tick - used by the index alarm so we keep cap discovery
 *  flowing even on quiet days when nobody's looking at the leaderboard. */
export async function runIndexOnlyTick(): Promise<IndexRefreshResult | null> {
  if (!isUnlocked()) return null;
  try {
    return await refreshDWalletIndex({});
  } catch (err) {
    console.warn('[leaderboard] index-only refresh failed:', err);
    return null;
  }
}
