/**
 * Activity-index walker orchestrator. Per-chain workers plug in via the `IndexWalker`
 * contract; this module handles common concerns so each chain implementation can focus
 * on the API quirks of its source provider:
 *
 *   - cursor + status persistence to IndexedDB via `patchCoverage` (so SW restarts can
 *     resume from where the last page ended)
 *   - operation-progress integration so `OperationProgressBanner` + the StatusStep on
 *     the Confirm screen + the Activity page row badges all see the same live state
 *   - cancellation via an in-memory cancel-flag set keyed by `(vaultId, chain, address)`
 *   - batched IDB writes (~100-500 rows per commit) so the transaction overhead stays sane
 *   - graceful failure: provider 5xx / 429s flip the coverage to 'partial' with the error
 *     stashed in `lastError`, the cursor preserved, so the user can resume from the UI
 *
 * deliberately NOT in scope for Phase 2 MVP:
 *   - chrome.alarms watchdog for auto-resume after SW restart (the user can re-trigger
 *     from the Activity page; cursor is preserved). add if user feedback shows people
 *     don't realize their indexing got cut short.
 *   - parallel jobs across multiple addresses. one job at a time keeps API rate-limit
 *     budgets predictable, and a typical user has < 10 addresses anyway.
 */

import {
  patchCoverage,
  recordIndexedTxs,
  type ActivityIndexChain,
  type CoverageStatus,
  type IndexedTx,
} from '@/background/services/activity-index';
import { beginOperation, type OperationHandle } from '@/background/progress/operation-progress';

/** signal-style cancel token. each running job has one; flipped by `cancelIndexJob`. */
type CancelToken = { cancelled: boolean };

/** the per-(vaultId, chain, address) state we keep in memory for jobs in flight. removed
 * on job completion. surviving here doesn't leak across SW restarts; the persistent state
 * lives in the coverage record's `status: 'partial'` with `resumeCursor`. */
const runningJobs = new Map<string, CancelToken>();

function runKey(vaultId: string, chain: ActivityIndexChain, address: string): string {
  return `${chain}:${vaultId}:${address}`;
}

/**
 * the contract per-chain workers fulfill. workers stream one page at a time; the
 * orchestrator handles persistence + cancel checks between pages. workers are responsible
 * for the chain-specific API call shape, pagination cursor semantics, and the
 * "did we reach the chain's history floor?" check (which determines whether final status
 * is `'complete-to-genesis'` or `'complete-to-retention'`).
 */
export interface IndexWalker {
  /** chain identifier; used in coverage keys + operation-progress label. */
  readonly chain: ActivityIndexChain;
  /** which provider this walker fetches from; goes into each IndexedTx's `source` field
   * for debugging "why does my row count look different on a re-index?". */
  readonly source: string;
  /** does this walker's source provider retain full chain history, or only a recent
   * window? when 'retention-bounded', a clean pagination drain produces
   * `'complete-to-retention'` status (the Solana case). when 'genesis-capable', a clean
   * drain produces `'complete-to-genesis'` (Sui / EVM-with-Alchemy / BTC / Aptos). */
  readonly coverageCeiling: 'complete-to-genesis' | 'complete-to-retention';
  /**
   * fetch one page. `cursor` is opaque to the orchestrator - workers define their own
   * shape and serialize via `String()` for the persisted resume cursor.
   *
   * returns:
   *   - `rows`: indexed-tx rows to persist. zero is fine (sparse address); the orchestrator
   *     still respects `nextCursor === null` to finish.
   *   - `nextCursor`: opaque next page key, or null when the walker has reached the end
   *     of the chain's available history for this address.
   *   - `newestPosition` / `oldestPosition`: range covered by this page (for the coverage
   *     record's running min/max). bigint-as-string.
   */
  fetchPage(opts: {
    vaultId: string;
    address: string;
    cursor: string | null;
  }): Promise<{
    rows: IndexedTx[];
    nextCursor: string | null;
    newestPosition: string | null;
    oldestPosition: string | null;
  }>;
}

/**
 * start an index job. returns a tracker the caller can use to monitor / cancel. if a job
 * is already running for the same `(vaultId, chain, address)`, the returned promise
 * short-circuits to "already running" rather than spawning a second walker.
 *
 * the caller typically fires this from a tRPC mutation and DOESN'T await the returned
 * promise - the walker runs to completion (or pause / cancel) in the background. the
 * tRPC mutation returns the initial status immediately and the UI polls
 * `activityIndexCoverage` for updates.
 */
export async function startIndexJob(opts: {
  walker: IndexWalker;
  vaultId: string;
  address: string;
  /** safety cap on total pages walked before the orchestrator force-pauses. prevents a
   * runaway worker on a misbehaving provider. default 200 pages (effectively ~10k-100k
   * txs depending on per-page sizes). */
  maxPages?: number;
}): Promise<{ status: 'started' | 'already-running' }> {
  const { walker, vaultId, address } = opts;
  const key = runKey(vaultId, walker.chain, address);
  if (runningJobs.has(key)) return { status: 'already-running' };

  const cancelToken: CancelToken = { cancelled: false };
  runningJobs.set(key, cancelToken);

  // run as fire-and-forget. errors inside `runWalker` are swallowed onto the coverage
  // record's `lastError` (status: 'partial') so the UI can surface them; we don't reject
  // the outer promise because no one awaits it.
  void runWalker({
    walker,
    vaultId,
    address,
    cancelToken,
    maxPages: opts.maxPages ?? 200,
  }).finally(() => {
    runningJobs.delete(key);
  });

  return { status: 'started' };
}

/** flip the cancel flag for an in-flight job. workers check between pages, so cancellation
 * lands at the next page boundary (typically within a couple of seconds). idempotent: cancelling
 * a job that isn't running is a no-op. */
export function cancelIndexJob(
  vaultId: string,
  chain: ActivityIndexChain,
  address: string,
): { wasRunning: boolean } {
  const key = runKey(vaultId, chain, address);
  const t = runningJobs.get(key);
  if (!t) return { wasRunning: false };
  t.cancelled = true;
  return { wasRunning: true };
}

/** is there a job currently running for this address? used by the UI to render the right
 * "Start / Cancel / Resume" affordance and by `startIndexJob` to avoid duplicates. */
export function isIndexJobRunning(
  vaultId: string,
  chain: ActivityIndexChain,
  address: string,
): boolean {
  return runningJobs.has(runKey(vaultId, chain, address));
}

// ---------------------------------------------------------------------------
// internal walker driver
// ---------------------------------------------------------------------------

async function runWalker(args: {
  walker: IndexWalker;
  vaultId: string;
  address: string;
  cancelToken: CancelToken;
  maxPages: number;
}): Promise<void> {
  const { walker, vaultId, address, cancelToken, maxPages } = args;

  // start coverage update: mark in-flight, clear any prior error. preserve resumeCursor
  // if it's set (this is a resume) or null if it's a fresh start.
  const existing = await patchCoverage(vaultId, walker.chain, address, {
    status: 'partial',
    lastError: null,
    lastSyncedAtMs: null, // mark "in-flight" by clearing lastSyncedAt
  });
  let cursor: string | null = existing.resumeCursor;

  const op: OperationHandle = await beginOperation(
    `Indexing ${walker.chain.toUpperCase()} history for ${shortAddr(address)}`,
  );
  let pagesScanned = 0;
  let totalRows = existing.rowCount ?? 0;
  let newestPosition: string | null = existing.newestPosition;
  let oldestPosition: string | null = existing.oldestPosition;

  try {
    while (pagesScanned < maxPages) {
      if (cancelToken.cancelled) {
        await patchCoverage(vaultId, walker.chain, address, {
          status: 'partial',
          resumeCursor: cursor,
          lastError: 'cancelled by user',
        });
        await op.fail('Indexing cancelled');
        return;
      }
      await op.updateStage(
        'fetching',
        `Fetched ${totalRows} txs; page ${pagesScanned + 1}…`,
      );

      let page;
      try {
        page = await walker.fetchPage({ vaultId, address, cursor });
      } catch (e) {
        // page fetch failed - persist as partial with cursor preserved so the user can
        // resume from the Activity page when the provider recovers.
        const msg = e instanceof Error ? e.message : String(e);
        await patchCoverage(vaultId, walker.chain, address, {
          status: 'partial',
          resumeCursor: cursor,
          lastError: msg,
        });
        await op.fail(`Indexing paused: ${msg}`);
        return;
      }

      if (page.rows.length > 0) {
        await recordIndexedTxs(page.rows);
        totalRows += page.rows.length;
      }
      // update running min/max position across the run.
      if (page.newestPosition != null) {
        newestPosition = pickGreater(newestPosition, page.newestPosition);
      }
      if (page.oldestPosition != null) {
        oldestPosition = pickLesser(oldestPosition, page.oldestPosition);
      }

      pagesScanned += 1;

      if (page.nextCursor === null) {
        // walker reached the end of available history for this address.
        const finalStatus: CoverageStatus = walker.coverageCeiling;
        await patchCoverage(vaultId, walker.chain, address, {
          status: finalStatus,
          newestPosition,
          oldestPosition,
          resumeCursor: null,
          lastError: null,
          lastSyncedAtMs: Date.now(),
          rowCount: totalRows,
        });
        await op.succeed(
          `Indexed ${totalRows} ${walker.chain.toUpperCase()} txs (${finalStatus === 'complete-to-genesis' ? 'full history' : 'complete to provider retention'})`,
        );
        return;
      }

      cursor = page.nextCursor;
      // persist cursor every page so SW restart can resume.
      await patchCoverage(vaultId, walker.chain, address, {
        status: 'partial',
        newestPosition,
        oldestPosition,
        resumeCursor: cursor,
        lastError: null,
        rowCount: totalRows,
      });
    }

    // hit the page cap before reaching genesis. record as partial; user can resume.
    await patchCoverage(vaultId, walker.chain, address, {
      status: 'partial',
      newestPosition,
      oldestPosition,
      resumeCursor: cursor,
      lastError: `paused after ${maxPages} pages; click resume to continue`,
      rowCount: totalRows,
    });
    await op.fail(`Paused after ${maxPages} pages; resume from the Activity page`);
  } catch (e) {
    // any uncaught error: persist as partial so the UI can surface + resume.
    const msg = e instanceof Error ? e.message : String(e);
    await patchCoverage(vaultId, walker.chain, address, {
      status: 'partial',
      resumeCursor: cursor,
      lastError: msg,
    }).catch(() => undefined);
    await op.fail(msg);
  }
}

function shortAddr(a: string): string {
  if (a.length <= 14) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/** bigint-as-string compare. both args may be null. returns the larger one (or whichever
 * is non-null). EVM block numbers / Solana slots / Sui checkpoints / BTC heights all fit
 * in regular bigints; safe to parse on demand. */
function pickGreater(a: string | null, b: string | null): string | null {
  if (a == null) return b;
  if (b == null) return a;
  return BigInt(a) > BigInt(b) ? a : b;
}
function pickLesser(a: string | null, b: string | null): string | null {
  if (a == null) return b;
  if (b == null) return a;
  return BigInt(a) < BigInt(b) ? a : b;
}
