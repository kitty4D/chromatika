/**
 * tRPC procedures for the ChromaLab dWallet leaderboard.
 *
 * surface design:
 *   - `leaderboardListEntries` is the cheap query the page polls on mount. it
 *     joins the dwallet id index with whatever cached portfolio snapshots exist,
 *     sorts by `usdMicros` desc, and returns wire-shaped rows. it never fires
 *     live RPCs - just reads `chrome.storage.local` (the index) + `.session`
 *     (the per-dwallet snapshots). UI re-renders via `chrome.storage.onChanged`
 *     when background ticks land new snapshots.
 *   - `leaderboardGetPortfolio` is the SWR per-row fetch (used when the user
 *     expands a row). returns the cached snapshot immediately + triggers a
 *     background refresh if stale.
 *   - `leaderboardRefreshNow` is the user-driven refresh. mutex-protected so
 *     concurrent clicks (or popup + side panel both open) don't stack ticks.
 *   - `leaderboardAddManualId` / `leaderboardRemoveManualId` cover the paste-id
 *     + hide-from-list affordances on the UI.
 *   - `leaderboardGetPrefs` / `leaderboardSetPrefs` gate the whole feature behind
 *     an opt-in flag. alarms read the same key to decide whether to tick.
 *
 * wire format: `bigint -> string` at the boundary, mirroring `vault-total-cache.ts:32`.
 */

import { z } from 'zod';
import { publicProcedure } from '../trpc';
import { STORAGE_KEYS } from '@/background/storage/keys';
import {
  readDWalletIndex,
  upsertDWalletIndexId,
  removeDWalletIndexId,
} from '@/background/services/dwallet-leaderboard-index';
import {
  readDWalletPortfolioSnapshot,
  type DWalletPortfolioSnapshot,
} from '@/background/services/dwallet-portfolio-cache';
import {
  getCachedOrTriggerRefresh,
  computeDWalletPortfolio,
} from '@/background/services/dwallet-portfolio-value';
import { runLeaderboardTick } from '@/background/services/dwallet-leaderboard-orchestrator';

type LeaderboardEntryWire = {
  dwalletId: string;
  /** first-time-seen timestamp on this device. `null` until indexed at least once. */
  firstSeenMs: number | null;
  /** most recent on-chain refresh. `null` if the entry was never probed. */
  lastFetchedMs: number | null;
  /** ika curve when known. `'unknown'` until a portfolio snapshot lands. */
  curve: 'SECP256K1' | 'ED25519' | 'unknown';
  /** ika state kind from the most recent snapshot. */
  stateKind: string;
  /** USD total, stringified for wire transport. `'0'` if never probed yet. */
  usdMicros: string;
  /** true when any probe failed or address derivation incomplete. */
  partial: boolean;
  /** false when no portfolio snapshot has ever been computed for this id. */
  hasPortfolio: boolean;
};

function snapshotToWire(dwalletId: string, snap: DWalletPortfolioSnapshot | null, firstSeenMs: number | null): LeaderboardEntryWire {
  if (!snap) {
    return {
      dwalletId,
      firstSeenMs,
      lastFetchedMs: null,
      curve: 'unknown',
      stateKind: 'unknown',
      usdMicros: '0',
      partial: false,
      hasPortfolio: false,
    };
  }
  return {
    dwalletId,
    firstSeenMs,
    lastFetchedMs: snap.lastFetchedMs,
    curve: snap.curve,
    stateKind: snap.stateKind,
    usdMicros: snap.usdMicros.toString(),
    partial: snap.partial,
    hasPortfolio: true,
  };
}

type PerChainWire = { chainKey: string; usdMicros: string; ok: boolean; reason?: string };
type PortfolioWire = {
  dwalletId: string;
  curve: DWalletPortfolioSnapshot['curve'];
  stateKind: string;
  addresses: DWalletPortfolioSnapshot['addresses'];
  usdMicros: string;
  partial: boolean;
  lastFetchedMs: number;
  perChain: PerChainWire[];
};

function portfolioToWire(snap: DWalletPortfolioSnapshot): PortfolioWire {
  return {
    dwalletId: snap.dwalletId,
    curve: snap.curve,
    stateKind: snap.stateKind,
    addresses: snap.addresses,
    usdMicros: snap.usdMicros.toString(),
    partial: snap.partial,
    lastFetchedMs: snap.lastFetchedMs,
    perChain: snap.perChain.map((p) => ({
      chainKey: p.chainKey,
      usdMicros: p.usdMicros.toString(),
      ok: p.ok,
      reason: p.reason,
    })),
  };
}

type LeaderboardPrefs = {
  enabled: boolean;
};

const DEFAULT_PREFS: LeaderboardPrefs = { enabled: false };

async function readPrefs(): Promise<LeaderboardPrefs> {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEYS.LEADERBOARD_PREFS_V1], (result) => {
      const raw = result[STORAGE_KEYS.LEADERBOARD_PREFS_V1];
      if (!raw || typeof raw !== 'object') {
        resolve({ ...DEFAULT_PREFS });
        return;
      }
      const enabled = (raw as { enabled?: unknown }).enabled === true;
      resolve({ enabled });
    });
  });
}

async function writePrefs(prefs: LeaderboardPrefs): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [STORAGE_KEYS.LEADERBOARD_PREFS_V1]: prefs }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

export const dwalletLeaderboardProcedures = {
  /**
   * list known dwallet ids sorted by cached USD desc. ids without a portfolio
   * snapshot land at the bottom with `hasPortfolio: false` so the UI can render
   * them as "pending probe" rows. partial / unknown rows still appear (they're
   * useful signal); the UI can offer a hide affordance via `leaderboardRemoveManualId`.
   */
  leaderboardListEntries: publicProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(500).optional(),
          offset: z.number().int().min(0).optional(),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      const limit = input?.limit ?? 100;
      const offset = input?.offset ?? 0;

      const index = await readDWalletIndex();
      const rows: LeaderboardEntryWire[] = [];

      for (const id of index.ids) {
        const snap = await readDWalletPortfolioSnapshot(id);
        rows.push(snapshotToWire(id, snap, index.firstSeenMs[id] ?? null));
      }

      // sort: known-USD desc, then partial-but-known last, then never-probed last.
      rows.sort((a, b) => {
        if (a.hasPortfolio !== b.hasPortfolio) return a.hasPortfolio ? -1 : 1;
        const ua = BigInt(a.usdMicros);
        const ub = BigInt(b.usdMicros);
        if (ub > ua) return 1;
        if (ub < ua) return -1;
        return 0;
      });

      return {
        rows: rows.slice(offset, offset + limit),
        total: rows.length,
        indexUpdatedAtMs: index.updatedAtMs,
        lastFullScanMs: index.lastFullScanMs,
      };
    }),

  /** detailed cache lookup. triggers a background refresh when stale. */
  leaderboardGetPortfolio: publicProcedure
    .input(z.object({ dwalletId: z.string() }))
    .query(async ({ input }) => {
      const snap = await getCachedOrTriggerRefresh(input.dwalletId);
      return snap ? portfolioToWire(snap) : null;
    }),

  /** force-recompute one row inline. used by the per-row "refresh" affordance. */
  leaderboardForceRefreshPortfolio: publicProcedure
    .input(z.object({ dwalletId: z.string() }))
    .mutation(async ({ input }) => {
      const snap = await computeDWalletPortfolio(input.dwalletId);
      return portfolioToWire(snap);
    }),

  /** user-driven refresh tick. mutex-protected so concurrent clicks coalesce. */
  leaderboardRefreshNow: publicProcedure.mutation(async () => {
    const res = await runLeaderboardTick();
    return {
      alreadyRunning: res.alreadyRunning,
      portfoliosRefreshed: res.portfoliosRefreshed,
      indexAdded: res.indexRefresh?.added ?? 0,
      indexObserved: res.indexRefresh?.observed ?? 0,
      fullScan: res.indexRefresh?.fullScan ?? false,
    };
  }),

  /** paste-an-id action from the UI. validates it's a sui object id shape. */
  leaderboardAddManualId: publicProcedure
    .input(z.object({ dwalletId: z.string() }))
    .mutation(async ({ input }) => {
      const id = input.dwalletId.trim();
      if (!id.startsWith('0x') || id.length !== 66) {
        throw new Error('Expected a Sui object id (0x followed by 64 hex chars)');
      }
      await upsertDWalletIndexId(id);
      // trigger a one-shot portfolio compute so the row populates quickly.
      void computeDWalletPortfolio(id).catch((err) => {
        console.warn('[leaderboard] manual-add portfolio compute failed:', err);
      });
      return { ok: true };
    }),

  /** hide-from-list affordance. removes from the index, doesn't touch the cache. */
  leaderboardRemoveManualId: publicProcedure
    .input(z.object({ dwalletId: z.string() }))
    .mutation(async ({ input }) => {
      await removeDWalletIndexId(input.dwalletId);
      return { ok: true };
    }),

  /** prefs read. UI uses this to decide whether to show the first-run disclosure. */
  leaderboardGetPrefs: publicProcedure.query(async () => {
    return await readPrefs();
  }),

  /** prefs write. the alarm handlers read the same key each tick so flipping is instant. */
  leaderboardSetPrefs: publicProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(async ({ input }) => {
      await writePrefs({ enabled: input.enabled });
      return { ok: true };
    }),
} as const;
