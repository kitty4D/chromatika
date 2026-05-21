/**
 * Pending-tx tracker. Inserts an optimistic IDB row the moment a send broadcasts, then
 * the reconciler (`pending-tx-reconciler.ts`) flips it to `'success'` / `'failure'` when
 * the chain settles.
 *
 * Why this lives separate from the walker scaffold: walkers are bulk historical scans;
 * pending-tx tracking is a single-row optimistic insert that happens inline with every
 * `sendUnified` call. Keeping them apart means the broadcast path doesn't import the
 * orchestrator machinery and the reconciler doesn't have to know about cursor state.
 */

import {
  getIndexedTx,
  deleteIndexedTx,
  makeTxKey,
  type ActivityIndexChain,
  type IndexedTx,
  type IndexedTxKind,
} from '@/background/services/activity-index';

/** insert a fresh pending row right after a successful broadcast. idempotent: a second
 * call for the same `(chain, digest)` is a no-op (would just be an overwrite that
 * preserves the `pendingMeta.broadcastAtMs`). intentionally writes via `idbPut` rather
 * than `recordIndexedTxs` so callers don't have to construct the full IndexedTx shape
 * for the boilerplate fields. */
export async function insertPendingTx(opts: {
  vaultId: string;
  chain: ActivityIndexChain;
  digest: string;
  perspectiveAddress: string;
  counterparty: string | null;
  kind: IndexedTxKind;
  symbol: string | null;
  amountRaw: string | null;
  /** wall-clock ms at the broadcast moment (caller passes `Date.now()` typically). */
  broadcastAtMs: number;
  /** for L2 hash replacement: usually `digest`, but if a caller knows the L2 may rewrite
   * the hash they can pass the originally-broadcast hash here so the reconciler can
   * migrate the row in-place. */
  originalDigest?: string;
  /** chain-native memo if known at broadcast time (Solana memo program). null when no
   * memo or chain doesn't support one. */
  memo?: string | null;
  /** swap multi-leg metadata when this pending tx is a swap (the wallet originated it
   * via the swap flow, not the send flow). null for normal transfers. */
  swapMeta?: IndexedTx['swapMeta'];
  /** EVM chainId so the reconciler knows which RPC to poll. ignored for non-EVM chains. */
  chainId?: number;
  /** dapp origin URL when the broadcast was dapp-initiated. */
  origin?: string | null;
}): Promise<void> {
  const row: IndexedTx = {
    key: makeTxKey(opts.chain, opts.vaultId, opts.digest),
    vaultId: opts.vaultId,
    chain: opts.chain,
    digest: opts.digest,
    perspectiveAddress: normalizePerspective(opts.chain, opts.perspectiveAddress),
    counterparty: normalizeCounterparty(opts.chain, opts.counterparty),
    // position: we don't know the chain position yet (tx hasn't been mined). use the
    // broadcastAtMs as a synthetic position so `byPerspective` sorts pending rows
    // chronologically. once the row settles, the reconciler can update `position` to
    // the real chain-side position if needed.
    position: String(opts.broadcastAtMs),
    timestampMs: opts.broadcastAtMs,
    symbol: opts.symbol,
    amountRaw: opts.amountRaw,
    source: 'broadcast-local',
    kind: opts.kind,
    swapMeta: opts.swapMeta,
    memo: opts.memo ?? null,
    status: 'pending',
    pendingMeta: {
      broadcastAtMs: opts.broadcastAtMs,
      lastPolledAtMs: opts.broadcastAtMs,
      attemptCount: 0,
      originalDigest: opts.originalDigest ?? opts.digest,
      chainId: opts.chainId,
      origin: opts.origin ?? null,
    },
    priceUsdAtSync: null,
  };
  // delegate the write to the shared module's `recordIndexedTxs` (which is just a batched
  // idbPut). this keeps all writes through a single code path.
  const { recordIndexedTxs } = await import('@/background/services/activity-index');
  await recordIndexedTxs([row]);
}

/** flip a pending row to settled state. handles two distinct cases:
 *
 *   1. Same-digest settlement (the normal path): the row's `status` flips to
 *      `'success'` or `'failure'`, `pendingMeta` cleared. `position` updated to the real
 *      chain position when supplied (block number for EVM, checkpoint for Sui, slot for
 *      Solana, block height for BTC).
 *
 *   2. L2 hash replacement: when `finalDigest` is supplied and differs from the
 *      pending row's digest, we look up the pending row by the original digest, delete
 *      it, and re-insert under the new key. Logs a console.warn for observability
 *      (this is rare and useful to flag).
 */
export async function markTxSettled(opts: {
  vaultId: string;
  chain: ActivityIndexChain;
  /** the digest the wallet originally broadcast. */
  digest: string;
  status: 'success' | 'failure';
  /** when set and differs from `digest`, the on-chain landing happened under a different
   * hash (L2 sequencer reorg). caller passes the chain-reported final digest here. */
  finalDigest?: string;
  /** real chain-side position (block number / checkpoint / slot / block height) as a
   * bigint-as-string. when omitted, we keep the synthetic broadcastAtMs position. */
  position?: string;
  /** human error message for failure case. */
  failureReason?: string;
  /** observed fee (paid by user, in base units). when set, overwrites `amountRaw` only
   * when the row was a fee-only tx; otherwise stored on `swapMeta` for swap rows or
   * ignored for plain transfers. */
  feeRaw?: string;
}): Promise<void> {
  const { recordIndexedTxs } = await import('@/background/services/activity-index');
  void opts.feeRaw; // fee plumbing: future work (TxDetailModal renders fee from receipt)

  const originalKey = makeTxKey(opts.chain, opts.vaultId, opts.digest);
  const current = await getIndexedTx(originalKey);
  if (!current) {
    console.warn('[pending-tx-tracker] markTxSettled: no row found', {
      vaultId: opts.vaultId,
      chain: opts.chain,
      digest: opts.digest,
    });
    return;
  }

  const updated: IndexedTx = {
    ...current,
    status: opts.status,
    pendingMeta: undefined,
    position: opts.position ?? current.position,
    timestampMs: current.timestampMs ?? Date.now(),
  };
  if (opts.failureReason && opts.status === 'failure') {
    // stash the reason on the symbol field's neighbor for failure rows. simpler than a
    // dedicated `failureReason` field on IndexedTx, and matches how the UI surfaces
    // failed sends today.
    (updated as IndexedTx & { failureReason?: string }).failureReason = opts.failureReason;
  }

  if (opts.finalDigest && opts.finalDigest !== opts.digest) {
    // L2 hash replacement: rewrite the row under the new key + drop the old one.
    console.warn('[pending-tx-tracker] L2 hash replacement detected; migrating row', {
      chain: opts.chain,
      from: opts.digest,
      to: opts.finalDigest,
    });
    updated.digest = opts.finalDigest;
    updated.key = makeTxKey(opts.chain, opts.vaultId, opts.finalDigest);
    await recordIndexedTxs([updated]);
    await deleteIndexedTx(originalKey);
    return;
  }

  await recordIndexedTxs([updated]);
}

/** update a pending row's `pendingMeta` (lastPolledAtMs + attemptCount) without flipping
 * status. used by the reconciler between polls so a SW restart can see how many attempts
 * the prior session made + back off correctly. */
export async function bumpPendingPollState(
  vaultId: string,
  chain: ActivityIndexChain,
  digest: string,
): Promise<void> {
  const { recordIndexedTxs } = await import('@/background/services/activity-index');
  const key = makeTxKey(chain, vaultId, digest);
  const current = await getIndexedTx(key);
  if (!current || current.status !== 'pending' || !current.pendingMeta) return;
  const updated: IndexedTx = {
    ...current,
    pendingMeta: {
      ...current.pendingMeta,
      lastPolledAtMs: Date.now(),
      attemptCount: current.pendingMeta.attemptCount + 1,
    },
  };
  await recordIndexedTxs([updated]);
}

function normalizePerspective(chain: ActivityIndexChain, addr: string): string {
  if (chain === 'evm' || chain === 'sui' || chain === 'aptos') return addr.toLowerCase();
  return addr;
}

function normalizeCounterparty(chain: ActivityIndexChain, addr: string | null): string | null {
  if (!addr) return null;
  if (chain === 'evm' || chain === 'sui' || chain === 'aptos') return addr.toLowerCase();
  return addr;
}
